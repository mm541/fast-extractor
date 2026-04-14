#![allow(static_mut_refs)]

// ═══════════════════════════════════════════════════════════════════════════
// wasm_extractor — Browser-native Slide Detection & Audio Extraction Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// This WASM module provides two core capabilities:
//   1. SLIDE DETECTION — Edge-based frame comparison on a static memory arena
//   2. AUDIO EXTRACTION — AAC demuxing via Symphonia with zero-copy OPFS reads
//
// ── INITIALIZATION CONTRACT ──────────────────────────────────────────────
//
//   All slide detection functions lazily initialize the arena on first use.
//   Calling init_arena() explicitly is optional but recommended for
//   predictable timing (avoids a ~512KB allocation on the first frame).
//
//   AudioExtractor is independent of the arena and can be used standalone.
//
// ── MEMORY LAYOUT ────────────────────────────────────────────────────────
//
//   init_arena() allocates four fixed buffers in WASM linear memory:
//     Buffer A  (raw_a)    — 427×240 grayscale — Baseline (last emitted slide)
//     Buffer B  (raw_b)    — 427×240 grayscale — Current frame being evaluated
//     Buffer Prev (raw_prev) — 427×240 grayscale — Previous frame (drift detection)
//     RGBA Buffer (rgba_buf) — 427×240×4 RGBA  — Staging area for pixel ingestion
//
//   Total: ~512KB. Allocated once, never freed, never resized.
//   Zero per-frame allocations. Zero GC pressure.
//
// ── PERFORMANCE INVARIANTS ───────────────────────────────────────────────
//
//   • All hot loops are bounds-check-free (LLVM proves safety at compile time)
//   • Edge detection uses branchless (diff > threshold) as u8 casts
//   • Grayscale conversion uses integer-only BT.601 coefficients (no floats)
//   • AudioExtractor reuses a scratch Uint8Array + options Object across reads
//
// ── SAFETY: STATIC MUT ──────────────────────────────────────────────────
//
//   This module uses `static mut ARENA` to bypass Rust's aliasing rules.
//   This is safe ONLY because:
//     1. WASM is SINGLE-THREADED — no data races possible
//     2. NO RE-ENTRANCY — JS never calls Rust concurrently
//     3. No stored references — only raw pointers returned to JS
//
//   Violating these assumptions → Undefined Behavior.
// ═══════════════════════════════════════════════════════════════════════════


use std::io::{Read, Seek, SeekFrom, Result as IoResult};
use js_sys::{Uint8Array, Object, Reflect};
use wasm_bindgen::prelude::*;
use symphonia::core::formats::FormatReader;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use symphonia::core::codecs::CODEC_TYPE_AAC;

// ════════════════════════════════════════════════
// 1. JS OPFS BINDINGS
// ════════════════════════════════════════════════

#[wasm_bindgen]
extern "C" {
    pub type SyncHandle;

    #[wasm_bindgen(method, js_name = read)]
    pub fn read_at(this: &SyncHandle, buffer: &Uint8Array, options: &Object) -> f64;

    #[wasm_bindgen(method, js_name = getSize)]
    pub fn get_size(this: &SyncHandle) -> f64;
}


// ════════════════════════════════════════════════
// 2. MATURE SLIDE-DIFF LOGIC (3-BUFFER ARENA)
// ════════════════════════════════════════════════

const ARENA_WIDTH: usize = 427;
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
        }
    }
}

static mut ARENA: Option<FrameArena> = None;

/// Lazy accessor — guarantees the arena is always initialized.
/// If JS forgot to call init_arena(), this silently creates it on first use.
/// Cost: a single branch per call (predicted-taken after first init).
#[inline(always)]
unsafe fn arena() -> &'static mut FrameArena {
    if ARENA.is_none() {
        ARENA = Some(FrameArena::new());
    }
    ARENA.as_mut().unwrap_unchecked()
}

#[wasm_bindgen]
pub fn init_arena() {
    unsafe { let _ = arena(); }
}

