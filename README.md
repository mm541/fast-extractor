# ⚡ FastExtractor

**Browser-native video slide & audio extraction engine.**

Extract presentation slides and audio from video files entirely in the browser — no server, no uploads, no FFmpeg CLI. Powered by WebCodecs, WASM, and OPFS.

---

## What It Does

Drop in a lecture recording or screen capture and get back:

- **🖼️ Slide images** — every unique slide, deduplicated, as WebP
- **🎧 Audio track** — raw AAC stream, ready to play or transcribe
- **📊 Timestamps** — when each slide appeared and for how long
- **📈 Metrics** — frame count, extraction time, peak RAM

All processing happens client-side. Your video never leaves the browser.

---

## How It Works

```
Video File
    │
    ▼
┌─────────────────────────────────────────┐
│  Web Worker                              │
│                                          │
│  ┌──────────┐   ┌──────────────────────┐ │
│  │   OPFS   │──▶│  Rust/WASM Engine    │ │
│  │ (temp    │   │  • Grayscale (SIMD)  │ │
│  │  storage)│   │  • Edge detection    │ │
│  └──────────┘   │  • Grid comparison   │ │
│       │         │  • dHash dedup       │ │
│       ▼         │  • Audio extraction  │ │
│  ┌──────────┐   └──────────────────────┘ │
│  │WebCodecs │                            │
│  │(HW       │──▶ Slides + Audio chunks   │
│  │ decode)  │                            │
│  └──────────┘                            │
└──────────────────┬───────────────────────┘
                   │
                   ▼
          ReadableStream<ExtractorEvent>
```

**Key architecture decisions:**
- **Zero GC pressure** — static WASM memory arena, no per-frame allocations
- **Hardware decode** — WebCodecs uses the GPU, not software decoders
- **Zero-copy transfers** — `ArrayBuffer` transferred (not cloned) from Worker to main thread
- **LLVM-optimized** — bounds-check-free loops, branchless edge detection, SIMD auto-vectorization

---

## Quick Start

```typescript
import { FastExtractor } from './fast-extractor';

// 1. Check browser support
const support = await FastExtractor.checkBrowserSupport();
if (!support.supported) {
  console.error(support.reason);
}

// 2. Create extractor
const extractor = new FastExtractor({ mode: 'turbo' });

// 3. Extract from a File object (e.g. from <input type="file">)
const stream = extractor.extract(file);
const reader = stream.getReader();

while (true) {
  const { done, value: event } = await reader.read();
  if (done) break;

  switch (event.type) {
    case 'audio':
      // Raw AAC chunk (ArrayBuffer). Accumulate for playback.
      audioChunks.push(event.chunk);
      break;

    case 'audio_done':
      // All audio extracted. event.fileName = suggested filename.
      const blob = new Blob(audioChunks, { type: 'audio/aac' });
      break;

    case 'slide':
      // New slide detected.
      // event.imageBuffer = WebP ArrayBuffer
      // event.timestamp   = "01:23:45"
      // event.startMs     = 83000
      // event.endMs       = 128000
      break;

    case 'progress':
      // event.percent = 0-100, event.message = status text
      // event.metrics = { totalFrames, totalSlides, peakRamMb, ... }
      break;

    case 'error':
      // Recoverable error (e.g. Android file permission expired)
      if (event.recoverable) {
        // Re-open file picker and retry
      }
      break;
  }
}
```

### Cancellation

```typescript
const controller = new AbortController();
const stream = extractor.extract(file, controller.signal);

// Cancel anytime:
controller.abort();
```

---

## Extraction Modes

| Mode | Strategy | Speed | Accuracy | Best For |
|------|----------|-------|----------|----------|
| `'turbo'` | Keyframe-only seeking | ~20s / 1hr video | Good | Quick previews, long recordings |
| `'accurate'` | Sequential frame decode | ~2-3min / 1hr video | Best | Short videos, precise transitions |

```typescript
// Turbo — 10x faster, skips non-keyframes
new FastExtractor({ mode: 'turbo' });

// Sequential — every frame, catches subtle transitions
new FastExtractor({ mode: 'accurate' });
```

---

## Configuration

All options have sensible defaults. Only `mode` matters for most users.

