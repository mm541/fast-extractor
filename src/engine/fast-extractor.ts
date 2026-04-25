/**
 * ============================================================================
 * fast-extractor.ts — Public Library API
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
 *
 *   5. WASM INJECTION STRATEGY (CORS/COEP BYPASS):
 *      The dependency `web-demuxer` spawns a nested `blob:` worker internally.
 *      That nested worker has an opaque (`null`) origin. If it attempts to
 *      fetch its WASM file from a URL, it triggers a strict CORS block (Failed to fetch)
 *      unless the host server explicitly sets `Access-Control-Allow-Origin: *`.
 *      To make this library "zero-config" for consumers, we bypass this entirely:
 *      Our worker (which has a valid origin) fetches the WASM, converts it to
 *      a base64 `data:` URL, and gives THAT string to web-demuxer.
 *      No network request = no CORS policies triggered. Do NOT revert this to
 *      a standard URL or a blob URL.
 */

// Vite-specific imports — used as defaults when consumer doesn't provide URLs.
// Library consumers using other bundlers will override these via options.
import MediaWorker from './worker?worker';
import defaultWasmUrl from './wasm/wasm_extractor_bg.wasm?url';
import { WebDemuxer } from 'web-demuxer';

// ─── Public Error Types ───

export type ExtractorErrorCode =
  | 'ERR_OPFS_NOT_SUPPORTED'
  | 'ERR_OPFS_PERMISSION'
  | 'ERR_OPFS_STALE_LOCK'
  | 'ERR_WASM_INIT'
  | 'ERR_FILE_INGEST'
  | 'ERR_AUDIO_EXTRACTION'
  | 'ERR_VIDEO_DECODE'
  | 'ERR_WORKER_GENERIC';

export class ExtractorError extends Error {
  constructor(public code: ExtractorErrorCode, message: string) {
    super(message);
    this.name = 'ExtractorError';
  }
}

// ─── Public Event Types ───

/** Audio chunk streamed from the worker (zero-copy transferred ArrayBuffer) */
export interface AudioChunkEvent {
  type: 'audio';
  /** Raw AAC audio data (ADTS-framed). Accumulate and wrap in Blob to play. */
  chunk: ArrayBuffer;
}

/** Audio extraction complete. No more audio events will be emitted. */
export interface AudioDoneEvent {
  type: 'audio_done';
  /** Suggested filename (e.g. "lecture.aac") */
  fileName: string;
}

/** A slide image was detected and captured. */
export interface SlideEvent {
  type: 'slide';
  /** Raw image data (WebP format) */
  imageBuffer: ArrayBuffer;
  /** Human-readable timestamp (e.g. "01:23:45") */
  timestamp: string;
  /** Start time in milliseconds (when this slide first appeared) */
  startMs: number;
  /** End time in milliseconds (when the next slide replaced this one) */
  endMs: number;
}

/** Progress update from the extraction engine. */
export interface ProgressEvent {
  type: 'progress';
  /** 0-100 */
  percent: number;
  /** Human-readable status message */
  message: string;
  /** Optional performance metrics */
  metrics?: {
    totalFrames: number;
    totalSlides: number;
    peakRamMb: number;
    avgFrameProcessTimeMs: number;
  };
}

/** A recoverable error occurred (e.g. Android SAF permission expired). */
export interface ErrorEvent {
  type: 'error';
  /** Human-readable error message */
  message: string;
  /** Whether the error is likely recoverable by re-selecting the file */
  recoverable: boolean;
}

/** Union of all events emitted by the extraction stream. */
export type ExtractorEvent = AudioChunkEvent | AudioDoneEvent | SlideEvent | ProgressEvent | ErrorEvent;

// ─── Browser Compatibility ───

/** Result of checking whether the current browser supports extraction. */
export interface BrowserSupport {
  /** WebCodecs (VideoDecoder) available — required */
  webCodecs: boolean;
  /** Origin Private File System available — required for audio extraction */
  opfs: boolean;
  /** OffscreenCanvas available — optional, for worker-side rendering */
  offscreenCanvas: boolean;
  /** Device RAM in GB (if exposed by navigator.deviceMemory) */
  deviceMemoryGb: number | null;
  /** Whether mobile browser is detected */
  isMobile: boolean;
  /** Overall: can this browser run the extraction engine? */
  supported: boolean;
  /** Human-readable reason if not supported */
  reason?: string;
}

