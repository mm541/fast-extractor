/**
 * ============================================================================
 * FFmpeg WASM Demuxer — Zero-Copy TypeScript API
 * ============================================================================
 *
 * TypeScript API for the FFmpeg 8.1 WASM demuxer.
 * Designed for high-performance media pipelines: video editors, slide
 * extractors, audio processors, or anything that needs raw demuxed packets.
 *
 * ARCHITECTURE:
 *   - ALL packet data is exposed as Uint8Array VIEWS into WASM linear memory.
 *     Zero intermediate JS copies. The only copy happens when you hand the
 *     view to WebCodecs (unavoidable, inside Chrome's C++).
 *   - File I/O uses pluggable readers. OPFS SyncAccessHandle gives true
 *     synchronous zero-copy reads directly into the WASM heap.
 *   - Memory lifecycle is explicit: call packet.free() when done, and
 *     demuxer.destroy() at the end. No GC surprises.
 *
 * USAGE:
 *   import { FFmpegDemuxer } from './index';
 *
 *   const demuxer = await FFmpegDemuxer.create(createDemuxerModule);
 *   await demuxer.open(syncAccessHandle, fileSize);
 *
 *   const videoConfig = demuxer.getVideoDecoderConfig();
 *   const audioInfo   = demuxer.getAudioStreamInfo();
 *
 *   let pkt;
 *   while ((pkt = demuxer.readPacket()) !== null) {
 *     if (pkt.streamIndex === demuxer.videoStreamIndex) {
 *       decoder.decode(new EncodedVideoChunk({
 *         type: pkt.isKeyframe ? 'key' : 'delta',
 *         timestamp: pkt.ptsUs,
 *         data: pkt.data,  // zero-copy view
 *       }));
 *     }
 *     pkt.free();
 *   }
 *
 *   demuxer.destroy();
 *
 * License: MIT
 */


// ─── Ambient Type Declarations ───────────────────────────────────────────────
// FileSystemSyncAccessHandle is a Worker-only API not present in all TS lib
// configurations. We declare the minimal subset we use so consumers don't
// need to add WebWorker to their tsconfig.

/** @see https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle */
declare interface FileSystemSyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  write(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}

import { buildVideoDecoderConfig, type FFmpegStreamInfo, type CodecBuildResult } from './codec-config-builder';

// ─── Emscripten Module Interface ─────────────────────────────────────────────
// Typed subset of the Emscripten Module we actually use.
// This avoids depending on @types/emscripten.

export interface EmscriptenModule {
  wasmMemory: WebAssembly.Memory;
  ccall: (ident: string, returnType: string, argTypes: string[], args: any[]) => any;
  addFunction: (fn: Function, sig: string) => number;
  removeFunction: (ptr: number) => void;
  UTF8ToString: (ptr: number) => string;
}

export type ModuleFactory = (opts?: Record<string, any>) => Promise<EmscriptenModule>;

// ─── C Struct Offsets ────────────────────────────────────────────────────────
// These MUST match the C struct layouts in demuxer.c exactly.
// All offsets are in bytes from the struct base pointer.
//
// StreamInfo (all int32):
//   [0]  stream_index    [4]  extradata (ptr)   [8]  extradata_size
//   [12] codec_id        [16] time_base_num     [20] time_base_den
//   [24] sample_rate     [28] channels          [32] width
//   [36] height          [40] bit_rate          [44] codec_type
//
// DemuxerPacketC:
//   [0]  data (ptr, 4B)  [4]  size (i32, 4B)
//   [8]  pts (i64, 8B)   [16] dts (i64, 8B)
//   [24] duration (i64, 8B)
//   [32] is_keyframe     [36] stream_index
//   [40] _raw_pkt (ptr)

const STREAM_INFO = {
  stream_index:   0,
  extradata:      4,
  extradata_size: 8,
  codec_id:       12,
  time_base_num:  16,
  time_base_den:  20,
  sample_rate:    24,
  channels:       28,
  width:          32,
  height:         36,
  bit_rate:       40,
  codec_type:     44,
  rotation_f64_idx: 6, // 48 / 8 = 6
  display_matrix_idx: 14, // 56 / 4 = 14
} as const;