```typescript
new FastExtractor({
  // Mode
  mode: 'turbo',                    // 'accurate' | 'turbo'

  // What to extract
  extractAudio: true,               // Extract audio track
  extractSlides: true,              // Extract slide images

  // Detection tuning
  edgeThreshold: 30,                // Edge sensitivity (10-100)
  blockThreshold: 12,               // Min changed blocks for new slide (1-64)
  minSlideDuration: 3,              // Min seconds between slides
  densityThresholdPct: 5,           // Block density threshold (%)
  dhashDuplicateThreshold: 10,      // Perceptual hash distance for dedup
  confirmThreshold: 10,             // Turbo mode confirmation strictness

  // Output
  imageQuality: 0.8,                // WebP quality (0.01-1.0)
  exportResolution: 0,              // Max slide width (0 = original)
  ignoreMask: 0n,                   // 64-bit bitmask to skip grid blocks

  // Storage
  cleanupAfterExtraction: true,     // Delete OPFS temp files when done

  // Advanced (for non-Vite bundlers)
  wasmUrl: '/path/to/wasm.wasm',    // Override WASM binary URL
  demuxerWasmUrl: '/path/to/demuxer.wasm',
  worker: myWorkerInstance,          // Provide your own Worker
});
```

---

## Static Methods

### `FastExtractor.checkBrowserSupport()`

Check if the current browser has the required APIs.

```typescript
const support = await FastExtractor.checkBrowserSupport();
// support.webCodecs       — VideoDecoder available
// support.opfs            — OPFS sync access available
// support.offscreenCanvas — OffscreenCanvas in workers
// support.deviceMemoryGb  — RAM (if exposed)
// support.isMobile        — Mobile browser detected
// support.supported       — Can run extraction?
// support.reason          — Why not (if unsupported)
```

### `FastExtractor.cleanupStorage()`

Manually delete OPFS temp files. Only needed when `cleanupAfterExtraction: false`.

```typescript
await FastExtractor.cleanupStorage();
```

---

## Stream Events

| Event | Fields | When |
|-------|--------|------|
| `audio` | `chunk: ArrayBuffer` | Each audio chunk (streamed) |
| `audio_done` | `fileName: string` | Audio extraction complete |
| `slide` | `imageBuffer`, `timestamp`, `startMs`, `endMs` | New slide detected |
| `progress` | `percent`, `message`, `metrics?` | Status updates |
| `error` | `message`, `recoverable` | Non-fatal error |

---

## Browser Support

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome 102+ (Desktop) | ✅ Full support | Recommended |
| Chrome 102+ (Android) | ✅ Works | Auto Turbo mode on ≤4GB RAM |
| Edge 102+ | ✅ Works | Chromium-based |
| Firefox 130+ | ✅ Works | WebCodecs now enabled by default |
| Safari | ❌ No OPFS sync | |
| iOS Safari | ❌ No WebCodecs | |

**Requirements:**
- Secure Context (HTTPS or localhost)
- WebCodecs (`VideoDecoder`)
- Origin Private File System (OPFS with sync access)

---

## Architecture

```
fast-extractor/
├── src/
│   ├── fast-extractor.ts    # Public API — ReadableStream wrapper
│   ├── worker.ts            # Web Worker — orchestrates the pipeline
│   ├── App.tsx              # Reference implementation (React)
│   ├── GridMaskPicker.tsx   # Region masking UI component
│   ├── index.css            # Styles
│   └── wasm/                # Pre-built WASM binaries
│       ├── wasm_extractor_bg.wasm
│       └── wasm_extractor.js
└── wasm-extractor/
    └── src/
        └── lib.rs           # WASM module (Rust)
            • Static memory arena (zero GC)
            • RGBA→grayscale (SIMD-vectorized)
            • Edge detection (branchless)
            • dHash perceptual hashing
            • 8×8 grid density comparison
            • Audio extraction (Symphonia)
```

### Detection Pipeline (per frame)

1. **Decode** — WebCodecs hardware-decodes the frame
2. **Downscale** — Rendered to 427×240 via OffscreenCanvas
3. **Grayscale** — WASM converts RGBA→luminance (SIMD)
4. **Edge map** — Sobel-like gradient, branchless threshold
5. **Grid compare** — 8×8 block density vs baseline
6. **Stability** — Requires N consecutive stable frames
7. **dHash dedup** — Perceptual hash rejects duplicate slides
8. **Emit** — Slide captured and streamed to consumer

---

## Development

```bash
# Install dependencies
npm install

# Dev server (with HMR)
npm run dev

# Production build
npm run build

# Preview production build
npx vite preview --port 4173
```

### Rebuilding WASM (requires Rust + wasm-pack)

```bash
cd wasm-extractor
wasm-pack build --target web --release
cp pkg/wasm_extractor_bg.wasm ../src/wasm/
cp pkg/wasm_extractor.js ../src/wasm/
cp pkg/wasm_extractor.d.ts ../src/wasm/
cp pkg/wasm_extractor_bg.wasm.d.ts ../src/wasm/
```

---

## Use Cases

- **Lecture recording → study notes** — Extract slides + audio, feed to Whisper for transcription
- **RAG pipelines** — Slide images + timestamps + transcript → multi-modal vector embeddings
- **Accessibility** — Generate slide descriptions from video content
- **Archival** — Pull presentation assets from screen recordings

---

## License

MIT

---

Built by [Mohd Moazzam](https://github.com/mm541)
