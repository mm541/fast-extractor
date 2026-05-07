/**
 * ============================================================================
 * pipeline.ts — OPFS File Ingestion & Video Demuxing Pipeline
 * ============================================================================
 *
 * Internal helper functions that handle the heavy lifting:
 *   1. ingestFile()         — Streams the user's video into OPFS
 *   2. extractVideoChunks() — Triggers video extraction on the Worker via ffmpeg-wasm-demuxer
 *   3. cleanupTempFile()    — Deletes the temp video after extraction
 *
 * These functions are NOT part of the public API. They are only used by
 * FastExtractor.ts internally.
 */

import type { FastExtractorOptions } from '../types/types';

// ─── File Ingestion ───

/**
 * Stream a File object into OPFS for stable, cross-origin access.
 * On Android, SAF file handles can expire if not read immediately,
 * so we pipe the file's ReadableStream directly into OPFS on ingest.
 */
export async function ingestFile(
  file: File,
  tempFileName: string,
  onProgress: (status: string, progress: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('OPFS is not supported in this browser.');
  }

  const root = await navigator.storage.getDirectory();
  const feDir = await root.getDirectoryHandle('.fast_extractor', { create: true });
  const fileHandle = await feDir.getFileHandle(tempFileName, { create: true });
  const writable = await fileHandle.createWritable();

  // Use a native TransformStream as a zero-copy progress counter.
  // pipeTo() lets the browser handle backpressure and chunk scheduling
  // internally, which is significantly faster than a manual read/write loop.
  let offset = 0;
  let lastReportTime = Date.now();
  onProgress('Ingesting Media: 0%', 0);

  const progressTracker = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      offset += chunk.byteLength;
      const now = Date.now();
      if (now - lastReportTime > 250) {
        const pct = Math.floor((offset / file.size) * 100);
        onProgress(`Ingesting Media: ${pct}%`, pct);
        lastReportTime = now;
      }
      controller.enqueue(chunk);
    },
  });

  try {
    // Android SAF: pipe the file immediately before permissions expire
    await file.stream().pipeThrough(progressTracker).pipeTo(writable, { signal });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Clean up OPFS temp file if we created it (direct File path)
      try {
        const root = await navigator.storage.getDirectory();
        const feDir = await root.getDirectoryHandle('.fast_extractor');
        await feDir.removeEntry(tempFileName);
      } catch {}
      throw err;
    }
    throw new Error(`FILE_ACCESS_EXPIRED: ${err.message}`);
  }
}

// ─── Video Chunk Extraction ───

/**
 * Trigger video slide extraction on the Worker via the new FFmpeg WASM demuxer.
 *
 * Unlike the old pipeline, this does NOT read the file or stream packets.
 * The Worker now owns the entire demuxing pipeline internally using
 * ffmpeg-wasm-demuxer with OPFS SyncAccessHandle for maximum throughput.
 *
 * Backpressure is handled entirely within the Worker thread via
 * `await slideExtractor.feedChunk()` — zero cross-thread messaging required.
 */
export async function extractMedia(
  worker: Worker, 
  options: FastExtractorOptions, 
  tempFileName: string,
  originalFileName: string,
): Promise<void> {
  try {
    worker.postMessage({ type: 'STATUS', status: 'Initializing Demuxer...' });

    // Get the OPFS file handle to pass to the worker
    const root = await navigator.storage.getDirectory();
    const feDir = await root.getDirectoryHandle('.fast_extractor');
    const fileHandle = await feDir.getFileHandle(tempFileName);

    // Send the EXTRACT_VIDEO command — the worker handles everything from here.
    // The worker will:
    //   1. Open the file via OPFS SyncAccessHandle
    //   2. Init FFmpegDemuxer and probe the container
    //   3. Configure WebCodecs VideoDecoder
    //   4. Run the packet loop with same-thread backpressure
    //   5. Flush and emit ALL_DONE when complete
    worker.postMessage({
      type: 'EXTRACT_MEDIA',
      fileHandle,
      extractAudio: options.extractAudio !== false,
      extractSlides: options.extractSlides !== false,
      buildManifest: options.buildManifest ?? false,
      fileName: originalFileName,
      mode: options.mode ?? 'turbo',
    });

    // NOTE: We do NOT await ALL_DONE here.
    // The FastExtractor.ts onmessage handler catches ALL_DONE
    // and calls controller.close(). Awaiting here would deadlock.
  } catch (err: any) {
    throw new Error(`Video extraction failed: ${err.message}`);
  }
}

// ─── Temp File Cleanup ───

/**
 * Delete the temporary video file from OPFS after extraction completes.
 * Only deletes the named video file — leaves other artifacts intact.
 * Lifecycle note: only called for the direct File path (non-pre-ingested).
 * Pre-ingested files are cleaned up explicitly by calling resetApp / cleanupStorage, and direct File paths auto-clean.
 */
export async function cleanupTempFile(
  tempFileName: string
): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const feDir = await root.getDirectoryHandle('.fast_extractor');
    await feDir.removeEntry(tempFileName);
    console.log(`[WorkspaceManager] Cleaned up temp file: ${tempFileName}`);
  } catch (e) {
    console.warn(`[WorkspaceManager] Failed to cleanup ${tempFileName}:`, e);
  }
}
