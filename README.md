# ⚡ FastExtractor

**Browser-native video slide & audio extraction engine.**

Extract presentation slides and audio from video files entirely in the browser — no server, no uploads, no FFmpeg CLI. Powered by WebCodecs, WebAssembly, and OPFS.

> **[Live Demo →](https://fast-extractor.mm541.in)**

---

## Features

- **🖼️ Slide extraction** — unique slides captured as WebP/JPEG using a **3x3 Sobel Operator** (L1-Norm) for massive noise resistance.
- **🎧 Audio extraction** — raw AAC/MP3/Opus stream passthrough, zero re-encoding via our custom C FFmpeg-WASM demuxer.
- **🚀 Turbo mode** — keyframe-only scanning, processes a 1-hour HD video in under 15 seconds.
- **🎯 Sequential mode** — full-frame decode for pixel-perfect transition detection.
- **⚡ SIMD Auto-Vectorization** — hot-loops are compiled with 128-bit WASM SIMD for extreme performance.
- **🪶 Ultra-Lite Payload** — the entire Rust WASM slide detection core is only **~10KB** gzipped.
- **🎭 Region masking** — 64-bit bitmask to exclude webcam overlays, watermarks, etc.
- **🔒 100% client-side** — your video never leaves the browser.
- **📱 Mobile-safe** — zero-race worker initialization, adaptive memory management, Android SAF recovery, strict hardware decoder leak prevention.

---

## Benchmarks

*Full extraction pipeline: concurrent audio demuxing + unique slide detection + WebP/JPEG export.*

| Device | Resolution | Mode | Video Length | Time | Speed |
|--------|-----------|------|-------------|------|-------|
| **i9-12900H / 16GB / RTX 3050 Ti** (Linux Chrome) | 720p | Turbo | 3h 43m | **35s** | **382×** |
| **i9-12900H / 16GB / RTX 3050 Ti** (Linux Chrome) | 1080p | Turbo | 5h 53m | **1m 20s** | **265×** |
| **i9-12900H / 16GB / RTX 3050 Ti** (Linux Chrome) | 1080p | Sequential | 5h 53m | **22m** | **16×** |
| **Redmi Note 9 Pro** (SD 720G, 4GB, Android Chrome) | 1080p | Turbo | 5h 53m | **7m 30s** | **47×** |
| **AMD A6-7310** (2015 APU, 4GB, Linux Firefox) | 1080p | Turbo | 5h 53m | **10m 50s** | **32×** |

---

## Architecture

```mermaid
flowchart TB
    UI[User Interface / Client App] -->|Extract File| API[FastExtractor API]
    API -->|Stream Chunks| OPFS[(OPFS Temporary Storage)]
    
    API -.->|Spawn| Worker[worker.ts]
    
    subgraph Worker Thread [Stateless Worker Thread]
        Demux[FFmpeg C-WASM Demuxer] -.->|Sync Access Read| OPFS
        
        subgraph Audio Extraction
            Demux -->|Raw Audio Packets| Remux[audio-remuxer.ts]
            Remux -->|Stream ArrayBuffer| API
        end
        
        subgraph Video Extraction
            Demux -->|Video Packets| VDec[WebCodecs VideoDecoder]
            VDec -->|VideoFrame GPU Texture| Extractor[extractor.ts Orchestrator]
            Extractor --> SD[SlideDetector.ts]
            Extractor --> IR[ImageRenderer.ts]
            Extractor --> WB[WasmBridge.ts]
            WB <-->|Zero-Copy I/O| Rust[(Rust WASM Engine)]
        end
    end
    
    SD -->|Decision| IR
    IR -->|SlideEvent Blob| API
```

**Key design decisions:**
- **Zero GC pressure** — 3.6MB preallocated static WASM memory arena, no per-frame allocations.
- **Hardware decode** — WebCodecs delegates to the GPU, entirely bypassing software decoding bottlenecks.
- **Zero-copy transfers** — `ArrayBuffer` instances are transferred (not cloned) between the Worker and main thread.
- **Self-Initializing WASM** — Worker handles dynamic fetching of the Vite `?url` WASM binary inline, completely eliminating race conditions.

### Per-Frame Detection Pipeline

```mermaid
flowchart TD
    Frame[VideoFrame] --> Canvas[OffscreenCanvas]
    Canvas -->|getImageData| Bridge[WasmBridge.ts]
    
    Bridge -->|Copy RGBA| Arena[(3.6MB WASM Arena)]
    
    subgraph Rust WASM Core [10KB WebAssembly Core]
        Arena --> Gray[Grayscale Conversion]
        Gray --> Sobel[3x3 Sobel Operator]
        Sobel --> Edge[Edge Frame]
        Edge --> Grid[8x8 Grid Comparison vs Previous]
        Grid --> Metric[Changed Blocks Score]
        Gray --> DHash[64-bit Perceptual Hash]
    end
    
    Metric --> Gate{Stability Gate}
    
    Gate -->|Score < Threshold| Skip[Drop Frame]
    Gate -->|Score ≥ Threshold| Drift[Three-Pointer Drift Engine]
    
    Drift -->|Motion Detected| Buffer[Buffer Candidate Frame]
    Drift -->|Motion Settled| Emit[ImageRenderer.ts]
    
    Emit --> WebP[WebP / JPEG Encoder]
    WebP --> Main[PostMessage to Main Thread]
```

---

## Quick Start

### Stream API

```typescript
import { FastExtractor } from './engine';

// 1. Check browser support
const support = await FastExtractor.checkBrowserSupport();
if (!support.supported) throw new Error(support.reason);

// 2. Create extractor
const extractor = new FastExtractor({ mode: 'turbo' });

// 3. Extract
const stream = extractor.extract(file);
const reader = stream.getReader();

while (true) {
  const { done, value: event } = await reader.read();
  if (done) break;

  switch (event.type) {
    case 'audio':
      // Raw codec chunk (ArrayBuffer) — stream to OPFS or accumulate
      await opfsWriter.write(event.chunk);
      break;

    case 'audio_done':
      // event.fileName = suggested filename
      // event.manifest = per-second byte-offset index (if buildManifest: true)
      break;

    case 'slide':
      // event.imageBuffer = WebP/JPEG ArrayBuffer
      // event.timestamp   = "01:23:45"
      // event.startMs     = 83000
      break;

    case 'progress':
      // event.percent = 0-100
      // event.message = status text
      // event.metrics = { totalFrames, totalSlides, peakRamMb, ... }
      break;
  }
}
```

### Callback API

```typescript
const extractor = new FastExtractor({ mode: 'turbo' });

await extractor.extractWithCallbacks(file, {
  onSlide: (slide) => {
    const blob = new Blob([slide.imageBuffer], { type: 'image/webp' });
    document.body.appendChild(Object.assign(document.createElement('img'), {
      src: URL.createObjectURL(blob)
    }));
  },
  onAudio: (chunk) => audioChunks.push(chunk),
  onProgress: (pct, msg) => console.log(`${pct}%: ${msg}`),
  onDone: () => console.log('Complete'),
});
```

### React Hook

```tsx
import { useFastExtractor } from './ui/useFastExtractor';

function App() {
  const {
    extract, cancel,
    isExtracting, progress, slides, audioBlob, error
  } = useFastExtractor({ mode: 'turbo' });

  return (
    <div>
      <input type="file" accept="video/*"
        onChange={(e) => extract(e.target.files![0])}
        disabled={isExtracting}
      />
      {isExtracting && <p>{progress.message} — {progress.percent}%</p>}
      {slides.map((s, i) => <img key={i} src={s.url} alt={s.timestamp} />)}
      {audioBlob && <audio controls src={URL.createObjectURL(audioBlob)} />}
    </div>
  );
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

## Configuration

All options have sensible defaults. Most users won't need to change anything.

> **Tuning Tip:** Use the **[live demo](https://fast-extractor.mm541.in)** as a calibration workbench — drop in a sample video, adjust sliders, see which slides get captured in real-time, then copy the values into your code.

```typescript
new FastExtractor({
  mode: 'turbo',            // 'turbo' | 'sequential'
  extractAudio: true,
  extractSlides: true,
  buildManifest: false,      // Per-second byte-offset index for S3 range queries

  // Detection tuning
  sampleFps: 1,              // Sequential only: frames per second to analyze
  edgeThreshold: 30,         // Sobel sensitivity (10-100)
  blockThreshold: 12,        // Minimum weighted score of changed blocks to trigger (0.01-64.0)
  minSlideDuration: 3,       // Seconds between captures
  densityThresholdPct: 5,    // Min edge % change per block (1-50)
  dhashDuplicateThreshold: 4, // Perceptual hash hamming distance (0-20)
  useDeferredEmit: true,     // Wait for transitions to settle before emitting

  // Output
  imageQuality: 0.8,         // WebP/JPEG quality (0.01-1.0)
  imageFormat: 'jpeg',       // 'webp' | 'jpeg'
  exportResolution: 0,       // Max width in px (0 = native)
  ignoreMask: 0n,            // 64-bit bitmask for 8×8 grid exclusion

  // Advanced drift detection
  cumulativeDriftMultiplier: 2,
  cumulativeSettledSeconds: 2,
  noiseResetSeconds: 30,
  noiseMainRatio: 0.25,

  // Debugging
  debug: false,              // Log all worker messages to console
});
```

### Extraction Modes

| Mode | Strategy | Speed | Accuracy |
|------|----------|-------|----------|
| `'turbo'` | Keyframe-only seeking | ~20s / 1hr video | ~95% of transitions |
| `'sequential'` | Full frame decode | ~2-3min / 1hr video | 100% of transitions |

---

## Stream Events

| Event | Key Fields | Description |
|-------|-----------|-------------|
| `audio` | `chunk: ArrayBuffer` | Raw audio data (codec-specific framing) |
| `audio_done` | `fileName`, `manifest?` | Audio complete, optional byte-offset manifest |
| `slide` | `imageBuffer`, `timestamp`, `startMs` | New unique slide detected |
| `progress` | `percent`, `message`, `metrics?` | Extraction progress update |

---

## Error Codes

All fatal errors are `ExtractorError` instances with a typed `code`:

| Code | Meaning |
|------|---------|
| `ERR_OPFS_NOT_SUPPORTED` | Browser lacks OPFS |
| `ERR_OPFS_PERMISSION` | Storage permission denied |
| `ERR_OPFS_STALE_LOCK` | Previous crashed tab holds lock |
| `ERR_WASM_INIT` | WASM module failed to load |
| `ERR_FILE_INGEST` | File copy failed (**recoverable** — re-pick file) |
| `ERR_AUDIO_EXTRACTION` | No compatible audio track found |
| `ERR_VIDEO_DECODE` | WebCodecs / demuxer failure |
| `ERR_WORKER_GENERIC` | Unhandled worker exception |

```typescript
import { ExtractorError } from './engine';

try {
  // ... extract
} catch (err) {
  if (err instanceof ExtractorError) {
    console.error(err.code, err.message);
  }
}
```

---

## Static Methods

```typescript
// Check browser compatibility
const support = await FastExtractor.checkBrowserSupport();
// → { webCodecs, opfs, offscreenCanvas, deviceMemoryGb, isMobile, supported, reason? }

// Clean up OPFS temp files
await FastExtractor.cleanupStorage();
```

---

## Browser Compatibility

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome 102+ (Desktop & Android) | ✅ Full support | Recommended |
| Edge 102+ | ✅ Full support | Chromium-based |
| Firefox 130+ | ✅ Full support | WebCodecs enabled by default |
| Brave / Vivaldi | ✅ Full support | Chromium-based |
| Safari 16.4+ (macOS) | ⚠️ Expected to work (untested) | Has WebCodecs, OPFS, SyncAccessHandle |
| Safari 16.4+ (iOS) | ⚠️ Expected to work (untested) | API support present, not field-tested |

**Required:** Secure Context (HTTPS), WebCodecs, OPFS with `SyncAccessHandle`

**Formats:** `.mp4`, `.mov`, `.webm`, `.mkv` — H.264, H.265*, VP8, VP9, AV1

---

## Project Structure

```
fast-extractor/
├── src/
│   ├── engine/                  # Core extraction library (framework-agnostic)
│   │   ├── FastExtractor.ts     #   Public API — Stream + Callback + Error system
│   │   ├── extractor.ts         #   Slide detection (three-pointer drift engine)
│   │   ├── pipeline.ts          #   Decode orchestration + backpressure
│   │   ├── worker.ts            #   Web Worker — OPFS + audio + video pipeline
│   │   ├── audio-remuxer.ts     #   Zero-alloc TS audio chunk framer (AAC/MP3/Opus)
│   │   ├── errors.ts            #   Typed ExtractorError codes
│   │   ├── types.ts             #   All public type definitions
│   │   └── wasm/                #   Pre-built WASM binaries
│   └── ui/                      # Reference demo app (React)
├── ffmpeg-wasm-demuxer/         # Custom C Demuxer
│   ├── src/demuxer.c            #   Lightweight libavformat wrapper
│   └── src/index.ts             #   Zero-copy TS bridging
└── wasm-extractor/              # Slide Detection Arena
    └── src/lib.rs               # Rust/WASM module
        • 3.6MB static memory arena (zero GC)
        • RGBA→grayscale (BT.601, SIMD Auto-Vectorized)
        • Branchless 3x3 Sobel edge detection (L1-Norm)
        • 64-bit dHash perceptual hashing
        • 8×8 grid density comparison
```

---

## Safety Invariants

| Invariant | Enforced By |
|---|---|
| Zero per-frame allocations | `FrameArena` (3.6MB preallocated `UnsafeCell`) |
| No data races | `UnsafeCell` interior mutability (prevents LLVM `noalias` UB) |
| Hardware leak prevention | Explicit `decoder.destroy()` in worker `finally` block |
| OPFS lock timeout | `createSyncAccessHandleWithTimeout(5000ms)` |
| Worker init deadlock prevention | `?url` Vite WASM inlining completely avoids main-thread fetching |
| Zero-copy slide transfer | `ArrayBuffer` transferred via `postMessage` transferList |

---

## Development

```bash
npm install        # Install dependencies
npm run dev        # Dev server with HMR
npm run build      # Production build
```

### Rebuilding WASM

```bash
npm run build:wasm
# Or: cd wasm-extractor && wasm-pack build --target web --out-dir ../src/engine/wasm
```

---

## Use Cases

- **Lecture → study notes** — Extract slides + audio, feed to Whisper for transcription
- **RAG pipelines** — Slide images + timestamps → multi-modal vector embeddings
- **Accessibility** — Generate slide descriptions from video content
- **Archival** — Pull presentation assets from screen recordings

---

## License

Released under the [MIT License](LICENSE).

---

Built by [Mohd Moazzam](https://github.com/mm541)
