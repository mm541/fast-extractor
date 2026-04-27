/**
 * ============================================================================
 * errors.ts — FastExtractor Error System
 * ============================================================================
 *
 * All error codes and the custom ExtractorError class.
 * Consumers catch these in their try/catch blocks to handle
 * specific failure modes (e.g. ERR_FILE_INGEST for Android SAF expiry).
 */

// ─── Error Codes ───

export type ExtractorErrorCode =
  | 'ERR_OPFS_NOT_SUPPORTED'
  | 'ERR_OPFS_PERMISSION'
  | 'ERR_OPFS_STALE_LOCK'
  | 'ERR_WASM_INIT'
  | 'ERR_FILE_INGEST'
  | 'ERR_AUDIO_EXTRACTION'
  | 'ERR_VIDEO_DECODE'
  | 'ERR_WORKER_GENERIC';

// ─── Error Class ───

export class ExtractorError extends Error {
  constructor(public code: ExtractorErrorCode, message: string) {
    super(message);
    this.name = 'ExtractorError';
  }
}
