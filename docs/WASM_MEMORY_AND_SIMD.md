# Rust WASM Memory Arena & SIMD Optimizations

This document explains the memory layout, Rust-to-TypeScript data pipeline, and LLVM/SIMD compilation techniques that make the slide detection core execute with zero allocation overhead.

---

## 💾 WASM Linear Memory Arena

To completely bypass garbage collection (GC) delays and memory fragmentation, the Rust WebAssembly module pre-allocates a static block of memory—the **[FrameArena](../../wasm-extractor/src/lib.rs#L68)**—upon initialization.

### Memory Map ([FrameArena](../../wasm-extractor/src/lib.rs#L68))

The arena dimensions are fixed at **$854 \times 480$ (480p)**. This resolution is the optimal sweet spot: it preserves fine text outlines and slide transition boundaries, while reducing the pixel count to $\approx 410,000$ pixels per frame.

| Buffer Name | Format | Byte Size | Description |
|---|---|---|---|
| `raw_a` | Grayscale (8-bit) | 409,920 B | Baseline slide (last emitted slide frame) |
| `raw_b` | Grayscale (8-bit) | 409,920 B | Current video frame under evaluation |
| `raw_prev` | Grayscale (8-bit) | 409,920 B | Previous video frame (consecutive drift tracking) |
| `edge_a` | Binary Map (8-bit) | 409,920 B | Binary edge map of the baseline slide |
| `edge_b` | Binary Map (8-bit) | 409,920 B | Binary edge map of the current frame (cached) |
| `rgba_buf` | RGBA (32-bit) | 1,639,680 B | Shared staging buffer for incoming video frames |
| **Total** | | **3,689,280 B** | **~3.6 MB flat allocation** |

### Shared Pointer Data Flow

Rather than copying pixels across the JavaScript-to-WASM boundary, FastExtractor uses **shared-memory pointers**:

1. The TypeScript wrapper ([WasmBridge.ts](../src/engine/video/WasmBridge.ts)) retrieves the raw memory address of `rgba_buf` inside the WASM heap using `get_rgba_buffer_ptr()`.
2. It instantiates a zero-copy Uint8ClampedArray view:
   ```typescript
   const view = new Uint8ClampedArray(wasm.memory.buffer, rgbaBufferPtr, 1639680);
   ```
3. During extraction, `drawImage()` renders the video frame directly onto an `OffscreenCanvas`. The canvas pixels are read via `getImageData()` into this mapped view.
4. Rust processes the memory space directly in-place.

---

## ⚡ SIMD & Loop Optimizations

The Rust module is compiled with target features enabling 128-bit **WASM SIMD**. To guarantee that the compiler generates vectorized assembly, several code patterns are enforced:

### 1. Bounds-Check Elimination (Auto-Vectorization)
In standard Rust, accessing array elements triggers runtime bounds checks. If the compiler cannot prove that index bounds are safe, it generates conditional checks for every pixel, disabling vectorization.

FastExtractor achieves **zero bounds checks** during grayscale conversion ([copy_rgba_to_gray](../../wasm-extractor/src/lib.rs#L141)) by using zipped iterators:
```rust
let src = &a.rgba_buf[..ARENA_SIZE * 4];
let dst = &mut target[..ARENA_SIZE];

for (d, s) in dst.iter_mut().zip(src.chunks_exact(4)) {
    *d = ((77 * s[0] as u32 + 150 * s[1] as u32 + 29 * s[2] as u32) >> 8) as u8;
}
```
* **Why it works**: `chunks_exact(4)` yields slices that are guaranteed to have a length of 4. LLVM uses this static guarantee to prove that `s[0]`, `s[1]`, and `s[2]` are always within bounds. The loop is compiled into a single, vectorized loop using WASM SIMD instructions (`v128`).

---

### 2. Branchless Sobel Edge Mapping
The L1-Norm Sobel operator calculates horizontal ($G_x$) and vertical ($G_y$) gradients for each pixel. We check if the gradient magnitude exceeds `edge_threshold`.

To prevent CPU pipeline stalls caused by branch mispredictions on high-contrast images, the threshold check is **branchless**:
```rust
let diff = (gx.abs() + gy.abs()) >> 2;
out[row_curr + x] = (diff > edge_threshold) as u8;
```
* **Why it works**: The boolean condition `diff > edge_threshold` is cast directly to a `u8` (`0` or `1`). LLVM compiles this condition into a comparison instruction (such as `i32.gt_s`) rather than a conditional jump branch, keeping the CPU instruction pipeline filled.

---

## 🔒 Thread Safety & Interior Mutability

Because WebAssembly runs inside the browser's single-threaded JavaScript runtime (within the Web Worker context), concurrent data races are impossible. To avoid the runtime overhead of RefCells, the arena is managed via a thread-safe `WasmCell` holding an `UnsafeCell`:

```rust
struct WasmCell<T>(UnsafeCell<T>);
unsafe impl<T> Sync for WasmCell<T> {}

static ARENA: WasmCell<Option<FrameArena>> = WasmCell(UnsafeCell::new(None));
```
- **Sync Promise**: Marking `WasmCell` as `Sync` tells the compiler that the data can be shared globally.
- **UnsafeCell**: Informs LLVM that the underlying `FrameArena` may be mutated via shared references, ensuring that the optimizer does not apply incorrect optimization invariants (such as assuming variables remain constant) across JS invocation boundaries.

---

## 📚 Further Reading

To explore specific modules in detail:
- **[System Architecture](ARCHITECTURE.md)**: Details the three-tier system layers, threading model, message passing, and OPFS storage architecture.
- **[Video & Audio Extraction Pipelines](PIPELINE_AND_DETECTION.md)**: Details the ADTS audio remuxer, WebCodecs configuration, backpressure tuning, and the Three-Pointer Drift stability gate.
