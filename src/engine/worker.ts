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


import init, { compare_frames, compare_prev_current, compute_dhash, get_avg_brightness, init_arena, get_buffer_a_ptr, get_buffer_b_ptr, get_buffer_prev_ptr, get_rgba_buffer_ptr, shift_current_to_prev, copy_rgba_to_gray } from './wasm/wasm_extractor';
import wasmUrl from './wasm/wasm_extractor_bg.wasm?url';
import { SlideExtractor } from './video/extractor';
import type { SlideExtractorOptions } from './video/extractor';
import { AudioRemuxer } from './audio/audio-remuxer';

// FFmpeg WASM Demuxer — lazy-loaded to avoid blocking worker startup on mobile
import type { FFmpegDemuxer as FFmpegDemuxerType, ModuleFactory } from '../../ffmpeg-wasm-demuxer/src/index';

// ─── WORKER STATE ───
let shouldExtractAudio = true;               // Controlled via CONFIG
let shouldExtractSlides = true;              // Controlled via CONFIG


// Slide extraction state
let pendingSlideEncodes = 0;
/**
 * Detection config — updated via CONFIG message before extraction starts.
 * See extractor.ts SlideExtractorOptions for full documentation of each field.
 */
let detectionConfig: Partial<SlideExtractorOptions> = {
    mode: 'turbo',
    edgeThreshold: 30,
    blockThreshold: 12,
    densityThresholdPct: 5,
};

/**
 * Self-initializing WASM loader. At 25KB the binary is tiny enough to
 * fetch inline at worker boot — no external coordination needed.
 * The promise is created immediately and awaited before first use.
 */
