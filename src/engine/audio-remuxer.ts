/**
 * ============================================================================
 * audio-remuxer.ts — Pure TypeScript Audio Packet Remuxer
 * ============================================================================
 *
 * Accepts raw audio packets from the FFmpeg WASM demuxer and wraps them in
 * playable container formats:
 *
 *   AAC    → 7-byte ADTS header per packet (direct browser playback)
 *   MP3    → direct passthrough (self-framing)
 *   Opus   → OGG container with OpusHead/OpusTags init pages
 *   Vorbis → OGG container with Xiph-laced identification/comment/setup headers
 *
 *   1. PRE-ALLOCATED BUFFER — feedPacket() writes into a reusable internal
 *      buffer. No per-packet allocations. The caller must copy/transfer the
 *      returned view before the next feedPacket() call.
 *
 *   2. PRE-ALLOCATED MANIFEST — buildManifest() writes into a pre-sized
 *      string. Capacity is computed from duration at construction time.
 *
 *   3. ZERO-COPY DESIGN — The OGG CRC table is computed once at module load.
 *      Segment tables are written directly into the output buffer.
 *
 * FFmpeg Codec IDs (from FFmpeg 8.1 libavcodec/codec_id.h):
 *   AAC:    86018
 *   MP3:    86017
 *   Opus:   86076
 *   Vorbis: 86021
 *
 * Usage (inside the Worker's EXTRACT_AUDIO handler):
 *   const remuxer = new AudioRemuxer(codecId, sampleRate, channels, extradata, {
 *     buildManifest: true,
 *     duration: 3600,
 *   });
 *   // ... in the demuxer loop:
 *   const framed = remuxer.feedPacket(pkt.data, pkt.ptsUs);
 *   postMessage({ type: 'AUDIO_CHUNK', buffer: framed.buffer }, [framed.buffer]);
 *   // ... after the loop:
 *   const eos = remuxer.finalize();
 *   const manifest = remuxer.buildManifest();
 *
 * License: MIT
 */

// ─── FFmpeg Audio Codec IDs (stable, from libavcodec/codec_id.h) ─────────

export const AV_CODEC_ID_MP3    = 86017;
export const AV_CODEC_ID_AAC    = 86018;
export const AV_CODEC_ID_VORBIS = 86021;
export const AV_CODEC_ID_OPUS   = 86076;

// ─── Internal Types ──────────────────────────────────────────────────────

const enum AudioCodec {
  Aac,
  Mp3,
  Opus,
  Vorbis,
}

export interface AudioRemuxerOptions {
  /** If true, build a per-second byte-offset manifest during extraction */
  buildManifest: boolean;
  /** Total duration in seconds (for pre-allocating the byte index) */
  duration: number;
  /** Stream serial number for OGG pages (default: 1) */
  serialNumber?: number;
}

export interface AudioManifest {
  codec: string;
  extension: string;
  mime: string;
  sample_rate: number;
  channels: number;
  duration_sec: number;
  total_bytes: number;
  pre_roll_ms: number;
  init_segments: string[];
  byte_index: number[];
}

// ─── OGG CRC32 Table (computed once at module load) ──────────────────────
//
// Polynomial: 0x04C11DB7 (OGG-specific, NOT the standard zlib CRC32).
// This is a direct port of the Rust `build_ogg_crc_table()` const fn.

const OGG_CRC_TABLE = new Uint32Array(256);
{
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if ((r & 0x80000000) !== 0) {
        r = ((r << 1) ^ 0x04C11DB7) >>> 0;
      } else {
        r = (r << 1) >>> 0;
      }
    }
    OGG_CRC_TABLE[i] = r;
  }
}

function oggCrc(data: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const idx = ((crc >>> 24) ^ data[i]) & 0xFF;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[idx]) >>> 0;
  }
  return crc;
}

// ─── OGG Page Writer ─────────────────────────────────────────────────────
//
// Max payload per OGG page: 255 segments × 255 bytes = 65,025 bytes.
// Handles continuation pages automatically for large packets.

const OGG_MAX_PAGE_PAYLOAD = 255 * 255;

/**
 * Write one or more OGG pages for a single audio packet into the buffer.
 * Returns the new write offset.
 */
