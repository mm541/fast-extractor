/**
 * ============================================================================
 * core/SlideDetector.ts — Slide Detection State Machine
 * ============================================================================
 *
 * The "brain" of the extraction engine. Implements the Three-Pointer
 * drift detection algorithm and the Stability Gate (deferred emit).
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
 *
 *   NOISE SUPPRESSION:
 *     - Duplicate slides are suppressed via 64-bit dHash comparison
 *     - Cumulative drift resets after noiseResetSeconds without a trigger
 *
 * STABILITY GATE (Deferred Emit):
 *   When Condition 1 fires, the frame is NOT emitted immediately. Instead,
 *   it is buffered as a "candidate." On the NEXT frame, we check if the
 *   content has settled (driftBlocks ≤ threshold). If settled, we emit the
 *   current (clean) frame with the candidate's timestamp. This prevents
 *   capturing blurry mid-transition frames.
 *
 * 💡 CONSIDERATION: DUPLICATE DETECTION — LAST HASH ONLY
 *   isDuplicate() only compares against the LAST saved hash, not all of
 *   them. This is intentional: consecutive dedup filters codec artifacts
 *   between keyframes, while still allowing a presenter to revisit an
 *   earlier slide (A → B → A) and have it captured as a new timeline event.
 *   Global dedup would silently swallow legitimate revisits and create
 *   unexplained gaps in the timeline.
 */

import type { SlideExtractorOptions, ExtractionMetrics } from '../types';
import type { WasmBridge } from './WasmBridge';
import type { ImageRenderer } from './ImageRenderer';

export class SlideDetector {
  private options: SlideExtractorOptions;
  private bridge: WasmBridge;
  private renderer: ImageRenderer;
  private metrics: ExtractionMetrics;

  // Detection state
  private hasBaseline = false;
  private savedHashes: bigint[] = [];
  private lastSlideTime = -10;

  // Deferred emit (Stability Gate)
  private pendingCandidate: { frame: VideoFrame; timestamp: number } | null = null;
  
  // Reference to last processed frame for flush() end-of-video logic
  lastProcessedFrame: VideoFrame | null = null;

  // Three-pointer cumulative drift tracking
  private cumulativeDrift = 0;
  private settledSinceTime = -1;
  private driftStartTime = 0;

  constructor(
    options: SlideExtractorOptions,
    bridge: WasmBridge,
    renderer: ImageRenderer,
    metrics: ExtractionMetrics,
  ) {
    this.options = options;
    this.bridge = bridge;
    this.renderer = renderer;
    this.metrics = metrics;
  }

  /** Reset all detection state (called on configure). */
  reset(metrics: ExtractionMetrics) {
    this.metrics = metrics;
    this.hasBaseline = false;
    this.savedHashes = [];
    this.lastSlideTime = -10;
    this.cumulativeDrift = 0;
    this.settledSinceTime = -1;
    if (this.pendingCandidate) {
      try { this.pendingCandidate.frame.close(); } catch {}
      this.pendingCandidate = null;
    }
    if (this.lastProcessedFrame) {
      try { this.lastProcessedFrame.close(); } catch {}
      this.lastProcessedFrame = null;
    }
  }

