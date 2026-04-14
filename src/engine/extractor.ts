/**
 * ============================================================================
 * extractor.ts — Slide Extraction Engine (Three-Pointer Drift Detection)
 * ============================================================================
 *
 * This class consumes decoded video frames and determines where slide
 * transitions occur, using a WASM-accelerated frame comparison engine.
 *
 * DETECTION ARCHITECTURE: "Three-Pointer" Comparison
 *   We maintain three grayscale frame buffers in WASM linear memory:
 *
 *     Buffer A ("Baseline")  — the last EMITTED slide's frame
 *     Buffer Prev ("Previous") — the immediately preceding frame
 *     Buffer B ("Current")   — the frame being evaluated right now
 *
 *   On each frame:
 *     1. Shift: B → Prev (so we always have the previous frame)
 *     2. Capture: VideoFrame → RGBA → grayscale → B
 *     3. Compare A↔B (mainChanges): "how different is this from the baseline?"
 *     4. Compare Prev↔B (driftBlocks): "did anything change since last frame?"
 *
 *   EMIT CONDITIONS (all require minSlideDuration to have elapsed):
 *     Condition 1: mainChanges ≥ blockThreshold  (big instant change)
 *     Condition 2: cumulativeDrift ≥ blockThreshold × multiplier AND settled
 *                  (many small changes that accumulated, e.g., scrolling text)
 *     Condition 3: partial main + partial drift  (combined weak signals)
 *
 *   NOISE SUPPRESSION:
 *     - Blank frames (brightness < blankBrightnessThreshold) are skipped
 *     - Duplicate slides are suppressed via 64-bit dHash comparison
 *     - Cumulative drift resets after noiseResetFrames without a trigger
 *
 * TWO EXTRACTION MODES:
 *   TURBO:    Decode only keyframes (IDR). ~20s for a 1-hour video.
 *             One VideoDecoder, flush() between each keyframe.
 *             Catches ~95% of transitions (misses those between IDRs).
 *
 *   ACCURATE: Decode EVERY frame in 60s chunks. ~120-150s for a 1-hour video.
 *             Decoder is recycled per chunk to bound RAM.
 *             Catches 100% of transitions. Higher accuracy, higher cost.
 *
 * WASM BUFFER LAYOUT:
 *   init_arena() allocates four buffers in WASM linear memory:
 *     [buffer_a: 427×240 gray] [buffer_b: 427×240 gray]
 *     [buffer_prev: 427×240 gray] [rgba_buffer: 427×240×4 RGBA]
 *
 *   All WASM functions operate on these fixed buffers — zero JS↔WASM copies.
 *   The RGBA buffer is a staging area: copy RGBA in, call copy_rgba_to_gray()
 *   to convert to gray in-place, then compare_frames() reads from gray buffers.
 *
 * ⚠️ CRITICAL: VIDEOFRAME LIFETIME
 *   VideoFrame objects hold GPU-backed textures (~1-4MB each).
 *   They MUST be closed immediately after pixel extraction.
 *   processFrameSync() closes the frame in a finally{} block.
 *   If you add any new code path that receives a VideoFrame,
 *   ALWAYS ensure frame.close() is called even on error paths.
 *
 * ⚠️ CRITICAL: CANVAS REUSE
 *   compareCanvas and slideCanvas are created once and reused for ALL frames.
 *   DO NOT create new OffscreenCanvas per frame — that causes GC pressure
 *   and GPU memory fragmentation leading to OOM on mobile.
 *
 * ⚠️ CRITICAL: RESOLUTION
 *   Comparison always happens at 427×240 (CMP_W × CMP_H) regardless of
 *   the input video resolution. This is intentional — higher resolution
 *   doesn't improve slide detection accuracy but massively increases cost.
 *   maxFrameWidth only affects the ORIGINAL file decoding, not comparison.
 *
 * CONFIGURATION REFERENCE:
 *   edgeThreshold (10-100, default 30)
 *     Per-pixel luminance difference required to count as "changed".
 *     Lower = more sensitive to subtle changes. Higher = more noise-tolerant.
 *
 *   blockThreshold (1-64, default 12)
 *     Number of 8×8 blocks that must have changed to trigger a new slide.
 *     The image is divided into an 8×8 grid (64 blocks). Each block's
 *     change density is checked against densityThresholdPct.
 *
 *   densityThresholdPct (1-50, default 5)
 *     Percentage of pixels within a single block that must differ.
 *     5% = at least 5% of the block's pixels must have changed.
 *
 *   stabilityThreshold (1-20, default 3)
 *     Number of consecutive frames with no drift required before
 *     considering the content "settled" (used by drift detection).
 *
 *   minSlideDuration (1-30s, default 3)
 *     Minimum seconds between two slide emissions.
 *     Prevents rapid-fire emissions during animations.
 *
 *   dhashDuplicateThreshold (0-20, default 10)
 *     Hamming distance for dHash comparison (64-bit perceptual hash).
 *     Two slides with distance ≤ this value are considered duplicates.
 *     0 = exact match only, 10 = tolerant of minor differences.
 *
 *   blankBrightnessThreshold (0-50, default 8)
 *     Average pixel brightness below which a frame is considered blank/black.
 *     Skipped entirely to avoid emitting transition frames.
 *
 *   cumulativeDriftMultiplier (1-5, default 2)
 *     Factor applied to blockThreshold for cumulative drift trigger.
 *     2 = cumulative drift must reach 2× blockThreshold to trigger.
 *
 *   cumulativeSettledFrames (1-10, default 2)
 *     Frames of stability required after cumulative drift before emitting.
 *
 *   partialThresholdRatio (0.1-1, default 0.5)
 *     Fraction of blockThreshold for the partial main change component
 *     of Condition 3. 0.5 = main change must be at least half the threshold.
 *
 *   noiseResetFrames (10-100, default 30)
 *     Reset cumulative drift after this many drift frames without trigger.
 *     Prevents webcam noise or subtle video compression artifacts from
 *     accumulating into false positives.
 *
 *   noiseMainRatio (0.05-0.5, default 0.25)
 *     Reset drift only if mainChanges < blockThreshold × this ratio.
 *     Ensures we don't reset when there's a genuine slow transition in progress.
 */
