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

// Default URL for web-demuxer's FFmpeg WASM — overridable via CONFIG message
let webDemuxerWasmUrl = new URL('/wasm-files/web-demuxer.wasm', self.location.origin).href;

// ─── WORKER STATE ───
// These are module-scoped because the worker lives for the entire extraction session.
//
let wasmBuffer: ArrayBuffer | undefined;    // Transferred from main thread, freed after init
let root: FileSystemDirectoryHandle;         // OPFS root directory handle
let syncHandle: FileSystemSyncAccessHandle | undefined;  // Exclusive lock on temp video file
let originalFile: File | undefined;          // DOM File from <input> (may expire on mobile!)
let shouldExtractAudio = true;               // Controlled via CONFIG
let shouldExtractSlides = true;              // Controlled via CONFIG
let shouldCleanup = true;                    // Controlled via CONFIG (cleanupAfterExtraction)

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
 * Initialize OPFS root handle.
 * Requires Secure Context (HTTPS or localhost) — will throw on HTTP.
 */
async function initStorage() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
        throw new Error("Secure Context Required: extraction requires HTTPS or Localhost.");
    }
    root = await navigator.storage.getDirectory();
}

/**
 * Remove leftover temp files from previous sessions.
 * Uses two-phase approach: collect names first, then delete.
 * This avoids iterator invalidation and works reliably on mobile Chrome.
 * 
 * ⚠️ The for-await on OPFS entries() can hang on mobile if stale locks exist.
 * That's why the caller wraps this in a Promise.race() with a 3s timeout.
 */
