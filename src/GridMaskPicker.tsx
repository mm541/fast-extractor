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
 * MEMORY:
 *   - <video> element buffers ~2-5MB regardless of file size (browser streams from disk)
 *   - Blob URL is revoked on unmount
 *   - Canvas is small (427×240) — same as comparison resolution
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
const PREVIEW_WIDTH = 427;
const PREVIEW_HEIGHT = 240;

const GridMaskPicker: React.FC<GridMaskPickerProps> = ({ file, onMaskChange, mask, disabled = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState<boolean>(true); // true = mask, false = unmask

  // Create blob URL on mount, revoke on unmount
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setBlobUrl(url);
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

  // Handle video metadata loaded
  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    // Seek to 1 second to skip potential black intro frames
    video.currentTime = Math.min(1, video.duration);
  }, []);

  // Handle seek complete
  const onSeeked = useCallback(() => {
    drawFrame();
  }, [drawFrame]);

  // Time scrubber change
  const onTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }, []);

  // Toggle a grid cell
  const toggleCell = useCallback((row: number, col: number, forceValue?: boolean) => {
    if (disabled) return;
    const bit = BigInt(row * 8 + col);
    const isSet = (mask >> bit & 1n) === 1n;
    const shouldSet = forceValue !== undefined ? forceValue : !isSet;

    let newMask: bigint;
    if (shouldSet) {
      newMask = mask | (1n << bit);
    } else {
      newMask = mask & ~(1n << bit);
    }
    onMaskChange(newMask);
  }, [mask, onMaskChange, disabled]);

  // Pointer handlers (work for both mouse AND touch natively)
  const onCellPointerDown = useCallback((row: number, col: number) => {
    if (disabled) return;
    const bit = BigInt(row * 8 + col);
    const isCurrentlySet = (mask >> bit & 1n) === 1n;
    setDragValue(!isCurrentlySet);
    setIsDragging(true);
    toggleCell(row, col, !isCurrentlySet);
  }, [mask, toggleCell, disabled]);

  const onCellPointerEnter = useCallback((row: number, col: number) => {
    if (!isDragging || disabled) return;
    toggleCell(row, col, dragValue);
  }, [isDragging, dragValue, toggleCell, disabled]);

  const onPointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Global pointerup listener (catches release outside the grid)
  useEffect(() => {
    window.addEventListener('pointerup', onPointerUp);
    return () => window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerUp]);

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

  // Format time as MM:SS
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="grid-mask-picker" style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div className="grid-mask-preview" style={{ position: 'relative', width: '100%', maxWidth: PREVIEW_WIDTH, aspectRatio: `${PREVIEW_WIDTH}/${PREVIEW_HEIGHT}` }}>
        {/* Hidden video element for frame extraction */}
        <video
          ref={videoRef}
          src={blobUrl || undefined}
          onLoadedMetadata={onLoadedMetadata}
          onSeeked={onSeeked}
          style={{ display: 'none' }}
          muted
          playsInline
          preload="metadata"
        />

        {/* Canvas showing the current video frame */}
        <canvas
          ref={canvasRef}
          width={PREVIEW_WIDTH}
          height={PREVIEW_HEIGHT}
          style={{ width: '100%', height: '100%', borderRadius: '8px', display: 'block' }}
        />

        {/* 8×8 grid overlay */}
        <div
          className="grid-overlay"
          style={{
            position: 'absolute', top: 0, left: 0,
            width: '100%', height: '100%',
            display: 'grid',
            gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
            gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
            userSelect: 'none',
            touchAction: 'none', // Prevent mobile browser scroll/zoom hijacking
          }}
        >
          {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
            const row = Math.floor(i / GRID_COLS);
            const col = i % GRID_COLS;
            const bit = BigInt(row * 8 + col);
            const isMasked = (mask >> bit & 1n) === 1n;

            return (
              <div
                key={i}
                className={`grid-cell ${isMasked ? 'masked' : ''}`}
                onPointerDown={(e) => { e.preventDefault(); onCellPointerDown(row, col); }}
                onPointerEnter={() => onCellPointerEnter(row, col)}
                style={{
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: isMasked ? 'rgba(255, 60, 60, 0.45)' : 'transparent',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s ease',
                  touchAction: 'none',
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Time scrubber */}
      <div className="grid-mask-controls" style={{ marginTop: '8px', width: '100%', maxWidth: PREVIEW_WIDTH }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', opacity: 0.7, minWidth: '40px' }}>{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={onTimeChange}
            style={{ flex: 1 }}
            disabled={disabled || duration === 0}
            aria-label="Seek to timestamp for mask preview"
          />
          <span style={{ fontSize: '12px', opacity: 0.7, minWidth: '40px' }}>{formatTime(duration)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
          <span style={{ fontSize: '12px', opacity: 0.6 }}>
            {maskedCount > 0 ? `🎭 ${maskedCount}/64 blocks masked` : 'Click cells to mask regions'}
          </span>
          {maskedCount > 0 && (
            <button
              onClick={() => onMaskChange(0n)}
              style={{
                background: 'none', border: 'none', color: '#ff6b6b',
                cursor: 'pointer', fontSize: '12px', padding: 0,
              }}
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