const PACKET = {
  data:           0,
  size:           4,
  // pts, dts, duration are i64, read via BigInt64Array at byte offset / 8
  pts_i64_idx:      1,  // byte offset 8 / 8
  dts_i64_idx:      2,  // byte offset 16 / 8
  duration_i64_idx: 3,  // byte offset 24 / 8
  is_keyframe:      32, // shifted by duration
  stream_index:     36,
} as const;

const AVSEEK_SIZE = 0x10000;

// ─── Public Types ────────────────────────────────────────────────────────────

/** Raw stream metadata extracted from FFmpeg's AVCodecParameters */
export interface StreamInfo {
  readonly streamIndex: number;
  readonly codecId: number;
  readonly codecType: 'video' | 'audio' | 'data' | 'subtitle' | 'unknown';
  readonly timeBaseNum: number;
  readonly timeBaseDen: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly width: number;
  readonly height: number;
  readonly bitRateKbps: number;
  /** Video display rotation in degrees (0, 90, 180, 270) */
  readonly rotation: number;
  /** Raw 3x3 transformation matrix extracted from the stream side data */
  readonly displayMatrix: Int32Array | null;
  /** Raw extradata bytes (COPIED from WASM — safe to hold indefinitely) */
  readonly extradata: Uint8Array | null;
}

/**
 * A demuxed packet. The `data` field is a ZERO-COPY view into WASM memory.
 *
 * ⚠️ CRITICAL: You MUST call `free()` when done with the packet.
 *    After `free()`, the `data` view is INVALIDATED — do not access it.
 *    If you need to hold the data beyond `free()`, copy it first:
 *      const copy = new Uint8Array(packet.data);
 */
export interface DemuxerPacket {
  /** Zero-copy Uint8Array view into WASM linear memory */
  readonly data: Uint8Array;
  /** Packet size in bytes */
  readonly size: number;
  /** Presentation timestamp in stream timebase units */
  readonly pts: bigint;
  /** Decode timestamp in stream timebase units */
  readonly dts: bigint;
  /** Frame duration in stream timebase units */
  readonly duration: bigint;
  /** PTS converted to microseconds (for WebCodecs EncodedVideoChunk) */
  readonly ptsUs: number;
  /** Duration converted to microseconds */
  readonly durationUs: number;
  /** Whether this packet is a keyframe */
  readonly isKeyframe: boolean;
  /** Stream index this packet belongs to */
  readonly streamIndex: number;
  /** Release the underlying AVPacket memory. MUST be called. */
  free(): void;
}

/**
 * I/O source abstraction. Implement this to feed data to the demuxer.
 * For OPFS SyncAccessHandle, use the built-in `createSyncHandleSource()`.
 */
export interface IOSource {
  /** Total file size in bytes */
  readonly size: number;
  /** Read up to `length` bytes at the given byte offset into `target`.
   *  `target` is a view into WASM memory — write directly into it.
   *  Returns the number of bytes actually read, or -1 on error. */
  read(target: Uint8Array, offset: number, length: number): number;
}

// ─── I/O Source Factories ────────────────────────────────────────────────────

/**
 * Create an IOSource from an OPFS FileSystemSyncAccessHandle.
 * This is the fastest possible path: OPFS reads directly into the WASM heap.
 * Must be called from a Web Worker (SyncAccessHandle is Worker-only).
 */
export function createSyncHandleSource(handle: FileSystemSyncAccessHandle, fileSize: number): IOSource {
  return {
    size: fileSize,
    read(target: Uint8Array, offset: number, _length: number): number {
      // SyncAccessHandle.read() accepts a BufferSource and an options object.
      // We pass the WASM memory view directly — OPFS writes into it. Zero copies.
      const bytesRead = handle.read(target, { at: offset });
      return bytesRead === 0 ? -1 : bytesRead;
    },
  };
}

/**
 * Create an IOSource from a File or Blob.
 * Uses synchronous reads via a pre-loaded ArrayBuffer.
 * Suitable for small files or when OPFS is unavailable.
 *
 * ⚠️ This loads the ENTIRE file into memory. For large files, use OPFS.
 */
