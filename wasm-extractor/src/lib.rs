
// ═══════════════════════════════════════════════════════════════════════════
// wasm_extractor — Browser-native Slide Detection Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// This WASM module provides a single core capability:
//   SLIDE DETECTION — Edge-based frame comparison on a static memory arena
//
// Audio extraction has been migrated to the TypeScript AudioRemuxer
// (src/engine/audio-remuxer.ts) which runs directly in the Worker thread,
// eliminating the Symphonia dependency and shrinking the WASM binary from
// ~682KB to ~30KB.
//
// ── INITIALIZATION CONTRACT ──────────────────────────────────────────────
//
//   All slide detection functions lazily initialize the arena on first use.
//   Calling init_arena() explicitly is optional but recommended for
//   predictable timing (avoids a ~512KB allocation on the first frame).
//
// ── MEMORY LAYOUT ────────────────────────────────────────────────────────
//
//   init_arena() allocates six fixed buffers in WASM linear memory:
//     Buffer A  (raw_a)    — 424×240 × 1  grayscale — Baseline (last emitted slide)
//     Buffer B  (raw_b)    — 424×240 × 1  grayscale — Current frame being evaluated
//     Buffer Prev (raw_prev) — 424×240 × 1  grayscale — Previous frame (drift detection)
//     Edge A   (edge_a)    — 424×240 × 1  binary    — Baseline edge map (0 or 1)
//     Edge B   (edge_b)    — 424×240 × 1  binary    — Current frame edge map (cached)
//     RGBA Buffer (rgba_buf) — 424×240 × 4  RGBA    — Staging area for pixel ingestion
//
//   Total: 5 × 101,760 + 407,040 = 915,840 bytes (~894KB).
//   Allocated once, never freed, never resized.
//   Zero per-frame allocations. Zero GC pressure.
//
// ── PERFORMANCE INVARIANTS ───────────────────────────────────────────────
//
//   • All hot loops are bounds-check-free (LLVM proves safety at compile time)
//   • Edge detection uses branchless (diff > threshold) as u8 casts
//   • Grayscale conversion uses integer-only BT.601 coefficients (no floats)
//
// ── SAFETY: UnsafeCell ARENA ─────────────────────────────────────────────
//
//   This module uses `UnsafeCell` (via WasmCell) for interior mutability.
//   UnsafeCell is Rust's only blessed mechanism for this — it correctly
//   informs LLVM not to apply noalias optimizations, preventing UB.
//   The single-threaded WASM guarantee is encoded via `unsafe impl Sync`.
//
//   Safety invariants:
//     1. WASM is SINGLE-THREADED — no data races possible
//     2. NO RE-ENTRANCY — JS never calls Rust concurrently
//     3. arena() is called at most once per exported function scope
// ═══════════════════════════════════════════════════════════════════════════


use std::cell::UnsafeCell;
use wasm_bindgen::prelude::*;



// ════════════════════════════════════════════════
// 2. MATURE SLIDE-DIFF LOGIC (3-BUFFER ARENA)
// ════════════════════════════════════════════════

const ARENA_WIDTH: usize = 424;
const ARENA_HEIGHT: usize = 240;
const ARENA_SIZE: usize = ARENA_WIDTH * ARENA_HEIGHT;
const RGBA_SIZE: usize = ARENA_SIZE * 4;

struct FrameArena {
    raw_a: Vec<u8>,    // Baseline Slide
    raw_b: Vec<u8>,    // Current Frame (T)
    raw_prev: Vec<u8>, // Previous Frame (T-1)
    edge_a: Vec<u8>,
    edge_b: Vec<u8>,
    rgba_buf: Vec<u8>, // Transfer Buffer
    edge_b_valid: bool, // Cache flag: true if edge_b matches current raw_b
}

impl FrameArena {
    fn new() -> Self {
        Self {
            raw_a: vec![0u8; ARENA_SIZE],
            raw_b: vec![0u8; ARENA_SIZE],
            raw_prev: vec![0u8; ARENA_SIZE],
            edge_a: vec![0u8; ARENA_SIZE],
            edge_b: vec![0u8; ARENA_SIZE],
            rgba_buf: vec![0u8; RGBA_SIZE],
            edge_b_valid: false,
        }
    }
}

// ── WasmCell: Zero-cost interior mutability for single-threaded WASM ─────
//
// UnsafeCell tells LLVM: "this memory may be mutated through shared refs."
// The Sync impl is our manual promise that WASM is single-threaded.
// Total runtime cost: zero. UnsafeCell compiles away entirely.
struct WasmCell<T>(UnsafeCell<T>);
unsafe impl<T> Sync for WasmCell<T> {}

static ARENA: WasmCell<Option<FrameArena>> = WasmCell(UnsafeCell::new(None));