// ─── Configuration ───

/** Options for the FastExtractor. Only mode is required; everything else has sensible defaults. */
export interface FastExtractorOptions {
  // ─── Extraction mode ───
  /** 'turbo' = keyframe-only (~10x faster), 'sequential' = every frame */
  mode?: 'sequential' | 'turbo';
  
  /** 
   * Frame sampling rate for sequential mode (0.2 - 10). Default: 1.
   * 1 = compare 1 frame per second.
   * 0.5 = one frame every 2 seconds.
   * Ignored in turbo mode.
   */
  sampleFps?: number;

  // ─── Asset URLs (for library consumers using non-Vite bundlers) ───
  /**
   * URL to the core WASM binary (wasm_extractor_bg.wasm).
   * Default: auto-resolved by Vite. Override this when using Webpack/Rollup/etc.
   */
  wasmUrl?: string;
  /**
   * URL to the web-demuxer WASM binary (web-demuxer.wasm).
   * Default: '/wasm-files/web-demuxer.wasm'. Override to match your CDN/asset path.
   */
  demuxerWasmUrl?: string;
  /**
   * A pre-constructed Worker instance. If provided, the library uses this
   * instead of creating its own. Useful for bundlers that don't support
   * Vite's `?worker` import syntax.
   */
  worker?: Worker;

  // ─── Detection tuning ───
  /** Edge detection sensitivity (10-100). Default: 30 */
  edgeThreshold?: number;
  /** Minimum changed blocks to trigger slide (1-64). Default: 12 */
  blockThreshold?: number;
  /** Minimum seconds between slides. Default: 3 */
  minSlideDuration?: number;
  /** Density percentage threshold for block comparison. Default: 5 */
  densityThresholdPct?: number;
  /** Perceptual hash hamming distance for duplicate detection. Default: 10 */
  dhashDuplicateThreshold?: number;
  /** Max dHash distance to confirm a turbo candidate as real (not a transition blend).
   *  Lower = stricter filtering (5-8 for crossfade-heavy videos).
   *  Higher = more permissive (12-15 for clean-cut transitions). Default: 10 */
  confirmThreshold?: number;
  /** 64-bit bitmask: bit (row*8 + col) = 1 skips that 8×8 grid block. Default: 0n (no masking). */
  ignoreMask?: bigint;

  // ─── Output selection ───
  /** Extract audio from the video. Default: true */
  extractAudio?: boolean;
  /** Extract slide images from the video. Default: true */
  extractSlides?: boolean;
  /** Encoded image quality of the extracted slides (0.01 - 1.0). Default: 0.8 */
  imageQuality?: number;
  /** Output format for extracted slides. /
  imageFormat?: 'webp' | 'jpeg';
  /** Max width of output slides (e.g. 1280 or 1920). 0 means original. Default: 0. */
  exportResolution?: number;

  // ─── Storage ───
  /**
   * Whether to delete OPFS temp files after extraction completes.
   * Default: true. Set to false to keep the ingested file in OPFS for
   * re-extraction with different settings (avoids re-ingesting the same video).
   * Call FastExtractor.cleanupStorage() explicitly when you're done.
   */
  cleanupAfterExtraction?: boolean;

  // ─── Debugging ───
  /**
   * When true, logs all internal worker messages and state transitions to the
   * browser console. Useful for diagnosing extraction failures.
   * Default: false. Has zero performance impact when disabled.
   */
  debug?: boolean;
}

// ─── Callback API ───

