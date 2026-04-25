# WebCodecs & Pipeline Hazards

This document outlines critical architectural invariants in the `fast-extractor` pipeline. **DO NOT MODIFY** these core mechanisms without understanding the cascading failures they prevent.

## 1. The Main-Thread CPU Burn Hazard (MessageChannel vs setTimeout)
**Location:** `fast-extractor.ts` (`extractVideoChunks` backpressure loop)

Chrome severely throttles `setTimeout` to 1000ms minimum when a tab is in the background. To bypass this, we use `MessageChannel` for UI yielding (which executes as a 0ms macrotask). 

**THE DANGER:** 
Never use `MessageChannel` (or a 0ms yield) inside a `while` loop that waits for the worker (e.g., `while (getUnacked() >= 15)`). Because `MessageChannel` takes 0ms, the `while` loop will execute 10,000+ times per second. This creates a 100% CPU busy-wait spinloop that will physically overheat the device, rapidly drain battery on mobile, and trigger extreme thermal throttling.
**THE SOLUTION:** 
Cross-thread backpressure must be explicitly resolved via a Promise that is tied to the worker's `onmessage` handler (`CHUNK_PROCESSED`). This completely suspends the main thread (0% CPU) until the worker explicitly wakes it up.

## 2. The Mobile Hardware Decoder OOM (Queue Size)
**Location:** `extractor.ts` (`maxQueue` configuration)

**THE DANGER:** 
On high-end PCs, hardware decoders can queue dozens of frames safely. On mobile devices (even flagships like Snapdragon 8+ Gen 1), feeding too many chunks into the `VideoDecoder` at once will cause the hardware decoder to allocate massive amounts of internal VRAM and crash or spike memory usage.
**THE SOLUTION:** 
In `sequential` mode (which decodes every single frame), `maxQueue` MUST be kept exceptionally low (e.g., `5`).

## 3. The Dropped-Frame Deadlock (ondequeue vs output)
**Location:** `extractor.ts` (`makeDecoder`)

**THE DANGER:** 
Mobile hardware decoders occasionally and silently drop frames when under load. If backpressure resolution is tied to the `output` callback, a dropped frame means the callback never fires, causing the pipeline to deadlock permanently (or stall if a safety timeout is used).
**THE SOLUTION:** 
WebCodecs backpressure must ALWAYS be wired to the `ondequeue` event on the `VideoDecoder`. `ondequeue` fires the exact microsecond a chunk leaves the decode queue, *regardless* of whether the frame was successfully output or silently dropped. This provides instant 0ms resolution and prevents deadlocks.

## 4. The Batching Starvation Choke (optimizeForLatency)
**Location:** `extractor.ts` (`decoderConfig`)

**THE DANGER:** 
Hardware decoders naturally prefer to batch frames (e.g., buffering 10-20 frames for B-frame reordering before outputting the first one). If you combine a batching decoder with a low `maxQueue` (like 5), the decoder will wait for more frames, but the pipeline will refuse to feed it because the queue is full. This causes permanent starvation, completely killing throughput.
**THE SOLUTION:** 
`optimizeForLatency: true` MUST always be set in the `VideoDecoderConfig` for both turbo and sequential modes. This forces the hardware decoder into a strict "1-in-1-out" mode, entirely bypassing internal batching and keeping the queue lean.