async function cleanupOldFiles() {
    if (!root) await initStorage();
    try {
        const entries: string[] = [];
        // @ts-ignore — collect names first, then delete (avoids iterator issues)
        for await (const [name] of (root as any).entries()) {
            if (name.startsWith('extract_') || name.startsWith('audio_') || name.startsWith('__cap_test_')) {
                entries.push(name);
            }
        }
        for (const name of entries) {
            try { await root.removeEntry(name); } catch {}
        }
    } catch (e) {
        console.warn('[Worker] cleanupOldFiles failed:', e);
    }
}

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
    const { type, data, fileName, config, wasmBuffer: wb } = e.data;
    
    try {
        if (type === 'CONFIG') {
            if (data?.demuxerWasmUrl) webDemuxerWasmUrl = data.demuxerWasmUrl;
            if (data?.extractAudio !== undefined) shouldExtractAudio = data.extractAudio;
            if (data?.extractSlides !== undefined) shouldExtractSlides = data.extractSlides;
            if (data?.cleanupAfterExtraction !== undefined) shouldCleanup = data.cleanupAfterExtraction;
            if (config) detectionConfig = { ...detectionConfig, ...config };
            console.log("Worker Config Updated:", detectionConfig, { shouldExtractAudio, shouldExtractSlides, shouldCleanup });
            return;
        }

        if (type === 'CLEANUP') {
            // Explicit cleanup requested by library consumer
            try {
                await cleanupOldFiles();
                self.postMessage({ type: 'STATUS', status: 'Storage cleaned up.' });
            } catch (e: any) {
                console.warn('[Worker] Manual cleanup failed:', e?.message);
            }
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

        if (type === 'START_INGEST') {
            originalFile = e.data.file;

            // ── CRITICAL: Minimize async gaps before reading the File ──
            // On Android Chrome (OxygenOS, ColorOS), the File object's SAF
            // permission can expire within seconds. We must:
            //   1. Create OPFS handle (fast, ~50ms)
            //   2. Read file IMMEDIATELY
            //   3. Cleanup old files AFTER (non-critical, can wait)
            // DO NOT add any slow async operations (cleanup, timeouts) before the file read!

            if (syncHandle) try { syncHandle.close(); } catch (e) {}

            if (!root) {
                try { await initStorage(); } catch (err: any) {
                    self.postMessage({ type: 'ERROR', code: 'ERR_OPFS_NOT_SUPPORTED', error: 'Storage init failed: ' + err.message });
                    return;
                }
            }

            const currentTempFile = `extract_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`;
            try {
                const fileHandle = await root.getFileHandle(currentTempFile, { create: true });
                (self as any).currentTempFile = currentTempFile;
                syncHandle = await createSyncAccessHandleWithTimeout(fileHandle, 5000);
            } catch (err: any) {
                self.postMessage({ type: 'ERROR', code: 'ERR_OPFS_STALE_LOCK', error: 'File handle failed: ' + err.message });
                return;
            }

            // ── Read file NOW — SAF permission is still fresh ──
            // Use file.stream() — it opens the file descriptor ONCE.
            // file.slice().arrayBuffer() re-opens it per chunk, which fails on Android
            // because each open re-checks SAF permissions that may have expired.
            const ingestFile = originalFile!;
            self.postMessage({ type: 'STATUS', status: 'Ingesting Media: 0%' });

            const doIngest = async (f: File): Promise<void> => {
                const stream = f.stream();
                const reader = stream.getReader();
                let offset = 0;
                let lastReportTime = Date.now();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    syncHandle!.write(value);
                    offset += value.byteLength;

                    if (Date.now() - lastReportTime > 250) {
                        const pct = Math.floor((offset / f.size) * 100);
                        self.postMessage({ type: 'STATUS', status: `Ingesting Media: ${pct}%`, progress: pct });
                        lastReportTime = Date.now();
                    }
                }
                syncHandle!.flush();
            };

            try {
                await doIngest(ingestFile);
            } catch (firstErr: any) {
                // Retry once — some Android devices transiently fail the first stream open
                console.warn('[Ingest] First attempt failed, retrying:', firstErr.message);
                try {
                    // Reset the sync handle write position to 0 for the retry
                    syncHandle!.truncate(0);
                    await doIngest(ingestFile);
                } catch (retryErr: any) {
                    self.postMessage({ type: 'ERROR', code: 'ERR_FILE_INGEST', error: 'File ingest failed: ' + retryErr.message });
                    return;
                }
            }

            // ── Cleanup old temp files AFTER ingestion (non-critical) ──
            if (shouldCleanup) {
                try {
                    await Promise.race([
                        cleanupOldFiles(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup timeout')), 3000))
                    ]);
                } catch (e) {
                    console.warn('[Worker] Post-ingest cleanup timed out, continuing anyway');
                }
            }
            
            // File fully ingested — proceed to extraction
            await processMedia(fileName, config);
            return;
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: 'ERROR', code: 'ERR_WORKER_GENERIC', error: message });
    }
};

/**
 * Phase 2+3: Audio extraction then slide extraction.
 * 
 * PIPELINE:
 *   1. Init WASM (if not already loaded)
 *   2. Audio: Symphonia reads OPFS sync handle → pulls AAC chunks → writes to second OPFS file
 *   3. Close syncHandle (releases exclusive lock) but KEEP the OPFS file
 *   4. Re-read OPFS file as regular File for demuxer (mobile-safe, no permission expiry)
 *   5. Slides: web-demuxer + WebCodecs + WASM three-pointer diffing
 *   6. Finally: cleanup OPFS temp files
 *
 * ⚠️ DO NOT reorder steps 3-4. The syncHandle MUST be closed before getFile()
 *    (can't have both a sync handle and a read handle on the same file).
 *    But the OPFS FILE must NOT be deleted until after the demuxer finishes.
 */
