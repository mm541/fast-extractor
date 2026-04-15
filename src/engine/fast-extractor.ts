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
  /** 'turbo' = keyframe-only (~10x faster), 'accurate' = every frame */
  mode?: 'accurate' | 'turbo';
  
  /** 
   * Frame sampling rate for accurate mode (0.2 - 10). Default: 1.
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
  /** Encoded WebP quality of the extracted slides (0.01 - 1.0). Default: 0.8 */
  imageQuality?: number;
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
      const root = await navigator.storage.getDirectory();
      const entries: string[] = [];
      // @ts-ignore — OPFS entries()
      for await (const [name] of (root as any).entries()) {
        if (name.startsWith('extract_') || name.startsWith('audio_') || name.startsWith('__cap_test_')) {
          entries.push(name);
        }
      }
      for (const name of entries) {
        try { await root.removeEntry(name); } catch {}
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
    let worker: Worker | null = null;

    const stream = new ReadableStream<ExtractorEvent>({
      start: async (controller) => {
        try {
          // 1. Create worker instantly
          worker = this.options.worker ?? new MediaWorker();

          // 2. Handle abort signal
          if (signal) {
            signal.addEventListener('abort', () => {
              worker?.terminate();
              worker = null;
              controller.close();
            }, { once: true });
          }

          // 4. Configure — extract asset URLs from options before sending detection config
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
                  worker?.terminate();
                  worker = null;
                  controller.close();
                  break;

                case 'ERROR': {
                  const errorMsg: string = e.data.error;
                  const errorCode: ExtractorErrorCode = e.data.code ?? 'ERR_WORKER_GENERIC';
                  const customError = new ExtractorError(errorCode, errorMsg);
                  
                  const isRecoverable = errorMsg.includes('File ingest failed') || errorMsg.includes('could not be read');
                  if (errorCode === 'ERR_FILE_INGEST' || isRecoverable) {
                    // Emit as a recoverable event — let consumer decide how to handle
                    controller.enqueue({
                      type: 'error',
                      message: customError.message,
                      recoverable: true,
                    });
                    // Don't close the stream via error — close it cleanly or leave open?
                    // Previous logic closed it.
                    worker?.terminate();
                    worker = null;
                    controller.close();
                  } else {
                    worker?.terminate();
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
            worker?.terminate();
            worker = null;
          };

          // =========================================================================================
          // ⚠️ CRITICAL ANDROID SAF WARNING ⚠️
          // DO NOT REORDER THE INITIALIZATION HANDSHAKE!
          // On Android (ColorOS/OxygenOS), Storage Access Framework (SAF) permissions expire
          // within ~2 seconds of the user picking the DOM `File` if it is not immediately read.
          // We MUST NOT perform any slow asynchronous operations (like `await fetch(wasm)`) 
          // before sending 'START_INGEST'. The file MUST be ingested instantly.
          // WASM fetching must occur in the background concurrently.
          // =========================================================================================

          // 5. Send START_INGEST immediately so Android SAF permission doesn't expire
          worker.postMessage({ type: 'START_INGEST', fileName: file.name, file });

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
              // If file ingestion succeeds but WASM fails, cleanly crash
              try { controller.error(new Error(`Failed to fetch WASM engine: ${err.message}`)); } catch {}
              worker?.terminate();
              worker = null;
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
