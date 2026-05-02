/**
 * ============================================================================
 * FastExtractor.ts — Public Library API
 * ============================================================================
 * 
 * ⚠️ CRITICAL ARCHITECTURE HAZARD: THE 100% CPU BURN SPINLOOP
 * When yielding to the browser to bypass background tab throttling, DO NOT use
 * 0ms `MessageChannel` loops inside `while` loops (e.g. backpressure polling).
 * A 0ms `while` loop busy-waits 10,000+ times per second, pinning the main thread
 * to 100% CPU, melting the user's device, and starving the worker thread.
 * Backpressure MUST be resolved via explicit cross-thread Promises (e.g., `waitForAck`)
 * tied directly to the worker's `CHUNK_PROCESSED` event to suspend the main thread
 * at 0% CPU. See `docs/WEBCODECS_HAZARDS.md` for details.
 *
 * ============================================================================
 *
 * This is the clean, consumer-facing API that wraps the raw Worker internals.
 * It exposes a single class with a single method:
 *
 *   const extractor = new FastExtractor({ mode: 'turbo' });
 *   const stream = extractor.extract(videoFile);
 *
 *   // Option 1: Async iteration
 *   for await (const event of stream) { ... }
 *
 *   // Option 2: Pipe-based composition
 *   stream.pipeThrough(ocrTransform).pipeTo(uploadSink);
 *
 *   // Option 3: Manual reader
 *   const reader = stream.getReader();
 *   while (true) { const { done, value } = await reader.read(); ... }
 *
 * INTERNAL ARCHITECTURE:
 *   This file does NOT contain any extraction logic. It is a thin adapter
 *   that translates raw Worker postMessage events into a typed ReadableStream.
 *
 *   FastExtractor.extract(file)
 *     → creates Worker
 *     → sends CONFIG → INIT → START_INGEST handshake
 *     → converts onmessage events → stream.enqueue(typed event)
 *     → maps worker errors → stream.error()
 *     → handles cancellation → worker.terminate()
 *
 * ⚠️ RULES FOR FUTURE DEVELOPERS:
 *   1. This file must NEVER import from worker.ts directly.
 *      It only references the Worker via Vite's ?worker import.
 *   2. The worker protocol (message types) is the contract.
 *      If you change message types in worker.ts, update the switch below.
 *   3. This file must have ZERO React dependencies.
 *      It is framework-agnostic — usable in React, Vue, Svelte, or vanilla JS.
 *   4. Do NOT add state or caching here. Each extract() call is independent.
 */

// Vite handles worker bundling and asset URL resolution via these imports.
// ?worker → creates a bundled Worker constructor
// ?url    → returns a hashed asset URL (e.g. /assets/wasm-abc123.wasm)
import MediaWorker from './worker?worker';
import defaultWasmUrl from './wasm/wasm_extractor_bg.wasm?url';

// ─── Internal Imports ───
import { ExtractorError } from './errors';
import type { ExtractorErrorCode } from './errors';
import type {
  ExtractorEvent,
  ExtractorCallbacks,
  FastExtractorOptions,
  BrowserSupport,
  IngestedFile,
} from './types';
import { ingestFile, extractVideoChunks, cleanupTempFile } from './pipeline';

// ─── Main Class ───

/**
 * FastExtractor — the public API for video/audio extraction.
 *
 * Usage:
 *   const extractor = new FastExtractor({ mode: 'turbo' });
 *   for await (const event of extractor.extract(file)) {
 *     switch (event.type) {
 *       case 'audio':      handleAudioChunk(event.chunk); break;
 *       case 'audio_done': finalizeAudio(event.fileName); break;
 *       case 'slide':      displaySlide(event.imageBuffer, event.timestamp); break;
 *       case 'progress':   updateUI(event.percent, event.message); break;
 *     }
 *   }
 */
export class FastExtractor {
  private options: FastExtractorOptions;
  /** Guards against concurrent extractions with a shared worker */
  private _extracting = false;

  constructor(options?: FastExtractorOptions) {
    this.options = options ?? {};
  }