/// Lazy accessor — guarantees the arena is always initialized.
/// If JS forgot to call init_arena(), this silently creates it on first use.
/// Cost: a single branch per call (predicted-taken after first init).
#[inline(always)]
fn arena() -> &'static mut FrameArena {
    unsafe {
        let ptr = ARENA.0.get();
        if (*ptr).is_none() {
            *ptr = Some(FrameArena::new());
        }
        (*ptr).as_mut().unwrap_unchecked()
    }
}

#[wasm_bindgen]
pub fn init_arena() {
    let _ = arena();
}

#[wasm_bindgen]
pub fn get_buffer_a_ptr() -> *mut u8 { arena().raw_a.as_mut_ptr() }
#[wasm_bindgen]
pub fn get_buffer_b_ptr() -> *mut u8 { arena().raw_b.as_mut_ptr() }
#[wasm_bindgen]
pub fn get_buffer_prev_ptr() -> *mut u8 { arena().raw_prev.as_mut_ptr() }
#[wasm_bindgen]
pub fn get_rgba_buffer_ptr() -> *mut u8 { arena().rgba_buf.as_mut_ptr() }

/// Efficient rotation: Current becomes Previous
#[wasm_bindgen]
pub fn shift_current_to_prev() {
    let a = arena();
    a.raw_prev.copy_from_slice(&a.raw_b);
}

/// Hardware-accelerated grayscale conversion in Rust.
/// Uses zipped iterators so LLVM can prove slice bounds at compile time,
/// eliminating all per-pixel bounds checks and enabling SIMD auto-vectorization.
#[wasm_bindgen]
pub fn copy_rgba_to_gray(is_target_b: bool) {
    let a = arena();
    let target = if is_target_b { &mut a.raw_b } else { &mut a.raw_a };

    let src = &a.rgba_buf[..ARENA_SIZE * 4];
    let dst = &mut target[..ARENA_SIZE];

    for (d, s) in dst.iter_mut().zip(src.chunks_exact(4)) {
        *d = ((77 * s[0] as u32 + 150 * s[1] as u32 + 29 * s[2] as u32) >> 8) as u8;
    }

    // Invalidate cached edge map when B's pixel data changes
    if is_target_b {
        a.edge_b_valid = false;
    }
}

const GRID_ROWS: usize = 8;
const GRID_COLS: usize = 8;

/// Edge detection via L1-norm First-Order Forward Difference gradient.
/// Uses branchless `(bool) as u8` cast to avoid branch-prediction stalls.
fn compute_edge_map_into(pixels: &[u8], width: usize, height: usize, edge_threshold: i16, out: &mut Vec<u8>) {
    let len = width * height;
    // Safety net: Ensures the buffer is large enough.
    // In our FrameArena (424x240), out.len() exactly equals len (101,760),
    // so this resize() never executes, preserving our zero-allocation invariant.
    if out.len() < len { out.resize(len, 0); }

    // Slice assertions to elide bounds checks inside the loop
    let pixels = &pixels[..len];
    let out = &mut out[..len];

    // Interior pixels: stop 1 early on each axis to prevent reading out of bounds
    for y in 0..height - 1 {
        let row_offset = y * width;
        for x in 0..width - 1 {
            let idx = row_offset + x;
            let current = pixels[idx] as i16;
            let right = pixels[idx + 1] as i16;
            let bottom = pixels[idx + width] as i16;
            let diff = (current - right).abs() + (current - bottom).abs();
            out[idx] = (diff > edge_threshold) as u8;
        }
    }
}

/// Divides the screen into an 8×8 grid of macro-regions (8 rows, 8 columns = 64 blocks total).
/// Compares the edge density of each block. Returns the number of blocks that changed.
/// `mask`: a 64-bit bitmask where bit (row*8 + col) = 1 means SKIP that block.
/// Pass mask=0 to compare all blocks (default behavior).
fn compare_grid_density(edges_a: &[u8], edges_b: &[u8], width: usize, height: usize, num: u32, den: u32, mask: u64) -> u32 {
    // Assert slice bounds once so LLVM drops all bounds checks inside the loops
    let len = width * height;
    let edges_a = &edges_a[..len];
    let edges_b = &edges_b[..len];

    let block_h = height / GRID_ROWS;
    let block_w = width / GRID_COLS;
    let mut changed: u32 = 0;

    for r in 0..GRID_ROWS {
        let y0 = r * block_h;
        let y1 = if r == GRID_ROWS - 1 { height } else { (r + 1) * block_h };
        for c in 0..GRID_COLS {
            // Skip masked blocks (e.g. webcam overlay region)
            if (mask >> (r * 8 + c)) & 1 == 1 { continue; }
            
            let x0 = c * block_w;
            let x1 = if c == GRID_COLS - 1 { width } else { (c + 1) * block_w };
            
            let mut sum_a = 0u32;
            let mut sum_b = 0u32;
            
            let block_size = ((y1 - y0) * (x1 - x0)) as u32;
            
            for y in y0..y1 {
                let start = y * width + x0;
                let end = y * width + x1;
                
                // Idiomatic SIMD-friendly zip loop (0 bounds checks)
                for (a, b) in edges_a[start..end].iter().zip(&edges_b[start..end]) {
                    sum_a += *a as u32;
                    sum_b += *b as u32;
                }
            }
            let diff = (sum_a as i32 - sum_b as i32).unsigned_abs();
            if diff * den > num * block_size { changed += 1; }
        }
    }
    changed
}

