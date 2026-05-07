/**
 * ============================================================================
 * core/types.ts — Slide Extraction Engine Types & Defaults
 * ============================================================================
 *
 * All internal type definitions and default configuration for the
 * SlideExtractor engine. Separated from the class to keep each module focused.
 */

export interface SlideExtractorOptions {
  mode: 'sequential' | 'turbo';
  sampleFps: number;
  edgeThreshold: number;
  blockThreshold: number;
  densityThresholdPct: number;
  minSlideDuration: number;
  dhashDuplicateThreshold: number;
  // Three-pointer drift detection
  cumulativeDriftMultiplier: number;    // cumulative drift must reach blockThreshold * this
  cumulativeSettledSeconds: number;     // seconds of stability before emitting on drift
  noiseResetSeconds: number;            // reset drift after this many seconds if no trigger
  noiseMainRatio: number;               // reset only if mainChanges < blockThreshold * this (0-1)
  // Region-of-interest masking
  ignoreMask: bigint;                   // 64-bit bitmask: bit (row*8+col)=1 skips that grid block
  
  // Transition Filter (Stability Gate)
  useDeferredEmit: boolean;

  /** Encoded image quality (0.01 - 1.0). Default: 0.8 */
  imageQuality?: number;
  /** Output format for extracted slides. Default: 'jpeg' */
  imageFormat?: 'webp' | 'jpeg';
  /** Max width of output slides (e.g. 1280 or 1920). 0 means original. Default: 0. */
  exportResolution?: number;

  onProgress: (percent: number, message: string, metrics?: ExtractionMetrics) => void;
  /** @param timestamp - exact timestamp (seconds) of the frame that triggered the slide */
  onSlide: (blob: Blob, timestamp: number) => void;
}

export interface ExtractionMetrics {
  startTime: number;
  endTime?: number;
  jobElapsedMs?: number;
  totalFrames: number;
  totalSlides: number;
  peakRamMb: number;
  avgFrameProcessTimeMs: number;
  /** Last video frame timestamp in seconds — used to compute last slide's endMs */
  lastFrameTimestamp?: number;
  /** Video duration in seconds from the demuxer — used for accurate last slide endMs */
  videoDurationSec?: number;
}

export const DEFAULT_OPTIONS: SlideExtractorOptions = {
  mode: 'turbo', sampleFps: 1,
  edgeThreshold: 30, blockThreshold: 12, densityThresholdPct: 5,
  minSlideDuration: 3, dhashDuplicateThreshold: 4,
  // Three-pointer defaults
  cumulativeDriftMultiplier: 2,
  cumulativeSettledSeconds: 2,
  noiseResetSeconds: 30,
  noiseMainRatio: 0.25,
  // Grid masking: 0n = compare all 64 blocks (no masking)
  ignoreMask: 0n,
  useDeferredEmit: true,
  onProgress: () => {}, onSlide: () => {},
};

export interface WasmModule {
  init_arena: () => void;
  get_buffer_a_ptr: () => number;
  get_buffer_b_ptr: () => number;
  get_buffer_prev_ptr: () => number;
  get_rgba_buffer_ptr: () => number;
  shift_current_to_prev: () => void;
  copy_rgba_to_gray: (is_target_b: boolean) => void;
  compare_frames: (edge: number, density: number, mask: bigint) => number;
  compare_prev_current: (edge: number, density: number, mask: bigint) => number;
  compute_dhash: (is_buffer_b: boolean) => bigint;
  get_avg_brightness: () => number;
  memory: WebAssembly.Memory;
}
