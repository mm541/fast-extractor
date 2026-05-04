import React from 'react';
import type { ProgressEvent } from '../../engine/types';

interface MetricsDashboardProps {
    metrics: NonNullable<ProgressEvent['metrics']>;
    extractionMode: 'turbo' | 'sequential';
}

const MetricsDashboard: React.FC<MetricsDashboardProps> = ({ metrics, extractionMode }) => {
    // metrics.jobElapsedMs is correctly computed inside the Web Worker (avoiding clock desync between threads)
    const elapsed = (metrics.jobElapsedMs ?? 0) / 1000;
    const decodeSpeed = metrics.totalFrames > 0 && elapsed > 0
        ? (metrics.totalFrames / elapsed).toFixed(1)
        : '0';

    return (
        <div className="metrics-dashboard slide-up">
            <div className="metric-card">
                <span className="label">Total Job Time</span>
                <span className="value">{elapsed.toFixed(1)}s</span>
            </div>
            <div className="metric-card">
                <span className="label">Decode Speed</span>
                <span className="value">
                    {decodeSpeed} {extractionMode === 'turbo' ? ' Keyframes/s' : ' FPS'}
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
    );
};

export default MetricsDashboard;
