/**
 * ============================================================================
 * App.tsx — Reference Implementation for FastExtractor Library
 * ============================================================================
 *
 * ARCHITECTURE OVERVIEW:
 * This is a React single-page app that extracts audio and slides from video files
 * using the FastExtractor ReadableStream API. App.tsx does NOT manage Workers,
 * WASM, or message protocols — all of that is handled by the library.
 *
 * This file serves as a real-world reference implementation that library consumers
 * can study and adapt. If you can build it with App.tsx, you can build it with
 * any framework (Vue, Svelte, vanilla JS).
 *
 * FLOW:
 *   1. User selects a video file via <input type="file">
 *   2. User clicks "Start Extraction"
 *   3. App creates a FastExtractor and calls extractor.extract(file)
 *   4. App reads from the returned ReadableStream via stream.getReader()
 *   5. Events arrive: 'audio' → 'audio_done' → 'slide' (×N) → 'progress' (×N)
 *   6. On completion, the stream closes. On fatal error, the stream errors.
 *   7. Recoverable errors (e.g. Android SAF permission expiry) are emitted as
 *      'error' events with recoverable=true, allowing the app to re-trigger
 *      the file picker.
 *
 * LIBRARY USAGE PATTERN:
 *   const extractor = new FastExtractor({ mode: 'turbo', ...config });
 *   const stream = extractor.extract(file, abortSignal);
 *   const reader = stream.getReader();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     switch (value.type) { ... }
 *   }
 *
 * ⚠️ RULES:
 *   1. ALWAYS use fileRef (useRef) in callbacks — React closures capture stale state.
 *   2. ALWAYS revoke Object URLs when re-extracting or unmounting (memory leak prevention).
 *   3. On Android, file access can expire. Handle 'error' events with recoverable=true
 *      by re-triggering the file picker.
 *
 * LOW-MEMORY DEVICES (≤4GB RAM):
 *   - Auto-selects Turbo mode (seek-based, not sequential)
 *   - This reduces accuracy but prevents OOM crashes
 *
 * CONFIGURATION:
 *   All detection thresholds are exposed in the UI. See extractor.ts for what each does.
 *   The "Advanced Drift Detection" section is hidden by default for normal users.
 */
import React, { useState, useRef, useEffect } from 'react';
import { FastExtractor } from '../engine';
import type { IngestedFile } from '../engine/types';
import { downloadZip } from 'client-zip';
import CapabilityBanner from './components/CapabilityBanner';
import MetricsDashboard from './components/MetricsDashboard';
import SlideGallery from './components/SlideGallery';
import Lightbox from './components/Lightbox';
import ConfigPanel from './components/ConfigPanel';
import { formatMs, cleanupAppStorage } from './utils';
import type { DeviceCapabilities, SlideIndexEntry } from './types';
import './App.css';


