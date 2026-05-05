/**
 * ============================================================================
 * codec-config-builder.ts — FFmpeg → WebCodecs Config Builder
 * ============================================================================
 *
 * Standalone, zero-dependency utility that converts raw FFmpeg stream metadata
 * (codec_id + extradata) into a fully-formed WebCodecs `VideoDecoderConfig`.
 *
 * Supports: H.264 (AVC), H.265 (HEVC), VP8, VP9, AV1
 *
 * Usage:
 *   import { buildVideoDecoderConfig } from './codec-config-builder';
 *
 *   const config = buildVideoDecoderConfig({
 *     codecId: 27,           // FFmpeg AV_CODEC_ID_H264
 *     width: 1920,
 *     height: 1080,
 *     extradata: uint8Array, // Raw AVCDecoderConfigurationRecord
 *   });
 *
 *   // Validate before use:
 *   const { supported } = await VideoDecoder.isConfigSupported(config);
 *
 * References:
 *   - ISO/IEC 14496-15 (AVC/HEVC decoder configuration records)
 *   - WebM VP9 Codec String: https://www.webmproject.org/vp9/mp4/
 *   - AV1 ISOBMFF Binding:   https://aomediacodec.github.io/av1-isobmff/
 *   - W3C WebCodecs Registry: https://www.w3.org/TR/webcodecs-codec-registry/
 *
 * License: MIT
 */

// ─── FFmpeg Codec IDs ────────────────────────────────────────────────────────
// These are stable constants from libavcodec/codec_id.h.
// They have not changed across FFmpeg versions and are safe to hardcode.

export const AV_CODEC_ID_H264 = 27;
export const AV_CODEC_ID_HEVC = 35;
export const AV_CODEC_ID_VP8  = 174;
export const AV_CODEC_ID_VP9  = 173;
export const AV_CODEC_ID_AV1  = 225;

// ─── Public Interface ────────────────────────────────────────────────────────

export interface FFmpegStreamInfo {
  /** FFmpeg AV_CODEC_ID_* value from AVCodecParameters.codec_id */
  codecId: number;
  /** Coded video width in pixels */
  width: number;
  /** Coded video height in pixels */
  height: number;
  /** Raw extradata bytes from AVCodecParameters.extradata (may be null for VP8/VP9) */
  extradata: Uint8Array | null;
}

