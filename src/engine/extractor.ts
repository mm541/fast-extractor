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
 *     Condition 4: color-only change — edges identical but avg RGB shifted ≥ 50
 *                  (dark mode toggle, background color swap)
 *
 *   NOISE SUPPRESSION:
 *     - Blank frames (brightness < blankBrightnessThreshold) are skipped
 *     - Duplicate slides are suppressed via 64-bit dHash comparison
 *     - Cumulative drift resets after noiseResetFrames without a trigger
 *
 * TWO EXTRACTION MODES:
 *   TURBO:    Decode only keyframes (IDR). ~10-20s for a 1-hour video.
 *             One pipelined VideoDecoder (no per-frame flush — see perf warning).
 *             
 *
 *   SEQUENTIAL: Decode EVERY frame in 300s (5-min) chunks. ~120-150s for a 1-hour video.
 *             Decoder is recycled per chunk to bound RAM.
 *             
 *
 * WASM BUFFER LAYOUT:
 *   init_arena() allocates four buffers in WASM linear memory:
 *     [buffer_a: 424×240 gray] [buffer_b: 424×240 gray]
 *     [buffer_prev: 424×240 gray] [rgba_buffer: 424×240×4 RGBA]
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
 *   Comparison always happens at 424×240 (CMP_W × CMP_H) regardless of
 *   the input video resolution. This is intentional — higher resolution
 *   doesn't improve slide detection accuracy but massively increases cost.
 *   maxFrameWidth only affects the ORIGINAL file decoding, not comparison.
 *
 * 💡 CONSIDERATION: ACCURATE MODE BACKPRESSURE (Promise.race + 5s timeout)
 *   The accurate mode backpressure loop (decodeQueueSize >= 3) uses a
 *   Promise.race with a 5s timeout as a deadlock safety net. Hardware
 *   decoders on mobile can silently drop frames, causing the output
 *   callback to never fire and pendingResolve to hang forever. The 5s
 *   timeout breaks the deadlock. In normal operation, the callback fires
 *   within milliseconds so the timeout never triggers. This is NOT the
 *   same bottleneck as the turbo per-frame flush — it's only backpressure,
 *   not a synchronous barrier. If you want to optimize accurate mode
 *   further, consider switching to `decodeQueueSize`-only polling (like
 *   turbo mode) — but test thoroughly on mobile hardware first.
 *
 * 💡 CONSIDERATION: DUAL-EMIT MODEL (emitBitmap + emitBitmapAsync)
 *   Hot-loop emissions use fire-and-forget emitBitmap() — it calls
 *   renderBitmapToBlob().then() without awaiting. This is safe because:
 *   (1) the ImageBitmap is .close()'d synchronously inside renderBitmapToBlob,
 *   so GPU memory is freed immediately, and (2) minSlideDuration (default 3s)
 *   guarantees a minimum gap between emissions, so WebP encodes (50-200ms)
 *   never overlap. If you ever reduce minSlideDuration to 0, this assumption
 *   breaks and you'd need to serialize the encode calls.
 *
 *   The FINAL candidate uses emitBitmapAsync() — an awaitable version that
 *   ensures the blob is fully encoded before extract() returns. Without this,
 *   worker.terminate() (triggered by ALL_DONE) would kill the worker while
 *   convertToBlob is still pending, silently dropping the last slide.
 *   The worker also drains any in-flight fire-and-forget onSlide callbacks
 *   via a pendingSlideEncodes counter before sending ALL_DONE.
 *
 * 💡 CONSIDERATION: DUPLICATE DETECTION — LAST HASH ONLY
 *   isDuplicate() only compares against the LAST saved hash, not all of
 *   them. This is intentional: consecutive dedup filters codec artifacts
 *   between keyframes, while still allowing a presenter to revisit an
 *   earlier slide (A → B → A) and have it captured as a new timeline event.
 *   Global dedup would silently swallow legitimate revisits and create
 *   unexplained gaps in the timeline. If you need global dedup for a
 *   specific use case, check against savedHashes[0..N] — but be aware
 *   it becomes O(N) per frame and changes the user-facing behavior.
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
 *
 *   sampleFps (0.2-10, default 1) [sequential mode only]
 *     Frame sampling rate for sequential mode.
 *     1 = compare 1 frame per second (default).
 *     0.5 = one frame every 2 seconds (faster, less precise).
 *     Ignored in turbo mode (turbo always decodes every keyframe).
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
  blankBrightnessThreshold: number;     // skip frames darker than this (0-255)
  cumulativeDriftMultiplier: number;    // cumulative drift must reach blockThreshold * this
  cumulativeSettledFrames: number;      // frames of stability before emitting on drift or partial match
  partialThresholdRatio: number;        // fraction of blockThreshold for partial match (0-1)
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
  
  /** Encoded image quality (0.01 - 1.0). Default: 0.8 */
  imageQuality?: number;
  /** Output format for extracted slides. Default: 'jpeg' */
  imageFormat?: 'webp' | 'jpeg';
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
  peakRamMb: number;
  avgFrameProcessTimeMs: number;
  /** Last video frame timestamp in seconds — used to compute last slide's endMs */
  lastFrameTimestamp?: number;
  /** Video duration in seconds from the demuxer — used for accurate last slide endMs */
  videoDurationSec?: number;
}