#[wasm_bindgen]
pub fn get_buffer_a_ptr() -> *mut u8 { unsafe { arena().raw_a.as_mut_ptr() } }
#[wasm_bindgen]
pub fn get_buffer_b_ptr() -> *mut u8 { unsafe { arena().raw_b.as_mut_ptr() } }
#[wasm_bindgen]
pub fn get_buffer_prev_ptr() -> *mut u8 { unsafe { arena().raw_prev.as_mut_ptr() } }
#[wasm_bindgen]
pub fn get_rgba_buffer_ptr() -> *mut u8 { unsafe { arena().rgba_buf.as_mut_ptr() } }

/// Efficient rotation: Current becomes Previous
#[wasm_bindgen]
pub fn shift_current_to_prev() {
    unsafe {
        let a = arena();
        a.raw_prev.copy_from_slice(&a.raw_b);
    }
}

/// Hardware-accelerated grayscale conversion in Rust.
/// Uses zipped iterators so LLVM can prove slice bounds at compile time,
/// eliminating all per-pixel bounds checks and enabling SIMD auto-vectorization.
#[wasm_bindgen]
pub fn copy_rgba_to_gray(is_target_b: bool) {
    unsafe {
        let a = arena();
        let target = if is_target_b { &mut a.raw_b } else { &mut a.raw_a };

        let src = &a.rgba_buf[..ARENA_SIZE * 4];
        let dst = &mut target[..ARENA_SIZE];

        for (d, s) in dst.iter_mut().zip(src.chunks_exact(4)) {
            *d = ((77 * s[0] as u32 + 150 * s[1] as u32 + 29 * s[2] as u32) >> 8) as u8;
        }
    }
}

const GRID_ROWS: usize = 8;
const GRID_COLS: usize = 8;

/// Edge detection via horizontal + vertical Sobel-like gradient.
/// Loops stop 1 pixel early on each axis to eliminate ALL bounds-check branches.
/// Uses branchless `(bool) as u8` cast to avoid branch-prediction stalls.
fn compute_edge_map_into(pixels: &[u8], width: usize, height: usize, edge_threshold: i16, out: &mut Vec<u8>) {
    let len = width * height;
    if out.len() < len { out.resize(len, 0); }

    // Interior pixels: no bounds checks needed (stop 1 early on each axis)
    for y in 0..height - 1 {
        let row_offset = y * width;
        for x in 0..width - 1 {
            let idx = row_offset + x;
            let current = pixels[idx] as i16;
            let right = pixels[idx + 1] as i16;
            let bottom = pixels[idx + width] as i16;
            let diff = (current - right).abs() + (current - bottom).abs();
            // Branchless: true → 1, false → 0. Single cmov instruction.
            out[idx] = (diff > edge_threshold) as u8;
        }
    }
}

/// Compare two edge maps on an 8×8 grid, returning the number of blocks that changed.
/// `mask`: a 64-bit bitmask where bit (row*8 + col) = 1 means SKIP that block.
/// Pass mask=0 to compare all blocks (default behavior).
fn compare_grid_density(edges_a: &[u8], edges_b: &[u8], width: usize, height: usize, num: u32, den: u32, mask: u64) -> u32 {
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
            let (mut sum_a, mut sum_b, mut block_size) = (0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row_offset = y * width;
                for x in x0..x1 {
                    let idx = row_offset + x;
                    sum_a += edges_a[idx] as u32;
                    sum_b += edges_b[idx] as u32;
                    block_size += 1;
                }
            }
            let diff = (sum_a as i32 - sum_b as i32).unsigned_abs();
            if diff * den > num * block_size { changed += 1; }
        }
    }
    changed
}

/// Compare Baseline (A) vs Current (B). mask=0 to compare all blocks.
#[wasm_bindgen]
pub fn compare_frames(edge_threshold: i16, density_num: u32, mask: u64) -> u32 {
    unsafe {
        let a = arena();
        compute_edge_map_into(&a.raw_a, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_a);
        compute_edge_map_into(&a.raw_b, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_b);
        compare_grid_density(&a.edge_a, &a.edge_b, ARENA_WIDTH, ARENA_HEIGHT, density_num, 100, mask)
    }
}

