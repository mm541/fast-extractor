# FFmpeg WASM Demuxer

A production-grade, zero-copy, highly optimized FFmpeg 8.1 demuxer built for the browser. Designed specifically to feed raw media packets directly into WebCodecs.

## Build Instructions (The Cheat Sheet)

Because this library is designed as a standalone NPM package, you need to compile the WASM and the TypeScript wrapper before using it.

### 1. Compile the C/Rust WASM
Run the build script. This will compile the C and Rust code, link it against the FFmpeg static libraries, and **Base64-inline** the entire `.wasm` binary directly into `pkg/ffmpeg_demuxer.js`.
```bash
./build_wasm.sh
```

### 2. Compile the TypeScript API
Run the TypeScript compiler. This takes the `src/index.ts` wrapper and outputs the final usable Javascript and type definitions into the `dist/` folder.
```bash
npm run build:ts
```

## How to Install in your Main Project

Do not copy-paste these files into your main project. Install it as a local NPM package so your bundler (Vite/Next/Webpack) resolves it perfectly.

In your main web app's directory (e.g., `fast-extractor`), run:
```bash
npm install /path/to/ffmpeg-wasm-demuxer
```

Then in your code:
```typescript
import { FFmpegDemuxer } from 'ffmpeg-wasm-demuxer';
```

## CORS & COEP Immunity

Because the WASM binary is Base64-inlined via the `-s SINGLE_FILE=1` Emscripten flag:
- **No CORS issues:** The browser never makes an HTTP `fetch()` request for a `.wasm` file. It's just a Javascript string.
- **No COEP/COOP headers required:** This WASM is strictly single-threaded. It does not use `SharedArrayBuffer`, so it does not require restrictive Cross-Origin Embedder Policies on your web server.
- **No 404 Errors:** Your bundler doesn't need any special plugins to serve the WASM file.

## OPFS Performance
By default, `createSyncHandleSource` will read from OPFS in massive 1MB chunks to ensure peak SSD sequential read speeds with zero memory copies.