export const DEFAULT_OPTIONS: SlideExtractorOptions = {
  mode: 'turbo', sampleFps: 1,
  edgeThreshold: 30, blockThreshold: 8, densityThresholdPct: 4,
  minSlideDuration: 3, dhashDuplicateThreshold: 4,
  // Three-pointer defaults
  blankBrightnessThreshold: 8,
  cumulativeDriftMultiplier: 2,
  cumulativeSettledFrames: 2,
  partialThresholdRatio: 0.5,
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
  compute_color_signature: () => bigint;
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

  // Chunk-fed decoder state
  private decoder: VideoDecoder | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  private videoDuration = 0;
  private chunkCount = 0;
  private lastKeyframeTs = -1;
  private lastReportTs = 0;
  private pendingBackpressureResolve: (() => void) | null = null;

  // VideoDecoder requires a keyframe after configure() or flush().
  // Without this gate, delta frames after a decoder reset trigger an infinite
  // error → close → recreate → error loop that floods the console and stalls the pipeline.
  private needsKeyframe = true;

  // Sequential mode: sampleFps gating. Decode every frame (reference chain)
  // but only run processFrameSync at sampleFps rate. Frames between samples
  // are frame.close()'d immediately in the decoder output callback.
  // This was the original pre-refactor architecture (nextCaptureTime + interval).
  private nextCaptureTime = 0;

  // processedFrames tracks only frames that pass the sampleFps gate and run
  // through the WASM pipeline — used for accurate avgFrameProcessTimeMs.
  // totalFrames (in metrics) counts ALL decoded frames including skipped ones.
  private processedFrames = 0;

  private metrics: ExtractionMetrics = {
    startTime: 0, totalFrames: 0, totalSlides: 0, peakRamMb: 0, avgFrameProcessTimeMs: 0
  };

  // Placeholder dimensions to prevent NaN logic crashes during startup.
  // These are immediately overwritten with exact dimensions when demuxer loads.
  private videoWidth = 1920;
  private videoHeight = 1080;

  constructor(wasm: WasmModule, options?: Partial<SlideExtractorOptions>) {
    this.wasm = wasm;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.wasm.init_arena();
  }

  /**
   * Configure the internal VideoDecoder. Must be called before feedChunk().
   * Accepts a VideoDecoderConfig from the demuxer (e.g., web-demuxer's getDecoderConfig).
   *
   * In turbo mode, attempts to use 'prefer-software' to avoid opaque GPU textures
   * that render as black frames on OffscreenCanvas in workers.
   *
   * @param config - VideoDecoderConfig from the demuxer
   * @param videoDuration - Total video duration in seconds (for progress reporting)
   */
  public async configure(config: VideoDecoderConfig, videoDuration: number = 0) {
    this.metrics = { startTime: performance.now(), totalFrames: 0, totalSlides: 0, peakRamMb: 0, avgFrameProcessTimeMs: 0 };
    this.processedFrames = 0;
    this.hasBaseline = false;
    this.savedHashes = [];
    this.lastEmitPromise = Promise.resolve();
    if (this.pendingCandidate) { this.pendingCandidate.bitmap.close(); }
    this.pendingCandidate = null;
    this.lastSlideTime = -10;
    this.needsKeyframe = true;
    this.nextCaptureTime = 0;
    // Reset robustness state
    this.noiseFloor = 0;
    this.calibrationSamples = [];
    this.isCalibrated = false;
    this.prevColorSig = null;

    this.cumulativeDrift = 0;
    this.driftFrames = 0;
    this.staticCount = 0;

    this.videoWidth = config.codedWidth || 1920;
    this.videoHeight = config.codedHeight || 1080;
    this.videoDuration = videoDuration;

    // Turbo: prefer-software decoder to avoid opaque GPU textures that
    // drawImage() reads as black frames on OffscreenCanvas in workers.
    // Sequential: uses default (hardware) acceleration since it decodes
    // every frame and needs the throughput.
    const baseConfig = { ...config, optimizeForLatency: true };
    let decoderConfig: VideoDecoderConfig = baseConfig;
    if (this.options.mode === 'turbo') {
      try {
        const swConfig = { ...baseConfig, hardwareAcceleration: 'prefer-software' as const };
        const supported = await VideoDecoder.isConfigSupported(swConfig);
        if (supported.supported) decoderConfig = swConfig;
      } catch { /* browser doesn't support isConfigSupported — use default */ }
    }
    this.decoderConfig = decoderConfig;

    // Create the decoder
    this.decoder = this.makeDecoder();
  }

  /**
   * Feed one encoded video chunk into the decoder pipeline.
   * The chunk will be decoded and processed via processFrameSync().
   *
   * In turbo mode: caller should only feed keyframes.
   * In sequential mode: caller feeds all frames at sampleFps rate.
   *
   * Handles backpressure internally — will block if decode queue is full.
   */
  public async feedChunk(data: ArrayBuffer, timestamp: number, type: 'key' | 'delta') {
    if (!this.decoder || !this.decoderConfig) {
      throw new Error('SlideExtractor.configure() must be called before feedChunk()');
    }

    this.chunkCount++;
    const tsSec = timestamp / 1e6;

    // Skip duplicate keyframes in turbo mode
    if (this.options.mode === 'turbo' && type === 'key') {
      if (tsSec === this.lastKeyframeTs) return;
      this.lastKeyframeTs = tsSec;
    }

    // Gate: after configure() or decoder reset, skip delta frames until a keyframe
    // arrives. Without this, every delta frame triggers "A key frame is required
    // after configure() or flush()", the decoder closes, gets recreated, and the
    // next delta errors again — an infinite loop that stalls the entire pipeline.
    if (this.needsKeyframe && type !== 'key') return;
    if (type === 'key') this.needsKeyframe = false;

    // If previous error killed the decoder, spin up a fresh one
    if (this.decoder.state === 'closed') {
      this.decoder = this.makeDecoder();
    }

    // Backpressure: prevent memory blowout
    const maxQueue = this.options.mode === 'turbo' ? 12 : 3;
    if (this.options.mode === 'turbo') {
      while (this.decoder.state !== 'closed' && this.decoder.decodeQueueSize > maxQueue) {
        await new Promise(r => setTimeout(r, 5));
      }
    } else {
      // Sequential backpressure with 500ms deadlock safety net.
      // Hardware decoders on mobile can silently drop frames, causing
      // pendingBackpressureResolve to hang forever. 500ms is long enough
      // for normal decode latency but short enough to not stall the pipeline.
      while (this.decoder.state !== 'closed' && this.decoder.decodeQueueSize >= maxQueue) {
        await Promise.race([
          new Promise<void>(r => { this.pendingBackpressureResolve = r; }),
          new Promise<void>(r => setTimeout(r, 500))
        ]);
      }
    }

    // Decode
    if (this.decoder.state === 'closed') {
      this.decoder = this.makeDecoder();
    }
    try {
      const chunk = new EncodedVideoChunk({
        type,
        timestamp,
        data,
      });
      this.decoder.decode(chunk);
    } catch (e: any) {
      console.warn(`${this.options.mode} decode error (skipping chunk):`, e);
    }

    // Progress reporting
    if (tsSec >= this.lastReportTs + 1 && this.videoDuration > 0) {
      this.updateMetrics(this.decoder.decodeQueueSize);
      this.options.onProgress(
        Math.min((tsSec / this.videoDuration) * 100, 99.9),
        `${this.options.mode === 'turbo' ? 'Turbo' : 'Sequential'}: ${Math.floor(tsSec)}s / ${Math.floor(this.videoDuration)}s`,
        this.metrics
      );
      this.lastReportTs = tsSec;
    }
  }

  /**
   * Flush the decoder pipeline and emit the final pending candidate.
   * Must be called when the demuxer has no more chunks to send.
   * Returns the final extraction metrics.
   */
  public async flush(): Promise<ExtractionMetrics> {
    // Flush remaining queued frames
    if (this.decoder && this.decoder.state !== 'closed') {
      await this.decoder.flush();
      this.decoder.close();
    }
    this.decoder = null;

    // Flush last buffered candidate (turbo deferred-emit)
    // MUST await here — fire-and-forget would race against worker termination.
    const lc = this.pendingCandidate as { bitmap: ImageBitmap; timestamp: number; hash: bigint } | null;
    if (lc) {
      this.savedHashes.push(lc.hash);
      await this.emitBitmapAsync(lc.bitmap, lc.timestamp);
      this.pendingCandidate = null;
    }

    // Await all queued background encodes to prevent dropping slides
    // when the worker terminates
    await this.lastEmitPromise;

    this.metrics.videoDurationSec = this.videoDuration;
    this.metrics.endTime = performance.now();
    this.options.onProgress(100, "Done", this.metrics);
    return this.metrics;
  }

  // ─── Internal decoder management ───

  private makeDecoder(): VideoDecoder {
    const d = new VideoDecoder({
      output: (frame) => {
        const ts = frame.timestamp / 1e6;

        // Sequential sampleFps gating: decode every frame (reference chain)
        // but only process at sampleFps rate. This was the original architecture
        // before the Phase 2 refactor accidentally dropped it.
        if (this.options.mode === 'sequential' && ts < this.nextCaptureTime) {
          frame.close();
          // Still resolve backpressure so feedChunk doesn't stall
          if (this.pendingBackpressureResolve) {
            const r = this.pendingBackpressureResolve;
            this.pendingBackpressureResolve = null;
            r();
          }
          return;
        }

        const t0 = performance.now();
        try {
          this.processFrameSync(frame, ts);
          // Only update avg for frames that actually ran through the WASM pipeline
          if (this.processedFrames > 0) {
            this.metrics.avgFrameProcessTimeMs =
              (this.metrics.avgFrameProcessTimeMs * (this.processedFrames - 1) + (performance.now() - t0))
              / this.processedFrames;
          }
        } catch (e) {
          console.warn(`${this.options.mode}: processFrameSync threw (skipping frame):`, e);
          // Safety net: close the frame if processFrameSync threw before its
          // own frame.close() path ran. Double-close is a harmless no-op.
          try { frame.close(); } catch {}
        }

        // Advance the capture gate for sequential mode
        if (this.options.mode === 'sequential') {
          this.nextCaptureTime = ts + (1 / (this.options.sampleFps || 1));
        }

        // Resolve backpressure waiter (sequential mode)
        if (this.pendingBackpressureResolve) {
          const r = this.pendingBackpressureResolve;
          this.pendingBackpressureResolve = null;
          r();
        }
      },
      error: (e) => {
        console.warn(`${this.options.mode} decode pipeline error:`, e);
        // Re-engage keyframe gate so the next decoder doesn't get fed delta frames
        this.needsKeyframe = true;
        if (this.pendingBackpressureResolve) {
          const r = this.pendingBackpressureResolve;
          this.pendingBackpressureResolve = null;
          r();
        }
      }
    });
    d.configure(this.decoderConfig!);
    return d;
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

    // Track frames that actually run through the WASM pipeline (for accurate metrics)
    this.processedFrames++;

    // ⚠️ CRITICAL: frame.close() MUST be called on every path.
    // Wrapping in try/finally guarantees no GPU memory leak even if
    // shift_current_to_prev() or captureFrameToRgba() throws.
    try {
      this.wasm.shift_current_to_prev();
      this.captureFrameToRgba(frame);
    } finally {
      frame.close();
    }

    // === Frame closed. Only WASM buffers from here. ===

    // Step 2: Compute color signature in WASM (before grayscale conversion)
    const colorSigPacked = this.wasm.compute_color_signature();
    const colorSig: [number, number, number] = [
      Number((colorSigPacked >> 48n) & 0xFFFFn),
      Number((colorSigPacked >> 32n) & 0xFFFFn),
      Number((colorSigPacked >> 16n) & 0xFFFFn),
    ];

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
      this.staticCount >= this.options.cumulativeSettledFrames
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
  private static readonly CMP_W = 424;
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
    // ⚠️ CRITICAL: Hardware GPUs (used in accurate mode) can return frames where
    // displayWidth AND codedWidth are BOTH 0/undefined. Triple fallback chain:
    //   1. displayWidth (standard, works on software decoders)
    //   2. codedWidth (fallback for hardware decoders that omit display dimensions)
    //   3. this.videoWidth (from demuxer container metadata — always reliable)
    const sourceW = frame.displayWidth || frame.codedWidth || this.videoWidth;
    const sourceH = frame.displayHeight || frame.codedHeight || this.videoHeight;
    const targetW = this.options.exportResolution || sourceW;
    const targetH = Math.round(targetW * (sourceH / sourceW)) || sourceH;
    
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

  private lastEmitPromise: Promise<void> = Promise.resolve();

  private emitBitmap(bitmap: ImageBitmap, timestamp: number) {
    // Chain encodes sequentially to prevent concurrent access to the shared
    // OffscreenCanvas, ensuring strict timestamp ordering and preventing
    // OOM spikes from massive concurrent convertToBlob calls.
    this.lastEmitPromise = this.lastEmitPromise.then(async () => {
      try {
        const blob = await this.renderBitmapToBlob(bitmap);
        this.options.onSlide(blob, timestamp);
        this.metrics.totalSlides++;
      } catch (e) {
        console.warn('emitBitmap: image encode failed (skipping slide):', e);
      }
    });
  }

  /**
   * Awaitable version of emitBitmap — used ONLY for the final candidate flush
   * at extraction end. Enqueues the final candidate and returns the promise
   * for the entire chain.
   */
  private emitBitmapAsync(bitmap: ImageBitmap, timestamp: number): Promise<void> {
    this.emitBitmap(bitmap, timestamp);
    return this.lastEmitPromise;
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
    const fmt = this.options.imageFormat === 'webp' ? 'image/webp' : 'image/jpeg';
    return this.blobCanvas.convertToBlob({ 
        type: fmt, 
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

  private updateMetrics(decoderQueueSize: number = 0) {
    // 1. WASM Linear Memory (exact byte length of our ArrayBuffer)
    const wasmRamMb = this.wasm.memory.buffer.byteLength / 1e6;

    // 2. Decoder buffers & WebCodecs queue
    // Each frame in WebCodecs queue holds raw GPU pixels. Worst case: RGBA.
    // Use exact dimensions from the video demuxer to prevent false readings.
    const frameSizeMb = (this.videoWidth * this.videoHeight * 4) / 1e6;
    // FFmpeg/Demuxer baseline overhead is roughly ~30MB.
    const decoderOverheadMb = 30 + (decoderQueueSize * frameSizeMb);

    // 3. Fallback to performance.memory if available for V8 JS Heap
    const jsHeapMb = (performance as any).memory?.usedJSHeapSize 
      ? (performance as any).memory.usedJSHeapSize / 1e6 
      : 15; // default 15MB assumption if OS security policy blocks API

    const totalEstimatedMb = wasmRamMb + decoderOverheadMb + jsHeapMb;

    this.metrics.peakRamMb = Math.max(this.metrics.peakRamMb, Math.round(totalEstimatedMb));
  }
}