  /**
   * Process a single decoded frame: extract pixels, compare, capture.
   * Frame is ALWAYS closed at the end.
   *
   * Integrates: adaptive noise floor, color detection, camera shake filter.
   */
  processFrame(frame: VideoFrame, timestamp: number, processedFrames: { value: number }) {
    this.metrics.totalFrames++;
    this.metrics.lastFrameTimestamp = timestamp;
    processedFrames.value++;

    // ⚠️ CRITICAL: frame.close() MUST be called on every path.
    // Wrapping in try/finally guarantees no GPU memory leak even if
    // shift_current_to_prev() or captureFrameToRgba() throws.
    try {
      this.bridge.shiftCurrentToPrev();
      this.bridge.captureFrameToRgba(frame);

    // === Frame captured. Only WASM buffers from here. ===

    // Convert RGBA → grayscale for block comparison
    this.bridge.convertRgbaToGray();

    if (!this.hasBaseline) {
      this.bridge.copyBufferBToA();
      this.savedHashes.push(this.bridge.computeDhash());
      this.renderer.emitSlideFromFrame(frame, timestamp);
      this.hasBaseline = true;
      this.lastSlideTime = timestamp;
      return;
    }

    // === THREE-POINTER COMPARISON (both modes) ===
    const { edgeThreshold, densityThresholdPct, blockThreshold } = this.options;

    // Pointer 1→3: Baseline (A) vs Current (B)
    const mask = this.options.ignoreMask;
    const mainChanges = this.bridge.compareFrames(edgeThreshold, densityThresholdPct, mask);

    // Pointer 2→3: Previous (Prev) vs Current (B) — consecutive drift
    const driftBlocks = this.bridge.comparePrevCurrent(edgeThreshold, densityThresholdPct, mask);

    // --- Transition Filter (Deferred Emit) ---
    let candidateConfirmedThisFrame = false;
    if (this.options.useDeferredEmit && this.pendingCandidate) {
      const allowedDrift = Math.max(1, Math.floor(blockThreshold * 0.3));
      const candidateAge = timestamp - this.pendingCandidate.timestamp;
      
      if (driftBlocks <= allowedDrift || candidateAge >= 15) {
        // SETTLED (or timed out after 15s of continuous movement).
        // Emit the CURRENT frame (clean/settled) with the timestamp from
        // when the transition was first detected.
        // Timeout prevents infinite starvation for "always-moving" content
        // like handwriting videos where driftBlocks never drops to zero.
        // 15s (not 5s) to avoid short-circuiting turbo mode where keyframes
        // are 5-10s apart — the stability gate needs 2-3 keyframes to settle.
        const dhash = this.bridge.computeDhash();
        if (!this.isDuplicate(dhash)) {
          this.savedHashes.push(dhash);
          this.renderer.emitSlideFromFrame(frame, this.pendingCandidate.timestamp);
        }
        // Always advance baseline and timing, even on duplicate.
        // Without this, a duplicate hash freezes the baseline permanently.
        this.bridge.copyBufferBToA();
        this.lastSlideTime = timestamp;
        
        this.pendingCandidate.frame.close();
        this.pendingCandidate = null;
        
        // Reset drift metrics because a transition just finished
        this.cumulativeDrift = 0;
        this.settledSinceTime = -1;
        candidateConfirmedThisFrame = true;
      }
    }

    // Track cumulative drift
    const staticDriftLimit = Math.max(2, Math.floor(blockThreshold * 0.15));
    if (driftBlocks > staticDriftLimit) {
      if (this.cumulativeDrift === 0) {
        this.driftStartTime = timestamp;
      }
      this.cumulativeDrift += driftBlocks;
      this.settledSinceTime = -1; // content is still moving
    } else {
      // Content is stable — mark when it first settled
      if (this.settledSinceTime < 0) this.settledSinceTime = timestamp;
    }

    // Reset drift if too long without trigger (prevents webcam noise buildup).
    // Runs BEFORE cooldown so drift doesn't accumulate unchecked during cooldown.
    if (
      !candidateConfirmedThisFrame &&
      this.cumulativeDrift > 0 &&
      (timestamp - this.driftStartTime) > this.options.noiseResetSeconds &&
      mainChanges < Math.floor(blockThreshold * this.options.noiseMainRatio)
    ) {
      this.cumulativeDrift = 0;
      this.settledSinceTime = -1;
    }

    // === EMIT CONDITIONS ===
    const timeSinceLastSlide = timestamp - this.lastSlideTime;
    const minTime = this.options.minSlideDuration;

    if (timeSinceLastSlide < minTime) {
      return;
    }

    let shouldEmit = false;
    let emitInstantly = false;
    let emitTimestamp = timestamp;

    if (!candidateConfirmedThisFrame && !this.pendingCandidate) {
      // Condition 1: Direct threshold — A vs B shows big change
      if (mainChanges >= blockThreshold) {
        shouldEmit = true;
      }

      // Condition 2: Cumulative drift — small changes piled up AND content settled
      if (
        !shouldEmit &&
        this.cumulativeDrift >= blockThreshold * this.options.cumulativeDriftMultiplier &&
        mainChanges >= Math.max(1, Math.floor(blockThreshold * 0.5)) &&
        this.settledSinceTime >= 0 && (timestamp - this.settledSinceTime) >= this.options.cumulativeSettledSeconds
      ) {
        shouldEmit = true;
        emitInstantly = true;
        emitTimestamp = this.driftStartTime;
      }
    }

    if (shouldEmit) {
      if (this.options.useDeferredEmit && !emitInstantly) {
        if (this.pendingCandidate) {
          this.pendingCandidate.frame.close();
        }
        this.pendingCandidate = {
          frame: frame.clone(),
          timestamp: emitTimestamp,
        };
      } else {
        const dhash = this.bridge.computeDhash();
        if (!this.isDuplicate(dhash)) {
          this.savedHashes.push(dhash);
          this.renderer.emitSlideFromFrame(frame, emitTimestamp);
        }
        // Always advance baseline, even on duplicate (prevents baseline freeze)
        this.bridge.copyBufferBToA();
        this.lastSlideTime = emitTimestamp;
        this.cumulativeDrift = 0;
        this.settledSinceTime = -1;
      }
    }

    } finally {
      if (this.lastProcessedFrame) this.lastProcessedFrame.close();
      this.lastProcessedFrame = frame.clone();
      frame.close();
    }
  }