/** Callback-style interface as an alternative to ReadableStream consumption. */
export interface ExtractorCallbacks {
  /** Called for each raw AAC audio chunk. */
  onAudio?: (chunk: ArrayBuffer) => void;
  /** Called when audio extraction is complete. */
  onAudioDone?: (fileName: string) => void;
  /** Called when a new slide is detected. */
  onSlide?: (slide: { imageBuffer: ArrayBuffer; timestamp: string; startMs: number; endMs: number }) => void;
  /** Called on progress updates. */
  onProgress?: (percent: number, message: string, metrics?: ProgressEvent['metrics']) => void;
  /** Called on recoverable errors (stream stays alive). */
  onError?: (error: ExtractorError | Error) => void;
  /** Called when extraction is fully complete. */
  onDone?: () => void;
}

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
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const supported = webCodecs && opfs;

    let reason: string | undefined;
    if (!supported) {
      const missing: string[] = [];
      if (!webCodecs) missing.push('WebCodecs (VideoDecoder)');
      if (!opfs) missing.push('Origin Private File System (OPFS)');
      reason = `Browser missing required APIs: ${missing.join(', ')}. Use Chrome 102+ on desktop or Android.`;
    }

    return { webCodecs, opfs, offscreenCanvas, deviceMemoryGb, isMobile, supported, reason };
  }

  /**
   * Manually clean up OPFS temp files left from previous extractions.
   * Only cleans files inside the `.fast_extractor/` subfolder — never touches
   * the consumer's own OPFS data.
   * Only needed when `cleanupAfterExtraction: false` was used.
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
      for (const name of entries) {
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
      }
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
   * @param file - The video File object (from <input type="file"> or drag-and-drop)
   * @param signal - Optional AbortSignal for cancellation
   */
  extract(file: File, signal?: AbortSignal): ReadableStream<ExtractorEvent> {
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
              controller.close();
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
            cleanupAfterExtraction = true, // default: clean up OPFS after extraction
            ...detectionConfig
          } = this.options;

          worker.postMessage({
            type: 'CONFIG',
            data: { demuxerWasmUrl, extractAudio, extractSlides, cleanupAfterExtraction },
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
                  });
                  break;

                case 'SLIDE':
                  controller.enqueue({
                    type: 'slide',
                    imageBuffer: e.data.buffer,
                    timestamp: e.data.timestamp,
                    startMs: e.data.startMs ?? 0,
                    endMs: e.data.endMs ?? 0,
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
                  // Don't terminate — worker self-closes after OPFS cleanup
                  worker = null;
                  controller.close();
                  break;

                case 'ERROR': {
                  const errorMsg: string = e.data.error;
                  const errorCode: ExtractorErrorCode = e.data.code ?? 'ERR_WORKER_GENERIC';
                  const customError = new ExtractorError(errorCode, errorMsg);
                  
                  const isRecoverable = errorMsg.includes('File ingest failed') || errorMsg.includes('could not be read');
                  this._extracting = false;
                  if (errorCode === 'ERR_FILE_INGEST' || isRecoverable) {
                    // Emit as a recoverable event — let consumer decide how to handle
                    controller.enqueue({
                      type: 'error',
                      message: customError.message,
                      recoverable: true,
                    });
                    // Don't terminate — worker self-closes after OPFS cleanup
                    worker = null;
                    controller.close();
                  } else {
                    // Don't terminate — worker self-closes after OPFS cleanup
                    worker = null;
                    controller.error(customError);
                  }
                  break;
                }
              }
            } catch (err) {
              // Stream already closed/errored — ignore late messages
            }
          };

          worker.onerror = (event) => {
            try {
              controller.error(new Error(event.message || 'Worker crashed'));
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
              try { controller.error(new Error(`Failed to fetch WASM engine: ${err.message}`)); } catch {}
              worker?.terminate();
              worker = null;
            });

          // 7. Instantiate WorkspaceManager and run the extraction pipeline
          const tempFileName = `extract_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
          
          const runPipeline = async () => {
            try {
              await ingestFile(file, worker!, tempFileName);

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
                  worker!.postMessage({ type: 'EXTRACT_AUDIO', fileName: file.name, fileHandle });
                });
              }

              // Run video extraction pipeline
              if (this.options.extractSlides !== false) {
                  await extractVideoChunks(worker!, this.options, tempFileName);
              } else {
                  worker!.postMessage({ type: 'VIDEO_DONE', skipped: true });
              }

              // Wait for ALL_DONE from the worker
              await new Promise<void>((resolve, reject) => {
                const handleDone = (e: MessageEvent) => {
                  if (e.data.type === 'ALL_DONE') {
                    worker!.removeEventListener('message', handleDone);
                    resolve();
                  } else if (e.data.type === 'ERROR') {
                    worker!.removeEventListener('message', handleDone);
                    reject(new Error(e.data.error));
                  }
                };
                worker!.addEventListener('message', handleDone);
              });

            } finally {
              await cleanupTempFile(this.options, tempFileName);
            }
          };

          const pipelinePromise = navigator.locks 
            ? navigator.locks.request(`fe_${tempFileName}`, runPipeline)
            : runPipeline();

          pipelinePromise.catch(err => {
            // Pipeline will throw if SAF permissions expire or pipeline fails
            const isRecoverable = err.message.includes('File ingest failed') || err.message.includes('could not be read');
            this._extracting = false;
            
            if (isRecoverable) {
              controller.enqueue({
                type: 'error',
                message: err.message,
                recoverable: true,
              });
              worker = null;
              controller.close();
            } else {
              worker = null;
              controller.error(err);
            }
          });

        } catch (err) {
          controller.error(err);
          worker?.terminate();
          worker = null;
        }
      },

      cancel() {
        // Consumer cancelled the stream (e.g. user navigated away)
        worker?.terminate();
        worker = null;
        // Clean up the OPFS file immediately
        FastExtractor.cleanupStorage().catch(e => console.warn('Cancel cleanup failed:', e));
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
              endMs: value.endMs,
            });
            break;
          case 'progress':
            callbacks.onProgress?.(value.percent, value.message, value.metrics);
            break;
          case 'error':
            callbacks.onError?.(new ExtractorError('ERR_WORKER_GENERIC', value.message));
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


// ─── Pipeline Helper Functions ───

async function ingestFile(file: File, worker: Worker, tempFileName: string): Promise<void> {
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
    
    worker.postMessage({ type: 'STATUS', status: 'Ingesting Media: 0%', progress: 0 });
    let lastReportTime = Date.now();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        await writable.write(value);
        offset += value.byteLength;
        
        if (Date.now() - lastReportTime > 250) {
            const pct = Math.floor((offset / file.size) * 100);
            worker.postMessage({ type: 'STATUS', status: `Ingesting Media: ${pct}%`, progress: pct });
            lastReportTime = Date.now();
        }
    }
    await writable.close();
  }

async function extractVideoChunks(worker: Worker, options: FastExtractorOptions, tempFileName: string): Promise<void> {
    let demuxer: WebDemuxer | null = null;
    try {
      worker.postMessage({ type: 'STATUS', status: 'Initializing Demuxer...' });

      // Demuxer runs on main thread now, no Base64 hack needed
      const wasmUrl = options.demuxerWasmUrl ?? '/wasm-files/web-demuxer.wasm';
      demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });

      // Read the file back from OPFS so demuxer has a stable reference
      const root = await navigator.storage.getDirectory();
      const feDir = await root.getDirectoryHandle('.fast_extractor');
      const fileHandle = await feDir.getFileHandle(tempFileName);
      const opfsFile = await fileHandle.getFile();

      await demuxer.load(opfsFile);
      
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

      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        if (options.mode === 'turbo' && value.type !== 'key') continue;

        // Extract raw bytes into an ArrayBuffer for zero-copy transfer
        const chunkData = new ArrayBuffer(value.byteLength);
        value.copyTo(chunkData);

        worker.postMessage({
          type: 'VIDEO_CHUNK',
          chunk: chunkData,
          timestamp: Number(value.timestamp),
          chunkType: value.type
        }, [chunkData]); // Zero-copy transfer!
      }

      // 3. Signal completion
      worker.postMessage({ type: 'VIDEO_DONE' });

    } finally {
      if (demuxer) demuxer.destroy();
    }
  }

async function cleanupTempFile(options: FastExtractorOptions, tempFileName: string): Promise<void> {
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
