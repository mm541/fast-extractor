/**
 * ============================================================================
 * worker.ts — Extraction Worker (runs in a dedicated Web Worker thread)
 * ============================================================================
 *
 * This worker receives a video File from the main thread and performs:
 *   Phase 1: File Ingestion — copy File → OPFS via SyncAccessHandle
 *   Phase 2: Audio Extraction — Rust/WASM (Symphonia) reads OPFS sync → outputs AAC
 *   Phase 3: Video Slide Extraction — web-demuxer + WebCodecs + WASM diffing
 *
 * WHY OPFS (Origin Private File System)?
 *   The Rust Symphonia audio library requires synchronous Read + Seek (like fread/fseek).
 *   Browser File APIs are all async (file.arrayBuffer() returns a Promise).
 *   OPFS's SyncAccessHandle is the ONLY browser API that provides blocking reads,
 *   making it the bridge between async JS world and sync Rust world.
 *
 * ⚠️ CRITICAL: OPFS LIFECYCLE RULES
 *   1. SyncAccessHandle is an EXCLUSIVE lock. Only ONE handle can exist per file
 *      across ALL tabs. If a previous tab crashed without closing its handle,
 *      createSyncAccessHandle() will hang FOREVER.
 *      → Solution: createSyncAccessHandleWithTimeout() enforces a 5s timeout.
 *
 *   2. cleanupOldFiles() runs with a 3s timeout on startup. It removes stale
 *      temp files from previous crashed sessions. Uses name prefixes:
 *      "extract_*", "audio_*", "__cap_test_*"
 *
 *   3. The OPFS temp file MUST be kept alive until AFTER video extraction.
 *      The demuxer (web-demuxer) needs the file, and the original DOM File
 *      from <input> expires on mobile (permission revoked after async gaps).
 *      → DO NOT delete the OPFS file early. The finally{} block handles cleanup.
 *
 * ⚠️ CRITICAL: MEMORY MANAGEMENT RULES
 *   1. ALWAYS close VideoFrames immediately after copying pixels to WASM buffers.
 *      An unclosed VideoFrame holds GPU memory (~1-4MB each). 10 unclosed = OOM.
 *
 *   2. Call AudioExtractor.free() explicitly after audio extraction.
 *      Rust/wasm-bindgen destructors don't run automatically in JS.
 *
 *   3. Set wasmBuffer = undefined after WASM init. The ArrayBuffer is ~560KB
 *      and is fully copied into WebAssembly.Memory — keeping the JS reference wastes RAM.
 *
 *   4. Use ArrayBuffer transfer (postMessage with transferList) for slide images.
 *      This moves the buffer to main thread at zero cost (no copy).
 *
 * ⚠️ CRITICAL: MOBILE COMPATIBILITY RULES
 *   1. File ingestion MUST happen inside the worker, not the main thread.
 *      Mobile Chrome revokes File permissions from <input type="file"> after
 *      async delays (WASM fetch, OPFS init). By the time the main thread tries
 *      to read the file, it's already dead. Worker receives the File via
 *      structured clone in START_INGEST and reads it immediately.
 *
 *   2. For the demuxer, use the OPFS copy (root.getFileHandle → getFile()),
 *      NOT the original DOM File. Same permission expiry issue.
 *
 *   3. The `onmessage` handler is async, but the browser event loop does NOT
 *      await async handlers. Two postMessage() calls fire concurrently.
 *      → INIT and START_INGEST are sequenced via INIT_COMPLETE handshake.
 *
 * MESSAGE FLOW:
 *   Main → Worker: CONFIG → INIT → (INIT_COMPLETE) → START_INGEST
 *   Worker internally: readFile → OPFS → audio → slides → ALL_DONE
 */

// 1. Send immediate heartbeat to confirm worker execution
self.postMessage({ type: 'STATUS', status: 'Worker Thread Initializing...' });

/** Global error handler — catches unhandled errors in imports, syntax, etc. */
self.onerror = (event: string | Event, source?: string, lineno?: number, colno?: number, error?: Error) => {
    const msg = typeof event === 'string' ? event : (error?.message || 'Unknown Worker Error');
    console.error("Worker Global Error:", msg, { source, lineno, colno, error });
    self.postMessage({ type: 'ERROR', code: 'ERR_WORKER_GENERIC', error: 'Worker Global Error: ' + msg });
};

// Polyfill: some libraries (web-demuxer) check for `window` global
(self as unknown as { window: unknown }).window = self;

import init, { AudioExtractor, compare_frames, compare_prev_current, compute_dhash, compute_color_signature, get_avg_brightness, init_arena, get_buffer_a_ptr, get_buffer_b_ptr, get_buffer_prev_ptr, get_rgba_buffer_ptr, shift_current_to_prev, copy_rgba_to_gray } from './wasm/wasm_extractor';
import { SlideExtractor } from './extractor';
import type { SlideExtractorOptions } from './extractor';

