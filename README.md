# ⚡ FastExtractor

**Browser-native video slide & audio extraction engine.**

Extract presentation slides and audio from video files entirely in the browser — no server, no uploads, no FFmpeg CLI. Powered by WebCodecs, WebAssembly, and OPFS.

> **[Live Demo →](https://fast-extractor.mm541.in)**

---

## ✨ Features

- **🖼️ Slide extraction** — unique slides captured as WebP with millisecond-accurate timestamps
- **🎧 Audio extraction** — raw AAC stream, ready to play or transcribe
- **🚀 Turbo mode** — keyframe-only scanning, processes a 1-hour video in ~20 seconds
- **🎯 Accurate mode** — sequential full-frame decode for pixel-perfect transitions
- **🎭 Region masking** — interactive 8×8 grid to exclude webcam overlays, watermarks, etc.
- **📊 Live metrics** — real-time decode speed, frame count, peak RAM, and analysis time
- **🔒 100% client-side** — your video never leaves the browser
- **📱 Mobile-safe** — adaptive memory management, Android SAF handling, backpressure controls

---

## How It Works

```
Video File
    │
    ▼
┌──────────────────────────────────────────┐
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

// 2. Create extractor (defaults to turbo mode)
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

| Mode | Strategy | Speed | Accuracy | Default |
|------|----------|-------|----------|---------|
| `'turbo'` | Keyframe-only seeking | ~20s / 1hr video | ~95% of transitions | ✅ Yes |
| `'accurate'` | Sequential frame decode | ~2-3min / 1hr video | 100% of transitions | |

```typescript
// Turbo (default) — 10x faster, skips non-keyframes
new FastExtractor({ mode: 'turbo' });

// Accurate — every frame, catches subtle transitions
new FastExtractor({ mode: 'accurate' });
```

---

## Configuration

All options have sensible defaults. Most users won't need to change anything.

```typescript
new FastExtractor({
  mode: 'turbo',
  extractAudio: true,
  extractSlides: true,
  edgeThreshold: 30,
  blockThreshold: 12,
  minSlideDuration: 3,
  densityThresholdPct: 5,
  dhashDuplicateThreshold: 10,
  confirmThreshold: 10,
  imageQuality: 0.8,
  exportResolution: 0,
  ignoreMask: 0n,
  cleanupAfterExtraction: true,
});
```

### Parameter Reference

#### `mode`
**Type:** `'turbo' | 'accurate'` · **Default:** `'turbo'`

Controls which video decoding strategy is used.

- **`'turbo'`** — Decodes only keyframes (IDR frames). The decoder is flushed between each keyframe, resulting in ~10x speed. Catches ~95% of slide transitions. Uses software decoding (`prefer-software`) to avoid GPU pipeline stall issues with isolated keyframes on mobile GPUs.
- **`'accurate'`** — Decodes every frame sequentially in 300-second chunks. Catches 100% of transitions including gradual scrolls and animations. Uses hardware decoding (GPU) since it feeds a continuous frame stream.

| Scenario | Recommended |
|----------|-------------|
| Lecture recordings (1+ hours) | `'turbo'` |
| Short screen recordings (<10 min) | `'accurate'` |
| Mobile devices with ≤4GB RAM | `'turbo'` |
| Animated/scrolling slide transitions | `'accurate'` |

---

#### `edgeThreshold`
**Type:** `number` · **Range:** `10–100` · **Default:** `30`

Controls how aggressive the Sobel edge detector is. The WASM engine computes horizontal + vertical gradients for every pixel. If the gradient magnitude exceeds this threshold, the pixel is flagged as an "edge pixel."

- **Lower values (10–20):** More edges detected. Sensitive to subtle text changes, thin lines, and small UI elements. Can cause false positives from compression artifacts or video noise.
- **Higher values (50–100):** Only bold edges (large text, thick borders, high-contrast shapes) are detected. Useful for noisy webcam recordings where compression introduces phantom edges.

| Scenario | Recommended |
|----------|-------------|
| Clean screen recordings (OBS, Loom) | `25–35` |
| Webcam-heavy recordings with compression | `40–60` |
| Whiteboard / handwriting videos | `15–25` |

---

#### `blockThreshold`
**Type:** `number` · **Range:** `1–64` · **Default:** `12`

The frame is divided into an 8×8 grid (64 blocks). After edge detection, each block's edge density is compared against the baseline slide. This parameter sets how many blocks must change before a new slide is triggered.

- **Lower values (3–8):** Triggers on small regional changes — a single paragraph updating, a chat bubble appearing, a code diff highlighting.
- **Higher values (20–40):** Only triggers when a large portion of the screen changes — full slide transitions, page navigations, app switches.

| Scenario | Recommended |
|----------|-------------|
| PowerPoint / Google Slides | `10–15` |
| IDE / code walkthroughs | `5–10` |
| Full-screen app demos | `15–25` |

---

#### `minSlideDuration`
**Type:** `number` (seconds) · **Range:** `1–30` · **Default:** `3`

Minimum time (in seconds) that must elapse between two slide captures. Prevents rapid-fire captures during animated transitions, loading spinners, or quick page flips.

- **Lower values (1–2):** Captures fast-paced content where slides change every few seconds.
- **Higher values (10–30):** Only captures slides that stay on screen for a long time. Good for hour-long lectures where the speaker lingers on each slide.

| Scenario | Recommended |
|----------|-------------|
| Fast-paced product demos | `1–2` |
| University lectures | `3–5` |
| Conference keynotes (slow transitions) | `5–10` |

---

#### `densityThresholdPct`
**Type:** `number` (percent) · **Range:** `1–50` · **Default:** `5`

Within each 8×8 grid block, this is the minimum percentage of edge pixels that must differ between frames for that block to count as "changed." This prevents noise and compression artifacts from triggering false block changes.

- **Lower values (1–3):** Extremely sensitive. Catches minute text edits but may false-trigger on video compression noise.
- **Higher values (10–30):** Only counts a block as changed if a significant portion of its edge structure shifted. Robust to noise but may miss small edits.

| Scenario | Recommended |
|----------|-------------|
| High-quality screen recordings (1080p+) | `3–5` |
| Heavily compressed videos (low bitrate) | `8–15` |
| 4K recordings | `3–5` |

---

#### `dhashDuplicateThreshold`
**Type:** `number` · **Range:** `0–20` · **Default:** `10`

After a slide is captured, its 64-bit perceptual hash (dHash) is compared against all previously captured slides. If the Hamming distance is below this threshold, the slide is considered a duplicate and discarded.

- **`0`:** Disable deduplication entirely (every triggered slide is kept).
- **Lower values (3–6):** Only exact or near-exact duplicates are suppressed. Different slides with similar layouts will both be kept.
- **Higher values (12–18):** Aggressively merges slides that look structurally similar, even if text content differs. Useful when the video revisits the same slide multiple times.

| Scenario | Recommended |
|----------|-------------|
| Lectures that revisit previous slides | `10–15` |
| Each slide has unique dense content | `5–8` |
| Disable dedup (keep everything) | `0` |

---

#### `confirmThreshold`
**Type:** `number` · **Range:** `3–20` · **Default:** `10`

**Turbo mode only.** After a keyframe triggers a potential slide change, the engine requires this many subsequent keyframes to remain "stable" (i.e., not trigger another change) before the slide is confirmed and emitted. This filters out brief flickers, transitions, and loading screens.

- **Lower values (3–5):** Faster confirmation. Slides are emitted almost immediately after detection. May capture mid-transition frames.
- **Higher values (12–20):** Requires the slide to persist across many keyframes. Very conservative — only emits slides that the speaker stayed on for a while.

| Scenario | Recommended |
|----------|-------------|
| Videos with frequent transitions | `8–12` |
| Stable lecture recordings | `5–8` |
| Extremely noisy/flickery videos | `15–20` |

---

#### `imageQuality`
**Type:** `number` · **Range:** `0.01–1.0` · **Default:** `0.8`

WebP compression quality for exported slide images. Higher values produce larger, sharper images.

- **`0.5–0.7`:** Good for thumbnails or when storage is limited. Visible compression artifacts on text.
- **`0.8–0.9`:** Balanced — sharp text, reasonable file sizes (~50-150KB per slide at 1080p).
- **`0.95–1.0`:** Near-lossless. Large files but pixel-perfect text reproduction.

---

#### `exportResolution`
**Type:** `number` · **Default:** `0`

Maximum width (in pixels) for exported slide images. The aspect ratio is preserved. Set to `0` to export at the video's native resolution.

- **`0`:** Native resolution (e.g., 1920px for a 1080p video).
- **`1280`:** Cap at 720p-equivalent width. Good for mobile-optimized output.
- **`3840`:** Allow full 4K export.

---

#### `ignoreMask`
**Type:** `bigint` · **Default:** `0n`

A 64-bit bitmask controlling which of the 8×8 grid blocks are excluded from slide detection. Bit `(row * 8 + col)` = `1` means that block is ignored. Use the built-in `GridMaskPicker` UI component to visually generate this value.

Common use cases: masking a webcam overlay in the corner, ignoring a persistent chat sidebar, excluding a video player's control bar.

---

#### `extractAudio` / `extractSlides`
**Type:** `boolean` · **Default:** `true` / `true`

Toggle audio or slide extraction independently. Set `extractAudio: false` if you only need slides (saves processing time). Set `extractSlides: false` if you only need the audio track.

---

#### `cleanupAfterExtraction`
**Type:** `boolean` · **Default:** `true`

Whether to delete OPFS temporary files after extraction completes. Set to `false` if you plan to re-process the same video multiple times (avoids re-ingestion). Call `FastExtractor.cleanupStorage()` manually when done.

---

#### Advanced: `wasmUrl`, `demuxerWasmUrl`, `worker`

For non-Vite bundlers (Webpack, Rollup, etc.) that don't support `?url` and `?worker` imports, you can manually provide:

- **`wasmUrl`** — Absolute URL to the `wasm_extractor_bg.wasm` binary.
- **`demuxerWasmUrl`** — Absolute URL to the `web-demuxer` WASM binary.
- **`worker`** — A pre-instantiated `Worker` pointing to your bundled worker script.

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

## Browser Compatibility

| Browser | Platform | Status | Notes |
|---------|----------|--------|-------|
| Chrome 102+ | Desktop | ✅ Full support | Recommended |
| Chrome 102+ | Android | ✅ Full support | Auto turbo on ≤4GB RAM devices |
| Edge 102+ | Desktop | ✅ Full support | Chromium-based |
| Brave / Vivaldi | Desktop, Android | ✅ Full support | Chromium-based |
| Firefox 130+ | Desktop | ✅ Full support | WebCodecs enabled by default |
| Safari | macOS | ❌ Unsupported | No OPFS `SyncAccessHandle` |
| Safari / WebKit | iOS, iPadOS | ❌ Unsupported | No WebCodecs or OPFS sync access |

**Required APIs:**
- Secure Context (HTTPS or localhost)
- WebCodecs (`VideoDecoder`)
- Origin Private File System (OPFS with `FileSystemSyncAccessHandle`)

**Supported formats:**
- **Video:** `.mp4`, `.mov`, `.webm`, `.mkv` — H.264, H.265*, VP8, VP9, AV1
- **Audio:** AAC only (raw ADTS passthrough, no re-encoding)

> For the full compatibility matrix including mobile limitations, storage quotas, and format edge cases, see **[COMPATIBILITY.md](./COMPATIBILITY.md)**.

---

## Architecture

```
fast-extractor/
├── src/
│   ├── fast-extractor.ts    # Public API — ReadableStream wrapper
│   ├── extractor.ts         # Detection engine (three-pointer drift)
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
            • Edge detection (branchless Sobel)
            • dHash perceptual hashing
            • 8×8 grid density comparison
            • Audio extraction (Symphonia AAC)
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
