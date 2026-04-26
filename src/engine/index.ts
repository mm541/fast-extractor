/**
 * ============================================================================
 * fast-extractor — Barrel Export
 * ============================================================================
 *
 * Single entry point for all public API surfaces.
 *
 * Usage:
 *   import { FastExtractor, ExtractorError } from 'fast-extractor';
 *   import type { ExtractorEvent, SlideEvent } from 'fast-extractor';
 */

// ─── Core Class ───
export { FastExtractor, default } from './fast-extractor';

// ─── Error System ───
export { ExtractorError } from './fast-extractor';
export type { ExtractorErrorCode } from './fast-extractor';

// ─── Event Types ───
export type {
  ExtractorEvent,
  AudioChunkEvent,
  AudioDoneEvent,
  SlideEvent,
  ProgressEvent,
  ExtractorErrorEvent,
} from './fast-extractor';

// ─── Configuration & Browser Support ───
export type {
  FastExtractorOptions,
  BrowserSupport,
} from './fast-extractor';

// ─── Callback API Types ───
export type { ExtractorCallbacks } from './fast-extractor';
