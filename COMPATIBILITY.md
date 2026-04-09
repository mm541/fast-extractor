# 🛠️ Support & Limitations

Fast-Extractor pushes the boundaries of what is possible in the browser by leveraging cutting-edge APIs like WebCodecs, OPFS, and WASM. Because it operates at such a low level, it has strict environment and format requirements.

This document details exactly what is supported, what gracefully degrades, and what outright fails.

---

## 🌐 Browser Compatibility Matrix

To run the extraction engine, the browser MUST support:
1. **WebCodecs (`VideoDecoder`)** — For hardware-accelerated video decoding.
2. **Origin Private File System (OPFS)** with `FileSystemSyncAccessHandle` — For zero-copy file ingestion and random-access reading in the Worker.
3. **Secure Context** — OPFS is strictly limited to HTTPS or `localhost`.

| Browser | OS | Status | Notes |
|---------|----|--------|-------|
| **Chrome** / Edge | Windows, Mac, Linux | ✅ Fully Supported | Chrome 102+ required for OPFS SyncAccessHandle. |
| **Chrome for Android** | Android | ✅ Fully Supported | Works perfectly on Chrome 102+. Automatically degrades to `turbo` mode on devices with $\le$ 4GB RAM to prevent Out-Of-Memory (OOM) crashes. |
| **Brave / Vivaldi** | Desktop, Android | ✅ Fully Supported | Same as Chrome. |
| **Safari** | macOS | ❌ Unsupported | Apple has not implemented OPFS `FileSystemSyncAccessHandle` for synchronous reading. |
| **Safari / WebKit** | iOS, iPadOS | ❌ Unsupported | iOS does not support WebCodecs or OPFS synchronous access. |
| **Firefox** | Windows, Mac, Linux | ❌ Unsupported | No WebCodecs support enabled by default. Even when flagged on, WebCodecs implementation is incomplete. |

### 🔍 Feature Detection
You should always use the built-in checker before initializing the library:

```typescript
const support = await FastExtractor.checkBrowserSupport();
if (!support.supported) {
   console.error("Cannot extract:", support.reason);
   // e.g., "Browser missing required APIs: WebCodecs (VideoDecoder), Origin Private File System (OPFS)"
}
```

---

## 🎬 Video & Audio Format Support

### Video Formats
Fast-Extractor relies on **WebCodecs (`VideoDecoder`)** to decode frames and **web-demuxer** (FFmpeg WASM) to parse the container.

*   **Supported Containers:** `.mp4`, `.mov`, `.webm`, `.mkv`
*   **Supported Video Codecs:** `H.264 (AVC)`, `H.265 (HEVC)`*, `VP8`, `VP9`, `AV1`
    *   *\*H.265 support depends entirely on the underlying OS and GPU hardware (e.g., supported on modern macOS/Windows but may fail on older Linux/Android).*
*   **Resolution & Framerate:** Any (up to 4K / 60fps). WebCodecs will leverage GPU acceleration.

### Audio Formats
Audio extraction is handled via the `Symphonia` Rust crate compiled to WASM. To maintain an extremely small WASM footprint, audio decoding is restricted.

*   **Supported Audio Codec:** `AAC` ONLY.
*   **Behavior:** The engine demuxes the AAC track and streams out raw ADTS packets. It does not re-encode.
*   **What if it's not AAC?** (e.g., WebM with `Opus` or `Vorbis`, or an MP4 with `MP3`):
    *   Audio extraction will gracefully fail.
    *   A `warning` progress event is emitted: `⚠️ Audio unavailable: unsupported format. Extracting slides only...`
    *   The video slide extraction **continues uninterrupted.**

---

## 📱 Mobile Device Limitations & Strategy

Mobile devices have aggressive memory management and background-task throttling. Fast-Extractor implements several safeguards for Android browsers:

1.  **Low RAM Strategy:** Devices reporting 4GB RAM or less will automatically default to `mode: 'turbo'` (keyframe-only extraction) to avoid allocating large decode queues that cause OOM crashes. Export resolution is also clamped.
2.  **SAF (Storage Access Framework) Expiry:** On Android, file permissions granted via `<input type="file">` can arbitrarily expire if the tab is backgrounded.
    *   The engine detects this and emits an `error` event with `recoverable: true`.
    *   The UI can prompt the user to quickly re-select the file, allowing extraction to resume/restart.
3.  **Background Throttling:** If the user minimizes Chrome on Android, OS-level battery optimizations (especially on OEMs like Samsung, Xiaomi, OnePlus) may pause the Web Worker. Extraction will resume when the tab is brought back to the foreground.

---

## 💾 Storage & OPFS Limits

*   **Ingestion:** The video file is copied into the browser's OPFS folder before extraction begins.
*   **Disk Space:** Ensure the device has at least `1x` the video file size in free browser storage. (e.g., a 2GB video requires 2GB of OPFS quota).
*   **Quotas:** OPFS counts towards the browser's origin storage quota. If the disk is nearly full, ingestion will fail with a `QuotaExceededError`.
*   **File Lifespans:** Temporary files are aggressively cleaned up:
    *   On startup, stale files from previously crashed tabs are wiped.
    *   On success, the ingested video is deleted (unless configured with `cleanupAfterExtraction: false`).

---

## ⚡ Performance Profiles

| Component | Architecture Limitation | Why it's designed this way |
| :--- | :--- | :--- |
| **WASM Memory** | 100MB Fixed Arena | No garbage collection (GC) pauses. Arrays are pre-allocated. Prevents memory ballooning during heavy seeking. |
| **Frame Resizing**| Fixed 427x240 compute grid | Fast perceptual hashing and edge detection. Pixel-perfect 4K comparison is too slow and produces false-positives for noise/compression artifacts. |
| **Turbo Mode** | Reads Demuxer Keyframes | Hardware decoders hate reverse-seeking. Turbo mode only feeds keyframes to WebCodecs, skipping P/B-frames entirely, resulting in $\approx$ 10x speedup. |