const App: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<string>('Ready to extract');
    const [isExtracting, setIsExtracting] = useState(false);
    const [isIngesting, setIsIngesting] = useState(false);
    const [ingestedFile, setIngestedFile] = useState<IngestedFile | null>(null);
    const ingestAbortRef = useRef<AbortController | null>(null);
    
    const [slides, setSlides] = useState<SlideIndexEntry[]>([]);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string>('');
    const [isZipping, setIsZipping] = useState(false);
    const [progress, setProgress] = useState<number>(0);
    const [jobMetrics, setJobMetrics] = useState<{ start: number; end: number | null }>({ start: 0, end: null });
    const [extractionMode, setExtractionMode] = useState<'turbo' | 'sequential'>('turbo');
    
    const [config, setConfig] = useState({
        sampleFps: 1,
        edgeThreshold: 30,
        blockThreshold: 8,
        densityThresholdPct: 4,
        minSlideDuration: 3,
        dhashDuplicateThreshold: 4,
        useDeferredEmit: true,

        // Drift detection
        cumulativeDriftMultiplier: 2,
        cumulativeSettledSeconds: 2,
        partialThresholdRatio: 0.5,
        noiseResetSeconds: 30,
        noiseMainRatio: 0.25,
        imageQuality: 0.8,
        imageFormat: 'jpeg' as 'webp' | 'jpeg',
        exportResolution: 0,
    });
    
    const [ignoreMask, setIgnoreMask] = useState<bigint>(0n);
    const [extractAudio, setExtractAudio] = useState(true);
    const [extractSlides, setExtractSlides] = useState(true);
    const [buildManifest, setBuildManifest] = useState(true);
    const [audioManifest, setAudioManifest] = useState<any>(null);
    
    const [metrics, setMetrics] = useState<any>(null);
    const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
    const [lightboxZoom, setLightboxZoom] = useState<number>(1);
    
    const abortRef = useRef<AbortController | null>(null);
    const fileRef = useRef<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const retryPending = useRef(false);
    const urlsToCleanup = useRef<string[]>([]);
    const sessionIdRef = useRef<string>('');
    
    useEffect(() => {
        // Wipe out any orphaned temp files from previously crashed/closed tabs
        FastExtractor.cleanupStorage().catch(console.warn);
        cleanupAppStorage().catch(console.warn);

        FastExtractor.checkBrowserSupport().then(support => {
            const caps: DeviceCapabilities = {
                webCodecs: support.webCodecs,
                opfs: support.opfs,
                offscreenCanvas: support.offscreenCanvas,
                deviceMemoryGb: support.deviceMemoryGb,
                hardwareConcurrency: support.hardwareConcurrency,
                webGpu: support.webGpu,
                isMobile: support.isMobile,
                canExtract: support.supported,
            };
            setCapabilities(caps);
            console.log('[DeviceCaps]', caps);
            if (caps.deviceMemoryGb && caps.deviceMemoryGb <= 4) {
                setExtractionMode('turbo');
            }
        });
        return () => {
            urlsToCleanup.current.forEach(url => URL.revokeObjectURL(url));
        };
    }, []);

    useEffect(() => {
        if (lightboxIndex === null) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setLightboxIndex(null);
            } else if (e.key === 'ArrowRight') {
                setLightboxZoom(1);
                setLightboxIndex(prev => (prev !== null && prev < slides.length - 1 ? prev + 1 : prev));
            } else if (e.key === 'ArrowLeft') {
                setLightboxZoom(1);
                setLightboxIndex(prev => (prev !== null && prev > 0 ? prev - 1 : prev));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [lightboxIndex, slides.length]);

    const cleanupPreviousSession = () => {
        urlsToCleanup.current.forEach(url => URL.revokeObjectURL(url));
        urlsToCleanup.current = [];
    };

    const resetApp = () => {
        setFile(null);
        fileRef.current = null;
        cleanupPreviousSession();
        setAudioUrl(null);
        setSlides([]);
        setIngestedFile(null);
        setStatus('Ready to extract');
        setProgress(0);
        setJobMetrics({ start: 0, end: null });
        setMetrics(null);
        setAudioManifest(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
        
        // Proactively clean up OPFS storage since the session is discarded
        FastExtractor.cleanupStorage().catch(console.warn);
        cleanupAppStorage().catch(console.warn);

        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const f = e.target.files[0];
            setFile(f);
            fileRef.current = f;
            cleanupPreviousSession();
            setAudioUrl(null);
            setSlides([]);
            setIngestedFile(null);
            
            if (ingestAbortRef.current) {
                ingestAbortRef.current.abort();
            }
            
            setStatus('Caching file to local sandbox...');
            setIsIngesting(true);
            setProgress(0);
            
            const controller = new AbortController();
            ingestAbortRef.current = controller;

            try {
                const ingested = await FastExtractor.ingest(f, {
                    onProgress: (pct, msg) => {
                        setProgress(pct);
                        setStatus(msg);
                    },
                    signal: controller.signal
                });
                setIngestedFile(ingested);
                setStatus('Ready to extract');
                
                // Auto-retry extraction if this was a re-select after SAF failure
                if (retryPending.current) {
                    retryPending.current = false;
                    setTimeout(() => startExtraction(), 100);
                }
            } catch (err: any) {
                if (err.name === 'AbortError') {
                    setStatus('Ingestion halted.');
                } else if (err.message.includes('FILE_ACCESS_EXPIRED') || err.message.includes('could not be read') || err.name === 'NotReadableError' || err.name === 'NetworkError') {
                    setStatus('⚠️ File access expired. Please re-select the same file.');
                    retryPending.current = true;
                    if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                        fileInputRef.current.click();
                    }
                } else {
                    setStatus('Ingestion failed: ' + err.message);
                }
                
                // Only clear the file if it wasn't a retry prompt
                if (!retryPending.current) {
                    setFile(null);
                    fileRef.current = null;
                }
            } finally {
                setIsIngesting(false);
                setProgress(0);
            }
        }
    };

    const haltIngestion = () => {
        if (ingestAbortRef.current) {
            ingestAbortRef.current.abort();
            ingestAbortRef.current = null;
        }
    };

    const downloadAsZip = async () => {
        if (slides.length === 0 && !audioUrl) return;
        try {
            setIsZipping(true);
            
            async function* yieldFiles() {
                const root = await navigator.storage.getDirectory();
                const artifactsDir = await root.getDirectoryHandle('.app_artifacts');
                
                if (audioUrl && fileName) {
                    try {
                        const audioH = await artifactsDir.getFileHandle(`audio_${sessionIdRef.current}.aac`);
                        yield { name: fileName, input: await audioH.getFile() };
                    } catch (e) {
                        console.warn("Audio file not found in OPFS, skipping.");
                    }
                }
                
                if (audioManifest) {
                    const manifestBlob = new Blob([JSON.stringify(audioManifest, null, 2)], { type: 'application/json' });
                    yield { name: 'manifest.json', input: manifestBlob };
                }
                
                if (slides.length > 0) {
                    try {
                        const slidesH = await artifactsDir.getFileHandle(`slides_${sessionIdRef.current}.dat`);
                        const slidesFile = await slidesH.getFile();
                        const mimeType = config.imageFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                        const ext = config.imageFormat === 'webp' ? 'webp' : 'jpg';
                        
                        for (let i = 0; i < slides.length; i++) {
                            const slide = slides[i];
                            const startSec = Math.floor(slide.startMs / 1000);
                            const startStr = formatMs(startSec * 1000).replace(/:/g, '-');
                            
                            const blob = slidesFile.slice(slide.offset, slide.offset + slide.length, mimeType);
                            yield { name: `slides/slide_${String(i+1).padStart(3, '0')}_${startStr}.${ext}`, input: blob };
                        }
                    } catch (e) {
                        console.warn("Slides file not found in OPFS, skipping.");
                    }
                }
            }

            const zipStream = downloadZip(yieldFiles());
            const baseName = file?.name ?? ingestedFile?.originalName ?? 'extraction';
            const downloadName = `${baseName.replace(/\.[^/.]+$/, "")}_extracted.zip`;

            // Modern Streaming Download via OPFS or File System Access API
            if ('showSaveFilePicker' in window) {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: downloadName,
                    types: [{
                        description: 'ZIP Archive',
                        accept: { 'application/zip': ['.zip'] },
                    }],
                });
                const writable = await handle.createWritable();
                await zipStream.body?.pipeTo(writable);
            } else {
                // Fallback for Safari/Mobile: Generate Blob (spikes RAM briefly)
                const response = new Response(zipStream.body);
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = downloadName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
            
        } catch (error: any) {
            // Ignore AbortError when user cancels the save file picker
            if (error.name !== 'AbortError') {
                console.error("Failed to create ZIP:", error);
                alert("Failed to create ZIP package.");
            }
        } finally {
            setIsZipping(false);
        }
    };

    const startExtraction = async () => {
        if (!file) return;

        // Cancel any previous extraction
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }

        cleanupPreviousSession();

        // Generate unique session ID for this extraction's OPFS files
        const sessionId = `${Date.now()}`;
        sessionIdRef.current = sessionId;

        setIsExtracting(true);
        setStatus('Initializing Processing Engine...');
        setSlides([]);
        setAudioManifest(null);
        setProgress(0);
        setMetrics(null);
        setJobMetrics({ start: performance.now(), end: null });

        const controller = new AbortController();
        abortRef.current = controller;

        // ── Create extractor with current config ──
        const extractor = new FastExtractor({
            mode: extractionMode,
            ignoreMask,
            extractAudio,
            extractSlides,
            buildManifest,
            ...config,
        });

        if (!extractAudio) setAudioUrl(null); // clear stale audio from a previous run

        let audioWritable: FileSystemWritableFileStream | null = null;
        let slidesWritable: FileSystemWritableFileStream | null = null;
        let slidesHandle: FileSystemFileHandle | null = null;

        const doExtract = async () => {
            try {
                const root = await navigator.storage.getDirectory();
            const artifactsDir = await root.getDirectoryHandle('.app_artifacts', { create: true });
            
            if (extractAudio) {
                const audioHandle = await artifactsDir.getFileHandle(`audio_${sessionId}.aac`, { create: true });
                audioWritable = await audioHandle.createWritable({ keepExistingData: false });
            }

            if (extractSlides) {
                slidesHandle = await artifactsDir.getFileHandle(`slides_${sessionId}.dat`, { create: true });
                slidesWritable = await slidesHandle.createWritable({ keepExistingData: false });
            }

            let currentSlideOffset = 0;
            let ramBatchSize = 0;
            const BATCH_LIMIT = 25 * 1024 * 1024; // 25MB RAM Buffer for Slides
            let slideIndexBuffer: SlideIndexEntry[] = [];

            const inputTarget = ingestedFile || fileRef.current!;
            const stream = extractor.extract(inputTarget, controller.signal);
            const reader = stream.getReader();

            while (true) {
                const { done, value: event } = await reader.read();
                if (done) break;

                switch (event.type) {
                    case 'audio':
                        if (audioWritable) {
                            await audioWritable.write(event.chunk);
                        }
                        break;

                    case 'audio_done': {
                        if (audioWritable) {
                            await audioWritable.close();
                            audioWritable = null;
                        }
                        if (event.manifest) {
                            setAudioManifest(event.manifest);
                        }
                        if (event.fileName) {
                            const audioH = await artifactsDir.getFileHandle(`audio_${sessionId}.aac`);
                            const audioFile = await audioH.getFile();
                            const url = URL.createObjectURL(audioFile);
                            urlsToCleanup.current.push(url);
                            setAudioUrl(url);
                            setFileName(event.fileName);
                            setStatus('Audio Ready! Harvesting Slides...');
                        } else {
                            // Audio extraction failed gracefully. Clean up the empty OPFS file.
                            try {
                                await artifactsDir.removeEntry(`audio_${sessionId}.aac`);
                            } catch (e) {}
                            setStatus('Audio unavailable. Extracting slides only...');
                        }
                        break;
                    }

                    case 'slide': {
                        if (slidesWritable && slidesHandle) {
                            // Write to OPFS Swap File
                            await slidesWritable.write(event.imageBuffer);
                            const length = event.imageBuffer.byteLength;
                            const offset = currentSlideOffset;
                            currentSlideOffset += length;
                            ramBatchSize += length;

                            const mimeType = config.imageFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                            const slideBlob = new Blob([event.imageBuffer], { type: mimeType });
                            const tempUrl = URL.createObjectURL(slideBlob);
                            urlsToCleanup.current.push(tempUrl);

                            const newSlide: SlideIndexEntry = {
                                offset,
                                length,
                                url: tempUrl,
                                time: event.timestamp,
                                startMs: event.startMs,
                            };
                            
                            slideIndexBuffer.push(newSlide);
                            setSlides(prev => [...prev, newSlide]);

                            // 25MB Batched Append Flush
                            if (ramBatchSize >= BATCH_LIMIT) {
                                await slidesWritable.close();
                                slidesWritable = await slidesHandle.createWritable({ keepExistingData: true });
                                await slidesWritable.seek(currentSlideOffset);
                                
                                const slidesFile = await slidesHandle.getFile();
                                const staleUrls: string[] = [];
                                setSlides(prev => {
                                    const updated = [...prev];
                                    slideIndexBuffer.forEach(s => {
                                        const idx = updated.findIndex(u => u.url === s.url);
                                        if (idx !== -1) {
                                            const newBlob = slidesFile.slice(s.offset, s.offset + s.length, mimeType);
                                            const newUrl = URL.createObjectURL(newBlob);
                                            staleUrls.push(s.url);
                                            urlsToCleanup.current = urlsToCleanup.current.filter(u => u !== s.url);
                                            urlsToCleanup.current.push(newUrl);
                                            updated[idx] = { ...updated[idx], url: newUrl };
                                        }
                                    });
                                    return updated;
                                });
                                // Delay revocation so the browser has time to load the new
                                // disk-backed images before the old RAM blobs are killed.
                                // This prevents any split-second blackout in the UI grid.
                                setTimeout(() => staleUrls.forEach(u => URL.revokeObjectURL(u)), 500);
                                slideIndexBuffer = [];
                                ramBatchSize = 0;
                            }
                        }
                        break;
                    }

                    case 'progress':
                        setStatus(event.message);
                        if (event.percent >= 0) setProgress(event.percent);
                        if (event.metrics) setMetrics(event.metrics);
                        break;

                }
            }            // Final Flush of any remaining RAM slides
            if (slidesWritable) {
                await slidesWritable.close();
                slidesWritable = null;
                
                if (slidesHandle && slideIndexBuffer.length > 0) {
                    const slidesFile = await slidesHandle.getFile();
                    const mimeType = config.imageFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                    setSlides(prev => {
                        const updated = [...prev];
                        slideIndexBuffer.forEach(s => {
                            const idx = updated.findIndex(u => u.url === s.url);
                            if (idx !== -1) {
                                const newBlob = slidesFile.slice(s.offset, s.offset + s.length, mimeType);
                                const newUrl = URL.createObjectURL(newBlob);
                                URL.revokeObjectURL(s.url);
                                urlsToCleanup.current = urlsToCleanup.current.filter(u => u !== s.url);
                                urlsToCleanup.current.push(newUrl);
                                updated[idx] = { ...updated[idx], url: newUrl };
                            }
                        });
                        return updated;
                    });
                }
            }

            // Stream closed — normal completion
            // (status is already 'Extraction Complete' from the final progress event)
            setJobMetrics(prev => ({ ...prev, end: performance.now() }));
            setIsExtracting(false);
        } catch (err: any) {
            // Close OPFS handles safely before retrying to prevent locks
            if (slidesWritable) {
                try { await slidesWritable.close(); } catch {}
            }
            if (audioWritable) {
                try { await audioWritable.close(); } catch {}
            }

            if (err.name === 'ExtractorError' && (err.code === 'ERR_FILE_INGEST' || err.message.includes('could not be read'))) {
                // Recoverable error (e.g. Android SAF permission expired)
                setStatus('⚠️ File access expired. Please re-select the same file.');
                setIsExtracting(false);
                setFile(null);
                fileRef.current = null;
                retryPending.current = true;
                if (fileInputRef.current) {
                    fileInputRef.current.value = '';
                    fileInputRef.current.click();
                }
            } else {
                // Fatal (non-recoverable) error
                setStatus(`Error: ${err.message}`);
                setIsExtracting(false);
            }
        } finally {
            abortRef.current = null;
        }
        }; // End of doExtract

        if (navigator.locks) {
            await navigator.locks.request(`app_audio_${sessionId}.aac`, async () => {
                await navigator.locks.request(`app_slides_${sessionId}.dat`, async () => {
                    await doExtract();
                });
            });
        } else {
            await doExtract();
        }
    };

    return (
        <div className="container">
            <header>
                <div className="logo">⚡ FastExtractor <span className="pro">PRO</span></div>
            </header>

            <main>
                <section className="hero">
                    <h1>Blazing Fast Audio & <span className="highlight">Slide Extraction</span></h1>
                    <p>Powered by WASM, OPFS, and Hardware-Accelerated WebCodecs.</p>
                </section>

                {capabilities && (
                    <CapabilityBanner capabilities={capabilities} />
                )}

                <div className="glass-panel">
                    <div className="upload-zone">
                        <label className={`file-label ${file ? 'has-file' : ''}`}>
                            {file ? '📄 ' + file.name : 'Select Video File'}
                            <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFileChange} disabled={isExtracting || isIngesting} />
                        </label>
                        
                        {isIngesting && (
                            <div style={{ marginTop: '15px', textAlign: 'center' }}>
                                <div style={{ color: 'var(--accent)', fontSize: '0.9rem', marginBottom: '8px' }}>{status}</div>
                                <div className="progress-container" style={{ margin: '0 auto 10px auto', width: '80%' }}>
                                    <div className="progress-bar-inner" style={{ '--width': `${progress}%` } as React.CSSProperties}></div>
                                </div>
                                <button 
                                    className="btn-halt" 
                                    onClick={haltIngestion}
                                    style={{ background: '#ff4d4d', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer' }}
                                >
                                    🛑 Halt
                                </button>
                            </div>
                        )}
                        
                        <ConfigPanel
                            file={file}
                            config={config}
                            setConfig={setConfig}
                            extractionMode={extractionMode}
                            setExtractionMode={setExtractionMode}
                            extractAudio={extractAudio}
                            setExtractAudio={setExtractAudio}
                            extractSlides={extractSlides}
                            setExtractSlides={setExtractSlides}
                            buildManifest={buildManifest}
                            setBuildManifest={setBuildManifest}
                            ignoreMask={ignoreMask}
                            setIgnoreMask={setIgnoreMask}
                            isExtracting={isExtracting}
                            isIngesting={isIngesting}
                            slides={slides}
                            audioUrl={audioUrl}
                            startExtraction={startExtraction}
                            resetApp={resetApp}
                        />
                    </div>

                    <div className="status-box">
                        <div className="status-header">
                            <div className="pulse-dot"></div>
                            <span>{status}</span>
                            {isExtracting && <span className="pct">{progress}%</span>}
                        </div>
                        {/* Progress UI */}
                        {isExtracting && !isIngesting && (
                            <div className="progress-container">
                                <div 
                                    className="progress-bar-inner" 
                                    style={{ '--width': `${progress}%` } as React.CSSProperties}
                                ></div>
                                {audioManifest && (
                    <div className="manifest-container" style={{ marginTop: '20px', padding: '15px', background: '#2c2c2c', borderRadius: '8px', border: '1px solid #444', textAlign: 'left' }}>
                        <h4 style={{ margin: '0 0 10px 0', color: '#ffb300' }}>Audio Manifest (S3 Range Query Index)</h4>
                        <details>
                            <summary style={{ cursor: 'pointer', color: '#888' }}>View JSON</summary>
                            <pre style={{ overflowX: 'auto', background: '#1e1e1e', padding: '10px', borderRadius: '4px', fontSize: '12px', color: '#a6e22e' }}>
                                {JSON.stringify(audioManifest, null, 2)}
                            </pre>
                        </details>
                    </div>
                )}
            </div>
                        )}
                    </div>
                </div>

                {metrics && metrics.startTime && (
                    <MetricsDashboard metrics={metrics} jobMetrics={jobMetrics} extractionMode={extractionMode} />
                )}

                {audioUrl && (
                    <div className="result-card slide-up">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0 }}>🎧 Extracted Audio</h3>
                            <a href={audioUrl} download={fileName} className="btn-download">
                                Download {fileName}
                            </a>
                        </div>
                    </div>
                )}
                
                {!isExtracting && (slides.length > 0 || audioUrl) && (
                     <div className="result-card slide-up" style={{ textAlign: 'center' }}>
                        <button 
                            onClick={downloadAsZip} 
                            disabled={isZipping}
                            className="btn-export-zip" 
                        >
                            {isZipping ? '⌛ Packaging...' : '📦 Export All as ZIP'}
                        </button>
                     </div>
                )}

                {slides.length > 0 && (
                    <SlideGallery slides={slides} onSlideClick={(i) => { setLightboxIndex(i); setLightboxZoom(1); }} />
                )}
                {lightboxIndex !== null && (
                    <Lightbox
                        slides={slides}
                        lightboxIndex={lightboxIndex}
                        lightboxZoom={lightboxZoom}
                        setLightboxIndex={setLightboxIndex}
                        setLightboxZoom={setLightboxZoom}
                    />
                )}
            </main>
        </div>
    );
};

export default App;