#[wasm_bindgen]
pub fn compute_dhash(is_buffer_b: bool) -> u64 {
    unsafe {
        let a = arena();
        let pixels = if is_buffer_b { &a.raw_b } else { &a.raw_a };
        let w = ARENA_WIDTH;
        let h = ARENA_HEIGHT;
        let dw: usize = 9;
        let dh: usize = 8;
        let mut small = [0u16; 72]; 
        let block_w = w / dw;
        let block_h = h / dh;
        for sy in 0..dh {
            for sx in 0..dw {
                let (mut sum, mut count) = (0u32, 0u32);
                let y0 = sy * block_h;
                let y1 = if sy == dh - 1 { h } else { (sy + 1) * block_h };
                let x0 = sx * block_w;
                let x1 = if sx == dw - 1 { w } else { (sx + 1) * block_w };
                for y in y0..y1 {
                    for x in x0..x1 {
                        sum += pixels[y * w + x] as u32;
                        count += 1;
                    }
                }
                small[sy * dw + sx] = if count > 0 { (sum / count) as u16 } else { 0 };
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
}

/// ACCURATE STABILITY: Compares Current (B) vs Previous (Prev)
#[wasm_bindgen]
pub fn check_stability(stability_threshold: u64) -> bool {
    unsafe {
        let a = arena();
        let total_pixels = (ARENA_WIDTH as u64) * (ARENA_HEIGHT as u64);
        let mut diff_sum: u64 = 0;
        for i in 0..ARENA_SIZE {
            diff_sum += (a.raw_b[i] as i16 - a.raw_prev[i] as i16).unsigned_abs() as u64;
        }
        diff_sum < stability_threshold * total_pixels
    }
}

/// Consecutive frame drift: edge-density comparison of Prev vs B.
/// Same algorithm as compare_frames but uses raw_prev instead of raw_a.
/// Returns number of grid blocks that changed (0-64).
/// Compare Previous (Prev) vs Current (B). mask=0 to compare all blocks.
#[wasm_bindgen]
pub fn compare_prev_current(edge_threshold: i16, density_num: u32, mask: u64) -> u32 {
    unsafe {
        let a = arena();
        compute_edge_map_into(&a.raw_prev, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_a);
        compute_edge_map_into(&a.raw_b, ARENA_WIDTH, ARENA_HEIGHT, edge_threshold, &mut a.edge_b);
        compare_grid_density(&a.edge_a, &a.edge_b, ARENA_WIDTH, ARENA_HEIGHT, density_num, 100, mask)
    }
}

/// Average brightness of buffer B (0-255). Detects blank/black frames.
#[wasm_bindgen]
pub fn get_avg_brightness() -> u32 {
    unsafe {
        let a = arena();
        let mut sum: u64 = 0;
        for i in 0..ARENA_SIZE {
            sum += a.raw_b[i] as u64;
        }
        (sum / ARENA_SIZE as u64) as u32
    }
}

// ════════════════════════════════════════════════
// 3. AUDIO EXTRACTOR (Symphonia based)
// ════════════════════════════════════════════════
// ... Same AudioExtractor implementation as before ...

#[wasm_bindgen]
pub struct AudioExtractor {
    reader: Box<dyn FormatReader>,
    track_id: u32,
    sample_rate_idx: u8,
    channels: u8,
    pos_ref: std::sync::Arc<std::sync::atomic::AtomicU64>,
    total_size: u64,
}

#[wasm_bindgen]
impl AudioExtractor {
    #[wasm_bindgen(constructor)]
    pub fn new(handle: SyncHandle) -> Result<AudioExtractor, JsValue> {
        console_error_panic_hook::set_once();
        let total_size = handle.get_size() as u64;
        let pos_ref = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reader_pos = pos_ref.clone();
        
        struct SharedPosReader {
            handle: SyncHandle,
            pos: std::sync::Arc<std::sync::atomic::AtomicU64>,
            scratch: Uint8Array,
            options: Object,    // reused across reads — avoids per-read JS allocation
            at_key: JsValue,    // cached "at" string — avoids per-read interning
        }
        
        impl Read for SharedPosReader {
            fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
                let len = buf.len() as u32;
                let sub = self.scratch.subarray(0, len);
                let current_pos = self.pos.load(std::sync::atomic::Ordering::Relaxed);
                Reflect::set(&self.options, &self.at_key, &(current_pos as f64).into()).ok();
                let bytes_read = self.handle.read_at(&sub, &self.options) as usize;
                if bytes_read > 0 {
                    sub.subarray(0, bytes_read as u32).copy_to(&mut buf[..bytes_read]);
                    self.pos.fetch_add(bytes_read as u64, std::sync::atomic::Ordering::Relaxed);
                }
                Ok(bytes_read)
            }
        }
        
        impl Seek for SharedPosReader {
            fn seek(&mut self, pos: SeekFrom) -> IoResult<u64> {
                match pos {
                    SeekFrom::Start(new_pos) => self.pos.store(new_pos, std::sync::atomic::Ordering::Relaxed),
                    SeekFrom::End(offset) => {
                        let total = self.handle.get_size() as i64;
                        self.pos.store((total + offset) as u64, std::sync::atomic::Ordering::Relaxed);
                    }
                    SeekFrom::Current(offset) => {
                        let cur = self.pos.load(std::sync::atomic::Ordering::Relaxed) as i64;
                        self.pos.store((cur + offset) as u64, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                Ok(self.pos.load(std::sync::atomic::Ordering::Relaxed))
            }
        }
        
        impl symphonia::core::io::MediaSource for SharedPosReader {
            fn is_seekable(&self) -> bool { true }
            fn byte_len(&self) -> Option<u64> { Some(self.handle.get_size() as u64) }
        }

        let scratch = Uint8Array::new_with_length(65536);
        let options = Object::new();
        let at_key: JsValue = "at".into();
        let mss = MediaSourceStream::new(Box::new(SharedPosReader { handle, pos: reader_pos, scratch, options, at_key }), Default::default());
        let probed = symphonia::default::get_probe()
            .format(&Hint::new(), mss, &Default::default(), &Default::default())
            .map_err(|_| JsValue::from_str("Failed to parse media format"))?;

        let reader = probed.format;
        let track = reader.tracks().iter()
            .find(|t| t.codec_params.codec == CODEC_TYPE_AAC)
            .ok_or_else(|| JsValue::from_str("No AAC track found"))?;

        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2) as u8;
        
        let sample_rate_idx = match sample_rate {
            96000 => 0, 88200 => 1, 64000 => 2, 48000 => 3, 44100 => 4,
            32000 => 5, 24000 => 6, 22050 => 7, 16000 => 8, 12000 => 9,
            11025 => 10, 8000 => 11, _ => 4,
        };

        Ok(AudioExtractor { reader, track_id, sample_rate_idx, channels, pos_ref, total_size })
    }

    pub fn get_progress(&self) -> f64 {
        let pos = self.pos_ref.load(std::sync::atomic::Ordering::SeqCst) as f64;
        (pos / self.total_size as f64) * 100.0
    }

    pub fn pull_chunk(&mut self, max_bytes: usize) -> Uint8Array {
        let mut buffer = Vec::with_capacity(max_bytes);
        while buffer.len() < max_bytes {
            match self.reader.next_packet() {
                Ok(packet) => {
                    if packet.track_id() == self.track_id {
                        let adts = create_adts_header(packet.data.len(), self.sample_rate_idx, self.channels);
                        buffer.extend_from_slice(&adts);
                        buffer.extend_from_slice(&packet.data);
                    }
                }
                _ => break,
            }
        }
        Uint8Array::from(&buffer[..])
    }
}

fn create_adts_header(packet_len: usize, sr_idx: u8, ch: u8) -> [u8; 7] {
    let fl = (packet_len + 7) as u16;
    let mut h = [0u8; 7];
    h[0] = 0xFF; h[1] = 0xF1;
    h[2] = (1 << 6) | (sr_idx << 2) | (ch >> 2);
    h[3] = ((ch & 3) << 6) | ((fl >> 11) as u8);
    h[4] = ((fl >> 3) & 0xFF) as u8;
    h[5] = (((fl & 7) << 5) | 0x1F) as u8;
    h[6] = 0xFC;
    h
}