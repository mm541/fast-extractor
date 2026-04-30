/**
 * ============================================================================
 * types.ts — FastExtractor Public Type Definitions
 * ============================================================================
 *
 * All public interfaces and type aliases used by the FastExtractor API.
 * This file contains zero runtime code — it is purely type definitions
 * consumed by TypeScript at compile time.
 */

import type { ExtractorError } from './errors';

// ─── Public Event Types ───

/** Audio chunk streamed from the worker (zero-copy transferred ArrayBuffer) */
export interface AudioChunkEvent {
  type: 'audio';
  /** Raw audio data (codec-specific framing: ADTS for AAC, self-framing for MP3, raw for Opus/Vorbis). */
  chunk: ArrayBuffer;
}

/** Per-second byte-offset manifest for S3 range-query access. */
export interface AudioManifest {
  /** Detected codec: "aac", "mp3", "opus", "vorbis" */
  codec: string;
  /** File extension: ".aac", ".mp3", ".ogg" */
  extension: string;
  /** MIME type: "audio/aac", "audio/mpeg", "audio/ogg; codecs=opus", etc. */
  mime: string;
  /** Audio sample rate in Hz */
  sample_rate: number;
  /** Number of audio channels */
  channels: number;
  /** Total audio duration in seconds */
  duration_sec: number;
  /** Total audio file size in bytes */
  total_bytes: number;
  /** Milliseconds of pre-roll needed before a seek target for clean playback */
  pre_roll_ms: number;
  /** Per-second byte offset index. byte_index[N] = byte offset at second N. */
  byte_index: number[];
}

/** Audio extraction complete. No more audio events will be emitted. */
export interface AudioDoneEvent {
  type: 'audio_done';
  /** Suggested filename (e.g. "lecture.aac", "lecture.mp3", "lecture.ogg"). Null if extraction failed. */
  fileName: string | null;
  /** Per-second byte-offset manifest. Null if buildManifest was false or extraction failed. */
  manifest?: AudioManifest | null;
}

/** A slide image was detected and captured. */
export interface SlideEvent {
  type: 'slide';
  /** Raw image data (WebP/JPEG format) */
  imageBuffer: ArrayBuffer;
  /** Human-readable timestamp (e.g. "01:23:45") */
  timestamp: string;
  /** Start time in milliseconds (when this slide first appeared) */
  startMs: number;
  /** End time in milliseconds (when the next slide replaced this one) */
  endMs: number;
}

/** Progress update from the extraction engine. */
export interface ProgressEvent {
  type: 'progress';
  /** 0-100 */
  percent: number;
  /** Human-readable status message */
  message: string;
  /** Optional performance metrics */
  metrics?: {
    totalFrames: number;
    totalSlides: number;
    peakRamMb: number;
    avgFrameProcessTimeMs: number;
  };
}

/** Union of all events emitted by the extraction stream. */
export type ExtractorEvent = AudioChunkEvent | AudioDoneEvent | SlideEvent | ProgressEvent;

// ─── Browser Compatibility ───

/** Result of checking whether the current browser supports extraction. */
export interface BrowserSupport {
  /** WebCodecs (VideoDecoder) available — required */
  webCodecs: boolean;
  /** Origin Private File System available — required for audio extraction */
  opfs: boolean;
  /** OffscreenCanvas available — optional, for worker-side rendering */
  offscreenCanvas: boolean;
  /** Device RAM in GB (if exposed by navigator.deviceMemory) */
  deviceMemoryGb: number | null;
  /** Number of logical CPU cores */
  hardwareConcurrency: number;
  /** Whether WebGPU API is available for future hardware acceleration */
  webGpu: boolean;
  /** Whether mobile browser is detected */
  isMobile: boolean;
  /** Overall: can this browser run the extraction engine? */
  supported: boolean;
  /** Human-readable reason if not supported */
  reason?: string;
}

// ─── Configuration ───

/** Options for the FastExtractor. Only mode is required; everything else has sensible defaults. */
export interface FastExtractorOptions {
  // ─── Extraction mode ───
  /** 'turbo' = keyframe-only (~10x faster), 'sequential' = every frame */
  mode?: 'sequential' | 'turbo';
  
  /** 
   * Frame sampling rate for sequential mode (0.2 - 10). Default: 1.
   * 1 = compare 1 frame per second.
   * 0.5 = one frame every 2 seconds.
   * Ignored in turbo mode.
   */
  sampleFps?: number;

