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
 */

import type { WasmModule } from '../types';

/** Comparison resolution — must match ARENA_WIDTH/ARENA_HEIGHT in lib.rs */
export const CMP_W = 854;
export const CMP_H = 480;

export class WasmBridge {
  private wasm: WasmModule;
  private compareCanvas: OffscreenCanvas | null = null;
  private compareCtx: OffscreenCanvasRenderingContext2D | null = null;

  constructor(wasm: WasmModule) {
    this.wasm = wasm;
  }

  /**
   * Copy VideoFrame pixels into the WASM RGBA buffer.
   * Does NOT convert to grayscale yet — call convertRgbaToGray() after.
   */
  captureFrameToRgba(frame: VideoFrame) {
    if (!this.compareCanvas) {
      this.compareCanvas = new OffscreenCanvas(CMP_W, CMP_H);
      this.compareCtx = this.compareCanvas.getContext('2d', { willReadFrequently: true })!;
      this.compareCtx.imageSmoothingEnabled = false;
    }
    this.compareCtx!.drawImage(frame, 0, 0, CMP_W, CMP_H);
    const { data } = this.compareCtx!.getImageData(0, 0, CMP_W, CMP_H);
    const ptr = this.wasm.get_rgba_buffer_ptr();
    new Uint8Array(this.wasm.memory.buffer, ptr, CMP_W * CMP_H * 4).set(data);
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