export function createBlobSource(buffer: ArrayBuffer): IOSource {
  const bytes = new Uint8Array(buffer);
  return {
    size: buffer.byteLength,
    read(target: Uint8Array, offset: number, length: number): number {
      const end = Math.min(offset + length, bytes.length);
      const slice = bytes.subarray(offset, end);
      if (slice.length === 0) return -1;
      target.set(slice);
      return slice.length;
    },
  };
}

// ─── FFmpegDemuxer ───────────────────────────────────────────────────────────

export class FFmpegDemuxer {
  private Module: EmscriptenModule;
  private demuxerPtr: number = 0;
  private readFnPtr: number = 0;
  private seekFnPtr: number = 0;
  private ioOffset: number = 0;
  private ioSource: IOSource | null = null;
  private _destroyed = false;
  private _debugRef: { enabled: boolean } = { enabled: false };

  // Cached stream metadata (populated after open())
  private _videoStreamIndex = -1;
  private _audioStreamIndex = -1;
  private _videoInfo: StreamInfo | null = null;
  private _audioInfo: StreamInfo | null = null;
  private _duration = 0;
  private _streamCount = 0;

  private constructor(Module: EmscriptenModule) {
    this.Module = Module;
  }

  /**
   * Create a new FFmpegDemuxer instance.
   * Loads the Emscripten WASM module via the provided factory function.
   *
   * @param factory - The `createDemuxerModule` function from ffmpeg_demuxer.js
   */
  static async create(factory: ModuleFactory): Promise<FFmpegDemuxer> {
    const debugRef = { enabled: false };
    const Module = await factory({
      print: () => {},
      printErr: (...args: any[]) => {
        if (debugRef.enabled) console.warn('[FFmpeg]', ...args);
      },
    });
    const demuxer = new FFmpegDemuxer(Module);
    demuxer._debugRef = debugRef;
    return demuxer;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Open a media file for demuxing.
   *
   * @param source - An IOSource (use createSyncHandleSource or createBlobSource)
   * @param options - Configuration options (e.g. custom AVIO buffer size)
   * @throws Error if FFmpeg cannot parse the container
   */
  open(source: IOSource, options?: { bufferSize?: number; debug?: boolean }): void {
    if (this._destroyed) throw new Error('Demuxer has been destroyed');
    if (this.demuxerPtr) throw new Error('Demuxer is already open. Call destroy() first.');

    this.ioSource = source;
    this.ioOffset = 0;

    const M = this.Module;

    // Register JS read callback → Emscripten function table
    const readCb = (bufPtr: number, bufSize: number): number => {
      if (!this.ioSource) return -1;
      const view = new Uint8Array(M.wasmMemory.buffer, bufPtr, bufSize);
      const bytesRead = this.ioSource.read(view, this.ioOffset, bufSize);
      if (bytesRead > 0) this.ioOffset += bytesRead;
      return bytesRead;
    };

    // Register JS seek callback → Emscripten function table
    const seekCb = (offset: bigint, whence: number): bigint => {
      if (!this.ioSource) return -1n;
      let newPos: number;

      if (whence === AVSEEK_SIZE) {
        newPos = this.ioSource.size;
      } else {
        const offsetNum = Number(offset);
        switch (whence) {
          case 0: newPos = offsetNum; break;                        // SEEK_SET
          case 1: newPos = this.ioOffset + offsetNum; break;        // SEEK_CUR
          case 2: newPos = this.ioSource.size + offsetNum; break;   // SEEK_END
          default: return -1n;
        }
        this.ioOffset = newPos;
      }

      return BigInt(newPos);
    };

    this.readFnPtr = M.addFunction(readCb, 'iii');
    this.seekFnPtr = M.addFunction(seekCb, 'jji');

    const bufferSize = options?.bufferSize ?? (1024 * 1024); // 1MB default
    const debugMode = options?.debug ? 1 : 0;
    this._debugRef.enabled = !!options?.debug;

    // Instantiate the C demuxer
    this.demuxerPtr = M.ccall(
      'wasm_demuxer_new', 'number',
      ['number', 'number', 'number', 'number'],
      [this.readFnPtr, this.seekFnPtr, bufferSize, debugMode]
    );
    if (this.demuxerPtr === 0) {
      this._cleanupCallbacks();
      throw new Error('Failed to allocate FFmpeg demuxer');
    }

    // Open the container (probe format, find streams)
    const ret = M.ccall('wasm_demuxer_init', 'number', ['number'], [this.demuxerPtr]);
    if (ret < 0) {
      const err = this._getLastError();
      this.destroy();
      throw new Error(`FFmpeg failed to open file: ${err} (code ${ret})`);
    }

    // Cache container metadata
    this._duration = M.ccall('wasm_demuxer_get_duration', 'number', ['number'], [this.demuxerPtr]);
    this._streamCount = M.ccall('wasm_demuxer_get_stream_count', 'number', ['number'], [this.demuxerPtr]);

    // Discover streams
    this._discoverStreams();
  }

  /**
   * Release all WASM memory and unregister callbacks.
   * After calling this, the demuxer instance is permanently dead.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this.demuxerPtr) {
      this.Module.ccall('wasm_demuxer_free', 'void', ['number'], [this.demuxerPtr]);
      this.demuxerPtr = 0;
    }
    this._cleanupCallbacks();
    this.ioSource = null;
    this._videoInfo = null;
    this._audioInfo = null;
  }

  // ── Metadata ─────────────────────────────────────────────────────────────

  /** Total duration in seconds. -1 if unknown. */
  get duration(): number { return this._duration; }

  /** Number of streams in the container */
  get streamCount(): number { return this._streamCount; }

  /** Index of the best video stream (-1 if none) */
  get videoStreamIndex(): number { return this._videoStreamIndex; }

  /** Index of the best audio stream (-1 if none) */
  get audioStreamIndex(): number { return this._audioStreamIndex; }

  /**
   * Get video stream metadata.
   * Returns null if no video stream exists.
   */
  getVideoStreamInfo(): StreamInfo | null {
    return this._videoInfo;
  }

  /**
   * Get audio stream metadata.
   * Exposes codecId, sampleRate, channels, and raw extradata —
   * everything needed to build ADTS headers or Ogg pages in TypeScript.
   * Returns null if no audio stream exists.
   */
  getAudioStreamInfo(): StreamInfo | null {
    return this._audioInfo;
  }

  /**
   * Get metadata for any stream by index.
   * Useful for subtitle or data streams.
   */
  getStreamInfo(index: number): StreamInfo | null {
    this._assertOpen();
    const ptr = this.Module.ccall(
      'wasm_demuxer_get_stream_info', 'number',
      ['number', 'number'],
      [this.demuxerPtr, index]
    );
    if (ptr === 0) return null;
    const info = this._readStreamInfo(ptr);
    this.Module.ccall('wasm_demuxer_free_stream_info', 'void', ['number'], [ptr]);
    return info;
  }

  /**
   * Build a WebCodecs VideoDecoderConfig from the video stream.
   * Uses the codec-config-builder to parse extradata into the
   * correct codec string (avc1.*, hev1.*, vp09.*, av01.*, vp8).
   *
   * Returns null if no video stream exists.
   */
  getVideoDecoderConfig(): CodecBuildResult | null {
    if (!this._videoInfo) return null;
    const info: FFmpegStreamInfo = {
      codecId: this._videoInfo.codecId,
      width: this._videoInfo.width,
      height: this._videoInfo.height,
      extradata: this._videoInfo.extradata,
    };
    return buildVideoDecoderConfig(info);
  }

  // ── Packet Reading ───────────────────────────────────────────────────────

  /**
   * Read the next demuxed packet.
   *
   * Returns a DemuxerPacket with a ZERO-COPY data view into WASM memory,
   * or null on EOF.
   *
   * ⚠️ You MUST call packet.free() when done. Failure to do so will leak
   *    the underlying AVPacket memory.
   *
   * ⚠️ The packet.data view is INVALIDATED after free(). If you need to
   *    hold the data, copy it: `new Uint8Array(packet.data)`
   *
   * @throws Error on read failure (not EOF)
   */
  readPacket(): DemuxerPacket | null {
    this._assertOpen();

    const pktPtr = this.Module.ccall(
      'wasm_demuxer_read_c_packet', 'number',
      ['number'],
      [this.demuxerPtr]
    );

    if (pktPtr === 0) {
      // Check if it's a real error or just EOF
      const err = this._getLastError();
      if (err) throw new Error(`Demuxer read error: ${err}`);
      return null; // EOF
    }

    return this._wrapPacket(pktPtr);
  }

  // ── Seeking ──────────────────────────────────────────────────────────────

  /**
   * Seek to the nearest keyframe at or before the given timestamp.
   *
   * @param streamIndex - Stream to seek on (use videoStreamIndex or audioStreamIndex)
   * @param timestampInTimebase - Target timestamp in the stream's timebase units
   * @throws Error if seek fails
   */
  seek(streamIndex: number, timestampInTimebase: number): void {
    this._assertOpen();
    const ret = this.Module.ccall(
      'wasm_demuxer_seek', 'number',
      ['number', 'number', 'number'],
      [this.demuxerPtr, streamIndex, BigInt(timestampInTimebase)]
    );
    if (ret < 0) {
      const err = this._getLastError();
      throw new Error(`Seek failed: ${err || 'unknown error'} (code ${ret})`);
    }
  }

  /**
   * Seek to a specific time in seconds on the video stream.
   * Convenience wrapper that handles timebase conversion.
   */
  seekToTime(seconds: number): void {
    if (this._videoStreamIndex < 0) throw new Error('No video stream');
    const info = this._videoInfo!;
    const ts = Math.floor(seconds * info.timeBaseDen / info.timeBaseNum);
    this.seek(this._videoStreamIndex, ts);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _assertOpen(): void {
    if (this._destroyed) throw new Error('Demuxer has been destroyed');
    if (!this.demuxerPtr) throw new Error('Demuxer is not open. Call open() first.');
  }

  private _getLastError(): string {
    if (!this.demuxerPtr) return '';
    const ptr = this.Module.ccall(
      'wasm_demuxer_get_last_error', 'number',
      ['number'],
      [this.demuxerPtr]
    );
    return ptr ? this.Module.UTF8ToString(ptr) : '';
  }

  private _cleanupCallbacks(): void {
    if (this.readFnPtr) {
      this.Module.removeFunction(this.readFnPtr);
      this.readFnPtr = 0;
    }
    if (this.seekFnPtr) {
      this.Module.removeFunction(this.seekFnPtr);
      this.seekFnPtr = 0;
    }
  }

  /**
   * Discover video and audio streams and cache their metadata.
   * Called once after open_demuxer succeeds.
   */
  private _discoverStreams(): void {
    const M = this.Module;

    // Video
    const vPtr = M.ccall('wasm_demuxer_get_video_info', 'number', ['number'], [this.demuxerPtr]);
    if (vPtr !== 0) {
      this._videoInfo = this._readStreamInfo(vPtr);
      this._videoStreamIndex = this._videoInfo.streamIndex;
      M.ccall('wasm_demuxer_free_stream_info', 'void', ['number'], [vPtr]);
    }

    // Audio
    const aPtr = M.ccall('wasm_demuxer_get_audio_info', 'number', ['number'], [this.demuxerPtr]);
    if (aPtr !== 0) {
      this._audioInfo = this._readStreamInfo(aPtr);
      this._audioStreamIndex = this._audioInfo.streamIndex;
      M.ccall('wasm_demuxer_free_stream_info', 'void', ['number'], [aPtr]);
    }
  }

  /**
   * Read a StreamInfo C struct from WASM memory.
   * Extradata is COPIED out because the struct is freed immediately after.
   */
  private _readStreamInfo(ptr: number): StreamInfo {
    const h = new Int32Array(this.Module.wasmMemory.buffer);
    const base = ptr / 4;

    const streamIndex   = h[base + STREAM_INFO.stream_index / 4];
    const extradataPtr  = h[base + STREAM_INFO.extradata / 4];
    const extradataSize = h[base + STREAM_INFO.extradata_size / 4];
    const codecId       = h[base + STREAM_INFO.codec_id / 4];
    const timeBaseNum   = h[base + STREAM_INFO.time_base_num / 4];
    const timeBaseDen   = h[base + STREAM_INFO.time_base_den / 4];
    const sampleRate    = h[base + STREAM_INFO.sample_rate / 4];
    const channels      = h[base + STREAM_INFO.channels / 4];
    const width         = h[base + STREAM_INFO.width / 4];
    const height        = h[base + STREAM_INFO.height / 4];
    const bitRate       = h[base + STREAM_INFO.bit_rate / 4];
    const codecTypeRaw  = h[base + STREAM_INFO.codec_type / 4];

    const f64 = new Float64Array(this.Module.wasmMemory.buffer);
    const rotation = f64[(ptr / 8) + STREAM_INFO.rotation_f64_idx];

    // Copy extradata out of WASM — this pointer becomes invalid after free_stream_info.
    // NOTE: This extradata points into AVStream->codecpar->extradata, which is owned
    // by FFmpeg's format context and lives for the demuxer's lifetime. However, the
    // StreamInfo wrapper struct is freed immediately, so we copy to be safe.
    let extradata: Uint8Array | null = null;
    if (extradataPtr !== 0 && extradataSize > 0) {
      const src = new Uint8Array(this.Module.wasmMemory.buffer, extradataPtr, extradataSize);
      extradata = new Uint8Array(src); // Copy
    }

    // Extract the 3x3 display matrix
    const matrixStart = base + STREAM_INFO.display_matrix_idx;
    const displayMatrixRaw = h.slice(matrixStart, matrixStart + 9);
    // If it's all zeros, the matrix is empty/unset, so return null.
    const isMatrixEmpty = displayMatrixRaw.every(val => val === 0);
    const displayMatrix = isMatrixEmpty ? null : displayMatrixRaw;

    const CODEC_TYPE_MAP: Record<number, StreamInfo['codecType']> = {
      0: 'video', 1: 'audio', 2: 'data', 3: 'subtitle',
    };

    return {
      streamIndex,
      codecId,
      codecType: CODEC_TYPE_MAP[codecTypeRaw] ?? 'unknown',
      timeBaseNum,
      timeBaseDen,
      sampleRate,
      channels,
      width,
      height,
      bitRateKbps: bitRate,
      rotation,
      displayMatrix,
      extradata,
    };
  }

  /**
   * Wrap a raw DemuxerPacketC pointer into a typed DemuxerPacket.
   * The `data` field is a ZERO-COPY view — no bytes are copied.
   */
  private _wrapPacket(pktPtr: number): DemuxerPacket {
    const M = this.Module;
    const h32 = new Int32Array(M.wasmMemory.buffer);
    const h64 = new BigInt64Array(M.wasmMemory.buffer);

    const base32 = pktPtr / 4;
    const base64 = pktPtr / 8;

    const dataPtr     = h32[base32 + PACKET.data / 4];
    const size        = h32[base32 + PACKET.size / 4];
    const pts         = h64[base64 + PACKET.pts_i64_idx];
    const dts         = h64[base64 + PACKET.dts_i64_idx];
    const duration    = h64[base64 + PACKET.duration_i64_idx];
    const isKeyframe  = h32[base32 + PACKET.is_keyframe / 4] !== 0;
    const streamIndex = h32[base32 + PACKET.stream_index / 4];

    // Zero-copy view into WASM linear memory
    const data = new Uint8Array(M.wasmMemory.buffer, dataPtr, size);

    // Compute PTS and duration in microseconds for WebCodecs compatibility.
    // We need the stream's timebase for this. Look up from cached info.
    let ptsUs: number;
    let durationUs: number;
    if (streamIndex === this._videoStreamIndex && this._videoInfo) {
      const tb = this._videoInfo.timeBaseNum / this._videoInfo.timeBaseDen * 1e6;
      ptsUs = Number(pts) * tb;
      durationUs = Number(duration) * tb;
    } else if (streamIndex === this._audioStreamIndex && this._audioInfo) {
      const tb = this._audioInfo.timeBaseNum / this._audioInfo.timeBaseDen * 1e6;
      ptsUs = Number(pts) * tb;
      durationUs = Number(duration) * tb;
    } else {
      ptsUs = Number(pts); // fallback: raw value
      durationUs = Number(duration);
    }

    let freed = false;

    return {
      data,
      size,
      pts,
      dts,
      duration,
      ptsUs,
      durationUs,
      isKeyframe,
      streamIndex,
      free() {
        if (freed) return;
        freed = true;
        M.ccall('wasm_demuxer_free_c_packet', 'void', ['number'], [pktPtr]);
      },
    };
  }
}
