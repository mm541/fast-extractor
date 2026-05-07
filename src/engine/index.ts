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
export { FastExtractor, default } from './api/FastExtractor';

// ─── Error System ───
export { ExtractorError } from './types/errors';
export type { ExtractorErrorCode } from './types/errors';

// ─── Event Types ───
export type {
  ExtractorEvent,
  AudioChunkEvent,
  AudioDoneEvent,
  AudioManifest,
  SlideEvent,
  ProgressEvent,
} from './types/types';

// ─── Configuration & Browser Support ───
export type {
  FastExtractorOptions,
  BrowserSupport,
} from './types/types';

// ─── Callback API Types ───
export type { ExtractorCallbacks } from './types/types';