export interface CodecBuildResult {
  /** The constructed VideoDecoderConfig, ready for VideoDecoder.configure() */
  config: VideoDecoderConfig;
  /** Human-readable codec name for logging/UI */
  codecName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a byte to a zero-padded 2-character hex string */
function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** Zero-pad a number to 2 digits */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ─── Per-Codec Builders ──────────────────────────────────────────────────────

/**
 * H.264 (AVC) — codec_id 27
 *
 * Extradata format: AVCDecoderConfigurationRecord (ISO/IEC 14496-15)
 *   Byte [0]: configurationVersion (always 1)
 *   Byte [1]: AVCProfileIndication  (profile_idc)
 *   Byte [2]: profile_compatibility (constraint_set flags)
 *   Byte [3]: AVCLevelIndication    (level_idc)
 *
 * Codec string: avc1.PPCCLL  (profile, constraints, level — all hex)
 * Description:  REQUIRED — the full extradata containing SPS/PPS
 *
 * Common profiles:
 *   66 (0x42) = Baseline    77 (0x4d) = Main
 *   88 (0x58) = Extended   100 (0x64) = High
 */
function buildH264(info: FFmpegStreamInfo): CodecBuildResult {
  const { extradata, width, height } = info;
  if (!extradata || extradata.length < 4) {
    throw new Error(
      'H.264 requires extradata (AVCDecoderConfigurationRecord). ' +
      'Got: ' + (extradata ? `${extradata.length} bytes` : 'null')
    );
  }

  const profile = extradata[1];
  const constraints = extradata[2];
  const level = extradata[3];
  const codec = `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;

  return {
    config: { codec, codedWidth: width, codedHeight: height, description: extradata },
    codecName: `H.264 (${describeH264Profile(profile)}, Level ${(level / 10).toFixed(1)})`,
  };
}

function describeH264Profile(profile: number): string {
  switch (profile) {
    case 66:  return 'Baseline';
    case 77:  return 'Main';
    case 88:  return 'Extended';
    case 100: return 'High';
    case 110: return 'High 10';
    case 122: return 'High 4:2:2';
    case 244: return 'High 4:4:4 Predictive';
    default:  return `Profile ${profile}`;
  }
}

/**
 * HEVC (H.265) — codec_id 35
 *
 * Extradata format: HEVCDecoderConfigurationRecord (ISO/IEC 14496-15)
 *   Byte [0]:     configurationVersion (always 1)
 *   Byte [1]:     [7:6] general_profile_space, [5] general_tier_flag, [4:0] general_profile_idc
 *   Byte [2..5]:  general_profile_compatibility_flags (32 bits, big-endian)
 *   Byte [6..11]: general_constraint_indicator_flags (48 bits)
 *   Byte [12]:    general_level_idc
 *
 * Codec string: hev1.<space><profileIdc>.<compatHex>.<tier><levelIdc>
 * Description:  REQUIRED — the full extradata containing VPS/SPS/PPS
 *
 * Common profiles:
 *   1 = Main    2 = Main 10    3 = Main Still Picture
 */
function buildHEVC(info: FFmpegStreamInfo): CodecBuildResult {
  const { extradata, width, height } = info;
  if (!extradata || extradata.length < 13) {
    throw new Error(
      'HEVC requires extradata (HEVCDecoderConfigurationRecord). ' +
      'Got: ' + (extradata ? `${extradata.length} bytes` : 'null')
    );
  }

  const byte1 = extradata[1];
  const profileSpace = (byte1 >> 6) & 0x3;
  const tierFlag = (byte1 >> 5) & 0x1;
  const profileIdc = byte1 & 0x1F;

  // Profile compatibility flags (32-bit big-endian)
  const compatFlags =
    ((extradata[2] << 24) | (extradata[3] << 16) | (extradata[4] << 8) | extradata[5]) >>> 0;

  const tierChar = tierFlag ? 'H' : 'L';
  const levelIdc = extradata[12];

  // Profile space prefix: '' for 0, 'A' for 1, 'B' for 2, 'C' for 3
  const spacePrefix = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace);

  const codec = `hev1.${spacePrefix}${profileIdc}.${compatFlags.toString(16).toUpperCase()}.${tierChar}${levelIdc}`;

  return {
    config: { codec, codedWidth: width, codedHeight: height, description: extradata },
    codecName: `HEVC (${describeHEVCProfile(profileIdc)}, ${tierChar === 'H' ? 'High' : 'Main'} Tier, Level ${(levelIdc / 30).toFixed(1)})`,
  };
}

function describeHEVCProfile(profileIdc: number): string {
  switch (profileIdc) {
    case 1: return 'Main';
    case 2: return 'Main 10';
    case 3: return 'Main Still Picture';
    default: return `Profile ${profileIdc}`;
  }
}

/**
 * VP8 — codec_id 174
 *
 * VP8 is fully self-describing. The bitstream contains all initialization
 * parameters in each keyframe header.
 *
 * Codec string: 'vp8'
 * Description:  NOT required
 */
function buildVP8(info: FFmpegStreamInfo): CodecBuildResult {
  return {
    config: { codec: 'vp8', codedWidth: info.width, codedHeight: info.height },
    codecName: 'VP8',
  };
}

/**
 * VP9 — codec_id 173
 *
 * VP9 is self-describing. Profile and bit-depth are embedded in the
 * bitstream's uncompressed header. No extradata is needed.
 *
 * Codec string: vp09.PP.LL.DD (profile, level, bit-depth)
 *   - Profile 0: 8-bit 4:2:0 (most common web content)
 *   - Profile 2: 10-bit 4:2:0 (HDR content)
 * Description:  NOT required
 *
 * Note: FFmpeg does not always populate VP9 extradata. We use a safe
 * default of Profile 0, Level 3.1, 8-bit. If the actual stream uses
 * Profile 2 (10-bit HDR), the browser will still decode it correctly —
 * the codec string is a hint, not a strict contract for VP9.
 */
function buildVP9(info: FFmpegStreamInfo): CodecBuildResult {
  // Safe default that covers the vast majority of web VP9 content
  const codec = 'vp09.00.31.08';

  return {
    config: { codec, codedWidth: info.width, codedHeight: info.height },
    codecName: 'VP9',
  };
}

/**
 * AV1 — codec_id 225
 *
 * Extradata format: AV1CodecConfigurationRecord (AV1-ISOBMFF, Section 2.3)
 *   Byte [0]: [7] marker=1, [6:0] version=1
 *   Byte [1]: [7:5] seq_profile, [4:0] seq_level_idx_0
 *   Byte [2]: [7] seq_tier_0, [6] high_bitdepth, [5] twelve_bit, [4] monochrome, ...
 *   Byte [3]: [7:4] chroma_subsampling_x/y/sample_position, ...
 *
 * Codec string: av01.P.LLT.DD (profile, level+tier, bit-depth)
 *   - Profile 0: Main     (YUV 4:2:0, 8/10-bit)
 *   - Profile 1: High     (adds 4:4:4)
 *   - Profile 2: Professional (adds 4:2:2, 12-bit)
 * Description:  NOT required — Sequence Header OBU in the bitstream is self-describing
 *
 * Fallback: If no extradata is available (e.g., MKV without CodecPrivate),
 * we use av01.0.08M.08 (Main, Level 4.0, Main Tier, 8-bit) as a safe default.
 */
function buildAV1(info: FFmpegStreamInfo): CodecBuildResult {
  const { extradata, width, height } = info;
  let codec: string;
  let bitDepth = 8;

  if (extradata && extradata.length >= 4) {
    const seqProfile = (extradata[1] >> 5) & 0x7;
    const seqLevelIdx = extradata[1] & 0x1F;
    const seqTier = (extradata[2] >> 7) & 0x1;
    const highBitDepth = (extradata[2] >> 6) & 0x1;
    const twelveBit = (extradata[2] >> 5) & 0x1;

    bitDepth = twelveBit ? 12 : (highBitDepth ? 10 : 8);
    const tierChar = seqTier ? 'H' : 'M';

    codec = `av01.${seqProfile}.${pad2(seqLevelIdx)}${tierChar}.${pad2(bitDepth)}`;
  } else {
    // Safe fallback for containers that don't provide AV1 extradata
    codec = 'av01.0.08M.08';
  }

  return {
    config: { codec, codedWidth: width, codedHeight: height },
    codecName: `AV1 (${bitDepth}-bit)`,
  };
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Build a WebCodecs `VideoDecoderConfig` from raw FFmpeg stream metadata.
 *
 * This function maps FFmpeg's `AV_CODEC_ID_*` and raw `extradata` bytes
 * into the exact codec string, dimensions, and description that
 * `VideoDecoder.configure()` expects.
 *
 * @throws Error if the codec is unsupported or required extradata is missing.
 *
 * @example
 * ```typescript
 * // From your FFmpeg WASM demuxer's StreamInfoC:
 * const result = buildVideoDecoderConfig({
 *   codecId: 27,           // H.264
 *   width: 3840,
 *   height: 2160,
 *   extradata: extradataBytes,
 * });
 *
 * console.log(result.codecName);   // "H.264 (High, Level 5.1)"
 * console.log(result.config.codec); // "avc1.64003f"
 *
 * // Always validate before configuring:
 * const { supported } = await VideoDecoder.isConfigSupported(result.config);
 * if (!supported) throw new Error('Unsupported');
 *
 * decoder.configure(result.config);
 * ```
 */
export function buildVideoDecoderConfig(info: FFmpegStreamInfo): CodecBuildResult {
  switch (info.codecId) {
    case 27:  return buildH264(info);
    case 35:  return buildHEVC(info);
    case 174: return buildVP8(info);
    case 173: return buildVP9(info);
    case 225: return buildAV1(info);
    default:
      throw new Error(
        `Unsupported FFmpeg codec_id: ${info.codecId}. ` +
        `Supported: H.264 (27), HEVC (35), VP8 (174), VP9 (173), AV1 (225).`
      );
  }
}
