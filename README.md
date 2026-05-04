# Fast-Extractor

A lightning-fast, entirely client-side slide extraction engine for video presentations. 

By heavily leveraging hardware-accelerated **WebCodecs** for video decoding and **WebAssembly (Rust)** for pixel-perfect frame analysis, `fast-extractor` processes 4K HDR lecture videos up to 5x faster than real-time directly inside the browser—with zero server costs.

## Features

- ⚡️ **Hardware Accelerated**: Uses the native WebCodecs API to tap directly into the user's GPU hardware video decoder.
- 🦀 **WASM Math Engine**: Computes perceptual hashes (dHash) and detects slide transitions using a highly optimized Rust WebAssembly module.
- 🧠 **Zero-Copy Pipeline**: Implements strict `VideoFrame.clone()` pointers to prevent massive CPU memory bottlenecks when handling uncompressed 4K video frames.
- 🔒 **100% Client-Side**: No video data is ever uploaded. Everything runs locally in the browser, ensuring complete privacy.
- 📊 **Robust Telemetry**: Accurate, deterministic "Accountant Model" memory tracking and frame-analysis telemetry.

## How It Works

The engine operates entirely inside a Web Worker to keep the main UI thread buttery smooth. It runs in two distinct architectural phases:

1. **Decoding**: The `web-demuxer` parses the MP4/WebM container, and feeds encoded chunks to the browser's hardware `VideoDecoder`.
2. **Analysis**: Raw uncompressed frames are passed to the WASM module where they are downscaled, grayscaled, and perceptually hashed.

### Two Extraction Modes

| Mode | Speed | Accuracy | Description |
|---|---|---|---|
| 🚀 **Turbo** | Extremely Fast | Good | Only decodes "Keyframes" (I-frames). Drops all P/B frames. Incredible speed (often 50+ frames/sec), but might miss fast transitions that occur between keyframes. |
| 🔍 **Sequential** | Fast | Perfect | Decodes *every* frame to maintain the reference chain, but safely ignores intermediary frames using a `sampleFps` gate. Runs at ~5x real-time on 4K footage. |

## Usage

```typescript
import FastExtractor from 'fast-extractor';

const extractor = new FastExtractor({
  mode: 'sequential', // 'turbo' or 'sequential'
  sampleFps: 1,       // Process 1 frame per video-second
  
  // Callbacks
  onProgress: (percent, message, metrics) => {
    console.log(`Progress: ${percent}%`, metrics);
  },
  onSlide: (blob, timestamp) => {
    console.log(`New slide extracted at ${timestamp}s!`);
    const imageUrl = URL.createObjectURL(blob);
  }
});

// Start extraction
await extractor.extract(videoFile);
```

### Advanced Configuration Options

You can fine-tune the extraction mathematics to match the noisiness of your video source:

- `blockThreshold`: How many blocks in the perceptual hash must change to trigger a new slide.
- `edgeThreshold`: Prevents UI elements (like a speaker webcam) from triggering false positives.
- `useDeferredEmit`: Wait for a slide to visually "settle" (stop animating) before capturing the final clean frame.
- `noiseResetSeconds`: Automatically resets cumulative drift counters if a slide stays on screen for a long time.

## Development & Building

The repository contains both the core engine and a React-based demo dashboard to test the pipeline visually.

```bash
# Install dependencies
npm install

# Build the Rust WASM module
npm run build:wasm

# Start the Vite development server for the UI Demo
npm run dev
```

## Architecture Notes
- The Web Worker is dynamically instantiated to prevent blocking the Main Thread.
- We utilize `OffscreenCanvas` for safe background rendering.
- Memory is strictly managed via `.close()` on all `VideoFrame` objects to prevent GPU starvation.
