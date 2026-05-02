import React from 'react';
import type { DeviceCapabilities } from '../types';

interface CapabilityBannerProps {
    capabilities: DeviceCapabilities;
}

const CapabilityBanner: React.FC<CapabilityBannerProps> = ({ capabilities }) => {
    return (
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
    );
};

export default CapabilityBanner;
