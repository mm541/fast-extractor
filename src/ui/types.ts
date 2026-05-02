/**
 * Shared UI types used across App components.
 */

export interface DeviceCapabilities {
    webCodecs: boolean;
    opfs: boolean;
    offscreenCanvas: boolean;
    deviceMemoryGb: number | null;
    hardwareConcurrency: number;
    webGpu: boolean;
    isMobile: boolean;
    canExtract: boolean;
}

export type SlideIndexEntry = {
    offset: number;
    length: number;
    time: string;
    startMs: number;
    url: string;
};