function writeOggPage(
  buf: Uint8Array,
  offset: number,
  payload: Uint8Array,
  granulePos: bigint,
  serial: number,
  pageSeq: { value: number },
  isBos: boolean,
  isEos: boolean,
): number {
  const total = payload.length;
  const pageCount = total === 0 ? 1 : Math.ceil(total / OGG_MAX_PAGE_PAYLOAD);
  let payloadOffset = 0;

  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const isFirstPage = pageIdx === 0;
    const isLastPage = pageIdx === pageCount - 1;
    const chunkEnd = Math.min(payloadOffset + OGG_MAX_PAGE_PAYLOAD, total);
    const chunkLen = chunkEnd - payloadOffset;

    const headerStart = offset;

    // Header type flags
    let headerType = 0x00;
    if (isBos && isFirstPage) headerType |= 0x02;
    if (isEos && isLastPage) headerType |= 0x04;
    if (!isFirstPage) headerType |= 0x01; // continuation

    // Granule position: only the last page carries the real value
    const pageGranule = isLastPage ? granulePos : 0xFFFFFFFFFFFFFFFFn;

    // "OggS" capture pattern
    buf[offset++] = 0x4F; buf[offset++] = 0x67;
    buf[offset++] = 0x67; buf[offset++] = 0x53;

    // Stream structure version
    buf[offset++] = 0;

    // Header type flag
    buf[offset++] = headerType;

    // Granule position (64-bit LE)
    const gv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    gv.setBigUint64(0, pageGranule, true);
    offset += 8;

    // Serial number (32-bit LE)
    const sv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
    sv.setUint32(0, serial, true);
    offset += 4;

    // Page sequence number (32-bit LE)
    const pv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
    pv.setUint32(0, pageSeq.value, true);
    offset += 4;

    // CRC32 placeholder (backpatched below)
    const checksumPos = offset;
    buf[offset++] = 0; buf[offset++] = 0;
    buf[offset++] = 0; buf[offset++] = 0;

    // Segment table
    const fullSegments = Math.floor(chunkLen / 255);
    const remainder = chunkLen % 255;
    let numSegments: number;
    if (chunkLen === 0) {
      numSegments = 1;
    } else if (remainder === 0 && isLastPage) {
      numSegments = fullSegments + 1; // trailing 0 to close the packet
    } else if (remainder === 0) {
      numSegments = fullSegments;
    } else {
      numSegments = fullSegments + 1;
    }

    buf[offset++] = numSegments;
    for (let i = 0; i < numSegments; i++) {
      buf[offset++] = i < fullSegments ? 255 : remainder;
    }

    // Payload data
    buf.set(payload.subarray(payloadOffset, chunkEnd), offset);
    offset += chunkLen;

    // Backpatch CRC32
    const crc = oggCrc(buf, headerStart, offset);
    const cv = new DataView(buf.buffer, buf.byteOffset + checksumPos, 4);
    cv.setUint32(0, crc, true);

    pageSeq.value++;
    payloadOffset = chunkEnd;
  }

  return offset;
}

// ─── ADTS Header Builder ─────────────────────────────────────────────────

/**
 * AAC sample rate index lookup (ISO 14496-3).
 * Maps sample rate → 4-bit index used in the ADTS header.
 */
function getAacSampleRateIndex(sampleRate: number): number {
  switch (sampleRate) {
    case 96000: return 0;   case 88200: return 1;
    case 64000: return 2;   case 48000: return 3;
    case 44100: return 4;   case 32000: return 5;
    case 24000: return 6;   case 22050: return 7;
    case 16000: return 8;   case 12000: return 9;
    case 11025: return 10;  case  8000: return 11;
    default:    return 4; // default to 44100
  }
}

/**
 * Build a 7-byte ADTS header for a single AAC Access Unit.
 * Layout: MPEG-4 AAC-LC, no CRC.
 */
function writeAdtsHeader(buf: Uint8Array, offset: number, packetLen: number, srIdx: number, channels: number): number {
  const frameLen = packetLen + 7;
  buf[offset]     = 0xFF;
  buf[offset + 1] = 0xF1;
  buf[offset + 2] = (1 << 6) | (srIdx << 2) | (channels >> 2);
  buf[offset + 3] = ((channels & 3) << 6) | ((frameLen >> 11) & 0x03);
  buf[offset + 4] = (frameLen >> 3) & 0xFF;
  buf[offset + 5] = ((frameLen & 7) << 5) | 0x1F;
  buf[offset + 6] = 0xFC;
  return offset + 7;
}