import { WebDemuxer } from 'web-demuxer';

export interface SlideExtractorOptions {
  mode: 'accurate' | 'turbo';
  fps: number;
  edgeThreshold: number;
  blockThreshold: number;
  densityThresholdPct: number;
  minSlideDuration: number;
  dhashDuplicateThreshold: number;
  // Three-pointer drift detection
  blankBrightnessThreshold: number;     // skip frames darker than this (0-255)
  cumulativeDriftMultiplier: number;    // cumulative drift must reach blockThreshold * this
  cumulativeSettledFrames: number;      // frames of stability before emitting on drift
  partialThresholdRatio: number;        // fraction of blockThreshold for partial match (0-1)
  partialDriftSettledFrames: number;    // settled frames for partial match
  noiseResetFrames: number;             // reset drift after this many drift frames if no trigger
  noiseMainRatio: number;               // reset only if mainChanges < blockThreshold * this (0-1)
  // Color-aware detection
  colorChangeThreshold: number;         // max(|ΔR|,|ΔG|,|ΔB|) to trigger color-only slide (0=disabled)
  // Camera shake filter
  shakeFilterStrictMultiplier: number;  // density multiplier for shake confirmation (0=disabled)
  // Region-of-interest masking
  ignoreMask: bigint;                   // 64-bit bitmask: bit (row*8+col)=1 skips that grid block
  // Turbo deferred-emit confirmation
  /** Max dHash hamming distance to confirm a candidate as real (not a transition blend). Default: 10.
   *  Lower = stricter (more transition frames filtered, but might drop fast slides).
   *  Higher = looser (more slides captured, but more transition frames leak through). */
  confirmThreshold: number;
  
  /** Encoded WebP quality (0.01 - 1.0). Default: 0.8 */
  imageQuality?: number;
  /** Max width of output slides (e.g. 1280 or 1920). 0 means original. Default: 0. */
  exportResolution?: number;

  onProgress: (percent: number, message: string, metrics?: ExtractionMetrics) => void;
  onSlide: (blob: Blob, timestamp: number) => void;
}

export interface ExtractionMetrics {
  startTime: number;
  endTime?: number;
  totalFrames: number;
  totalSlides: number;
  // peakRamMb: number; // Removed due to inconsistent browser security gating for real memory APIs
  avgFrameProcessTimeMs: number;
  /** Last video frame timestamp in seconds — used to compute last slide's endMs */
  lastFrameTimestamp?: number;
}