/// Compare Baseline (A) vs Current (B). mask=0 to compare all blocks.
/// Caches B's edge map — subsequent calls with the same B skip recomputation.
#[wasm_bindgen]
pub fn compare_frames(edge_threshold: i16, density_num: u32, mask: u64) -> u32 {
    let a = arena();
    compute_edge_map_into(&a.raw_a, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_a);
    if !a.edge_b_valid {
        compute_edge_map_into(&a.raw_b, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_b);
        a.edge_b_valid = true;
    }
    compare_grid_density(&a.edge_a, &a.edge_b, ARENA_WIDTH, ARENA_HEIGHT, density_num, 100, mask)
}

#[wasm_bindgen]
pub fn compute_dhash(is_buffer_b: bool) -> u64 {
    let a = arena();
    let pixels = if is_buffer_b { &a.raw_b } else { &a.raw_a };
    let w = ARENA_WIDTH;
    let h = ARENA_HEIGHT;
    // Slice assertion: tells LLVM the exact length so it drops all bounds checks below
    let pixels = &pixels[..w * h];
    let dw: usize = 9;
    let dh: usize = 8;
    let mut small = [0u16; 72]; 
    let block_w = w / dw;
    let block_h = h / dh;
    for sy in 0..dh {
        for sx in 0..dw {
            let mut sum = 0u32;
            let y0 = sy * block_h;
            let y1 = if sy == dh - 1 { h } else { (sy + 1) * block_h };
            let x0 = sx * block_w;
            let x1 = if sx == dw - 1 { w } else { (sx + 1) * block_w };
            let block_size = ((y1 - y0) * (x1 - x0)) as u32;
            for y in y0..y1 {
                let start = y * w + x0;
                let end = y * w + x1;
                for &p in &pixels[start..end] {
                    sum += p as u32;
                }
            }
            small[sy * dw + sx] = (sum / block_size) as u16;
        }
    }
    let mut hash: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            if small[y * dw + x] > small[y * dw + x + 1] { hash |= 1; }
        }
    }
    hash
}

/// Consecutive frame drift: edge-density comparison of Prev vs B.
/// Same algorithm as compare_frames but uses raw_prev instead of raw_a.
/// Returns number of grid blocks that changed (0-64).
/// Reuses B's cached edge map from compare_frames if available.
#[wasm_bindgen]
pub fn compare_prev_current(edge_threshold: i16, density_num: u32, mask: u64) -> u32 {
    let a = arena();
    // edge_a is scratch — overwrite with Prev's edge map
    compute_edge_map_into(&a.raw_prev, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_a);
    // Reuse B's cached edge map if compare_frames already computed it
    if !a.edge_b_valid {
        compute_edge_map_into(&a.raw_b, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_b);
        a.edge_b_valid = true;
    }
    compare_grid_density(&a.edge_a, &a.edge_b, ARENA_WIDTH, ARENA_HEIGHT, density_num, 100, mask)
}

/// Average brightness of buffer B (0-255). Detects blank/black frames.
#[wasm_bindgen]
pub fn get_avg_brightness() -> u32 {
    let a = arena();
    let sum: u64 = a.raw_b[..ARENA_SIZE].iter().map(|&p| p as u64).sum();
    (sum / ARENA_SIZE as u64) as u32
}

/// Compute average color signature from the RGBA buffer.
/// Returns packed u64: [avgR: u16 | avgG: u16 | avgB: u16 | unused: u16]
/// Samples every 64th pixel (~1590 samples from 424×240) — fast and representative.
/// Must be called AFTER pixel ingestion but BEFORE copy_rgba_to_gray().
#[wasm_bindgen]
pub fn compute_color_signature() -> u64 {
    let a = arena();
    let rgba = &a.rgba_buf[..RGBA_SIZE];
    let mut sum_r: u64 = 0;
    let mut sum_g: u64 = 0;
    let mut sum_b: u64 = 0;
    
    // chunks_exact(256) guarantees every chunk is exactly 256 bytes long.
    // This allows LLVM to mathematically prove chunk[0], chunk[1], chunk[2] are safe,
    // completely eliminating bounds checks from the inner loop.
    let chunks = rgba.chunks_exact(256);
    let count = chunks.len() as u64;
    
    for chunk in chunks {
        sum_r += chunk[0] as u64;
        sum_g += chunk[1] as u64;
        sum_b += chunk[2] as u64;
    }
    
    if count == 0 { return 0; }
    
    let avg_r = sum_r / count;
    let avg_g = sum_g / count;
    let avg_b = sum_b / count;
    
    (avg_r << 48) | (avg_g << 32) | (avg_b << 16)
}