// ─── AudioRemuxer Class ─────────────────────────────────────────────────

/**
 * Pre-allocated audio packet remuxer.
 *
 * Lifecycle:
 *   1. constructor() — detects codec, writes OGG init pages if needed
 *   2. feedPacket()  — frames each raw packet, returns a view to copy/transfer
 *   3. finalize()    — writes OGG EOS page if needed
 *   4. buildManifest() — returns pre-built JSON manifest string
 */
export class AudioRemuxer {
  private readonly codec: AudioCodec;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly serialNumber: number;

  // AAC-specific
  private readonly aacSrIdx: number;

  // Pre-allocated output buffer (1MB default, grown if needed)
  private buffer: Uint8Array;
  private offset: number;

  // OGG muxer state
  private oggPageSeq: { value: number };
  private lastGranulePos: bigint;

  // Manifest state (null = disabled, zero cost)
  private readonly byteIndex: number[] | null;
  private bytesWritten: number;
  private lastIndexedSec: number;
  private readonly initSegments: string[];

  constructor(
    codecId: number,
    sampleRate: number,
    channels: number,
    extradata: Uint8Array | null,
    options: AudioRemuxerOptions,
  ) {
    // Resolve codec from FFmpeg codec ID
    switch (codecId) {
      case AV_CODEC_ID_AAC:    this.codec = AudioCodec.Aac; break;
      case AV_CODEC_ID_MP3:    this.codec = AudioCodec.Mp3; break;
      case AV_CODEC_ID_OPUS:   this.codec = AudioCodec.Opus; break;
      case AV_CODEC_ID_VORBIS: this.codec = AudioCodec.Vorbis; break;
      default:
        throw new Error(
          `Unsupported audio codec_id: ${codecId}. ` +
          `Supported: AAC (86018), MP3 (86017), Opus (86076), Vorbis (86021).`
        );
    }

    this.sampleRate = sampleRate;
    this.channels = channels;
    this.serialNumber = options.serialNumber ?? 1;
    this.aacSrIdx = getAacSampleRateIndex(sampleRate);

    // Pre-allocate output buffer (1MB)
    this.buffer = new Uint8Array(1024 * 1024);
    this.offset = 0;

    // OGG state
    this.oggPageSeq = { value: 0 };
    this.lastGranulePos = 0n;

    // Manifest state
    this.initSegments = [];
    this.bytesWritten = 0;
    this.lastIndexedSec = 0;

    if (options.buildManifest) {
      const cap = options.duration > 0 ? Math.ceil(options.duration) + 1 : 64;
      this.byteIndex = new Array(cap).fill(0);
    } else {
      this.byteIndex = null;
    }

    // Write OGG init pages for Opus/Vorbis
    if (this.codec === AudioCodec.Opus && extradata && extradata.length > 0) {
      this._writeOpusInitPages(extradata);
    } else if (this.codec === AudioCodec.Vorbis && extradata && extradata.length > 0) {
      this._writeVorbisInitPages(extradata);
    }

    // Record init page bytes
    this.bytesWritten = this.offset;
  }

  // ── OGG Init Pages ────────────────────────────────────────────────────

  private _writeOpusInitPages(extradata: Uint8Array): void {
    // Page 0: OpusHead (BOS)
    this.offset = writeOggPage(
      this.buffer, this.offset,
      extradata, 0n,
      this.serialNumber, this.oggPageSeq, true, false,
    );
    this.initSegments.push(this._base64(extradata));

    // Page 1: OpusTags
    const te = new TextEncoder();
    const vendorStr = te.encode('FastExtractor');
    const tags = new Uint8Array(8 + 4 + vendorStr.length + 4);
    tags.set(te.encode('OpusTags'), 0);
    new DataView(tags.buffer).setUint32(8, vendorStr.length, true);
    tags.set(vendorStr, 12);
    new DataView(tags.buffer).setUint32(12 + vendorStr.length, 0, true); // 0 comments

    this.offset = writeOggPage(
      this.buffer, this.offset,
      tags, 0n,
      this.serialNumber, this.oggPageSeq, false, false,
    );
    this.initSegments.push(this._base64(tags));
  }

