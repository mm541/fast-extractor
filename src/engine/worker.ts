/**
 * ============================================================================
 * worker.ts — Stateless Compute Worker
 * ============================================================================
 *
 * This worker is a pure decoder/extractor. It receives pre-prepared data from
 * the main thread (FastExtractor) and performs:
 *   Phase 1: Audio Extraction — receives a FileSystemFileHandle, reads it
 *            synchronously via SyncAccessHandle, runs Rust/WASM Symphonia.
 *   Phase 2: Video Slide Extraction — receives pre-demuxed video chunks,
 *            decodes via WebCodecs, diffs via WASM perceptual hashing.
 *
 * The worker has ZERO knowledge of:
 *   - OPFS directory structure (no navigator.storage calls)
 *   - WebDemuxer (runs on the main thread)
 *   - File ingestion (handled by FastExtractor)
 *   - Cleanup (handled by FastExtractor)
 *
 * ⚠️ CRITICAL: MEMORY MANAGEMENT RULES
 *   1. ALWAYS close VideoFrames immediately after copying pixels to WASM buffers.
 *   2. Call AudioExtractor.free() explicitly after audio extraction.
 *   3. Set wasmBuffer = undefined after WASM init to free ~560KB.
 *   4. Use ArrayBuffer transfer (postMessage with transferList) for slides.
 *
 * MESSAGE FLOW:
 *   Main → Worker: CONFIG → INIT → EXTRACT_AUDIO → CONFIG_DECODER → VIDEO_CHUNK* → VIDEO_DONE
 *   Worker → Main: STATUS | AUDIO_CHUNK | AUDIO_DONE | SLIDE | ALL_DONE | ERROR
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

let syncHandle: FileSystemSyncAccessHandle | undefined;  // Exclusive lock on temp video file
let shouldExtractAudio = true;               // Controlled via CONFIG
let shouldExtractSlides = true;              // Controlled via CONFIG
let shouldCleanup = true;

// Slide extraction state
let slideExtractor: SlideExtractor | null = null;
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
let chunkProcessingChain = Promise.resolve();

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
            self.postMessage({ type: 'STATUS', status: 'Worker Initialized. Ready.' });
            self.postMessage({ type: 'INIT_COMPLETE' });
            return;
        }

        if (type === 'EXTRACT_AUDIO') {
            const { fileName, fileHandle, buildManifest = false, duration = 0 } = e.data;
            
            // Wait up to 30s for background WASM fetch to arrive
            let retries = 0;
            while (!wasmInitialized && !wasmBuffer && retries < 300) {
                await new Promise(r => setTimeout(r, 100));
                retries++;
            }
            await ensureWasm(wasmBuffer);
            
            try {
                syncHandle = await createSyncAccessHandleWithTimeout(fileHandle, 5000);
            } catch (err: any) {
                self.postMessage({ type: 'ERROR', code: 'ERR_OPFS_STALE_LOCK', error: 'File handle failed: ' + err.message });
                return;
            }

            let audioExtractor: any = null;
            try {
                audioExtractor = new AudioExtractor(syncHandle, buildManifest, duration);

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

                // Read extension and manifest from WASM (codec-agnostic)
                const ext = audioExtractor.get_extension();
                const manifest = buildManifest ? JSON.parse(audioExtractor.build_manifest()) : null;

                postMessage({
                    type: 'AUDIO_DONE',
                    fileName: fileName.replace(/\.[^/.]+$/, "") + "." + ext,
                    manifest,
                });
            } catch (e: any) {
                const reason = e?.message ?? 'unsupported format';
                console.warn('[Worker] Audio extraction failed:', reason);
                postMessage({ type: 'STATUS', status: `⚠️ Audio unavailable: ${reason}. Extracting slides only...` });
                postMessage({ type: 'AUDIO_DONE', fileName: null, manifest: null });
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
                        const boundaryMs = Math.round(timestamp * 1000);

                        self.postMessage({
                            type: 'SLIDE',
                            buffer: ab,
                            timestamp: formatTime(timestamp),
                            startMs: boundaryMs,
                            endMs: boundaryMs, // Dummy value, the UI will override this based on the next slide's startMs
                        }, [ab]);
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
            const currentExtractor = slideExtractor;
            if (currentExtractor) {
                // ⚠️ CRITICAL: Serialize chunk processing!
                // If we don't chain these, the async onmessage handler will pick up 
                // up to 15 chunks concurrently whenever feedChunk hits backpressure.
                // Concurrent feedChunks overwrite the backpressure resolve promise,
                // causing massive 500ms deadlocks for every batch of frames.
                chunkProcessingChain = chunkProcessingChain.then(async () => {
                    await currentExtractor.feedChunk(chunk, timestamp, chunkType);
                    self.postMessage({ type: 'CHUNK_PROCESSED' });
                });
            }
            return;
        }

        if (type === 'VIDEO_DONE') {
            const { skipped } = e.data;
            const currentExtractor = slideExtractor;
            
            chunkProcessingChain = chunkProcessingChain.then(async () => {
                let metrics: any = {};
                
                if (!skipped && currentExtractor) {
                    metrics = await currentExtractor.flush();
                }

                // Drain any pending async onSlide callbacks
                if (pendingSlideEncodes > 0) {
                    await Promise.race([
                        new Promise<void>(r => { drainResolve = r; }),
                        new Promise<void>(r => setTimeout(r, 3000))
                    ]);
                }



                postMessage({ type: 'ALL_DONE', metrics });
            });
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
