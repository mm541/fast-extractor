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
export { FastExtractor, default } from './FastExtractor';

// ─── Error System ───
export { ExtractorError } from './errors';
export type { ExtractorErrorCode } from './errors';

// ─── Event Types ───
export type {
  ExtractorEvent,
  AudioChunkEvent,
  AudioDoneEvent,
  SlideEvent,
  ProgressEvent,
} from './types';

// ─── Configuration & Browser Support ───
export type {
  FastExtractorOptions,
  BrowserSupport,
} from './types';

// ─── Callback API Types ───
export type { ExtractorCallbacks } from './types';
