/**
 * core/index.ts — Barrel re-export for the core engine modules.
 */
export { WasmBridge, CMP_W, CMP_H } from './WasmBridge';
export { ImageRenderer } from './ImageRenderer';
export { SlideDetector } from './SlideDetector';
export type { SlideExtractorOptions, ExtractionMetrics, WasmModule } from './types';
export { DEFAULT_OPTIONS } from './types';
