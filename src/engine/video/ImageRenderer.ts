/**
 * ============================================================================
 * core/ImageRenderer.ts — Slide Image Capture & Encoding
 * ============================================================================
 *
 * Handles all Canvas operations for exporting detected slides:
 *   - Scaling VideoFrames to the user's exportResolution
 *   - Converting ImageBitmaps to WebP/JPEG Blobs
 *   - Sequential encode chaining to prevent concurrent canvas access
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
 *   The FINAL candidate uses drainPending() — an awaitable drain that
 *   ensures all blobs are fully encoded before extract() returns. Without this,
 *   worker.terminate() (triggered by ALL_DONE) would kill the worker while
 *   convertToBlob is still pending, silently dropping the last slide.
 */

import type { SlideExtractorOptions, ExtractionMetrics } from '../types';

export class ImageRenderer {
  private options: SlideExtractorOptions;
  private metrics: ExtractionMetrics;

  private exportCanvas: OffscreenCanvas | null = null;
  private exportCtx: OffscreenCanvasRenderingContext2D | null = null;
  private blobCanvas: OffscreenCanvas | null = null;
  private blobCtx: OffscreenCanvasRenderingContext2D | null = null;

  private lastEmitPromise: Promise<void> = Promise.resolve();

  // Video dimensions — set via setVideoDimensions() during configure()
  private videoWidth = 1920;
  private videoHeight = 1080;

  constructor(options: SlideExtractorOptions, metrics: ExtractionMetrics) {
    this.options = options;
    this.metrics = metrics;
  }

  setVideoDimensions(w: number, h: number) {
    this.videoWidth = w;
    this.videoHeight = h;
  }

  /** Update the metrics reference (called on configure reset). */
  setMetrics(metrics: ExtractionMetrics) {
    this.metrics = metrics;
  }

  /** Reset the encode chain (called on configure reset). */
  resetEmitChain() {
    this.lastEmitPromise = Promise.resolve();
  }

  /** Capture a VideoFrame at export resolution, emit as blob via onSlide. */
  emitSlideFromFrame(frame: VideoFrame, timestamp: number) {
    this.emitBitmap(this.captureExportBitmap(frame), timestamp);
  }

  /** Wait for all in-flight blob encodes to finish. */
  async drainPending(): Promise<void> {
    await this.lastEmitPromise;
  }

  /** Get the export canvas dimensions for RAM estimation. */
  getExportCanvasDimensions(): { width: number; height: number } | null {
    if (!this.exportCanvas) return null;
    return { width: this.exportCanvas.width, height: this.exportCanvas.height };
  }

  // ─── Internal ───

  private captureExportBitmap(frame: VideoFrame): ImageBitmap {
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
    return this.exportCanvas!.transferToImageBitmap();
  }

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
}