// ─── WORKER STATE ───
// These are module-scoped because the worker lives for the entire extraction session.
//
let wasmBuffer: ArrayBuffer | undefined;    // Transferred from main thread, freed after init
let root: FileSystemDirectoryHandle;         // OPFS root directory handle
let syncHandle: FileSystemSyncAccessHandle | undefined;  // Exclusive lock on temp video file
let shouldExtractAudio = true;               // Controlled via CONFIG
let shouldExtractSlides = true;              // Controlled via CONFIG
let shouldCleanup = true;

// Slide extraction state
let slideExtractor: SlideExtractor | null = null;
let pendingSlide: { buffer: ArrayBuffer; startMs: number; timestamp: string } | null = null;
let pendingSlideEncodes = 0;
let drainResolve: (() => void) | null = null;
/**
 * Detection config — updated via CONFIG message before extraction starts.
 * Merged with per-extraction options in processMedia().
 * See extractor.ts SlideExtractorOptions for full documentation of each field.
 */
let detectionConfig: Partial<SlideExtractorOptions> = {
    mode: 'turbo',
    edgeThreshold: 30,
    blockThreshold: 12,
    densityThresholdPct: 5,
};

/**
 * Lazy WASM initializer. Only loads once — subsequent calls are no-ops.
 * The wasmBuffer ArrayBuffer is consumed here; set it to undefined after calling.
 */
let wasmInitialized = false;
let wasmModule: any = null;
async function ensureWasm(wasmBuffer?: ArrayBuffer) {
    if (!wasmInitialized) {
        if (!wasmBuffer) throw new Error("WASM buffer must be provided for initialization.");
        wasmModule = await init({ module_or_path: wasmBuffer });
        wasmInitialized = true;
    }
}

/**
 * Initialize OPFS handle inside a dedicated `.fast_extractor/` subfolder.
 * All temp files live here — never in the consumer's OPFS root.
 * Requires Secure Context (HTTPS or localhost) — will throw on HTTP.
 */
async function initStorage() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
        throw new Error("Secure Context Required: extraction requires HTTPS or Localhost.");
    }
    const opfsRoot = await navigator.storage.getDirectory();
    root = await opfsRoot.getDirectoryHandle('.fast_extractor', { create: true });
}

/**
 * Remove leftover temp files from previous sessions.
 * Uses two-phase approach: collect names first, then delete.
 * This avoids iterator invalidation and works reliably on mobile Chrome.
 *
 * SAFETY: Uses Web Locks API to skip files actively used by other tabs.
 * All files live inside `.fast_extractor/` — no risk to consumer's OPFS data.
 *
 * ⚠️ The for-await on OPFS entries() can hang on mobile if stale locks exist.
 * That's why the caller wraps this in a Promise.race() with a 3s timeout.
 */


