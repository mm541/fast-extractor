/**
 * ============================================================================
 * extractor.ts — Slide Extraction Orchestrator
 * ============================================================================
 *
 * ⚠️ CRITICAL ARCHITECTURE HAZARDS: WEBCODECS DECODER INVARIANTS
 * 1. OOM Hazard: Mobile hardware decoders crash if fed too many chunks. `maxQueue`
 *    MUST be kept low (e.g. 5) in sequential mode.
 * 2. Dropped-Frame Deadlock: Mobile decoders silently drop frames under load.
 *    Wiring backpressure to the `output` callback causes deadlocks. You MUST use
 *    `ondequeue` to instantly resolve backpressure regardless of dropped frames.
 * 3. Batching Starvation: Hardware decoders batch frames (B-frame reordering).
 *    If `maxQueue` is 5, but the decoder waits for 10 frames before outputting, 
 *    the pipeline starves and locks up. You MUST use `optimizeForLatency: true` 
 *    to force strict 1-in-1-out processing.
 * See `docs/WEBCODECS_HAZARDS.md` for detailed explanations.
 *
 * ============================================================================
 *
 * This class is the thin orchestrator that connects WebCodecs decoding to the
 * detection engine. The heavy lifting is delegated to:
 *
 *   core/WasmBridge.ts    — WASM memory interactions (pixel ingestion, comparison)
 *   core/SlideDetector.ts — Detection state machine (three-pointer, stability gate)
 *   core/ImageRenderer.ts — Canvas capture & WebP/JPEG encoding
 *   core/types.ts         — Shared types, interfaces, default config
 *
 * ⚠️ CRITICAL: VIDEOFRAME LIFETIME
 *   VideoFrame objects hold GPU-backed textures (~1-4MB each).
 *   They MUST be closed immediately after pixel extraction.
 *   processFrame() closes the frame in a finally{} block.
 *   If you add any new code path that receives a VideoFrame,
 *   ALWAYS ensure frame.close() is called even on error paths.
 *
 * CONFIGURATION REFERENCE:
 *   edgeThreshold (10-100, default 30)
 *     Per-pixel luminance difference required to count as "changed".
 *     Lower = more sensitive to subtle changes. Higher = more noise-tolerant.
 *
 *   blockThreshold (0.01-64.0, default 12)
 *     Weighted score of 8×8 grid blocks that must change to trigger a new slide.
 *     Continuous: a block that changes by 2× the density threshold contributes 2.0.
 *
 *   densityThresholdPct (1-50, default 5)
 *     Percentage of pixels within a single block that must differ.
 *     5% = at least 5% of the block's pixels must have changed.
 *
 *   minSlideDuration (1-30s, default 3)
 *     Minimum seconds between two slide emissions.
 *     Prevents rapid-fire emissions during animations.
 *
 *   dhashDuplicateThreshold (0-20, default 4)
 *     Hamming distance for dHash comparison (64-bit perceptual hash).
 *     Two slides with distance ≤ this value are considered duplicates.
 *     0 = exact match only, 4 = tolerant of minor differences.
 *
 *   sampleFps (0.2-10, default 1) [sequential mode only]
 *     Frame sampling rate for sequential mode.
 *     1 = compare 1 frame per second (default).
 *     Ignored in turbo mode (turbo always decodes every keyframe).
 */

import {
  WasmBridge, CMP_W, CMP_H,
  ImageRenderer,
  SlideDetector,
  DEFAULT_OPTIONS,
} from './core';
import type {
  SlideExtractorOptions,
  ExtractionMetrics,
  WasmModule,
} from './core';

// Re-export everything consumers need
export { DEFAULT_OPTIONS, CMP_W, CMP_H };
export type { SlideExtractorOptions, ExtractionMetrics, WasmModule };

/**
 * ARCHITECTURE: Stream + selective keyframe decode.
 *
 * Stream ALL packets from demuxer (fast sequential I/O, zero round-trips).
 * Only DECODE packets that are keyframes near our sample times.
 * Everything else is skipped at zero cost.
 */
export class SlideExtractor {
  private options: SlideExtractorOptions;
  private bridge: WasmBridge;
  private renderer: ImageRenderer;
  private detector: SlideDetector;

  // Chunk-fed decoder state
  private decoder: VideoDecoder | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  private videoDuration = 0;
  private chunkCount = 0;
  private lastKeyframeTs = -1;
  private lastReportTs = 0;
  private pendingBackpressureResolve: (() => void) | null = null;

  // VideoDecoder requires a keyframe after configure() or flush().
  private needsKeyframe = true;

  // Sequential mode: sampleFps gating
  private nextCaptureTime = 0;

  // processedFrames tracks only frames that pass the sampleFps gate
  private processedFrames = { value: 0 };

  private metrics: ExtractionMetrics = {
    startTime: 0, totalFrames: 0, totalSlides: 0, peakRamMb: 0, avgFrameProcessTimeMs: 0
  };

  // Placeholder dimensions — overwritten by configure()
  private videoWidth = 1920;
  private videoHeight = 1080;

  constructor(wasm: WasmModule, options?: Partial<SlideExtractorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.bridge = new WasmBridge(wasm);
    this.renderer = new ImageRenderer(this.options, this.metrics);
    this.detector = new SlideDetector(this.options, this.bridge, this.renderer, this.metrics);
    wasm.init_arena();
  }