  private _writeVorbisInitPages(extradata: Uint8Array): void {
    // Vorbis extradata uses Xiph lacing: [0x02, len1_laced, len2_laced, h1, h2, h3]
    if (extradata.length === 0 || extradata[0] !== 2) return;

    let pos = 1;

    // Read len1 (Xiph lacing)
    let len1 = 0;
    while (pos < extradata.length) {
      const b = extradata[pos++];
      len1 += b;
      if (b < 255) break;
    }

    // Read len2 (Xiph lacing)
    let len2 = 0;
    while (pos < extradata.length) {
      const b = extradata[pos++];
      len2 += b;
      if (b < 255) break;
    }

    if (pos + len1 + len2 > extradata.length) return;

    const h1 = extradata.subarray(pos, pos + len1);
    const h2 = extradata.subarray(pos + len1, pos + len1 + len2);
    const h3 = extradata.subarray(pos + len1 + len2);

    // Page 0: Identification header (BOS)
    this.offset = writeOggPage(
      this.buffer, this.offset, h1, 0n,
      this.serialNumber, this.oggPageSeq, true, false,
    );
    this.initSegments.push(this._base64(h1));

    // Page 1: Comment header
    this.offset = writeOggPage(
      this.buffer, this.offset, h2, 0n,
      this.serialNumber, this.oggPageSeq, false, false,
    );
    this.initSegments.push(this._base64(h2));

    // Page 2: Setup header
    this.offset = writeOggPage(
      this.buffer, this.offset, h3, 0n,
      this.serialNumber, this.oggPageSeq, false, false,
    );
    this.initSegments.push(this._base64(h3));
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Feed a raw audio packet from the FFmpeg demuxer.
   *
   * Packets are accumulated into the internal buffer. Call `drain()` when
   * `bufferedBytes` exceeds your desired chunk size (e.g. 1MB) to retrieve
   * the accumulated data. This matches the Rust `pull_chunk(max_bytes)`
   * pattern and minimizes cross-thread postMessage overhead.
   *
   * @param data  — Raw codec packet bytes (from DemuxerPacket.data)
   * @param ptsUs — Presentation timestamp in microseconds
   */
  feedPacket(data: Uint8Array, ptsUs: number): void {
    // Ensure buffer is large enough for this packet + framing overhead.
    // OGG overhead per page: 27 (header) + 255 (segment table) = 282 bytes.
    // Large packets (>65025 bytes) span multiple continuation pages.
    const oggPages = Math.max(1, Math.ceil(data.length / 65025));
    const overhead = this.codec === AudioCodec.Aac ? 7
      : this.codec === AudioCodec.Mp3 ? 0
      : oggPages * 282;
    const maxFramedSize = this.offset + data.length + overhead;
    if (maxFramedSize > this.buffer.length) {
      const newBuf = new Uint8Array(Math.max(maxFramedSize * 2, this.buffer.length * 2));
      newBuf.set(this.buffer.subarray(0, this.offset));
      this.buffer = newBuf;
    }

    const framedStart = this.offset;

    switch (this.codec) {
      case AudioCodec.Aac:
        this.offset = writeAdtsHeader(this.buffer, this.offset, data.length, this.aacSrIdx, this.channels);
        this.buffer.set(data, this.offset);
        this.offset += data.length;
        break;

      case AudioCodec.Mp3:
        // MP3 frames are self-framing (sync word 0xFFE/0xFFF). Direct passthrough.
        this.buffer.set(data, this.offset);
        this.offset += data.length;
        break;

      case AudioCodec.Opus:
      case AudioCodec.Vorbis: {
        // Calculate granule_pos in PCM samples.
        // Opus: always 48000 Hz regardless of container sample rate.
        // Vorbis: uses the original track sample rate.
        const targetSr = this.codec === AudioCodec.Opus ? 48000 : this.sampleRate;
        const pcmSamples = BigInt(Math.round((ptsUs / 1_000_000) * targetSr));
        this.lastGranulePos = pcmSamples;

        this.offset = writeOggPage(
          this.buffer, this.offset,
          data, pcmSamples,
          this.serialNumber, this.oggPageSeq, false, false,
        );
        break;
      }
    }

    // Update manifest byte index
    const framedSize = this.offset - framedStart;
    if (this.byteIndex !== null) {
      const currentSec = Math.floor(ptsUs / 1_000_000);
      while (this.lastIndexedSec < currentSec) {
        this.lastIndexedSec++;
        if (this.lastIndexedSec >= this.byteIndex.length) {
          this.byteIndex.push(this.bytesWritten);
        } else {
          this.byteIndex[this.lastIndexedSec] = this.bytesWritten;
        }
      }
    }
    this.bytesWritten += framedSize;
  }

  /**
   * Number of bytes currently buffered (accumulated via feedPacket).
   * Use this to decide when to call drain() — e.g. when >= 1MB.
   */
  get bufferedBytes(): number {
    return this.offset;
  }

  /**
   * Drain the accumulated buffer and return the data.
   *
   * Returns a **copy** of the accumulated data as a new Uint8Array whose
   * underlying ArrayBuffer can be safely transferred via postMessage.
   * The internal buffer is reset to 0 for the next batch of packets.
   *
   * For Opus/Vorbis, the first drain() includes the OGG init pages
   * (OpusHead/OpusTags or Vorbis headers) prepended before the packet data.
   */
  drain(): Uint8Array {
    if (this.offset === 0) return new Uint8Array(0);
    // slice() creates a copy with its own ArrayBuffer — safe to transfer
    const result = this.buffer.slice(0, this.offset);
    this.offset = 0;
    return result;
  }

  /**
   * Finalize the audio stream.
   * For Opus/Vorbis, writes the EOS (End-of-Stream) OGG page.
   * For AAC/MP3, returns an empty view (no finalization needed).
   */
  finalize(): Uint8Array {
    this.offset = 0;

    if (this.codec === AudioCodec.Opus || this.codec === AudioCodec.Vorbis) {
      // Write empty EOS page with the final granule position
      const emptyPayload = new Uint8Array(0);
      this.offset = writeOggPage(
        this.buffer, this.offset,
        emptyPayload, this.lastGranulePos,
        this.serialNumber, this.oggPageSeq, false, true,
      );
      this.bytesWritten += this.offset;
    }

    // Return a copy (safe to transfer via postMessage without neutering our buffer)
    const result = this.buffer.slice(0, this.offset);
    this.offset = 0;
    return result;
  }

  /** File extension for the output audio file */
  get extension(): string {
    switch (this.codec) {
      case AudioCodec.Aac: return 'aac';
      case AudioCodec.Mp3: return 'mp3';
      case AudioCodec.Opus:
      case AudioCodec.Vorbis: return 'ogg';
    }
  }

  /** MIME type for the output audio */
  get mime(): string {
    switch (this.codec) {
      case AudioCodec.Aac: return 'audio/aac';
      case AudioCodec.Mp3: return 'audio/mpeg';
      case AudioCodec.Opus: return 'audio/ogg; codecs=opus';
      case AudioCodec.Vorbis: return 'audio/ogg; codecs=vorbis';
    }
  }

  /**
   * Build the manifest as a JSON object.
   * Returns null if manifest building was disabled.
   *
   * The manifest contains:
   *   - Codec metadata (codec, extension, mime, sample_rate, channels)
   *   - Per-second byte offset index (for seeking in custom players)
   *   - Base64-encoded init segments (OGG header pages for Opus/Vorbis)
   */
  buildManifest(): AudioManifest | null {
    if (this.byteIndex === null) return null;

    const preRollMs = this.codec === AudioCodec.Aac ? 48
      : this.codec === AudioCodec.Mp3 ? 300
      : this.codec === AudioCodec.Opus ? 80
      : 50; // Vorbis

    const codecStr = this.codec === AudioCodec.Aac ? 'aac'
      : this.codec === AudioCodec.Mp3 ? 'mp3'
      : this.codec === AudioCodec.Opus ? 'opus'
      : 'vorbis';

    return {
      codec: codecStr,
      extension: '.' + this.extension,
      mime: this.mime,
      sample_rate: this.sampleRate,
      channels: this.channels,
      duration_sec: Math.max(0, this.byteIndex.length - 1),
      total_bytes: this.bytesWritten,
      pre_roll_ms: preRollMs,
      init_segments: this.initSegments,
      byte_index: this.byteIndex,
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  /** Base64 encode a Uint8Array using the native btoa() available in Workers */
  private _base64(data: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }
}