  /**
   * Flush the final pending candidate or check for end-of-video drift.
   * Called by SlideExtractor.flush() when the video ends.
   */
  flushFinalSlide() {
    if (this.pendingCandidate) {
      this.renderer.emitSlideFromFrame(this.pendingCandidate.frame, this.pendingCandidate.timestamp);
      this.pendingCandidate.frame.close();
      this.pendingCandidate = null;
    } else if (this.metrics.lastFrameTimestamp !== undefined && this.lastProcessedFrame) {
      // If the video ended in the middle of a slow drawing transition, it never reached the 
      // staticCount required to trigger Condition 2 or 3.
      // We check if the final frame (Buffer B) is meaningfully different from the last emitted slide (Buffer A).
      const mainChanges = this.bridge.compareFrames(
        this.options.edgeThreshold, 
        this.options.densityThresholdPct, 
        this.options.ignoreMask
      );
      
      const partialThreshold = Math.floor(this.options.blockThreshold * 0.5);
      
      if (mainChanges >= partialThreshold) {
        // Emit the final state of the video
        const emitTs = this.cumulativeDrift > 0 ? this.driftStartTime : this.metrics.lastFrameTimestamp;
        this.renderer.emitSlideFromFrame(this.lastProcessedFrame, emitTs);
      }
    }

    if (this.lastProcessedFrame) {
      this.lastProcessedFrame.close();
      this.lastProcessedFrame = null;
    }
  }

  /** Forcibly release GPU resources (VideoFrame clones). */
  destroy() {
    if (this.lastProcessedFrame) {
      try { this.lastProcessedFrame.close(); } catch {}
      this.lastProcessedFrame = null;
    }
    if (this.pendingCandidate) {
      try { this.pendingCandidate.frame.close(); } catch {}
      this.pendingCandidate = null;
    }
  }

  // ─── Helpers ───

  private static hammingDistance(a: bigint, b: bigint): number {
    let xor = a ^ b, dist = 0;
    while (xor > 0n) { if (xor & 1n) dist++; xor >>= 1n; }
    return dist;
  }

  private isDuplicate(hash: bigint): boolean {
    if (this.savedHashes.length === 0) return false;
    return SlideDetector.hammingDistance(this.savedHashes[this.savedHashes.length - 1], hash)
      <= this.options.dhashDuplicateThreshold;
  }
}