  /**
   * Check if the current browser supports the extraction engine.
   * Call this before creating an extractor to show appropriate UI.
   *
   * @example
   * const support = await FastExtractor.checkBrowserSupport();
   * if (!support.supported) {
   *   alert(support.reason);
   * }
   */
  static async checkBrowserSupport(): Promise<BrowserSupport> {
    const webCodecs = typeof VideoDecoder !== 'undefined';
    let opfs = false;

    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        await navigator.storage.getDirectory();
        opfs = true;
      }
    } catch { /* OPFS not available */ }

    const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
    const deviceMemoryGb = (navigator as any).deviceMemory ?? null;
    const hardwareConcurrency = navigator.hardwareConcurrency ?? 1;
    const webGpu = 'gpu' in navigator;
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const supported = webCodecs && opfs;
    let reason: string | undefined;

    if (!supported) {
      const missing: string[] = [];
      if (!webCodecs) missing.push('WebCodecs (VideoDecoder)');
      if (!opfs) missing.push('Origin Private File System (OPFS)');
      reason = `Browser missing required APIs: ${missing.join(', ')}. Use Chrome 102+ on desktop or Android.`;
    }

    return { webCodecs, opfs, offscreenCanvas, deviceMemoryGb, hardwareConcurrency, webGpu, isMobile, supported, reason };
  }

  /**
   * Statically ingests a video file into OPFS prior to extraction.
   * This is extremely useful on Android to prevent SAF "File Access Expired" errors,
   * as you can ingest the file immediately upon user selection.
   * 
   * @param file - The raw File object from the browser
   * @param options - Callbacks and cancellation signals
   * @returns An IngestedFile descriptor that can be passed directly to extract()
   */
  static async ingest(
    file: File, 
    options?: { 
      onProgress?: (percent: number, message: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<IngestedFile> {
    const tempFileName = `extract_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
    await ingestFile(file, tempFileName, (status, progress) => {
      options?.onProgress?.(progress, status);
    }, options?.signal);
    
    return {
      type: 'ingested_file',
      opfsFileName: tempFileName,
      originalName: file.name,
      size: file.size,
    };
  }

  /**
   * Manually clean up OPFS temp files left from previous extractions.
   * Only needed if you want to proactively free OPFS space.
   * In the normal flow, pre-ingested files are cleaned up when the consumer
   * calls resetApp / cleanupStorage, and direct File paths auto-clean.
   * Safe to call at any time — it's a no-op if no temp files exist.
   *
   * @example
   * // After you're done re-extracting with different settings:
   * await FastExtractor.cleanupStorage();
   */
  static async cleanupStorage(): Promise<void> {
    if (!navigator.storage?.getDirectory) return;
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      let feDir: FileSystemDirectoryHandle;
      try {
        feDir = await opfsRoot.getDirectoryHandle('.fast_extractor');
      } catch {
        return; // folder doesn't exist — nothing to clean
      }
      const entries: string[] = [];
      // @ts-ignore — OPFS entries()
      for await (const [name] of (feDir as any).entries()) {
        entries.push(name);
      }
      await Promise.all(entries.map(async (name) => {
        try {
          if (navigator.locks) {
            await navigator.locks.request(
              `fe_${name}`, { ifAvailable: true },
              async (lock) => {
                if (lock) await feDir.removeEntry(name);
              }
            );
          } else {
            await feDir.removeEntry(name);
          }
        } catch {}
      }));
    } catch (e) {
      console.warn('[FastExtractor] cleanupStorage failed:', e);
    }
  }

  /**
   * Extract audio and slides from a video file.
   * Returns a ReadableStream that emits ExtractorEvent objects.
   *
   * The stream completes when extraction is done.
   * Cancel the stream (or use an AbortSignal) to stop extraction early.
   *
   * @param input - The video File object or a pre-ingested file descriptor
   * @param signal - Optional AbortSignal for cancellation
   */
  extract(input: File | IngestedFile, signal?: AbortSignal): ReadableStream<ExtractorEvent> {
    // Guard: if using a shared custom worker, prevent concurrent extractions
    // that would corrupt the worker's module-scoped state (syncHandle, wasmBuffer, etc.)
    if (this._extracting && this.options.worker) {
      throw new ExtractorError(
        'ERR_WORKER_GENERIC',
        'Cannot run concurrent extractions with a shared worker. Wait for the current extraction to complete, or create a separate FastExtractor instance.'
      );
    }
    this._extracting = true;

    let worker: Worker | null = null;
    let tempFileName: string = '';
    const isPreIngested = 'type' in input && input.type === 'ingested_file';

    const stream = new ReadableStream<ExtractorEvent>({
      start: async (controller) => {
        try {
          // 1. Create worker instantly
          worker = this.options.worker ?? new MediaWorker();

          // 2. Handle abort signal
          if (signal) {
            signal.addEventListener('abort', () => {
              this._extracting = false;
              worker?.terminate();
              worker = null;
              try { controller.close(); } catch { /* stream already closed/errored */ }
              // Clean up OPFS temp file if we created it (direct File path)
              if (!isPreIngested && tempFileName) {
                cleanupTempFile(tempFileName).catch(() => {});
              }
            }, { once: true });
          }

          // 3. Configure — extract asset URLs from options before sending detection config
          const {
            mode = 'turbo',
            wasmUrl: _wasmUrl,           // consumed above, don't forward
            demuxerWasmUrl,              // forwarded to worker
            worker: _workerOpt,          // consumed above, don't forward
            extractAudio = true,         // default: extract audio
            extractSlides = true,        // default: extract slides
            buildManifest: _buildManifest, // consumed by audio pipeline, don't forward to slide detection
            ...detectionConfig
          } = this.options;

          worker.postMessage({
            type: 'CONFIG',
            data: { demuxerWasmUrl, extractAudio, extractSlides },
            config: { ...detectionConfig, mode },
          });

          // 5. Wire up message → stream translation
          const debugMode = this.options.debug ?? false;
          worker.onmessage = (e: MessageEvent) => {
            const { type } = e.data;

            if (debugMode) {
              console.log(`[FastExtractor:DEBUG] Worker → Main | type=${type}`, e.data);
            }

            try {
              switch (type) {
                case 'INIT_COMPLETE':
                  // Handshake acknowledged.
                  break;

                case 'AUDIO_CHUNK':
                  controller.enqueue({
                    type: 'audio',
                    chunk: e.data.buffer,
                  });
                  break;

                case 'AUDIO_DONE':
                  controller.enqueue({
                    type: 'audio_done',
                    fileName: e.data.fileName,
                    manifest: e.data.manifest ?? null,
                  });
                  break;

                case 'SLIDE':
                  controller.enqueue({
                    type: 'slide',
                    imageBuffer: e.data.buffer,
                    timestamp: e.data.timestamp,
                    startMs: e.data.startMs ?? 0,
                  });
                  break;

                case 'STATUS':
                  controller.enqueue({
                    type: 'progress',
                    percent: e.data.progress ?? -1,
                    message: e.data.status,
                    metrics: e.data.metrics,
                  });
                  break;

                case 'CHUNK_PROCESSED':
                  unackedChunks--;
                  if (unblockMainThread && unackedChunks < 15) {
                    unblockMainThread();
                    unblockMainThread = null;
                  }
                  break;

                case 'ALL_DONE':
                  // Emit final progress with metrics if available
                  if (e.data.metrics) {
                    controller.enqueue({
                      type: 'progress',
                      percent: 100,
                      message: 'Extraction Complete',
                      metrics: e.data.metrics,
                    });
                  }
                  this._extracting = false;
                  worker = null;
                  controller.close();
                  // Clean up OPFS temp file AFTER worker is fully done
                  if (!isPreIngested) {
                    cleanupTempFile(tempFileName).catch(() => {});
                  }
                  break;

                case 'ERROR': {
                  const errorMsg: string = e.data.error;
                  const errorCode: ExtractorErrorCode = e.data.code ?? 'ERR_WORKER_GENERIC';
                  const customError = new ExtractorError(errorCode, errorMsg);
                  
                  this._extracting = false;
                  // Don't terminate — worker self-closes after OPFS cleanup
                  worker = null;
                  controller.error(customError);
                  break;
                }
              }
            } catch (err) {
              // Stream already closed/errored — ignore late messages
            }
          };

          worker.onerror = (event) => {
            try {
              controller.error(new Error(`Worker Script Error: ${event.message || 'Failed to load worker (possible network drop)'}`));
            } catch { /* stream already closed */ }
            this._extracting = false;
            worker?.terminate();
            worker = null;
          };

          // =========================================================================================
          // ⚠️ CRITICAL ANDROID SAF WARNING ⚠️
          // Android SAF requires immediate reading of the File object.
          // We delegate to WorkspaceManager which calls File.stream() immediately.
          // WASM fetching happens concurrently in the background.
          // =========================================================================================

          // 6. Fetch WASM asynchronously in the background and send INIT when ready
          const resolvedWasmUrl = this.options.wasmUrl
            ?? new URL(defaultWasmUrl, self.location?.origin ?? 'https://localhost').href;
          
          fetch(resolvedWasmUrl)
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.arrayBuffer();
            })
            .then(wasmBuffer => {
              worker?.postMessage({ type: 'INIT', wasmBuffer }, [wasmBuffer]);
            })
            .catch(err => {
              try { controller.error(new Error(`Rust WASM Fetch Error: ${err.message}`)); } catch {}
              worker?.terminate();
              worker = null;
            });

          // 7. Ingest file to OPFS (or reuse pre-ingested handle)
          if (isPreIngested) {
            tempFileName = (input as IngestedFile).opfsFileName;
          } else {
            tempFileName = `extract_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
            
            // Ingest to OPFS. This pipes the File straight into an OPFS FileSystemSyncAccessHandle
            // which the worker can access synchronously.
            await ingestFile(input as File, tempFileName, (status, percent) => {
              controller.enqueue({
                type: 'progress',
                percent,
                message: status,
              });
            }, signal);
          }
          
          let unackedChunks = 0;
          let unblockMainThread: (() => void) | null = null;
          
          const runPipeline = async () => {
            try {
              // Trigger audio extraction on the worker
              if (this.options.extractAudio !== false) {
                const root = await navigator.storage.getDirectory();
                const feDir = await root.getDirectoryHandle('.fast_extractor');
                const fileHandle = await feDir.getFileHandle(tempFileName);

                await new Promise<void>((resolve, reject) => {
                  const handleAudioMessage = (e: MessageEvent) => {
                    if (e.data.type === 'AUDIO_DONE') {
                      worker!.removeEventListener('message', handleAudioMessage);
                      resolve();
                    } else if (e.data.type === 'ERROR') {
                      worker!.removeEventListener('message', handleAudioMessage);
                      reject(new Error(e.data.error));
                    }
                  };
                  worker!.addEventListener('message', handleAudioMessage);
                  worker!.postMessage({
                    type: 'EXTRACT_AUDIO',
                    fileName: isPreIngested ? (input as IngestedFile).originalName : (input as File).name,
                    fileHandle,
                    buildManifest: this.options.buildManifest ?? false,
                  });
                });
              }

              // Run video extraction pipeline
              if (this.options.extractSlides !== false) {
                  await extractVideoChunks(
                    worker!, 
                    this.options, 
                    tempFileName, 
                    () => unackedChunks, 
                    () => { unackedChunks++; },
                    () => new Promise<void>(r => { unblockMainThread = r; })
                  );
              } else {
                  worker!.postMessage({ type: 'VIDEO_DONE', skipped: true });
              }

              // NOTE: Do NOT await ALL_DONE here.
              // The stream's onmessage handler (line ~475) already catches ALL_DONE
              // and calls controller.close(). If we also awaited here, the onmessage
              // handler would set worker=null first, crashing our addEventListener
              // callback and deadlocking the pipeline forever.

            } finally {
              // NOTE: Do NOT clean up the OPFS file here.
              // The worker may still be flushing the decoder and encoding
              // the last slide. Cleanup happens in the ALL_DONE handler.
            }
          };

          const pipelinePromise = navigator.locks 
            ? navigator.locks.request(`fe_${tempFileName}`, runPipeline)
            : runPipeline();

          pipelinePromise.catch((err: any) => {
            // Pipeline will throw if SAF permissions expire or pipeline fails
            const msg = err?.message ?? String(err ?? 'Unknown pipeline error');
            this._extracting = false;
            worker = null;
            
            const isRecoverable = msg.includes('File ingest failed') || msg.includes('could not be read') || msg.includes('FILE_ACCESS_EXPIRED');
            try {
              if (isRecoverable) {
                controller.error(new ExtractorError('ERR_FILE_INGEST', 'File could not be read'));
              } else {
                controller.error(err instanceof Error ? err : new Error(msg));
              }
            } catch { /* stream already closed/errored */ }
          });

        } catch (err) {
          controller.error(err);
          worker?.terminate();
          worker = null;
        }
      },

      cancel: () => {
        // Consumer cancelled the stream (e.g. user navigated away)
        worker?.terminate();
        worker = null;
        // Clean up the OPFS file immediately if we implicitly created it
        if (!isPreIngested) {
          cleanupTempFile(tempFileName).catch(e => console.warn('Cancel cleanup failed:', e));
        }
      },
    });

    return stream;
  }

  /**
   * Callback-style extraction — a simpler alternative to ReadableStream.
   *
   * Internally calls `extract()` and reads the stream, dispatching to your callbacks.
   * Returns a Promise that resolves when extraction completes or rejects on fatal error.
   *
   * @param file - The video File object
   * @param callbacks - Object with onSlide, onAudio, onProgress, etc.
   * @param signal - Optional AbortSignal for cancellation
   *
   * @example
   * await extractor.extractWithCallbacks(file, {
   *   onSlide: (slide) => console.log('Slide at', slide.timestamp),
   *   onProgress: (pct, msg) => console.log(`${pct}%: ${msg}`),
   *   onDone: () => console.log('Done!'),
   * });
   */
  async extractWithCallbacks(file: File, callbacks: ExtractorCallbacks, signal?: AbortSignal): Promise<void> {
    const stream = this.extract(file, signal);
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        switch (value.type) {
          case 'audio':
            callbacks.onAudio?.(value.chunk);
            break;
          case 'audio_done':
            callbacks.onAudioDone?.(value.fileName);
            break;
          case 'slide':
            callbacks.onSlide?.({
              imageBuffer: value.imageBuffer,
              timestamp: value.timestamp,
              startMs: value.startMs,
            });
            break;
          case 'progress':
            callbacks.onProgress?.(value.percent, value.message, value.metrics);
            break;
        }
      }
      callbacks.onDone?.();
    } catch (err) {
      if (err instanceof ExtractorError) {
        callbacks.onError?.(err);
      } else {
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    }
  }
}

// ─── Default Export ───
export default FastExtractor;
