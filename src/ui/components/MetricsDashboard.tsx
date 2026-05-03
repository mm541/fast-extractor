import React from 'react';

interface MetricsDashboardProps {
    metrics: any;
    jobMetrics: { start: number; end: number | null };
    extractionMode: 'turbo' | 'sequential';
}

const MetricsDashboard: React.FC<MetricsDashboardProps> = ({ metrics, jobMetrics, extractionMode }) => {
    return (
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
    );
};

export default MetricsDashboard;