  // ─── Asset URLs (for library consumers using non-Vite bundlers) ───
  /**
   * URL to the core WASM binary (wasm_extractor_bg.wasm).
   * Default: auto-resolved by Vite. Override this when using Webpack/Rollup/etc.
   */
  wasmUrl?: string;
  /**
   * URL to the web-demuxer WASM binary (web-demuxer.wasm).
   * Default: '/wasm-files/web-demuxer.wasm'. Override to match your CDN/asset path.
   */
  demuxerWasmUrl?: string;
  /**
   * A pre-constructed Worker instance. If provided, the library uses this
   * instead of creating its own. Useful for bundlers that don't support
   * Vite's `?worker` import syntax.
   */
  worker?: Worker;

  // ─── Detection tuning ───
  /** Edge detection sensitivity (10-100). Default: 30 */
  edgeThreshold?: number;
  /** Minimum changed blocks to trigger slide (1-64). Default: 12 */
  blockThreshold?: number;
  /** Minimum seconds between slides. Default: 3 */
  minSlideDuration?: number;
  /** Density percentage threshold for block comparison. Default: 5 */
  densityThresholdPct?: number;
  /** Perceptual hash hamming distance for duplicate detection. Default: 10 */
  dhashDuplicateThreshold?: number;
  /** Brightness threshold for blank slide detection. Default: 0 */
  blankBrightnessThreshold?: number;
  /** 
   * If true, enables the "Stability Gate" which buffers frames during a transition
   * and only emits them once the video has stopped moving (driftBlocks drops).
   * Greatly reduces mid-transition garbage frames.
   * @default true
   */
  useDeferredEmit?: boolean;
  /** 64-bit bitmask: bit (row*8 + col) = 1 skips that 8×8 grid block. Default: 0n (no masking). */
  ignoreMask?: bigint;

  // ─── Advanced Drift & Shake Detection ───
  /** Cumulative drift must reach blockThreshold * this multiplier to emit a slow-transition slide. Default: 2 */
  cumulativeDriftMultiplier?: number;
  /** Frames of stability required before emitting on drift or partial match. Default: 2 */
  cumulativeSettledFrames?: number;
  /** Fraction of blockThreshold for partial match (0.0 - 1.0). Default: 0.5 */
  partialThresholdRatio?: number;
  /** Reset drift accumulator after this many drift frames if no trigger. Default: 30 */
  noiseResetFrames?: number;
  /** Reset drift only if mainChanges < blockThreshold * this ratio. Default: 0.25 */
  noiseMainRatio?: number;
  /** max(|ΔR|,|ΔG|,|ΔB|) to trigger color-only slide (0 = disabled). Default: 25 */
  colorChangeThreshold?: number;
  /** Density multiplier for camera shake confirmation (0 = disabled). Default: 3 */
  shakeFilterStrictMultiplier?: number;

  // ─── Output selection ───
  /** Extract audio from the video. Default: true */
  extractAudio?: boolean;
  /** Extract slide images from the video. Default: true */
  extractSlides?: boolean;
  /**
   * Build a per-second byte-offset manifest during audio extraction.
   * When true, the WASM engine tracks byte offsets at 1-second granularity,
   * enabling S3 range-query access to arbitrary audio segments.
   * The manifest is emitted alongside audio_done. Default: false.
   */
  buildManifest?: boolean;
  /** Encoded image quality of the extracted slides (0.01 - 1.0). Default: 0.8 */
  imageQuality?: number;
  /** Output format for extracted slides. Default: 'jpeg' */
  imageFormat?: 'webp' | 'jpeg';
  /** Max width of output slides (e.g. 1280 or 1920). 0 means original. Default: 0. */
  exportResolution?: number;

  // ─── Storage ───
  /**
   * Whether to delete OPFS temp files after extraction completes.
   * Default: true. Set to false to keep the ingested file in OPFS for
   * re-extraction with different settings (avoids re-ingesting the same video).
   * Call FastExtractor.cleanupStorage() explicitly when you're done.
   */
  cleanupAfterExtraction?: boolean;

  // ─── Debugging ───
  /**
   * When true, logs all internal worker messages and state transitions to the
   * browser console. Useful for diagnosing extraction failures.
   * Default: false. Has zero performance impact when disabled.
   */
  debug?: boolean;
}

// ─── Callback API ───

/** Callback-style interface as an alternative to ReadableStream consumption. */
export interface ExtractorCallbacks {
  /** Called for each raw audio chunk (codec-agnostic). */
  onAudio?: (chunk: ArrayBuffer) => void;
  /** Called when audio extraction is complete. */
  onAudioDone?: (fileName: string | null, manifest?: AudioManifest | null) => void;
  /** Called when a new slide is detected. */
  onSlide?: (slide: { imageBuffer: ArrayBuffer; timestamp: string; startMs: number; endMs: number }) => void;
  /** Called on progress updates. */
  onProgress?: (percent: number, message: string, metrics?: ProgressEvent['metrics']) => void;
 
  onError?: (error: ExtractorError | Error) => void;
  /** Called when extraction is fully complete. */
  onDone?: () => void;
}
