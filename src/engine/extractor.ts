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
 *     Condition 1: mainChanges ≥ blockThreshold  (absolute divergence from baseline)
 *                  Optionally filtered by camera shake detector.
 *     Condition 2: color-only change — edges identical but avg RGB shifted ≥ threshold
 *                  (dark mode toggle, background color swap)
 *
 *   NOISE SUPPRESSION:
 *     - Blank frames (brightness < blankBrightnessThreshold) are skipped
 *     - Duplicate slides are suppressed via 64-bit dHash comparison
 *     - Baseline is always updated on trigger (even duplicate rejection) to prevent
 *       infinite re-triggering
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
 * 💡 CONSIDERATION: BASE64 WASM CHUNKING (String.fromCharCode += loop)
 *   The demuxer WASM binary (~2MB) is converted to a data: URL via a
 *   += string concatenation loop. This looks inefficient (quadratic string
 *   growth), but it runs exactly ONCE per extraction during the
 *   "Initializing Demuxer..." phase. The alternative (array.join) saves
 *   ~50-100ms on mobile but adds code complexity for a one-time cost.
 *   The chunking (32KB per iteration) exists to prevent call stack
 *   overflow — String.fromCharCode.apply() crashes if given >64K args.
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
 *   sampleFps (0.2-10, default 1) [sequential mode only]
 *     Frame sampling rate for sequential mode.
 *     1 = compare 1 frame per second (default).
 *     0.5 = one frame every 2 seconds (faster, less precise).
 *     Ignored in turbo mode (turbo always decodes every keyframe).
 */
