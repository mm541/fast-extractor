# How to Use `ffmpeg-wasm-demuxer`

This library provides a zero-copy, synchronous API for extracting raw media packets (video and audio) from any container format supported by FFmpeg 8.1 (MP4, WebM, MKV, MOV, etc.).

## 1. Initialization

Because the library relies on WebAssembly, you must await its initialization before using it.

```typescript
import { FFmpegDemuxer, createDemuxerModule } from 'ffmpeg-wasm-demuxer';

// Initialize the WASM module
const demuxer = await FFmpegDemuxer.create(createDemuxerModule);
```

## 2. Opening a File (I/O Sources)

The demuxer supports two types of I/O sources depending on your environment.

### OPFS (Extremely Fast, Web Worker Only)
If you have a file in the Origin Private File System, you can pass its `FileSystemSyncAccessHandle`. This is the absolute fastest way to read files, as the SSD writes directly into the WASM heap.

```typescript
import { createSyncHandleSource } from 'ffmpeg-wasm-demuxer';

// Get handle from OPFS
const fileHandle = await opfsRoot.getFileHandle('video.mp4');
const syncHandle = await fileHandle.createSyncAccessHandle();
const size = syncHandle.getSize();

// Create source and open
const source = createSyncHandleSource(syncHandle, size);
demuxer.open(source);
```

### Blob / File (Fallback)
If you just have a standard `File` or `Blob` object (e.g., from an `<input type="file">`), you can use the Blob source. Note: this loads the file into memory.

```typescript
import { createBlobSource } from 'ffmpeg-wasm-demuxer';

const arrayBuffer = await file.arrayBuffer();
const source = createBlobSource(arrayBuffer);

// Open with custom buffer size if needed (default is 1MB)
demuxer.open(source, { bufferSize: 256 * 1024 }); 
```

## 3. WebCodecs Video Extraction

Here is a complete example of extracting video frames and feeding them directly to the browser's hardware-accelerated `VideoDecoder`.

```typescript
// 1. Get the pre-built WebCodecs configuration
const videoConfigResult = demuxer.getVideoDecoderConfig();
if (!videoConfigResult) throw new Error("No video stream found!");

// 2. Setup the WebCodecs Decoder
const decoder = new VideoDecoder({
  output: (frame) => {
    console.log("Decoded frame at", frame.timestamp);
    // Draw to canvas or process...
    frame.close();
  },
  error: (e) => console.error("Decoder error:", e)
});

// 3. Configure the decoder using the string built from FFmpeg's extradata
decoder.configure(videoConfigResult.config);

// 4. Read packets in a loop
let pkt;
while ((pkt = demuxer.readPacket()) !== null) {
  
  // Only process video packets
  if (pkt.streamIndex === demuxer.videoStreamIndex) {
    
    // Create the WebCodecs chunk. 
    // pkt.data is a ZERO-COPY view directly into WASM memory!
    const chunk = new EncodedVideoChunk({
      type: pkt.isKeyframe ? 'key' : 'delta',
      timestamp: pkt.ptsUs,
      duration: pkt.durationUs,
      data: pkt.data 
    });
    
    decoder.decode(chunk);
  }
  
  // CRITICAL: You MUST free the packet when done to prevent WASM memory leaks
  pkt.free();
}

// 5. Cleanup when finished
demuxer.destroy();
decoder.close();
```

## 4. WebCodecs Audio Extraction

The demuxer also exports raw audio packets perfectly formatted for WebCodecs.

```typescript
const audioInfo = demuxer.getAudioStreamInfo();
if (audioInfo) {
  const audioDecoder = new AudioDecoder({
    output: (audioData) => { /* Process raw PCM audio */ },
    error: (e) => console.error(e)
  });

  audioDecoder.configure({
    // 86076 = Opus, 86018 = AAC
    codec: audioInfo.codecId === 86076 ? 'opus' : 'mp4a.40.2',
    sampleRate: audioInfo.sampleRate,
    numberOfChannels: audioInfo.channels,
    description: audioInfo.extradata // Raw AAC AudioSpecificConfig or OpusHead
  });

  // Inside your demuxer loop:
  // if (pkt.streamIndex === demuxer.audioStreamIndex) { ... }
}
```

## 5. Important Memory Rules (Manual GC)
Because this library relies on C/WASM, JavaScript's Garbage Collector cannot automatically clean up media packets. You are required to manage memory manually. 

### Why Manual Memory Management?
While unusual in standard JavaScript, manual memory management is the industry standard for high-performance WebAssembly and WebCodecs libraries for two reasons:
* **Zero-Copy Performance:** To avoid copying data, `pkt.data` is just a view into the WASM heap. If we relied on JS garbage collection, we would have to copy the data into a new array, destroying performance.
* **OOM Crash Prevention:** Video demuxing generates thousands of packets per second. If the JS garbage collector is slow to run, the WASM memory will instantly fill up with dead packets, crashing the browser tab with an Out-of-Memory (OOM) error.

### The Two Golden Rules:
1. **Free Every Packet:** Every time you call `demuxer.readPacket()`, you **MUST** call `pkt.free()` before reading the next one or after passing it to WebCodecs.
2. **Destroy the Demuxer:** When you are done with the file, you **MUST** call `demuxer.destroy()` to free the FFmpeg context and internal buffers.