  /**
   * Configure the internal VideoDecoder. Must be called before feedChunk().
   * Accepts a VideoDecoderConfig from the demuxer.
   *
   * In turbo mode, attempts to use 'prefer-software' to avoid opaque GPU textures
   * that render as black frames on OffscreenCanvas in workers.
   */
  public async configure(config: VideoDecoderConfig, videoDuration: number = 0) {
    this.metrics = { startTime: performance.now(), totalFrames: 0, totalSlides: 0, peakRamMb: 0, avgFrameProcessTimeMs: 0 };
    this.processedFrames = { value: 0 };
    this.needsKeyframe = true;
    this.nextCaptureTime = 0;

    this.videoWidth = config.codedWidth || 1920;
    this.videoHeight = config.codedHeight || 1080;
    this.videoDuration = videoDuration;

    // Propagate state to sub-modules
    this.renderer.setMetrics(this.metrics);
    this.renderer.setVideoDimensions(this.videoWidth, this.videoHeight);
    this.renderer.resetEmitChain();
    this.detector.reset(this.metrics);

    // Turbo: prefer-software decoder to avoid opaque GPU textures that
    // drawImage() reads as black frames on OffscreenCanvas in workers.
    // Both modes MUST use optimizeForLatency: true to force 1-in-1-out decoding.
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

    // Backpressure: prevent memory blowout
    const maxQueue = 12;
    while (this.decoder.state !== 'closed' && this.decoder.decodeQueueSize >= maxQueue) {
      await Promise.race([
        new Promise<void>(r => { this.pendingBackpressureResolve = r; }),
        new Promise<void>(r => setTimeout(r, 15))
      ]);
    }

    // Gate: skip delta frames until a keyframe arrives after configure/reset
    if (this.needsKeyframe && type !== 'key') return;
    if (type === 'key') this.needsKeyframe = false;

    // Decode
    if (this.decoder.state === 'closed') {
      this.decoder = this.makeDecoder();
    }
    try {
      const chunk = new EncodedVideoChunk({ type, timestamp, data });
      this.decoder.decode(chunk);
    } catch (e: any) {
      console.warn(`${this.options.mode} decode error (skipping chunk):`, e);
      this.needsKeyframe = true;
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
   * Returns the final extraction metrics.
   */
  public async flush(): Promise<ExtractionMetrics> {
    if (this.decoder && this.decoder.state !== 'closed') {
      await this.decoder.flush();
      this.decoder.close();
    }
    this.decoder = null;

    this.detector.flushFinalSlide();
    await this.renderer.drainPending();

    this.metrics.videoDurationSec = this.videoDuration;
    this.metrics.endTime = performance.now();
    this.metrics.jobElapsedMs = this.metrics.endTime - this.metrics.startTime;
    this.options.onProgress(100, "Done", this.metrics);
    return this.metrics;
  }

  /**
   * Forcibly release all hardware resources if an error aborts extraction.
   */
  public destroy() {
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch {}
    }
    this.decoder = null;
    this.detector.destroy();
    if (this.pendingBackpressureResolve) {
      try { this.pendingBackpressureResolve(); } catch {}
      this.pendingBackpressureResolve = null;
    }
  }

  // ─── Internal decoder management ───

  private makeDecoder(): VideoDecoder {
    const d = new VideoDecoder({
      output: (frame) => {
        const ts = frame.timestamp / 1e6;

        // Sequential sampleFps gating: decode every frame (reference chain)
        // but only process at sampleFps rate.
        if (this.options.mode === 'sequential' && ts < this.nextCaptureTime) {
          frame.close();
          return;
        }

        const t0 = performance.now();
        try {
          this.detector.processFrame(frame, ts, this.processedFrames);
          if (this.processedFrames.value > 0) {
            this.metrics.avgFrameProcessTimeMs =
              (this.metrics.avgFrameProcessTimeMs * (this.processedFrames.value - 1) + (performance.now() - t0))
              / this.processedFrames.value;
          }
        } catch (e) {
          console.warn(`${this.options.mode}: processFrame threw (skipping frame):`, e);
          try { frame.close(); } catch {}
        }

        // Advance the capture gate for sequential mode
        if (this.options.mode === 'sequential') {
          this.nextCaptureTime = ts + (1 / (this.options.sampleFps || 1));
        }
      },
      error: (e) => {
        console.warn(`${this.options.mode} decode pipeline error:`, e);
        this.needsKeyframe = true;
        if (this.pendingBackpressureResolve) {
          const r = this.pendingBackpressureResolve;
          this.pendingBackpressureResolve = null;
          r();
        }
      }
    });

    d.ondequeue = () => {
      if (this.pendingBackpressureResolve) {
        const r = this.pendingBackpressureResolve;
        this.pendingBackpressureResolve = null;
        r();
      }
    };

    d.configure(this.decoderConfig!);
    return d;
  }

  // ─── Metrics ───

  private updateMetrics(decoderQueueSize: number = 0) {
    const wasmRamMb = this.bridge.memory.buffer.byteLength / 1048576;
    const frameSizeMb = (this.videoWidth * this.videoHeight * 4) / 1048576;
    const decoderOverheadMb = 30 + (decoderQueueSize * frameSizeMb);

    let clonedFramesCount = 0;
    if (this.detector.lastProcessedFrame) clonedFramesCount++;
    const retainedFramesMb = clonedFramesCount * frameSizeMb;

    const compareCanvasMb = (CMP_W * CMP_H * 4) / 1048576;
    const exportDims = this.renderer.getExportCanvasDimensions();
    const exportCanvasMb = exportDims
      ? (exportDims.width * exportDims.height * 4) / 1048576
      : 0;

    const jsHeapMb = 15;
    const currentEstimatedMb = wasmRamMb + decoderOverheadMb + retainedFramesMb + compareCanvasMb + exportCanvasMb + jsHeapMb;

    this.metrics.peakRamMb = Math.max(this.metrics.peakRamMb, Math.round(currentEstimatedMb));
    this.metrics.jobElapsedMs = performance.now() - this.metrics.startTime;
  }
}