export const DEFAULT_OPTIONS: SlideExtractorOptions = {
  mode: 'turbo', fps: 1,
  edgeThreshold: 30, blockThreshold: 12, densityThresholdPct: 5,
  minSlideDuration: 3, dhashDuplicateThreshold: 10,
  // Three-pointer defaults
  blankBrightnessThreshold: 8,
  cumulativeDriftMultiplier: 2,
  cumulativeSettledFrames: 2,
  partialThresholdRatio: 0.5,
  partialDriftSettledFrames: 1,
  noiseResetFrames: 30,
  noiseMainRatio: 0.25,
  // Color detection: 25 = detect shifts where any channel moves >25/255
  colorChangeThreshold: 25,
  // Shake filter: 3 = confirm with 3× density. 0 = disabled
  shakeFilterStrictMultiplier: 3,
  // Grid masking: 0n = compare all 64 blocks (no masking)
  ignoreMask: 0n,
  // Turbo confirmation: 10 = moderate strictness
  confirmThreshold: 10,
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
  check_stability: (threshold: bigint) => boolean;
  get_avg_brightness: () => number;
  memory: WebAssembly.Memory;
}

/**
 * ARCHITECTURE: Stream + selective keyframe decode.
 *
 * Stream ALL packets from demuxer (fast sequential I/O, zero round-trips).
 * Only DECODE packets that are keyframes near our sample times.
 * Everything else is skipped at zero cost.
 *
 * For a 1-hour video at 1fps with keyframes every 5s:
 *   Packets streamed: ~108,000 (cheap — just checking timestamp)
 *   Frames decoded:   ~720 (only keyframes, self-contained)
 *   Expected time:    ~15-30s
 *   Expected RAM:     ~150-250MB (one decoder, no ref frame buildup)
 */
export class SlideExtractor {
  private wasm: WasmModule;
  private options: SlideExtractorOptions;
  private hasBaseline = false;
  private savedHashes: bigint[] = [];
  private lastSlideTime = -10;

  private compareCanvas: OffscreenCanvas | null = null;
  private compareCtx: OffscreenCanvasRenderingContext2D | null = null;
  private exportCanvas: OffscreenCanvas | null = null;
  private exportCtx: OffscreenCanvasRenderingContext2D | null = null;
  private blobCanvas: OffscreenCanvas | null = null;
  private blobCtx: OffscreenCanvasRenderingContext2D | null = null;

  // Three-pointer cumulative drift tracking
  private cumulativeDrift = 0;   // accumulated block changes (Prev vs B)
  private driftFrames = 0;       // how many frames contributed drift
  private staticCount = 0;       // consecutive frames with zero drift

  // Adaptive noise floor — calibrates blockThreshold from video noise level
  private noiseFloor = 0;
  private calibrationSamples: number[] = [];
  private isCalibrated = false;

  // Color-aware detection — tracks average RGB to detect color-only changes
  private prevColorSig: [number, number, number] | null = null;


  // Turbo deferred-emit: buffers one candidate to filter transition frames
  private pendingCandidate: { bitmap: ImageBitmap; timestamp: number; hash: bigint } | null = null;

  private metrics: ExtractionMetrics = {
    startTime: 0, totalFrames: 0, totalSlides: 0, avgFrameProcessTimeMs: 0
  };



  constructor(wasm: WasmModule, options?: Partial<SlideExtractorOptions>) {
    this.wasm = wasm;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.wasm.init_arena();
  }

  public async extract(file: File, demuxerWasmUrl: string) {
    this.metrics = { startTime: performance.now(), totalFrames: 0, totalSlides: 0, avgFrameProcessTimeMs: 0 };
    this.hasBaseline = false;
    this.savedHashes = [];
    if (this.pendingCandidate) { this.pendingCandidate.bitmap.close(); }
    this.pendingCandidate = null;
    // Reset robustness state
    this.noiseFloor = 0;
    this.calibrationSamples = [];
    this.isCalibrated = false;
    this.prevColorSig = null;

    this.cumulativeDrift = 0;
    this.driftFrames = 0;
    this.staticCount = 0;

    this.options.onProgress(0, "Initializing Demuxer...");

    // Pre-fetch the WASM binary in OUR worker (correct origin) and convert to
    // a data: URL. web-demuxer spawns a nested blob: worker that can't access
    // blob: URLs or make same-origin fetches. A data: URL embeds the binary
    // inline, so no network request or blob store lookup is needed.
    let wasmDataUrl: string;
    try {
      const resp = await fetch(demuxerWasmUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const wasmBytes = new Uint8Array(await resp.arrayBuffer());
      // Convert to base64 in chunks to avoid call stack overflow
      let binary = '';
      const chunkSize = 32768;
      for (let i = 0; i < wasmBytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, wasmBytes.subarray(i, i + chunkSize) as any);
      }
      wasmDataUrl = 'data:application/wasm;base64,' + btoa(binary);
    } catch (e: any) {
      throw new Error(`Failed to fetch demuxer WASM (${demuxerWasmUrl}): ${e.message}`);
    }

    const demuxer = new WebDemuxer({ wasmFilePath: wasmDataUrl });
    try {
      await demuxer.load(file);
      const mediaInfo = await demuxer.getMediaInfo();
      const duration = mediaInfo.duration || 0;

      const interval = this.options.mode === 'turbo'
        ? 2
        : (1 / (this.options.fps || 1));

      await this.extractKeyframes(demuxer, duration, interval);

      // Flush last buffered candidate (turbo deferred-emit)
      // eslint-disable-next-line -- TS CFA narrows to `never` after async calls
      const lc = this.pendingCandidate as { bitmap: ImageBitmap; timestamp: number; hash: bigint } | null;
      if (lc) {
        this.savedHashes.push(lc.hash);
        this.emitBitmap(lc.bitmap, lc.timestamp);
        this.pendingCandidate = null;
      }

      this.metrics.endTime = performance.now();
      this.options.onProgress(100, "Done", this.metrics);
    } finally {
      demuxer.destroy();
    }
  }

