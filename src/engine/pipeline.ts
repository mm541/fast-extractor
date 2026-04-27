/**
 * ============================================================================
 * pipeline.ts — OPFS File Ingestion & Video Demuxing Pipeline
 * ============================================================================
 *
 * Internal helper functions that handle the heavy lifting:
 *   1. ingestFile()         — Streams the user's video into OPFS
 *   2. extractVideoChunks() — Demuxes video packets and streams them to the Worker
 *   3. cleanupTempFile()    — Deletes the temp video after extraction
 *
 * These functions are NOT part of the public API. They are only used by
 * FastExtractor.ts internally.
 */

import { WebDemuxer } from 'web-demuxer';
import type { FastExtractorOptions } from './types';

// ─── File Ingestion ───

/**
 * Stream a File object into OPFS for stable, cross-origin access.
 * On Android, SAF file handles can expire if not read immediately,
 * so we pipe the file's ReadableStream directly into OPFS on ingest.
 */
export async function ingestFile(
  file: File,
  tempFileName: string,
  onProgress: (status: string, progress: number) => void
): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('OPFS is not supported in this browser.');
  }

  const root = await navigator.storage.getDirectory();
  const feDir = await root.getDirectoryHandle('.fast_extractor', { create: true });
  const fileHandle = await feDir.getFileHandle(tempFileName, { create: true });
  
  // createWritable is available on the main thread
  const writable = await fileHandle.createWritable();
  
  // Android SAF: pipe the file immediately
  const stream = file.stream();
  const reader = stream.getReader();
  let offset = 0;
  
  onProgress('Ingesting Media: 0%', 0);
  let lastReportTime = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      await writable.write(value);
      offset += value.byteLength;
      
      if (Date.now() - lastReportTime > 250) {
        const pct = Math.floor((offset / file.size) * 100);
        onProgress(`Ingesting Media: ${pct}%`, pct);
        lastReportTime = Date.now();
      }
    }
  } catch (err: any) {
    throw new Error(`FILE_ACCESS_EXPIRED: ${err.message}`);
  } finally {
    await writable.close();
  }
}

// ─── Video Chunk Extraction ───

/**
 * Demux the ingested video file and stream encoded video packets to the Worker.
 * Implements cross-thread backpressure to prevent main-thread flooding.
 *
 * In turbo mode, only keyframes are forwarded (~10x fewer packets).
 */
export async function extractVideoChunks(
  worker: Worker, 
  options: FastExtractorOptions, 
  tempFileName: string, 
  getUnacked: () => number, 
  incUnacked: () => void,
  waitForAck: () => Promise<void>
): Promise<void> {
  let demuxer: WebDemuxer | null = null;
  try {
    worker.postMessage({ type: 'STATUS', status: 'Initializing Demuxer...' });

    // Resolve the WASM URL relative to the current page.
    // We use a relative path ('wasm-files/...') and self.location.href to ensure
    // it resolves correctly whether hosted at the root (/) or a subpath (/audio-extractor/).
    const defaultUrl = 'wasm-files/web-demuxer.wasm';
    const rawUrl = options.demuxerWasmUrl ?? defaultUrl;
    const wasmUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, self.location.href).href;
    
    try {
      demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });

      // Read the file back from OPFS so demuxer has a stable reference
      const root = await navigator.storage.getDirectory();
      const feDir = await root.getDirectoryHandle('.fast_extractor');
      const fileHandle = await feDir.getFileHandle(tempFileName);
      const opfsFile = await fileHandle.getFile();

      await demuxer.load(opfsFile);
    } catch (err: any) {
      throw new Error(`Demuxer WASM Error: ${err.message}`);
    }
    
    const mediaInfo = await demuxer.getMediaInfo();
    const duration = mediaInfo.duration || 0;
    const decoderConfig = await demuxer.getDecoderConfig('video');

    // 1. Send config to worker
    worker.postMessage({ 
      type: 'CONFIG_DECODER', 
      config: decoderConfig, 
      duration 
    });

    // 2. Read packets and stream to worker
    const endTime = duration > 0 ? duration * 2 : 999999;
    const reader = demuxer.read('video', 0, endTime).getReader();
    let packetCount = 0;

    // Chrome throttles setTimeout to 1000ms in background tabs, which kills
    // the pipeline. MessageChannel.postMessage fires as a macrotask that is
    // NOT subject to timer throttling, so extraction runs at full speed
    // even when the user switches tabs.
    const yieldToEventLoop = (): Promise<void> => new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(null);
    });

    while (true) {
      // Cross-thread backpressure: Wait if the worker has too many chunks queued up.
      // We explicitly await a Promise resolved by the worker's onmessage handler
      // to completely suspend the main thread (0% CPU) instead of busy-waiting.
      while (getUnacked() >= 15) {
        await waitForAck();
      }

      const { done, value } = await reader.read();
      if (done || !value) break;

      if (options.mode === 'turbo' && value.type !== 'key') continue;

      // Extract raw bytes into an ArrayBuffer for zero-copy transfer
      const chunkData = new ArrayBuffer(value.byteLength);
      value.copyTo(chunkData);

      incUnacked();
      worker.postMessage({
        type: 'VIDEO_CHUNK',
        chunk: chunkData,
        timestamp: Number(value.timestamp),
        chunkType: value.type
      }, [chunkData]); // Zero-copy transfer!

      // Yield to browser every 50 packets so React can paint UI updates
      if (++packetCount % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    // 3. Signal completion
    worker.postMessage({ type: 'VIDEO_DONE' });

  } finally {
    if (demuxer) demuxer.destroy();
  }
}

// ─── Temp File Cleanup ───

/**
 * Delete the temporary video file from OPFS after extraction completes.
 * Only deletes the video — leaves slides.dat and audio.aac artifacts intact.
 */
export async function cleanupTempFile(
  options: FastExtractorOptions,
  tempFileName: string
): Promise<void> {
  if (options.cleanupAfterExtraction === false) return;
  
  try {
    const root = await navigator.storage.getDirectory();
    const feDir = await root.getDirectoryHandle('.fast_extractor');
    await feDir.removeEntry(tempFileName);
    console.log(`[WorkspaceManager] Cleaned up temp file: ${tempFileName}`);
  } catch (e) {
    console.warn(`[WorkspaceManager] Failed to cleanup ${tempFileName}:`, e);
  }
}
