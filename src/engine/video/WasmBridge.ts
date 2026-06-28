/**
 * ============================================================================
 * core/WasmBridge.ts — WASM Memory Bridge
 * ============================================================================
 *
 * Manages all direct interaction with the WASM linear memory arena:
 *   - OffscreenCanvas setup for the comparison canvas (854×480)
 *   - VideoFrame → RGBA pixel extraction into the WASM buffer
 *   - RGBA → Grayscale conversion
 *   - Buffer B → Buffer A copy (baseline update)
 *
 * ⚠️ CRITICAL: CANVAS REUSE
 *   compareCanvas is created once and reused for ALL frames.
 *   DO NOT create new OffscreenCanvas per frame — that causes GC pressure
 *   and GPU memory fragmentation leading to OOM on mobile.
 *
 * ⚠️ CRITICAL: RESOLUTION
 *   Comparison always happens at 854×480 (CMP_W × CMP_H) regardless of
 *   the input video resolution. This is intentional — higher resolution
 *   doesn't improve slide detection accuracy but massively increases cost.
 *
 * ⚠️ ALLOCATION NOTE
 *   getImageData() allocates a new ~1.6MB ImageData object per frame.
 *   This is a platform limitation of the Canvas 2D API — there is no
 *   method to read pixels into an existing buffer. The WASM target view
 *   is cached and only recreated if WASM memory grows (buffer detach).
 */

import type { WasmModule } from '../types';

/** Comparison resolution — must match ARENA_WIDTH/ARENA_HEIGHT in lib.rs */
export const CMP_W = 854;
export const CMP_H = 480;
const RGBA_BYTE_LENGTH = CMP_W * CMP_H * 4;

export class WasmBridge {
  private wasm: WasmModule;
  private compareCanvas: OffscreenCanvas | null = null;
  private compareCtx: OffscreenCanvasRenderingContext2D | null = null;

  // ── Cached pixel transfer objects (zero-alloc after first frame) ──
  /** Reusable target view into WASM rgba_buf. Recreated only on memory growth. */
  private wasmRgbaView: Uint8Array | null = null;
  /** Tracks the ArrayBuffer identity to detect WASM memory growth/detach. */
  private lastWasmBuffer: ArrayBuffer | null = null;

  constructor(wasm: WasmModule) {
    this.wasm = wasm;
  }

  /**
   * Copy VideoFrame pixels into the WASM RGBA buffer.
   * Does NOT convert to grayscale yet — call convertRgbaToGray() after.
   *
   * Hot path: after the first frame, the only allocation is the browser-internal
   * ImageData from getImageData(). The WASM target view is fully cached.
   */
  captureFrameToRgba(frame: VideoFrame): void {
    if (!this.compareCanvas) {
      this.compareCanvas = new OffscreenCanvas(CMP_W, CMP_H);
      this.compareCtx = this.compareCanvas.getContext('2d', { willReadFrequently: true })!;
      this.compareCtx.imageSmoothingEnabled = false;
    }

    // 1. Hardware-accelerated downscale (GPU → CPU-backed canvas buffer)
    this.compareCtx!.drawImage(frame, 0, 0, CMP_W, CMP_H);

    // 2. Extract raw RGBA pixels from the canvas
    const { data } = this.compareCtx!.getImageData(0, 0, CMP_W, CMP_H);

    // 3. Ensure our WASM view is valid (recreate only if memory grew/detached)
    const currentBuffer = this.wasm.memory.buffer;
    if (currentBuffer !== this.lastWasmBuffer) {
      const ptr = this.wasm.get_rgba_buffer_ptr();
      this.wasmRgbaView = new Uint8Array(currentBuffer, ptr, RGBA_BYTE_LENGTH);
      this.lastWasmBuffer = currentBuffer;
    }

    // 4. Copy pixels directly into WASM arena (single memcpy, zero intermediate alloc)
    this.wasmRgbaView!.set(data);
  }

  /** Convert RGBA buffer to grayscale into buffer B. Call after captureFrameToRgba. */
  convertRgbaToGray() {
    this.wasm.copy_rgba_to_gray(true);
  }

  /** Copy buffer B → buffer A (update baseline to current frame). */
  copyBufferBToA() {
    const size = CMP_W * CMP_H;
    const buf = this.wasm.memory.buffer;
    new Uint8Array(buf, this.wasm.get_buffer_a_ptr(), size).set(
      new Uint8Array(buf, this.wasm.get_buffer_b_ptr(), size)
    );
  }

  /** Rotate: Current → Previous (so we always have the previous frame). */
  shiftCurrentToPrev() {
    this.wasm.shift_current_to_prev();
  }

  /** Edge-density grid comparison: Baseline (A) vs Current (B). */
  compareFrames(edgeThreshold: number, densityPct: number, mask: bigint): number {
    return this.wasm.compare_frames(edgeThreshold, densityPct, mask);
  }

  /** Edge-density grid comparison: Previous vs Current (B). */
  comparePrevCurrent(edgeThreshold: number, densityPct: number, mask: bigint): number {
    return this.wasm.compare_prev_current(edgeThreshold, densityPct, mask);
  }

  /** Compute 64-bit perceptual hash of buffer B (current frame). */
  computeDhash(): bigint {
    return this.wasm.compute_dhash(true);
  }

  /** Get the raw WASM module (for metrics access to memory.buffer). */
  get memory(): WebAssembly.Memory {
    return this.wasm.memory;
  }
}
