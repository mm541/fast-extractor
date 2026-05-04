import React, { useState } from 'react';
import GridMaskPicker from '../GridMaskPicker';
import type { ExtractionConfig, SlideIndexEntry } from '../types';

interface ConfigPanelProps {
    file: File | null;
    config: ExtractionConfig;
    setConfig: (config: ExtractionConfig) => void;
    extractionMode: 'turbo' | 'sequential';
    setExtractionMode: (mode: 'turbo' | 'sequential') => void;
    extractAudio: boolean;
    setExtractAudio: (v: boolean) => void;
    extractSlides: boolean;
    setExtractSlides: (v: boolean) => void;
    buildManifest: boolean;
    setBuildManifest: (v: boolean) => void;
    ignoreMask: bigint;
    setIgnoreMask: (v: bigint) => void;
    isExtracting: boolean;
    isIngesting: boolean;
    slides: SlideIndexEntry[];
    audioUrl: string | null;
    startExtraction: () => void;
    resetApp: () => void;
}

const ConfigPanel: React.FC<ConfigPanelProps> = ({
    file,
    config,
    setConfig,
    extractionMode,
    setExtractionMode,
    extractAudio,
    setExtractAudio,
    extractSlides,
    setExtractSlides,
    buildManifest,
    setBuildManifest,
    ignoreMask,
    setIgnoreMask,
    isExtracting,
    isIngesting,
    slides,
    audioUrl,
    startExtraction,
    resetApp,
}) => {
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [showMaskEditor, setShowMaskEditor] = useState(false);

    if (!file || isIngesting) {
        if (!file && !isIngesting) {
            return (
                <p style={{ marginTop: '20px', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
                    Settings will appear after you select a file.
                </p>
            );
        }
        return null;
    }

    return (
        <>
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
                <label className={`extract-toggle-btn ${buildManifest ? 'active' : ''}`}>
                    <input
                        type="checkbox"
                        checked={buildManifest}
                        onChange={e => setBuildManifest(e.target.checked)}
                        disabled={isExtracting || !extractAudio}
                    />
                    📄 Build Manifest
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
                <div className="setting-item" style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <input 
                            type="checkbox" 
                            checked={config.useDeferredEmit} 
                            onChange={e => setConfig({...config, useDeferredEmit: e.target.checked})}
                            disabled={isExtracting}
                            style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
                        />
                        <div>
                            <strong style={{ color: 'var(--accent)', display: 'block', fontSize: '1rem', marginBottom: '4px' }}>Transition Filter (Deferred Emit)</strong>
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Waits for slides to stop moving before emitting to prevent blurry mid-transition frames.</span>
                        </div>
                    </label>
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
                        <label>Drift Multiplier: <strong>{config.cumulativeDriftMultiplier}×</strong></label>
                        <input 
                            type="range" min="1" max="5" step="0.5" 
                            value={config.cumulativeDriftMultiplier} onChange={e => setConfig({...config, cumulativeDriftMultiplier: Number(e.target.value)})} 
                            disabled={isExtracting}
                            aria-label="Cumulative drift multiplier"
                        />
                    </div>
                    <div className="setting-item">
                        <label>Settled Time: <strong>{config.cumulativeSettledSeconds}s</strong></label>
                        <input 
                            type="range" min="1" max="10" step="1" 
                            value={config.cumulativeSettledSeconds} onChange={e => setConfig({...config, cumulativeSettledSeconds: Number(e.target.value)})} 
                            disabled={isExtracting}
                            aria-label="Seconds of stability before drift emit"
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
                        <label>Noise Reset: <strong>{config.noiseResetSeconds}s</strong></label>
                        <input 
                            type="range" min="10" max="120" step="5" 
                            value={config.noiseResetSeconds} onChange={e => setConfig({...config, noiseResetSeconds: Number(e.target.value)})} 
                            disabled={isExtracting}
                            aria-label="Noise reset time in seconds"
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
            
            <div className="action-row" style={{ marginTop: '20px' }}>
                {(!isExtracting && (slides.length > 0 || audioUrl)) ? (
                    <button 
                        className="btn-extract"
                        onClick={resetApp}
                        style={{ backgroundColor: '#2b2b2b', color: '#fff', border: '1px solid #444' }}
                    >
                        🔄 Extract Another Video
                    </button>
                ) : (
                    <button 
                        className={`btn-extract ${isExtracting ? 'extracting' : ''}`}
                        onClick={startExtraction}
                        disabled={isExtracting}
                    >
                        {isExtracting ? 'Processing...' : '▶ Start Extraction'}
                    </button>
                )}
            </div>
        </>
    );
};

export default ConfigPanel;
