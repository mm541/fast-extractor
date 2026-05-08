/**
 * GridMaskPicker — Interactive 8×8 grid overlay on a video preview.
 *
 * Lets the user visually select grid blocks to exclude from slide detection.
 * Useful for masking webcam overlays, chat widgets, timers, watermarks, etc.
 *
 * ARCHITECTURE:
 *   - Creates a <video> element from the File (blob URL, ~2-5MB buffer, NOT full file in RAM)
 *   - Draws current frame to a <canvas> on seek/load
 *   - Overlays an 8×8 CSS grid of clickable cells
 *   - Click toggles mask bit; drag-select supported
 *   - Time scrubber lets user seek to any point in the video
 *   - Exposes bitmask via onMaskChange callback
 *
 * MOBILE:
 *   - Uses touch-action: none on grid to prevent scroll/zoom hijacking
 *   - Uses pointerdown/pointermove (NOT pointerenter) for drag painting on touch
 *   - Manually resolves grid cell from clientX/clientY via getBoundingClientRect
 *   - All inline styles moved to index.css for proper cascade and maintainability
 *
 * MEMORY:
 *   - <video> element buffers ~2-5MB regardless of file size (browser streams from disk)
 *   - Blob URL is revoked on unmount
 *   - Canvas is small (424×240) — same as comparison resolution
 *
 * ⚠️ This component has ZERO dependency on the extraction engine.
 *    It only produces a bigint mask. The consumer passes it to FastExtractor.
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';

interface GridMaskPickerProps {
  /** The video file to preview */
  file: File;
  /** Called whenever the mask changes. Bit (row*8+col) = 1 means "skip this block". */
  onMaskChange: (mask: bigint) => void;
  /** Current mask value (controlled component) */
  mask: bigint;
  /** Disable interaction during extraction */
  disabled?: boolean;
}

const GRID_ROWS = 8;
const GRID_COLS = 8;
const PREVIEW_WIDTH = 424;
const PREVIEW_HEIGHT = 240;

const GridMaskPicker: React.FC<GridMaskPickerProps> = ({ file, onMaskChange, mask, disabled = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const isDraggingRef = useRef(false);
  const dragValueRef = useRef(true);

  // Create blob URL on mount, revoke on unmount
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setBlobUrl(url);
    if (videoRef.current) {
      videoRef.current.load();
    }
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Draw current video frame to canvas
  const drawFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    video.currentTime = Math.min(1, video.duration);
  }, []);

  const onSeeked = useCallback(() => { drawFrame(); }, [drawFrame]);
  const onLoadedData = useCallback(() => { drawFrame(); }, [drawFrame]);

  const onTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentTime(parseFloat(e.target.value));
  }, []);

  const onSeekCommit = useCallback((e: React.SyntheticEvent<HTMLInputElement>) => {
    if (videoRef.current) {
      videoRef.current.currentTime = parseFloat(e.currentTarget.value);
    }
  }, []);

  // Resolve a pointer's clientX/clientY to a grid (row, col) — works on both mouse and touch
  const resolveCell = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    const col = Math.floor((x / rect.width) * GRID_COLS);
    const row = Math.floor((y / rect.height) * GRID_ROWS);
    return { row: Math.min(row, GRID_ROWS - 1), col: Math.min(col, GRID_COLS - 1) };
  }, []);

  // Apply mask toggle for a given cell
  const applyCell = useCallback((row: number, col: number, value: boolean, currentMask: bigint) => {
    const bit = BigInt(row * 8 + col);
    const newMask = value
      ? currentMask | (1n << bit)
      : currentMask & ~(1n << bit);
    onMaskChange(newMask);
  }, [onMaskChange]);

  // Pointer down — start drag, toggle first cell
  const onGridPointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    const cell = resolveCell(e.clientX, e.clientY);
    if (!cell) return;

    const bit = BigInt(cell.row * 8 + cell.col);
    const isSet = (mask >> bit & 1n) === 1n;
    dragValueRef.current = !isSet;
    isDraggingRef.current = true;
    applyCell(cell.row, cell.col, !isSet, mask);

    // Capture pointer so pointermove fires even outside the grid
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [mask, resolveCell, applyCell, disabled]);

  // Pointer move — paint cells while dragging (works on touch via capture)
  const onGridPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current || disabled) return;
    e.preventDefault();
    const cell = resolveCell(e.clientX, e.clientY);
    if (!cell) return;
    applyCell(cell.row, cell.col, dragValueRef.current, mask);
  }, [mask, resolveCell, applyCell, disabled]);

  // Pointer up — stop drag
  const onGridPointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  // Global pointerup fallback
  useEffect(() => {
    const handler = () => { isDraggingRef.current = false; };
    window.addEventListener('pointerup', handler);
    return () => window.removeEventListener('pointerup', handler);
  }, []);

  // Count masked cells
  const maskedCount = (() => {
    let count = 0;
    let m = mask;
    while (m > 0n) {
      count += Number(m & 1n);
      m >>= 1n;
    }
    return count;
  })();

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className={`grid-mask-picker ${disabled ? 'grid-mask-disabled' : ''}`}>
      <div className="grid-mask-preview">
        {/* Hidden video element for frame extraction */}
        <video
          ref={videoRef}
          src={blobUrl || undefined}
          onLoadedMetadata={onLoadedMetadata}
          onSeeked={onSeeked}
          onLoadedData={onLoadedData}
          className="grid-mask-video"
          muted
          playsInline
          preload="auto"
        />

        <canvas
          ref={canvasRef}
          width={PREVIEW_WIDTH}
          height={PREVIEW_HEIGHT}
          className="grid-mask-canvas"
        />

        {/* 8×8 grid overlay — pointer events resolved via coordinates, not per-cell handlers */}
        <div
          ref={gridRef}
          className="grid-overlay"
          onPointerDown={onGridPointerDown}
          onPointerMove={onGridPointerMove}
          onPointerUp={onGridPointerUp}
        >
          {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
            const row = Math.floor(i / GRID_COLS);
            const col = i % GRID_COLS;
            const bit = BigInt(row * 8 + col);
            const isMasked = (mask >> bit & 1n) === 1n;

            return (
              <div
                key={i}
                className={`grid-cell ${isMasked ? 'grid-cell-masked' : ''}`}
              />
            );
          })}
        </div>
      </div>

      {/* Time scrubber */}
      <div className="grid-mask-controls">
        <div className="grid-mask-scrubber">
          <span className="grid-mask-time">{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={onTimeChange}
            onPointerUp={onSeekCommit}
            onTouchEnd={onSeekCommit}
            onKeyUp={onSeekCommit}
            className="grid-mask-slider"
            disabled={disabled || duration === 0}
            aria-label="Seek to timestamp for mask preview"
          />
          <span className="grid-mask-time">{formatTime(duration)}</span>
        </div>
        <div className="grid-mask-status">
          <span className="grid-mask-count">
            {maskedCount > 0 ? `🎭 ${maskedCount}/64 blocks masked` : 'Click cells to mask regions'}
          </span>
          {maskedCount > 0 && (
            <button
              className="grid-mask-clear"
              onClick={() => onMaskChange(0n)}
            >
              Clear All
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default GridMaskPicker;