import { WebDemuxer } from 'web-demuxer';

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
  // Color-aware detection
  colorChangeThreshold: number;         // max(|ΔR|,|ΔG|,|ΔB|) to trigger color-only slide (0=disabled)
  // Camera shake filter
  shakeFilterStrictMultiplier: number;  // density multiplier for shake confirmation (0=disabled)
  // Region-of-interest masking
  ignoreMask: bigint;                   // 64-bit bitmask: bit (row*8+col)=1 skips that grid block
  
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
  // Color detection: 25 = detect shifts where any channel moves >25/255
  colorChangeThreshold: 25,
  // Shake filter: 3 = confirm with 3× density. 0 = disabled
  shakeFilterStrictMultiplier: 3,
  // Grid masking: 0n = compare all 64 blocks (no masking)
  ignoreMask: 0n,
  imageQuality: 0.8,
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
 * ARCHITECTURE: Two Pipeline Modes
 *
 * 1. Turbo Mode (Keyframes only)
 *    Stream packets from demuxer. Only pass `type === 'key'` chunks to the VideoDecoder.
 *    Reduces decode workload by dropping all P and B packets before decoding.
 *    Tradeoff: Can land on blurry crossfades if a keyframe coincides with a transition.
 *
 * 2. Sequential Mode (Sampled FPS)
 *    Stream packets and decode every frame, but only send frames to WASM at `sampleFps`.
 *    Slower, but perfectly accurate for live-coding and fast transitions.
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


  // Color-aware detection — tracks average RGB to detect color-only changes
  private prevColorSig: [number, number, number] | null = null;




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

  public async extract(file: File, demuxerWasmUrl: string) {
    this.metrics = { startTime: performance.now(), totalFrames: 0, totalSlides: 0, peakRamMb: 0, avgFrameProcessTimeMs: 0 };
    this.hasBaseline = false;
    this.savedHashes = [];
    this.lastSlideTime = -10;
    this.prevColorSig = null;

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
        : (1 / (this.options.sampleFps || 1));

      await this.extractKeyframes(demuxer, duration, interval);

      this.metrics.videoDurationSec = duration;
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
    this.videoWidth = config.codedWidth || 1920;
    this.videoHeight = config.codedHeight || 1080;
    
    let packetCount = 0;
    let decodedCount = 0;
    let lastReport = 0;

    if (this.options.mode === 'turbo') {
      // TURBO: Decode ALL keyframes via streaming.
      // Keyframes are IDR (self-contained) so pipelining them is 100% safe.
      // We keep 'prefer-software' because hardware decoders output opaque GPU
      // textures that render as black frames on OffscreenCanvas in Web Workers.
      // Software decoding returns CPU-backed frames that drawImage can read.
      const baseConfig = { ...config as VideoDecoderConfig, optimizeForLatency: true };
      let turboDecoderConfig: VideoDecoderConfig = baseConfig;
      try {
        const swConfig = { ...baseConfig, hardwareAcceleration: 'prefer-software' as const };
        const supported = await VideoDecoder.isConfigSupported(swConfig);
        if (supported.supported) turboDecoderConfig = swConfig;
      } catch { /* browser doesn't support isConfigSupported — use default */ }

      const makeTurboDecoder = () => {
        const d = new VideoDecoder({
          output: (frame) => {
            decodedCount++;
            const ts = frame.timestamp / 1e6;
            const t0 = performance.now();
            try {
              this.processFrameSync(frame, ts);
              this.metrics.avgFrameProcessTimeMs =
                (this.metrics.avgFrameProcessTimeMs * (this.metrics.totalFrames - 1) + (performance.now() - t0))
                / this.metrics.totalFrames;
            } catch (e) {
              // Gracefully skip bad frames instead of crashing the entire worker.
              // processFrameSync closes the frame in its own finally{} block.
              console.warn('Turbo: processFrameSync threw (skipping frame):', e);
            }
          },
          error: (e) => {
            console.warn('Turbo decode pipeline error:', e);
            // Decoder state becomes 'closed', main loop spins up a fresh one on next frame
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

            // Backpressure: prevent memory blowout if demuxer vastly outpaces decoding.
            // Also gives the browser event loop time to fire output callbacks.
            while (decoder.state !== 'closed' && decoder.decodeQueueSize > 5) {
              await new Promise(r => setTimeout(r, 5));
            }

            try {
              // ⚠️ CRITICAL PERFORMANCE WARNING ⚠️
              // DO NOT add `await decoder.flush()` or synchronous `Promise.race()` calls here!
              //
              // History: In commit 1c3de0f, per-frame flush() was added. Paired with 4bb3d27 
              // ('prefer-software'), this destroyed turbo mode performance, taking a 25s run 
              // to 48s because it forced the multi-threaded software decoder to run 100% 
              // sequentially, stalling the pipeline on every single frame.
              //
              // Let the decoder run freely. `decodeQueueSize` handles backpressure above.
              // A dropped frame simply skips the callback and continues normally.
              decoder.decode(value);
            } catch (e: any) {
              console.warn('Turbo decode error (skipping keyframe):', e);
              continue;
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
        
        // Wait for all remaining queued frames in the pipeline to be outputted
        if (decoder.state !== 'closed') {
          await decoder.flush();
        }
      } finally {
        if (decoder.state !== 'closed') decoder.close();
      }
      this.metrics.totalFrames = packetCount;

    } else {
      // ACCURATE: Full decode of EVERY frame. ~120-150s for 1-hour video.
      // Catches 100% of transitions including between keyframes.
      // Chunked: 300s (5-minute) segments with decoder recycling to bound RAM.
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
              try {
                this.processFrameSync(frame, ts);
                this.metrics.avgFrameProcessTimeMs =
                  (this.metrics.avgFrameProcessTimeMs * (this.metrics.totalFrames - 1) + (performance.now() - t0))
                  / this.metrics.totalFrames;
              } catch (e) {
                // Gracefully skip bad frames instead of crashing the entire worker.
                // processFrameSync closes the frame in its own finally{} block.
                console.warn('Sequential: processFrameSync threw (skipping frame):', e);
              }
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
      this.metrics.totalFrames = packetCount;
    }
  }



  /**
   * Process a single decoded frame: extract pixels, compare, capture.
   * Frame is ALWAYS closed at the end.
   *
   * Integrates: color detection, camera shake filter.
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
    const { edgeThreshold, densityThresholdPct, blockThreshold } = this.options;

    // Pointer 1→3: Baseline (A) vs Current (B)
    const mask = this.options.ignoreMask;
    const mainChanges = this.wasm.compare_frames(edgeThreshold, densityThresholdPct, mask);


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

    // Condition 1: Absolute Divergence — enough blocks changed from baseline
    if (mainChanges >= blockThreshold) {
      // --- Camera Shake Filter (optional) ---
      // If the change is diffuse (all blocks changed a little), it's shake, not a slide.
      // Confirm with a stricter density check: if few blocks pass 3× density, it's shake.
      if (this.options.shakeFilterStrictMultiplier > 0 && mainChanges < blockThreshold * 2) {
        const strictDensity = Math.min(densityThresholdPct * this.options.shakeFilterStrictMultiplier, 100);
        const strictChanges = this.wasm.compare_frames(edgeThreshold, strictDensity, mask);
        if (strictChanges >= blockThreshold * 0.3) {
          shouldEmit = true; // Concentrated change → real slide
        } else {
          // Shake filter rejected — update baseline anyway to prevent
          // infinite re-evaluation on every subsequent frame.
          this.copyBufferBToA();
        }
      } else {
        // Shake filter disabled OR change is overwhelming (≥2× threshold) → bypass filter
        shouldEmit = true;
      }
    }
    // Condition 2: Color-only change
    else if (
      mask !== 0xFFFFFFFFFFFFFFFFn &&
      colorDelta >= this.options.colorChangeThreshold
    ) {
      shouldEmit = true;
    }

    if (shouldEmit) {
      const dhash = this.wasm.compute_dhash(true);
      if (!this.isDuplicate(dhash)) {
        this.savedHashes.push(dhash);
        this.emitSlideFromCanvas(timestamp);
        this.lastSlideTime = timestamp;
      }
      // CRITICAL: Always update baseline A to current B after a trigger,
      // even if it was rejected as a duplicate. Otherwise, A vs B remains high
      // and triggers an infinite loop of dhash computations on every frame!
      this.copyBufferBToA();
    }
  }

  // ===================== Helpers =====================

  // Comparison canvas: small for fast WASM processing
  private static readonly CMP_W = 424;
  private static readonly CMP_H = 240;


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
    }).catch(e => {
      // Prevent unhandled promise rejection from crashing the worker.
      // convertToBlob can fail under mobile memory pressure or unsupported formats.
      console.warn('emitBitmap: WebP encode failed (skipping slide):', e);
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