  /**
   * Stream all packets. Only decode keyframes at interval boundaries.
   * Skip everything else — no decode cost, no GPU allocation.
   *
   * One VideoDecoder lives for the entire extraction.
   * Keyframes are self-contained (IDR) so the decoder doesn't accumulate
   * reference frames between them.
   */
  private async extractKeyframes(demuxer: WebDemuxer, duration: number, interval: number) {
    const config = await demuxer.getDecoderConfig('video');

    
    let packetCount = 0;
    let decodedCount = 0;
    let lastReport = 0;

    if (this.options.mode === 'turbo') {
      // TURBO: Decode ALL keyframes via streaming. ~20s for 1-hour video.
      // Keyframes are IDR (self-contained), flush() between each is safe.
      // Catches ~95% of slide transitions. Backfill closes the remaining ~5%.
      let frameResolve: ((frame: VideoFrame | null) => void) | null = null;
      const baseConfig = { ...config as VideoDecoderConfig, optimizeForLatency: true };
      // prefer-software prevents older GPUs from silently dropping isolated keyframes.
      // But some browsers don't support the hardwareAcceleration option at all,
      // so we probe first and fall back to the default (let-browser-decide).
      let turboDecoderConfig: VideoDecoderConfig = baseConfig;
      try {
        const swConfig = { ...baseConfig, hardwareAcceleration: 'prefer-software' as const };
        const supported = await VideoDecoder.isConfigSupported(swConfig);
        if (supported.supported) turboDecoderConfig = swConfig;
      } catch { /* browser doesn't support isConfigSupported — use default */ }

      const makeTurboDecoder = () => {
        const d = new VideoDecoder({
          output: (frame) => {
            if (frameResolve) { const r = frameResolve; frameResolve = null; r(frame); }
            else frame.close();
          },
          error: (e) => {
            console.warn('Turbo decode error callback:', e);
            if (frameResolve) { const r = frameResolve; frameResolve = null; r(null); }
          }
        });
        d.configure(turboDecoderConfig);
        return d;
      };

      let decoder = makeTurboDecoder();

      try {
        const endTime = duration > 0 ? duration * 2 : 999999;
        const reader = demuxer.read('video', 0, endTime).getReader();
        let lastKeyframeTs = -1;

        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;

          packetCount++;
          const ts = Number(value.timestamp) / 1e6;

          // Decode every keyframe — no interval gating
          if (value.type === 'key') {
            if (ts === lastKeyframeTs) continue;
            lastKeyframeTs = ts;

            // If previous error killed the decoder, spin up a fresh one
            if (decoder.state === 'closed') {
              decoder = makeTurboDecoder();
            }

            const framePromise = new Promise<VideoFrame | null>(resolve => { frameResolve = resolve; });
            try {
              decoder.decode(value);
              await decoder.flush();
            } catch (e: any) {
              console.warn('Turbo decode error (skipping keyframe):', e);
              continue;
            }

            // Race: if the hardware decoder silently drops the frame (no output
            // callback), framePromise hangs forever. 5s timeout → skip frame.
            const frame = await Promise.race([
              framePromise,
              new Promise<VideoFrame | null>(r => setTimeout(() => r(null), 5000))
            ]);
            decodedCount++;

            if (frame) {
              const t0 = performance.now();
              this.processFrameSync(frame, ts);
              this.metrics.avgFrameProcessTimeMs =
                (this.metrics.avgFrameProcessTimeMs * (this.metrics.totalFrames - 1) + (performance.now() - t0))
                / this.metrics.totalFrames;
            }

          }

          if (ts >= lastReport + 1) {
            this.updateMetrics(decoder.decodeQueueSize);
            this.options.onProgress(
              Math.min((ts / duration) * 100, 99.9),
              `Turbo: ${Math.floor(ts)}s / ${Math.floor(duration)}s`,
              this.metrics
            );
            lastReport = ts;
          }
        }
        if (decoder.state !== 'closed') await decoder.flush();
      } finally {
        if (decoder.state !== 'closed') decoder.close();
      }

    } else {
      // ACCURATE: Full decode of EVERY frame. ~120-150s for 1-hour video.
      // Catches 100% of transitions including between keyframes.
      // Chunked: 60s segments with decoder recycling to bound RAM.
      const CHUNK_SIZE = 300;
      let nextCaptureTime = 0;
      let pendingResolve: (() => void) | null = null;
      // Don't specify hardwareAcceleration — let the browser pick the best strategy.
      // Forcing 'prefer-hardware' breaks on browsers that don't support this option.
      const seqDecoderConfig = { ...config as VideoDecoderConfig, optimizeForLatency: true };

      const makeSeqDecoder = () => {
        const d = new VideoDecoder({
          output: (frame) => {
            const ts = frame.timestamp / 1e6;
            decodedCount++;

            if (ts >= nextCaptureTime) {
              const t0 = performance.now();
              this.processFrameSync(frame, ts);
              this.metrics.avgFrameProcessTimeMs =
                (this.metrics.avgFrameProcessTimeMs * (this.metrics.totalFrames - 1) + (performance.now() - t0))
                / this.metrics.totalFrames;
              nextCaptureTime = ts + interval;
            } else {
              frame.close();
            }

            if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); }
          },
          error: (e) => {
            console.warn('Sequential decode error callback:', e);
            if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); }
          }
        });
        d.configure(seqDecoderConfig);
        return d;
      };

      for (let chunkStart = 0; chunkStart < duration; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, duration);
        pendingResolve = null;

        let decoder = makeSeqDecoder();

        try {
          const reader = demuxer.read('video', chunkStart, chunkEnd).getReader();

          let seenKeyframe = false;

          while (true) {
            // Backpressure: don't overwhelm decoder queue.
            // Race against a 5s timeout — if the hardware decoder silently drops
            // a frame (common on mobile), the output callback never fires and
            // pendingResolve hangs forever. The timeout breaks the deadlock.
            while (decoder.state !== 'closed' && decoder.decodeQueueSize >= 3) {
              await Promise.race([
                new Promise<void>(r => { pendingResolve = r; }),
                new Promise<void>(r => setTimeout(r, 5000))
              ]);
            }

            const { done, value } = await reader.read();
            if (done || !value) break;

            // Wait for the first keyframe after configure()
            if (!seenKeyframe) {
              if (value.type !== 'key') continue;
              seenKeyframe = true;
            }

            packetCount++;
            try {
              // If decoder died, spawn a fresh one and wait for next keyframe
              if (decoder.state === 'closed') {
                console.warn('Sequential: decoder died, spawning fresh instance...');
                decoder = makeSeqDecoder();
                seenKeyframe = false;
                continue;
              }
              decoder.decode(value);
            } catch (e: any) {
              console.warn('Sequential decode error:', e);
              if (decoder.state === 'closed') {
                decoder = makeSeqDecoder();
                seenKeyframe = false;
                continue;
              }
              if (e?.message && e.message.includes('key frame is required')) {
                seenKeyframe = false;
              }
            }

            const ts = Number(value.timestamp) / 1e6;
            if (ts >= lastReport + 1) {
              this.updateMetrics(decoder.decodeQueueSize);
              this.options.onProgress(
                Math.min((ts / duration) * 100, 99.9),
                `Sequential: ${Math.floor(ts)}s / ${Math.floor(duration)}s`,
                this.metrics
              );
              lastReport = ts;
            }
          }

          if (decoder.state !== 'closed') await decoder.flush();
        } finally {
          if (decoder.state !== 'closed') decoder.close();
        }
      }
    }
  }



  /**
   * Process a single decoded frame: extract pixels, compare, capture.
   * Frame is ALWAYS closed at the end.
   *
   * Integrates: adaptive noise floor, color detection, camera shake filter.
   */
  private processFrameSync(frame: VideoFrame, timestamp: number) {
    this.metrics.totalFrames++;
    this.metrics.lastFrameTimestamp = timestamp;
    this.wasm.shift_current_to_prev();

    // Step 1: Copy frame pixels → WASM RGBA buffer
    try {
      this.captureFrameToRgba(frame);
    } finally {
      frame.close();
    }

    // === Frame closed. Only WASM buffers from here. ===

    // Step 2: Compute color signature BEFORE grayscale conversion
    const colorSig = this.computeColorSignature();

    // Step 3: Convert RGBA → grayscale for block comparison
    this.convertRgbaToGray();

    // Edge case: Skip near-black/blank frames (transitions, fades)
    const brightness = this.wasm.get_avg_brightness();
    if (brightness < this.options.blankBrightnessThreshold) return;

    // Turbo deferred-emit: confirm or discard the pending candidate
    // by checking if the current frame is similar (real slide persisted)
    // or different (candidate was a transition frame).
    if (this.options.mode === 'turbo' && this.pendingCandidate) {
      const currentHash = this.wasm.compute_dhash(true);
      const dist = SlideExtractor.hammingDistance(this.pendingCandidate.hash, currentHash);
      if (dist <= this.options.confirmThreshold) {
        // Next frame is similar → candidate was a real slide, emit it
        this.savedHashes.push(this.pendingCandidate.hash);
        this.emitBitmap(this.pendingCandidate.bitmap, this.pendingCandidate.timestamp);
      } else {
        // Next frame is different → candidate was a transition frame, discard
        this.pendingCandidate.bitmap.close();
      }
      this.pendingCandidate = null;
    }

    if (!this.hasBaseline) {
      this.copyBufferBToA();
      this.savedHashes.push(this.wasm.compute_dhash(true));
      this.emitSlideFromCanvas(timestamp);
      this.hasBaseline = true;
      this.lastSlideTime = timestamp;
      this.prevColorSig = colorSig;
      return;
    }

    // === THREE-POINTER COMPARISON (both modes) ===
    const { edgeThreshold, densityThresholdPct } = this.options;
    const blockThreshold = this.getEffectiveBlockThreshold();

    // Pointer 1→3: Baseline (A) vs Current (B)
    const mask = this.options.ignoreMask;
    const mainChanges = this.wasm.compare_frames(edgeThreshold, densityThresholdPct, mask);

    // Pointer 2→3: Previous (Prev) vs Current (B) — consecutive drift
    const driftBlocks = this.wasm.compare_prev_current(edgeThreshold, densityThresholdPct, mask);

    // --- Adaptive Noise Floor Calibration ---
    // Collect drift samples during the first 10 frames where content is stable
    // (drift > 0 but no big change = codec noise, not a real transition)
    if (!this.isCalibrated && driftBlocks > 0 && mainChanges < this.options.blockThreshold) {
      this.calibrationSamples.push(driftBlocks);
      if (this.calibrationSamples.length >= 10) {
        // Use median (robust against outliers from transitions)
        const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
        this.noiseFloor = sorted[Math.floor(sorted.length / 2)];
        this.isCalibrated = true;
        console.log(`[NoiseFloor] Calibrated: ${this.noiseFloor} blocks (effective threshold: ${this.getEffectiveBlockThreshold()})`);
      }
    }

    // Track cumulative drift
    if (driftBlocks > 0) {
      this.cumulativeDrift += driftBlocks;
      this.driftFrames++;
      this.staticCount = 0;
    } else {
      this.staticCount++;
    }

    // --- Color Delta ---
    let colorDelta = 0;
    if (this.prevColorSig && this.options.colorChangeThreshold > 0) {
      colorDelta = Math.max(
        Math.abs(colorSig[0] - this.prevColorSig[0]),
        Math.abs(colorSig[1] - this.prevColorSig[1]),
        Math.abs(colorSig[2] - this.prevColorSig[2])
      );
    }
    this.prevColorSig = colorSig;

    // === EMIT CONDITIONS ===
    const timeSinceLastSlide = timestamp - this.lastSlideTime;
    const minTime = this.options.minSlideDuration;

    if (timeSinceLastSlide < minTime) return;

    let shouldEmit = false;

    // Condition 1: Direct threshold — A vs B shows big change
    if (mainChanges >= blockThreshold) {
      // --- Camera Shake Filter ---
      // If the change is diffuse (all blocks changed a little), it's shake, not a slide.
      // Confirm with a stricter density check: if few blocks pass 3× density, it's shake.
      if (this.options.shakeFilterStrictMultiplier > 0) {
        const strictDensity = Math.min(densityThresholdPct * this.options.shakeFilterStrictMultiplier, 100);
        const strictChanges = this.wasm.compare_frames(edgeThreshold, strictDensity, mask);
        if (strictChanges >= blockThreshold * 0.3) {
          // Concentrated change → real slide transition
          shouldEmit = true;
        }
        // else: diffuse change → camera shake, suppress
      } else {
        shouldEmit = true;
      }
    }
    // Condition 2: Cumulative drift — small changes piled up AND content settled
    else if (
      this.cumulativeDrift >= blockThreshold * this.options.cumulativeDriftMultiplier &&
      this.staticCount >= this.options.cumulativeSettledFrames
    ) {
      shouldEmit = true;
    }
    // Condition 3: Partial main + partial drift — combined signal
    else if (
      mainChanges >= Math.floor(blockThreshold * this.options.partialThresholdRatio) &&
      this.cumulativeDrift >= blockThreshold &&
      this.staticCount >= this.options.partialDriftSettledFrames
    ) {
      shouldEmit = true;
    }
    // Condition 4: Color-only change — grayscale missed it but color shifted significantly
    // Note: color signature is computed over the ENTIRE frame (not per-block), so it
    // does not respect the grid mask. Skip this condition if all blocks are masked.
    else if (
      mask !== 0xFFFFFFFFFFFFFFFFn &&
      colorDelta >= this.options.colorChangeThreshold
    ) {
      shouldEmit = true;
    }

    if (shouldEmit) {
      const dhash = this.wasm.compute_dhash(true);
      if (!this.isDuplicate(dhash)) {
        if (this.options.mode === 'turbo') {
          // Turbo: defer emit — buffer as candidate for confirmation on next keyframe.
          // Transition frames (crossfades, dissolves) will be discarded when the
          // next frame doesn't match. Real slides persist across keyframes.
          const bitmap = this.captureCanvasBitmap();
          if (this.pendingCandidate) this.pendingCandidate.bitmap.close();
          this.pendingCandidate = { bitmap, timestamp, hash: dhash };
        } else {
          // Accurate: emit immediately (has frame-level temporal resolution)
          this.savedHashes.push(dhash);
          this.emitSlideFromCanvas(timestamp);
        }
        this.copyBufferBToA();
        this.lastSlideTime = timestamp;
      }
      // Reset drift regardless (baseline updated or duplicate skipped)
      this.cumulativeDrift = 0;
      this.driftFrames = 0;
      this.staticCount = 0;
    }
    // Reset drift if too long without trigger (prevents webcam noise buildup)
    else if (
      this.driftFrames > this.options.noiseResetFrames &&
      mainChanges < Math.floor(blockThreshold * this.options.noiseMainRatio)
    ) {
      this.cumulativeDrift = 0;
      this.driftFrames = 0;
    }
  }

  // ===================== Helpers =====================

  // Comparison canvas: small for fast WASM processing
  private static readonly CMP_W = 427;
  private static readonly CMP_H = 240;

  // Deferred-emit: max hamming distance to confirm a candidate is real (not a transition blend)
  // Now configurable via options.confirmThreshold (default: 10)

  /**
   * Copy VideoFrame pixels into the WASM RGBA buffer.
   * Does NOT convert to grayscale yet — call convertRgbaToGray() after
   * color signature extraction.
   */
  private captureFrameToRgba(frame: VideoFrame) {
    const W = SlideExtractor.CMP_W, H = SlideExtractor.CMP_H;
    if (!this.compareCanvas) {
      this.compareCanvas = new OffscreenCanvas(W, H);
      this.compareCtx = this.compareCanvas.getContext('2d', { willReadFrequently: true })!;
      this.compareCtx.imageSmoothingEnabled = false;
    }
    this.compareCtx!.drawImage(frame, 0, 0, W, H);
    const { data } = this.compareCtx!.getImageData(0, 0, W, H);
    const ptr = this.wasm.get_rgba_buffer_ptr();
    new Uint8Array(this.wasm.memory.buffer, ptr, W * H * 4).set(data);

    // Buffer the frame in higher resolution for export!
    const targetW = this.options.exportResolution || frame.displayWidth;
    const targetH = Math.round(targetW * (frame.displayHeight / frame.displayWidth));
    
    if (!this.exportCanvas) {
      this.exportCanvas = new OffscreenCanvas(targetW, targetH);
      this.exportCtx = this.exportCanvas.getContext('2d')!;
    } else if (this.exportCanvas.width !== targetW || this.exportCanvas.height !== targetH) {
      this.exportCanvas.width = targetW;
      this.exportCanvas.height = targetH;
    }
    this.exportCtx!.drawImage(frame, 0, 0, targetW, targetH);
  }

  /** Convert RGBA buffer to grayscale into buffer B. Call after captureFrameToRgba. */
  private convertRgbaToGray() {
    this.wasm.copy_rgba_to_gray(true);
  }

  /**
   * Compute average R, G, B from the WASM RGBA buffer by sampling every 64th pixel.
   * ~1600 samples from a 427×240 image — fast and representative.
   * Must be called AFTER captureFrameToRgba but BEFORE convertRgbaToGray.
   */
  private computeColorSignature(): [number, number, number] {
    const W = SlideExtractor.CMP_W, H = SlideExtractor.CMP_H;
    const ptr = this.wasm.get_rgba_buffer_ptr();
    const rgba = new Uint8Array(this.wasm.memory.buffer, ptr, W * H * 4);
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    // Sample every 64th pixel (stride of 256 bytes in RGBA)
    for (let i = 0; i < rgba.length; i += 256) {
      sumR += rgba[i];
      sumG += rgba[i + 1];
      sumB += rgba[i + 2];
      count++;
    }
    return [sumR / count, sumG / count, sumB / count];
  }

  /**
   * Get effective blockThreshold, adjusted for video noise level.
   * After calibration (10 samples), if the median noise per-frame exceeds
   * the configured threshold / 3, the threshold is raised.
   * For clean videos (noise ~1), returns the configured blockThreshold unchanged.
   */
  private getEffectiveBlockThreshold(): number {
    if (!this.isCalibrated) return this.options.blockThreshold;
    // Raise threshold if noise is high, never lower it
    return Math.max(this.options.blockThreshold, this.noiseFloor * 3);
  }

  private copyBufferBToA() {
    const size = SlideExtractor.CMP_W * SlideExtractor.CMP_H;
    const buf = this.wasm.memory.buffer;
    new Uint8Array(buf, this.wasm.get_buffer_a_ptr(), size).set(
      new Uint8Array(buf, this.wasm.get_buffer_b_ptr(), size)
    );
  }

  private captureCanvasBitmap(): ImageBitmap {
    return this.exportCanvas!.transferToImageBitmap();
  }

  private emitSlideFromCanvas(timestamp: number) {
    this.emitBitmap(this.captureCanvasBitmap(), timestamp);
  }

  private emitBitmap(bitmap: ImageBitmap, timestamp: number) {
    this.renderBitmapToBlob(bitmap).then(blob => {
      this.options.onSlide(blob, timestamp);
      this.metrics.totalSlides++;
    });
  }

  private async renderBitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
    const w = bitmap.width, h = bitmap.height;
    if (!this.blobCanvas || this.blobCanvas.width !== w || this.blobCanvas.height !== h) {
      this.blobCanvas = new OffscreenCanvas(w, h);
      this.blobCtx = this.blobCanvas.getContext('2d')!;
    }
    this.blobCtx!.drawImage(bitmap, 0, 0);
    // Draw is synchronous, we can safely close the bitmap immediately freeing GPU RAM.
    bitmap.close();
    return this.blobCanvas.convertToBlob({ 
        type: 'image/webp', 
        quality: this.options.imageQuality ?? 0.8 
    });
  }

  private static hammingDistance(a: bigint, b: bigint): number {
    let xor = a ^ b, dist = 0;
    while (xor > 0n) { if (xor & 1n) dist++; xor >>= 1n; }
    return dist;
  }

  private isDuplicate(hash: bigint): boolean {
    if (this.savedHashes.length === 0) return false;
    return SlideExtractor.hammingDistance(this.savedHashes[this.savedHashes.length - 1], hash)
      <= this.options.dhashDuplicateThreshold;
  }

  /**
   * RAM MEASUREMENT (Commented out)
   * We previously used performance.measureUserAgentSpecificMemory(), but it requires
   * strict COOP/COEP (require-corp) headers which can break cross-origin resources.
   * Fallbacks to WASM memory only measure ~25MB (missing the 300MB+ in GPU/Decoder bounds).
   * Rather than showing wildly inaccurate numbers based on the user's browser security context,
   * we've removed this metric for now.
   */
  private updateMetrics(_decoderQueueSize: number = 0) {
    // Left empty for future implementation if a reliable sync API ever emerges.
  }
}