async function processMedia(fileName: string, options: any = {}) {
    try {
        // ========== MEMORY PROFILER ==========
        const memLog = (label: string) => {
            const mem = (performance as any).memory;
            const wasmPages = wasmModule?.memory?.buffer?.byteLength;
            console.log(`[MEM ${label}]`, {
                jsHeapMB: mem ? (mem.usedJSHeapSize / 1e6).toFixed(1) : 'N/A',
                jsHeapTotalMB: mem ? (mem.totalJSHeapSize / 1e6).toFixed(1) : 'N/A',
                jsHeapLimitMB: mem ? (mem.jsHeapSizeLimit / 1e6).toFixed(1) : 'N/A',
                wasmHeapMB: wasmPages ? (wasmPages / 1e6).toFixed(1) : 'N/A',
            });
        };

        memLog('1-START');

        self.postMessage({ type: 'STATUS', status: 'Initializing WASM...' });
        
        // Wait up to 30 seconds for the background WASM fetch to arrive if we ingested extremely fast
        let retries = 0;
        while (!wasmInitialized && !wasmBuffer && retries < 300) {
            await new Promise(r => setTimeout(r, 100));
            retries++;
        }
        
        await ensureWasm(wasmBuffer);
        memLog('2-WASM-INIT');

        // 1. Audio Extraction — stream chunks to main thread via postMessage.
        // The consumer (App.tsx, or a future library user) decides what to do:
        //   - Accumulate in RAM → new Blob(chunks)
        //   - Stream to disk   → showSaveFilePicker → writable.write(chunk)
        //   - Stream to network → fetch upload
        // This eliminates the second OPFS temp file and its createSyncAccessHandle
        // call (which was a potential deadlock point on mobile).
        if (shouldExtractAudio) {
            let audioExtractor: any = null;
            try {
                audioExtractor = new AudioExtractor(syncHandle!);
                memLog('3-AUDIO-EXTRACTOR-CREATED');

                let lastReport = 0;
                while (true) {
                    const chunk = audioExtractor.pull_chunk(1024 * 1024);
                    if (chunk.length === 0) break;
                    const ab = chunk.buffer.slice(0) as ArrayBuffer;
                    postMessage({ type: 'AUDIO_CHUNK', buffer: ab }, [ab]);
                    const progress = Math.floor(audioExtractor.get_progress());
                    if (progress >= lastReport + 5 || progress === 100) {
                        postMessage({ type: 'STATUS', status: `Extracting Audio...`, progress });
                        lastReport = progress;
                    }
                }
                postMessage({ type: 'AUDIO_DONE', fileName: fileName.replace(/\.[^/.]+$/, "") + ".aac" });
                memLog('4-AUDIO-DONE');
            } catch (e: any) {
                // Audio extraction failed (e.g. no AAC track in WebM/Opus, unsupported codec).
                const reason = e?.message ?? 'unsupported format';
                console.warn('[Worker] Audio extraction failed:', reason);

                if (shouldExtractSlides) {
                    // Non-fatal — warn and proceed to slide extraction.
                    postMessage({ type: 'STATUS', status: `⚠️ Audio unavailable: ${reason}. Extracting slides only...` });
                } else {
                    // Fatal — audio was the ONLY thing requested and it failed.
                    postMessage({ type: 'ERROR', code: 'ERR_AUDIO_EXTRACTION', error: `Audio extraction failed: ${reason}. This file does not contain an AAC audio track (common with WebM/Opus). Try an MP4 file instead.` });
                    return;
                }
            } finally {
                if (audioExtractor) try { audioExtractor.free(); } catch(_) {}
                memLog('5-AUDIO-FREED');
            }
        } else {
            console.log('[Worker] Skipping audio extraction (disabled)');
            memLog('3-5-AUDIO-SKIPPED');
        }

        // --- Release the OPFS exclusive lock (but keep file for demuxer) ---
        if (syncHandle) {
            console.log("Releasing OPFS exclusive lock for Video Extraction...");
            syncHandle.close();
            syncHandle = undefined;
        }

        memLog('6-OPFS-LOCK-RELEASED');

        // Release wasmBuffer reference — it's already loaded into the module
        wasmBuffer = undefined;
        memLog('7-WASMBUF-RELEASED');

        // Get a fresh File reference from OPFS (mobile DOM File permissions expire)
        const tempFileName = (self as any).currentTempFile;
        let file: File;
        if (tempFileName && originalFile) {
            try {
                const opfsHandle = await root.getFileHandle(tempFileName);
                const opfsFile = await opfsHandle.getFile();
                if (opfsFile.size > 0 && opfsFile.size === originalFile.size) {
                    file = opfsFile;
                    console.log("Using validated OPFS copy for demuxer (mobile-safe)");
                } else {
                    file = originalFile;
                    console.warn("OPFS copy is empty or incomplete, falling back to original DOM File");
                }
            } catch {
                file = originalFile;
                console.warn("OPFS read failed, falling back to original DOM File");
            }
        } else {
            if (!originalFile) throw new Error("Original file handle missing in worker.");
            file = originalFile;
        }
        if (shouldExtractSlides) {
            // --- Slide buffering for timestamp ranges ---
            // We buffer ONE slide so that when the next slide arrives, we can
            // fill in endMs (= next slide's startMs) on the previous slide.
            // RAM cost: one WebP ArrayBuffer (~50-200KB) held briefly.
            let pendingSlide: { buffer: ArrayBuffer; startMs: number; timestamp: string } | null = null;

            const flushPendingSlide = (endMs: number) => {
                if (!pendingSlide) return;
                self.postMessage({
                    type: 'SLIDE',
                    buffer: pendingSlide.buffer,
                    timestamp: pendingSlide.timestamp,
                    startMs: pendingSlide.startMs,
                    endMs: Math.round(endMs),
                }, [pendingSlide.buffer]);
                pendingSlide = null;
            };

            // Merge passed options with persistent detectionConfig
            const finalOptions = {
                ...detectionConfig,
                ...options,
                onProgress: (percent: number, message: string, metrics?: any) => {
                    self.postMessage({ type: 'STATUS', status: message, progress: Math.round(percent), metrics });
                },
                onSlide: async (blob: Blob, timestamp: number) => {
                    const ab = await blob.arrayBuffer();
                    const startMs = Math.round(timestamp * 1000);

                    // Emit the PREVIOUS slide with endMs = this slide's start
                    flushPendingSlide(startMs);

                    // Buffer this slide (will be emitted when next slide arrives or on ALL_DONE)
                    pendingSlide = { buffer: ab, startMs, timestamp: formatTime(timestamp) };
                }
            };

            console.log("Starting Video Extraction with options:", {
                mode: finalOptions.mode,
                sampleFps: finalOptions.sampleFps,
                turboInterval: finalOptions.turboInterval
            });

            const slideExtractor = new SlideExtractor(
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
                {
                    ...finalOptions
                }
            );

            memLog('8-BEFORE-VIDEO-EXTRACT');
            await slideExtractor.extract(file, webDemuxerWasmUrl);
            memLog('9-AFTER-VIDEO-EXTRACT');

            // Flush the last buffered slide — use last processed timestamp as endMs
            const metrics = (slideExtractor as any).metrics;
            const ps = pendingSlide as { buffer: ArrayBuffer; startMs: number; timestamp: string } | null;
            const videoDurationMs = metrics?.lastFrameTimestamp
                ? Math.round(metrics.lastFrameTimestamp * 1000)
                : (ps?.startMs ?? 0);
            flushPendingSlide(videoDurationMs);

            postMessage({ type: 'ALL_DONE', metrics });
        } else {
            console.log('[Worker] Skipping slide extraction (disabled)');
            postMessage({ type: 'ALL_DONE', metrics: {} });
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        postMessage({ type: 'ERROR', code: 'ERR_VIDEO_DECODE', error: 'Extraction Error: ' + message });
    } finally {
        if (syncHandle) {
            try { syncHandle.close(); } catch (e) {}
        }
        if (shouldCleanup) {
            const toRemove = (self as any).currentTempFile;
            if (toRemove) {
                try {
                    await root.removeEntry(toRemove);
                    console.log("Cleaned up temp file:", toRemove);
                } catch (e) {}
            }
        } else {
            console.log('[Worker] Skipping OPFS cleanup (cleanupAfterExtraction=false)');
        }
    }
}



function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const min = Math.floor((seconds % 3600) / 60);
    const sec = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}
