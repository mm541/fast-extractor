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
import GridMaskPicker from './GridMaskPicker';
import { FastExtractor } from '../engine';
import { downloadZip } from 'client-zip';
import './App.css';

interface DeviceCapabilities {
    webCodecs: boolean;
    opfs: boolean;
    offscreenCanvas: boolean;
    deviceMemoryGb: number | null;
    hardwareConcurrency: number;
    webGpu: boolean;
    isMobile: boolean;
    canExtract: boolean;
}

/** Convert milliseconds to HH:MM:SS */
function formatMs(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const App: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<string>('Ready to extract');
    const [isExtracting, setIsExtracting] = useState(false);
    
    type SlideIndexEntry = { offset: number, length: number, time: string, startMs: number, endMs: number, url: string };
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
        confirmThreshold: 10,
        // Drift detection
        blankBrightnessThreshold: 8,
        cumulativeDriftMultiplier: 2,
        cumulativeSettledFrames: 2,
        partialThresholdRatio: 0.5,
        noiseResetFrames: 30,
        noiseMainRatio: 0.25,
        imageQuality: 0.8,
        imageFormat: 'jpeg' as 'webp' | 'jpeg',
        exportResolution: 0,
    });
    
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [showMaskEditor, setShowMaskEditor] = useState(false);
    const [ignoreMask, setIgnoreMask] = useState<bigint>(0n);
    const [extractAudio, setExtractAudio] = useState(true);
    const [extractSlides, setExtractSlides] = useState(true);
    
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

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const f = e.target.files[0];
            setFile(f);
            fileRef.current = f;
            cleanupPreviousSession();
            setAudioUrl(null);
            setSlides([]);
            setStatus('File selected: ' + f.name);

            // Auto-retry extraction if this was a re-select after SAF failure
            if (retryPending.current) {
                retryPending.current = false;
                // Small delay to let React state settle
                setTimeout(() => startExtraction(), 100);
            }
        }
    };

    const downloadAsZip = async () => {
        if (!file) return;
        try {
            setIsZipping(true);
            
            async function* yieldFiles() {
                const root = await navigator.storage.getDirectory();
                const feDir = await root.getDirectoryHandle('.fast_extractor');
                
                if (audioUrl && fileName) {
                    try {
                        const audioH = await feDir.getFileHandle(`audio_${sessionIdRef.current}.aac`);
                        yield { name: fileName, input: await audioH.getFile() };
                    } catch (e) {
                        console.warn("Audio file not found in OPFS, skipping.");
                    }
                }
                
                if (slides.length > 0) {
                    try {
                        const slidesH = await feDir.getFileHandle(`slides_${sessionIdRef.current}.dat`);
                        const slidesFile = await slidesH.getFile();
                        const mimeType = config.imageFormat === 'webp' ? 'image/webp' : 'image/jpeg';
                        const ext = config.imageFormat === 'webp' ? 'webp' : 'jpg';
                        
                        for (let i = 0; i < slides.length; i++) {
                            const slide = slides[i];
                            const startStr = formatMs(slide.startMs).replace(/:/g, '-');
                            const endStr = formatMs(slide.endMs).replace(/:/g, '-');
                            const blob = slidesFile.slice(slide.offset, slide.offset + slide.length, mimeType);
                            yield { name: `slides/slide_${String(i+1).padStart(3, '0')}_${startStr}_to_${endStr}.${ext}`, input: blob };
                        }
                    } catch (e) {
                        console.warn("Slides file not found in OPFS, skipping.");
                    }
                }
            }

            const zipStream = downloadZip(yieldFiles());
            const downloadName = `${file.name.replace(/\.[^/.]+$/, "")}_extracted.zip`;

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

        // Clean stale OPFS files from crashed/previous tabs before starting
        await FastExtractor.cleanupStorage();

        // Generate unique session ID for this extraction's OPFS files
        const sessionId = `${Date.now()}`;
        sessionIdRef.current = sessionId;

        setIsExtracting(true);
        setStatus('Initializing Processing Engine...');
        setSlides([]);
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
            ...config,
        });

        if (!extractAudio) setAudioUrl(null); // clear stale audio from a previous run

        let audioWritable: FileSystemWritableFileStream | null = null;
        let slidesWritable: FileSystemWritableFileStream | null = null;
        let slidesHandle: FileSystemFileHandle | null = null;

        try {
            const root = await navigator.storage.getDirectory();
            const feDir = await root.getDirectoryHandle('.fast_extractor', { create: true });
            
            if (extractAudio) {
                const audioHandle = await feDir.getFileHandle(`audio_${sessionId}.aac`, { create: true });
                audioWritable = await audioHandle.createWritable({ keepExistingData: false });
            }

            if (extractSlides) {
                slidesHandle = await feDir.getFileHandle(`slides_${sessionId}.dat`, { create: true });
                slidesWritable = await slidesHandle.createWritable({ keepExistingData: false });
            }

            let currentSlideOffset = 0;
            let ramBatchSize = 0;
            const BATCH_LIMIT = 25 * 1024 * 1024; // 25MB RAM Buffer for Slides
            let slideIndexBuffer: SlideIndexEntry[] = [];

            const stream = extractor.extract(fileRef.current!, controller.signal);
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
                        const audioH = await feDir.getFileHandle(`audio_${sessionId}.aac`);
                        const audioFile = await audioH.getFile();
                        const url = URL.createObjectURL(audioFile);
                        urlsToCleanup.current.push(url);
                        setAudioUrl(url);
                        setFileName(event.fileName);
                        setStatus('Audio Ready! Harvesting Slides...');
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
                                endMs: event.endMs,
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
                    <div className={`capability-banner ${capabilities.canExtract ? 'supported' : 'unsupported'}`}>
                        <div className="cap-row">
                            <span className={capabilities.webCodecs ? 'cap-ok' : 'cap-fail'}>WebCodecs {capabilities.webCodecs ? '✓' : '✗'}</span>
                            <span className={capabilities.opfs ? 'cap-ok' : 'cap-fail'}>OPFS {capabilities.opfs ? '✓' : '✗'}</span>
                            <span className={capabilities.offscreenCanvas ? 'cap-ok' : 'cap-warn'}>OffscreenCanvas {capabilities.offscreenCanvas ? '✓' : '⚠'}</span>
                            {capabilities.deviceMemoryGb && <span className="cap-info">{capabilities.deviceMemoryGb}GB RAM</span>}
                        </div>
                        {!capabilities.canExtract && (
                            <p className="cap-error">Your browser does not support the required APIs (WebCodecs + OPFS). Try Chrome 102+ on desktop or Android.</p>
                        )}
                        {capabilities.isMobile && capabilities.canExtract && (
                            <p className="cap-warning">Mobile detected — auto-selected Turbo mode with reduced resolution for stability.</p>
                        )}
                        {!capabilities.isMobile && capabilities.canExtract && capabilities.deviceMemoryGb && capabilities.deviceMemoryGb <= 4 && (
                            <p className="cap-warning">Low memory ({capabilities.deviceMemoryGb}GB) — auto-selected Turbo mode to prevent crashes.</p>
                        )}
                    </div>
                )}

                <div className="glass-panel">
                    <div className="upload-zone">
                        <label className={`file-label ${file ? 'has-file' : ''}`}>
                            {file ? '📄 ' + file.name : 'Select Video File'}
                            <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFileChange} disabled={isExtracting} />
                        </label>
                        <p className="hint">Tip: Use <b>"Turbo"</b> mode for 10x faster sampling of long videos.</p>
                        
                        <div className="mode-toggle">
                            <button 
                                className={`mode-btn ${extractionMode === 'sequential' ? 'active' : ''}`}
                                onClick={() => setExtractionMode('sequential')}
                                disabled={isExtracting}
                            >
                                🎯 Sequential
                            </button>
                            <button 
                                className={`mode-btn ${extractionMode === 'turbo' ? 'active' : ''}`}
                                onClick={() => setExtractionMode('turbo')}
                                disabled={isExtracting}
                            >
                                🚀 Turbo
                            </button>
                        </div>

                        <div className="extract-toggles">
                            <label className={`extract-toggle-btn ${extractAudio ? 'active' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={extractAudio}
                                    onChange={e => setExtractAudio(e.target.checked)}
                                    disabled={isExtracting}
                                />
                                🎧 Extract Audio
                            </label>
                            <label className={`extract-toggle-btn ${extractSlides ? 'active' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={extractSlides}
                                    onChange={e => setExtractSlides(e.target.checked)}
                                    disabled={isExtracting}
                                />
                                🖼️ Extract Slides
                            </label>
                        </div>

                        {/* Mask Editor Toggle + Picker */}
                        {file && (
                            <div style={{ marginTop: '12px' }}>
                                <button
                                    className={`mode-btn ${showMaskEditor ? 'active' : ''}`}
                                    onClick={() => setShowMaskEditor(!showMaskEditor)}
                                    disabled={isExtracting}
                                    style={{ width: '100%', fontSize: '13px' }}
                                >
                                    🎭 {showMaskEditor ? 'Hide' : 'Show'} Region Mask {ignoreMask > 0n ? '(Active)' : ''}
                                </button>
                                {showMaskEditor && (
                                    <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'center', boxSizing: 'border-box', width: '100%', padding: '0 8px' }}>
                                        <GridMaskPicker
                                            file={file}
                                            mask={ignoreMask}
                                            onMaskChange={setIgnoreMask}
                                            disabled={isExtracting}
                                        />
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="settings-grid">
                            {extractionMode === 'sequential' && (
                                <div className="setting-item">
                                    <label>Accurate FPS: <strong>{config.sampleFps}</strong></label>
                                    <input 
                                        type="range" min="0.2" max="10" step="0.2" 
                                        value={config.sampleFps} onChange={e => setConfig({...config, sampleFps: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Frames per second to sample in accurate mode"
                                    />
                                </div>
                            )}
                            <div className="setting-item">
                                <label>Edge Threshold: <strong>{config.edgeThreshold}</strong></label>
                                <input 
                                    type="range" min="10" max="100" step="1" 
                                    value={config.edgeThreshold} onChange={e => setConfig({...config, edgeThreshold: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Edge detection threshold"
                                />
                            </div>
                            <div className="setting-item">
                                <label>Min Slide Duration: <strong>{config.minSlideDuration}s</strong></label>
                                <input 
                                    type="range" min="1" max="30" step="1" 
                                    value={config.minSlideDuration} onChange={e => setConfig({...config, minSlideDuration: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Minimum duration between slides"
                                />
                            </div>
                            <div className="setting-item">
                                <label>Density Threshold: <strong>{config.densityThresholdPct}%</strong></label>
                                <input 
                                    type="range" min="1" max="50" step="1" 
                                    value={config.densityThresholdPct} onChange={e => setConfig({...config, densityThresholdPct: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Density change percentage threshold"
                                />
                            </div>
                            <div className="setting-item">
                                <label>Block Threshold: <strong>{config.blockThreshold}</strong></label>
                                <input 
                                    type="range" min="1" max="64" step="1" 
                                    value={config.blockThreshold} onChange={e => setConfig({...config, blockThreshold: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Number of changed blocks required"
                                />
                            </div>
                            <div className="setting-item">
                                <label>DHash Limit: <strong>{config.dhashDuplicateThreshold}</strong></label>
                                <input 
                                    type="range" min="0" max="20" step="1" 
                                    value={config.dhashDuplicateThreshold} onChange={e => setConfig({...config, dhashDuplicateThreshold: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="DHash duplicate threshold"
                                />
                            </div>
                            <div className="setting-item">
                                <label>Transition Filter: <strong>{config.confirmThreshold}</strong></label>
                                <input 
                                    type="range" min="3" max="20" step="1" 
                                    value={config.confirmThreshold} onChange={e => setConfig({...config, confirmThreshold: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Turbo transition filter strictness"
                                />
                            </div>
                            <div className="setting-item">
                                <label>Image Quality: <strong>{Math.round(config.imageQuality! * 100)}%</strong></label>
                                <input 
                                    type="range" min="0.1" max="1.0" step="0.1" 
                                    value={config.imageQuality} onChange={e => setConfig({...config, imageQuality: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Extracted slide WebP quality"
                                />
                            </div>
                            <div className="setting-item">
                                <label>Format: <strong>{config.imageFormat === 'jpeg' ? 'JPEG' : 'WebP'}</strong></label>
                                <select
                                    value={config.imageFormat}
                                    onChange={e => setConfig({...config, imageFormat: e.target.value as 'webp' | 'jpeg'})}
                                    disabled={isExtracting}
                                    aria-label="Output image format"
                                >
                                    <option value="webp">WebP (smaller)</option>
                                    <option value="jpeg">JPEG (faster)</option>
                                </select>
                            </div>
                            <div className="setting-item">
                                <label>Export Res: <strong>{config.exportResolution === 0 ? 'Original' : config.exportResolution + 'px'}</strong></label>
                                <select 
                                    value={config.exportResolution} 
                                    onChange={e => setConfig({...config, exportResolution: Number(e.target.value)})} 
                                    disabled={isExtracting}
                                    aria-label="Output image max width"
                                >
                                    <option value={424}>Low (424px)</option>
                                    <option value={854}>Medium (854px)</option>
                                    <option value={1280}>HD (1280px)</option>
                                    <option value={1920}>Full HD (1920px)</option>
                                    <option value={0}>Original Size</option>
                                </select>
                            </div>
                        </div>

                        <button 
                            className="btn-advanced-toggle"
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            type="button"
                        >
                            {showAdvanced ? '▲ Hide' : '▼ Show'} Drift Detection Settings
                        </button>

                        {showAdvanced && (
                            <div className="settings-grid advanced-grid">
                                <div className="setting-item">
                                    <label>Blank Brightness: <strong>{config.blankBrightnessThreshold}</strong></label>
                                    <input 
                                        type="range" min="0" max="50" step="1" 
                                        value={config.blankBrightnessThreshold} onChange={e => setConfig({...config, blankBrightnessThreshold: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Blank frame brightness threshold"
                                    />
                                </div>
                                <div className="setting-item">
                                    <label>Drift Multiplier: <strong>{config.cumulativeDriftMultiplier}×</strong></label>
                                    <input 
                                        type="range" min="1" max="5" step="0.5" 
                                        value={config.cumulativeDriftMultiplier} onChange={e => setConfig({...config, cumulativeDriftMultiplier: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Cumulative drift multiplier"
                                    />
                                </div>
                                <div className="setting-item">
                                    <label>Settled Frames: <strong>{config.cumulativeSettledFrames}</strong></label>
                                    <input 
                                        type="range" min="1" max="10" step="1" 
                                        value={config.cumulativeSettledFrames} onChange={e => setConfig({...config, cumulativeSettledFrames: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Frames of stability before drift emit"
                                    />
                                </div>
                                <div className="setting-item">
                                    <label>Partial Ratio: <strong>{config.partialThresholdRatio}</strong></label>
                                    <input 
                                        type="range" min="0.1" max="1" step="0.1" 
                                        value={config.partialThresholdRatio} onChange={e => setConfig({...config, partialThresholdRatio: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Partial threshold ratio"
                                    />
                                </div>
                                <div className="setting-item">
                                    <label>Noise Reset: <strong>{config.noiseResetFrames}</strong></label>
                                    <input 
                                        type="range" min="10" max="100" step="5" 
                                        value={config.noiseResetFrames} onChange={e => setConfig({...config, noiseResetFrames: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Noise reset frame count"
                                    />
                                </div>
                                <div className="setting-item">
                                    <label>Noise Ratio: <strong>{config.noiseMainRatio}</strong></label>
                                    <input 
                                        type="range" min="0.05" max="0.5" step="0.05" 
                                        value={config.noiseMainRatio} onChange={e => setConfig({...config, noiseMainRatio: Number(e.target.value)})} 
                                        disabled={isExtracting}
                                        aria-label="Noise main change ratio"
                                    />
                                </div>
                            </div>
                        )}

                        <button 
                            className="btn-extract" 
                            onClick={startExtraction} 
                            disabled={!file || isExtracting || (capabilities !== null && !capabilities.canExtract)}
                        >
                            {isExtracting ? <span className="spinner"></span> : (capabilities && !capabilities.canExtract ? '⚠ Not Supported' : '🚀 Start Extraction')}
                        </button>
                    </div>

                    <div className="status-box">
                        <div className="status-header">
                            <div className="pulse-dot"></div>
                            <span>{status}</span>
                            {isExtracting && <span className="pct">{progress}%</span>}
                        </div>
                        {isExtracting && (
                            <div className="progress-container">
                                <div 
                                    className="progress-bar-inner" 
                                    style={{ '--width': `${progress}%` } as React.CSSProperties}
                                ></div>
                            </div>
                        )}
                    </div>
                </div>

                {metrics && metrics.startTime && (
                    <div className="metrics-dashboard slide-up">
                        <div className="metric-card">
                            <span className="label">Total Job Time</span>
                            <span className="value">
                                {jobMetrics.end ? ((jobMetrics.end - jobMetrics.start) / 1000).toFixed(1) : ((performance.now() - jobMetrics.start) / 1000).toFixed(1)}s
                            </span>
                        </div>
                        <div className="metric-card">
                            <span className="label">Decode Speed</span>
                            <span className="value">
                                {metrics.totalFrames ? (metrics.totalFrames / (((metrics.endTime || performance.now()) - metrics.startTime) / 1000)).toFixed(1) : '0'} 
                                {extractionMode === 'turbo' ? ' Keyframes/s' : ' FPS'}
                            </span>
                        </div>
                        <div className="metric-card">
                            <span className="label">Peak RAM</span>
                            <span className="value">{metrics.peakRamMb > 0 ? `${Math.round(metrics.peakRamMb)}MB` : 'N/A'}</span>
                        </div>
                        <div className="metric-card">
                            <span className="label">Frame Analysis Time</span>
                            <span className="value">{metrics.avgFrameProcessTimeMs?.toFixed(1) ?? 'N/A'}ms</span>
                        </div>
                        <div className="metric-card">
                            <span className="label">Detection</span>
                            <span className="value">{metrics.totalSlides ?? 0} Slides</span>
                        </div>
                    </div>
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
                     <div className="result-card slide-up" style={{ textAlign: 'right' }}>
                        <button 
                            onClick={downloadAsZip} 
                            disabled={isZipping}
                            className="btn-download" 
                            style={{ backgroundColor: '#2b2b2b', color: '#fff', border: '1px solid #444' }}
                        >
                            {isZipping ? '⌛ Zipping...' : '📦 Download All as ZIP'}
                        </button>
                     </div>
                )}

                {slides.length > 0 && (
                    <section className="gallery-section">
                        <h2>📌 Detected Slides ({slides.length})</h2>
                        <div className="filmstrip">
                            {slides.map((slide, i) => (
                                <div key={i} className="slide-item">
                                    <img 
                                        src={slide.url} 
                                        alt={`Slide ${i}`} 
                                        loading="lazy" 
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => { setLightboxIndex(i); setLightboxZoom(1); }}
                                    />
                                    <span className="timestamp">{formatMs(slide.startMs)} → {formatMs(slide.endMs)}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                )}
                {lightboxIndex !== null && (
                    <div className="lightbox-overlay" onClick={() => setLightboxIndex(null)}>
                        <button className="lightbox-close" onClick={() => setLightboxIndex(null)}>&times;</button>
                        {lightboxIndex > 0 && (
                            <button className="lightbox-nav prev" onClick={(e) => { e.stopPropagation(); setLightboxZoom(1); setLightboxIndex(lightboxIndex - 1); }}>&#10094;</button>
                        )}
                        {lightboxIndex < slides.length - 1 && (
                            <button className="lightbox-nav next" onClick={(e) => { e.stopPropagation(); setLightboxZoom(1); setLightboxIndex(lightboxIndex + 1); }}>&#10095;</button>
                        )}
                        <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
                            <img 
                                src={slides[lightboxIndex].url} 
                                className="lightbox-img" 
                                style={{ transform: `scale(${lightboxZoom})` }}
                                onWheel={(e) => {
                                    e.preventDefault();
                                    const zoomFactor = Math.exp(-e.deltaY * 0.002);
                                    setLightboxZoom(prev => Math.max(1, Math.min(prev * zoomFactor, 5)));
                                }}
                                alt="Slide larger view" 
                            />
                        </div>
                        <div className="lightbox-info">
                            {formatMs(slides[lightboxIndex].startMs)} → {formatMs(slides[lightboxIndex].endMs)}
                        </div>
                        <div className="lightbox-controls" onClick={(e) => e.stopPropagation()}>
                            <button className="lightbox-btn" onClick={() => setLightboxZoom(prev => Math.max(1, prev - 0.5))}>⊖</button>
                            <span style={{ color: 'white', lineHeight: '24px' }}>{Math.round(lightboxZoom * 100)}%</span>
                            <button className="lightbox-btn" onClick={() => setLightboxZoom(prev => Math.min(5, prev + 0.5))}>⊕</button>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};

export default App;