let wasmModule: any = null;
const wasmReady = init({ module_or_path: wasmUrl }).then(m => { wasmModule = m; });



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
    const { type, data, config } = e.data;
    
    try {
        if (type === 'CONFIG') {
            if (data?.extractAudio !== undefined) shouldExtractAudio = data.extractAudio;
            if (data?.extractSlides !== undefined) shouldExtractSlides = data.extractSlides;
            if (config) detectionConfig = { ...detectionConfig, ...config };
            console.log("Worker Config Updated:", detectionConfig, { shouldExtractAudio, shouldExtractSlides });
            return;
        }


        if (type === 'EXTRACT_MEDIA') {
            const { fileHandle, extractAudio, extractSlides, buildManifest, fileName, mode } = e.data;

            // Wait for the self-initialized WASM to be ready
            await wasmReady;

            let syncHandle: FileSystemSyncAccessHandle | undefined;
            let demuxer: FFmpegDemuxerType | null = null;
            let slideExtractor: SlideExtractor | null = null;
            let drainResolve: (() => void) | null = null;

            // Lazy-load the FFmpeg demuxer wrapper
            const { FFmpegDemuxer, createSyncHandleSource } = await import('../../ffmpeg-wasm-demuxer/src/index');

            try {
                self.postMessage({ type: 'STATUS', status: 'Initializing Demuxer...' });

                syncHandle = await createSyncAccessHandleWithTimeout(fileHandle, 5000);
                const fileSize = syncHandle.getSize();

                // Load the FFmpeg WASM demuxer module
                // @ts-ignore
                const { default: createDemuxerModule } = await import('../../ffmpeg-wasm-demuxer/pkg/ffmpeg_demuxer.js');
                demuxer = await FFmpegDemuxer.create(createDemuxerModule as ModuleFactory);

                const ioSource = createSyncHandleSource(syncHandle, fileSize);
                demuxer.open(ioSource);

                const duration = demuxer.duration;
                const audioInfo = extractAudio ? demuxer.getAudioStreamInfo() : null;
                const videoInfo = extractSlides ? demuxer.getVideoDecoderConfig() : null;

                // ── PASS 1: AUDIO ──
                if (extractAudio && audioInfo) {
                    self.postMessage({ type: 'STATUS', status: 'Extracting Audio...' });
                    const remuxer = new AudioRemuxer(
                        audioInfo.codecId,
                        audioInfo.sampleRate,
                        audioInfo.channels,
                        audioInfo.extradata,
                        { buildManifest, duration }
                    );

                    let lastReport = 0;
                    let pkt;
                    while ((pkt = demuxer.readPacket()) !== null) {
                        try {
                            if (pkt.streamIndex === demuxer.audioStreamIndex) {
                                remuxer.feedPacket(pkt.data, pkt.ptsUs);
                                if (remuxer.bufferedBytes >= 1024 * 1024) {
                                    const chunk = remuxer.drain();
                                    const ab = chunk.buffer as ArrayBuffer;
                                    postMessage({ type: 'AUDIO_CHUNK', buffer: ab }, [ab]);
                                }
                                
                                const progressMs = pkt.ptsUs / 1000;
                                const totalMs = duration * 1000;
                                const progress = totalMs > 0 ? Math.floor((progressMs / totalMs) * 100) : 0;
                                
                                if (progress >= lastReport + 5 || progress === 100) {
                                    postMessage({ type: 'STATUS', status: `Extracting Audio...`, progress });
                                    lastReport = progress;
                                }
                            }
                        } finally {
                            pkt.free();
                        }
                    }

                    // Flush remaining audio chunks
                    const remaining = remuxer.drain();
                    if (remaining.length > 0) {
                        const ab = remaining.buffer as ArrayBuffer;
                        postMessage({ type: 'AUDIO_CHUNK', buffer: ab }, [ab]);
                    }

                    // Finalize (OGG EOS)
                    const eosChunk = remuxer.finalize();
                    if (eosChunk.length > 0) {
                        const ab = eosChunk.buffer as ArrayBuffer;
                        postMessage({ type: 'AUDIO_CHUNK', buffer: ab }, [ab]);
                    }

                    const ext = remuxer.extension;
                    const manifest = buildManifest ? remuxer.buildManifest() : null;

                    postMessage({
                        type: 'AUDIO_DONE',
                        fileName: fileName.replace(/\.[^/.]+$/, "") + "." + ext,
                        manifest,
                    });
                } else if (extractAudio) {
                    console.warn('[Worker] No audio stream found or audio extraction disabled.');
                    postMessage({ type: 'STATUS', status: `⚠️ Audio stream not found. Extracting slides only...` });
                    postMessage({ type: 'AUDIO_DONE', fileName: null, manifest: null });
                }

                // ── REWIND FOR PASS 2 ──
                if (extractAudio && extractSlides && videoInfo) {
                    demuxer.seekToTime(0);
                }

                // ── PASS 2: SLIDES ──
                if (extractSlides && videoInfo) {
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

                            get_avg_brightness,
                            memory: wasmModule.memory
                        } as any,
                        finalOptions
                    );

                    await slideExtractor.configure(videoInfo.config, duration);
                    self.postMessage({ type: 'STATUS', status: 'Extracting Slides...' });

                    let pkt;
                    while ((pkt = demuxer.readPacket()) !== null) {
                        try {
                            if (pkt.streamIndex === demuxer.videoStreamIndex) {
                                if (mode === 'turbo' && !pkt.isKeyframe) {
                                    continue;
                                }

                                await slideExtractor.feedChunk(
                                    pkt.data.slice().buffer as ArrayBuffer,
                                    pkt.ptsUs,
                                    pkt.isKeyframe ? 'key' : 'delta'
                                );
                            }
                        } finally {
                            pkt.free();
                        }
                    }

                    const metrics = await slideExtractor.flush();

                    if (pendingSlideEncodes > 0) {
                        await Promise.race([
                            new Promise<void>(r => { drainResolve = r; }),
                            new Promise<void>(r => setTimeout(r, 3000))
                        ]);
                    }

                    postMessage({ type: 'ALL_DONE', metrics });
                } else if (extractSlides) {
                    throw new Error('No video stream found in file');
                } else {
                    // Audio only mode
                    postMessage({ type: 'ALL_DONE', metrics: {} });
                }

            } catch (err: any) {
                const message = err instanceof Error ? err.message : String(err);
                self.postMessage({ type: 'ERROR', code: 'ERR_WORKER_GENERIC', error: message });
            } finally {
                if (slideExtractor) {
                    try { slideExtractor.destroy(); } catch {}
                }
                if (demuxer) {
                    try { demuxer.destroy(); } catch {}
                }
                if (syncHandle) {
                    try { syncHandle.close(); } catch {}
                }
                if (drainResolve) {
                    try { (drainResolve as any)(); } catch {}
                }
            }
            return;
        }

        if (type === 'VIDEO_DONE') {
            // Handle the "skipped slides" case from FastExtractor
            const { skipped } = e.data;
            if (skipped) {
                postMessage({ type: 'ALL_DONE', metrics: {} });
            }
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
