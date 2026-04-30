/**
 * ============================================================================
 * useFastExtractor — React Hook for FastExtractor
 * ============================================================================
 *
 * Wraps the FastExtractor ReadableStream API into idiomatic React state.
 * Manages progress, slides, audio, errors, and cancellation automatically.
 *
 * Usage:
 *   const {
 *     extract, cancel,
 *     isExtracting, progress, slides, audioBlob, error, metrics
 *   } = useFastExtractor({ mode: 'turbo' });
 *
 *   <button onClick={() => extract(file)}>Extract</button>
 *   <p>{progress.message} — {progress.percent}%</p>
 *   {slides.map(s => <img src={s.url} alt={s.timestamp} />)}
 */

import { useState, useCallback, useRef } from 'react';
import { FastExtractor } from '../engine/FastExtractor';
import type {
  FastExtractorOptions,
  ProgressEvent,
} from '../engine/types';

// ─── Hook State Types ───

export interface SlideResult {
  /** Object URL for the slide image — use directly in <img src> */
  url: string;
  /** Human-readable timestamp (e.g. "01:23:45") */
  timestamp: string;
  /** Start time in milliseconds */
  startMs: number;
  /** End time in milliseconds */
  endMs: number;
  /** Raw image ArrayBuffer (WebP) — for programmatic use */
  buffer: ArrayBuffer;
}

export interface ExtractorProgress {
  /** 0-100 */
  percent: number;
  /** Human-readable status message */
  message: string;
}

export interface UseFastExtractorReturn {
  /** Start extraction from a File. Cancels any in-progress extraction first. */
  extract: (file: File) => void;
  /** Cancel the current extraction. Safe to call even if not extracting. */
  cancel: () => void;
  /** Whether extraction is currently in progress */
  isExtracting: boolean;
  /** Current progress (percent + message) */
  progress: ExtractorProgress;
  /** All slides captured so far (accumulates during extraction) */
  slides: SlideResult[];
  /** Finalized audio Blob, or null if audio hasn't completed yet */
  audioBlob: Blob | null;
  /** The last error that occurred, or null */
  error: Error | null;
  /** Final performance metrics (available after extraction completes) */
  metrics: ProgressEvent['metrics'] | null;
}

/**
 * React hook that wraps FastExtractor into managed state.
 *
 * @param options - Same options as `new FastExtractor(options)`
 * @returns State and control functions for the extraction lifecycle
 *
 * @example
 * function App() {
 *   const { extract, isExtracting, progress, slides, error } = useFastExtractor({ mode: 'turbo' });
 *   const onFileChange = (e) => extract(e.target.files[0]);
 *
 *   return (
 *     <div>
 *       <input type="file" accept="video/*" onChange={onFileChange} disabled={isExtracting} />
 *       {isExtracting && <p>{progress.message} — {progress.percent}%</p>}
 *       {error && <p style={{ color: 'red' }}>{error.message}</p>}
 *       {slides.map((s, i) => (
 *         <div key={i}>
 *           <img src={s.url} alt={`Slide at ${s.timestamp}`} />
 *           <span>{s.timestamp}</span>
 *         </div>
 *       ))}
 *     </div>
 *   );
 * }
 */
export function useFastExtractor(options?: FastExtractorOptions): UseFastExtractorReturn {
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState<ExtractorProgress>({ percent: 0, message: '' });
  const [slides, setSlides] = useState<SlideResult[]>([]);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [metrics, setMetrics] = useState<ProgressEvent['metrics'] | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const audioChunksRef = useRef<ArrayBuffer[]>([]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsExtracting(false);
  }, []);

  const extract = useCallback((file: File) => {
    // Cancel any in-progress extraction
    abortRef.current?.abort();

    // Reset state
    setIsExtracting(true);
    setProgress({ percent: 0, message: 'Starting...' });
    setSlides([]);
    setAudioBlob(null);
    setError(null);
    setMetrics(null);
    audioChunksRef.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    const extractor = new FastExtractor(options);
    const stream = extractor.extract(file, controller.signal);
    const reader = stream.getReader();

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          switch (value.type) {
            case 'audio':
              audioChunksRef.current.push(value.chunk);
              break;

            case 'audio_done': {
              if (audioChunksRef.current.length > 0) {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/aac' });
                setAudioBlob(blob);
              }
              audioChunksRef.current = []; // free memory
              break;
            }

            case 'slide': {
              const slideBlob = new Blob([value.imageBuffer], { type: 'image/webp' });
              const url = URL.createObjectURL(slideBlob);
              setSlides(prev => [...prev, {
                url,
                timestamp: value.timestamp,
                startMs: value.startMs,
                endMs: value.endMs,
                buffer: value.imageBuffer,
              }]);
              break;
            }

            case 'progress':
              setProgress({ percent: value.percent, message: value.message });
              if (value.metrics) {
                setMetrics(value.metrics);
              }
          }
        }

        // Stream completed normally
        setIsExtracting(false);
      } catch (err) {
        if (controller.signal.aborted) {
          // User cancelled — not an error
          setIsExtracting(false);
          return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsExtracting(false);
      }
    })();
  }, [options]);

  return { extract, cancel, isExtracting, progress, slides, audioBlob, error, metrics };
}

export default useFastExtractor;