/** createSyncAccessHandle with timeout — prevents infinite deadlock from stale OPFS locks */
function createSyncAccessHandleWithTimeout(
    fileHandle: FileSystemFileHandle,
    timeoutMs = 5000
): Promise<FileSystemSyncAccessHandle> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`createSyncAccessHandle timed out after ${timeoutMs}ms — possible stale OPFS lock. Try closing other tabs or clearing site data.`));
        }, timeoutMs);

        (fileHandle as any).createSyncAccessHandle()
            .then((handle: FileSystemSyncAccessHandle) => {
                clearTimeout(timer);
                resolve(handle);
            })
            .catch((err: Error) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

self.onmessage = async (e: MessageEvent) => {
    const { type, data, config, wasmBuffer: wb } = e.data;
    
    try {
        if (type === 'CONFIG') {
            if (data?.extractAudio !== undefined) shouldExtractAudio = data.extractAudio;
            if (data?.extractSlides !== undefined) shouldExtractSlides = data.extractSlides;
            if (data?.cleanupAfterExtraction !== undefined) shouldCleanup = data.cleanupAfterExtraction;
            if (config) detectionConfig = { ...detectionConfig, ...config };
            console.log("Worker Config Updated:", detectionConfig, { shouldExtractAudio, shouldExtractSlides, shouldCleanup });
            return;
        }


        if (type === 'INIT') {
            wasmBuffer = wb;
            try {
                await initStorage();
            } catch (err: any) {
                self.postMessage({ type: 'ERROR', code: 'ERR_OPFS_NOT_SUPPORTED', error: 'OPFS not available: ' + err.message });
                return;
            }
            self.postMessage({ type: 'STATUS', status: 'Worker Initialized. Ready.' });
            self.postMessage({ type: 'INIT_COMPLETE' });
            return;
        }

        if (type === 'EXTRACT_AUDIO') {
            const { fileName, tempFileName } = e.data;
            
            // Wait up to 30s for background WASM fetch to arrive
            let retries = 0;
            while (!wasmInitialized && !wasmBuffer && retries < 300) {
                await new Promise(r => setTimeout(r, 100));
                retries++;
            }
            await ensureWasm(wasmBuffer);
            
            if (!root) await initStorage();

            try {
                const fileHandle = await root.getFileHandle(tempFileName);
                syncHandle = await createSyncAccessHandleWithTimeout(fileHandle, 5000);
            } catch (err: any) {
                self.postMessage({ type: 'ERROR', code: 'ERR_OPFS_STALE_LOCK', error: 'File handle failed: ' + err.message });
                return;
            }

            let audioExtractor: any = null;
            try {
                audioExtractor = new AudioExtractor(syncHandle);

                let lastReport = 0;
                while (true) {
                    const chunk = audioExtractor.pull_chunk(1024 * 1024);
                    if (chunk.length === 0) break;
                    
                    const ab = chunk.slice().buffer as ArrayBuffer;
                    postMessage({ type: 'AUDIO_CHUNK', buffer: ab }, [ab]);
                    
                    const progress = Math.floor(audioExtractor.get_progress());
                    if (progress >= lastReport + 5 || progress === 100) {
                        postMessage({ type: 'STATUS', status: `Extracting Audio...`, progress });
                        lastReport = progress;
                    }
                }
                postMessage({ type: 'AUDIO_DONE', fileName: fileName.replace(/\.[^/.]+$/, "") + ".aac" });
            } catch (e: any) {
                const reason = e?.message ?? 'unsupported format';
                console.warn('[Worker] Audio extraction failed:', reason);
                postMessage({ type: 'STATUS', status: `⚠️ Audio unavailable: ${reason}. Extracting slides only...` });
            } finally {
                if (audioExtractor) try { audioExtractor.free(); } catch(_) {}
                if (syncHandle) {
                    try { syncHandle.close(); } catch (e) {}
                    syncHandle = undefined;
                }
            }
            return;
        }

        if (type === 'CONFIG_DECODER') {
            const { config: decoderConfig, duration } = e.data;
            
            // Wait for WASM if needed
            let retries = 0;
            while (!wasmInitialized && !wasmBuffer && retries < 300) {
                await new Promise(r => setTimeout(r, 100));
                retries++;
            }
            await ensureWasm(wasmBuffer);

            // Set up slide extractor
            const finalOptions = {
                ...detectionConfig,
                onProgress: (percent: number, message: string, metrics?: any) => {
                    self.postMessage({ type: 'STATUS', status: message, progress: Math.round(percent), metrics });
                },
                onSlide: async (blob: Blob, timestamp: number) => {
                    pendingSlideEncodes++;
                    try {
                        const ab = await blob.arrayBuffer();
                        const startMs = Math.round(timestamp * 1000);

                        if (pendingSlide) {
                            self.postMessage({
                                type: 'SLIDE',
                                buffer: pendingSlide.buffer,
                                timestamp: pendingSlide.timestamp,
                                startMs: pendingSlide.startMs,
                                endMs: startMs,
                            }, [pendingSlide.buffer]);
                        }

                        pendingSlide = { buffer: ab, startMs, timestamp: formatTime(timestamp) };
                    } catch (e: any) {
                        console.warn('[Worker] onSlide buffer read failed:', e.message);
                    } finally {
                        pendingSlideEncodes--;
                        if (pendingSlideEncodes === 0 && drainResolve) {
                            drainResolve();
                            drainResolve = null;
                        }
                    }
                }
            };

            slideExtractor = new SlideExtractor(
                { 
                    init_arena, 
                    get_buffer_a_ptr, 
                    get_buffer_b_ptr, 
                    get_buffer_prev_ptr,
                    get_rgba_buffer_ptr,
                    shift_current_to_prev,
                    copy_rgba_to_gray,
                    compare_frames, 
                    compare_prev_current,
                    compute_dhash, 
                    compute_color_signature,
                    get_avg_brightness,
                    memory: wasmModule.memory
                } as any,
                finalOptions
            );

            await slideExtractor.configure(decoderConfig, duration);
            return;
        }

        if (type === 'VIDEO_CHUNK') {
            const { chunk, timestamp, chunkType } = e.data;
            if (slideExtractor) {
                await slideExtractor.feedChunk(chunk, timestamp, chunkType);
            }
            return;
        }

        if (type === 'VIDEO_DONE') {
            const { skipped } = e.data;
            let metrics: any = {};
            
            if (!skipped && slideExtractor) {
                metrics = await slideExtractor.flush();
            }

            // Drain any pending async onSlide callbacks
            if (pendingSlideEncodes > 0) {
                await Promise.race([
                    new Promise<void>(r => { drainResolve = r; }),
                    new Promise<void>(r => setTimeout(r, 3000))
                ]);
            }

            // Flush the last buffered slide
            if (pendingSlide) {
                const videoDurationMs = metrics?.videoDurationSec
                    ? Math.round(metrics.videoDurationSec * 1000)
                    : metrics?.lastFrameTimestamp
                        ? Math.round(metrics.lastFrameTimestamp * 1000)
                        : pendingSlide.startMs;
                
                self.postMessage({
                    type: 'SLIDE',
                    buffer: pendingSlide.buffer,
                    timestamp: pendingSlide.timestamp,
                    startMs: pendingSlide.startMs,
                    endMs: videoDurationMs,
                }, [pendingSlide.buffer]);
                pendingSlide = null;
            }

            postMessage({ type: 'ALL_DONE', metrics });
            return;
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: 'ERROR', code: 'ERR_WORKER_GENERIC', error: message });
    }
};



function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const min = Math.floor((seconds % 3600) / 60);
    const sec = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}
