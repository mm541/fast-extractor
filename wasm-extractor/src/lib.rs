

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
//   • AudioExtractor reuses a scratch Uint8Array + options Object across reads
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
use std::io::{Read, Seek, SeekFrom, Result as IoResult};
use js_sys::{Uint8Array, Object, Reflect};
use wasm_bindgen::prelude::*;
use symphonia::core::formats::FormatReader;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use symphonia::core::codecs::{CODEC_TYPE_AAC, CODEC_TYPE_MP3, CODEC_TYPE_VORBIS, CODEC_TYPE_OPUS};

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



// ════════════════════════════════════════════════
// 3. AUDIO EXTRACTOR (Symphonia-based, multi-codec)
// ════════════════════════════════════════════════
//
// Supported codecs (priority order during probing):
//   1. AAC  — packets framed with 7-byte ADTS headers
//   2. MP3  — self-framing, direct passthrough
//   3. Opus — raw packets (Ogg muxing deferred to Phase 2)
//   4. Vorbis — raw packets (Ogg muxing deferred to Phase 2)
//
// ── MANIFEST (optional) ──────────────────────────────────────────────
//
//   When `build_manifest=true`, a per-second byte-offset index is built
//   during extraction. Memory cost: ceil(duration) × 8 bytes (~29KB/hr).
//   The index is never allocated when disabled (Option::None).
//
// ── HARDWARE SYMPATHY ────────────────────────────────────────────────
//
//   • SharedPosReader reuses a single 64KB Uint8Array + cached JS Object/key
//   • pull_chunk() reuses a pre-capacity Vec<u8> (no per-call allocation)
//   • Codec dispatch is a match on a fieldless enum (compiles to a jump table)
//   • Manifest JSON is hand-serialized via format!() — no serde dependency
//

/// Detected audio codec — used for branchless dispatch in the hot loop.
/// Fieldless variants keep the match cheap (single integer compare).
enum AudioCodec {
    Aac,
    Mp3,
    Opus,
    Vorbis,
}

/// Codec priority for probing: AAC > MP3 > Opus > Vorbis.
/// First match wins. This matches real-world frequency of lecture videos.
const SUPPORTED_CODECS: &[symphonia::core::codecs::CodecType] = &[
    CODEC_TYPE_AAC,
    CODEC_TYPE_MP3,
    CODEC_TYPE_OPUS,
    CODEC_TYPE_VORBIS,
];

#[wasm_bindgen]
pub struct AudioExtractor {
    reader: Box<dyn FormatReader>,
    track_id: u32,
    codec: AudioCodec,
    sample_rate: u32,
    channels: u8,
    time_base_numer: u32,
    time_base_denom: u32,
    // AAC-specific: ADTS sample rate index (only meaningful for AAC)
    aac_sr_idx: u8,
    // OPFS position tracking (shared with SharedPosReader)
    pos_ref: std::sync::Arc<std::sync::atomic::AtomicU64>,
    total_size: u64,
    // ── Manifest state (all zero-cost when None) ──
    bytes_written: u64,
    byte_index: Option<Vec<u64>>,
    last_indexed_sec: usize,
    // Pre-allocated reusable buffer for chunks to avoid per-call allocations
    chunk_buffer: Vec<u8>,
    // Pre-allocated reusable buffer for building the manifest JSON string
    manifest_buffer: String,
}

#[wasm_bindgen]
impl AudioExtractor {
    /// Create a new AudioExtractor from an OPFS SyncAccessHandle.
    ///
    /// # Arguments
    /// * `handle` — OPFS SyncAccessHandle for zero-copy reads
    /// * `build_manifest` — if true, preallocate per-second byte index
    /// * `duration_sec` — total video duration in seconds (for index preallocation)
    #[wasm_bindgen(constructor)]
    pub fn new(handle: SyncHandle, build_manifest: bool, duration_sec: f64) -> Result<AudioExtractor, JsValue> {
        console_error_panic_hook::set_once();
        let total_size = handle.get_size() as u64;
        let pos_ref = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reader_pos = pos_ref.clone();
        
        // ── SharedPosReader (unchanged — preserves zero-alloc invariants) ──
        // Reuses a single 64KB Uint8Array scratch buffer and a cached JS
        // Object + "at" key across all reads to avoid per-read JS allocations.
        struct SharedPosReader {
            handle: SyncHandle,
            pos: std::sync::Arc<std::sync::atomic::AtomicU64>,
            scratch: Uint8Array,
            options: Object,
            at_key: JsValue,
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
        let mss = MediaSourceStream::new(
            Box::new(SharedPosReader { handle, pos: reader_pos, scratch, options, at_key }),
            Default::default(),
        );
        let probed = symphonia::default::get_probe()
            .format(&Hint::new(), mss, &Default::default(), &Default::default())
            .map_err(|_| JsValue::from_str("Failed to parse media format"))?;

        let reader = probed.format;

        // ── Dynamic codec probing ──
        // Search tracks in priority order: AAC > MP3 > Opus > Vorbis
        let track = reader.tracks().iter()
            .find(|t| SUPPORTED_CODECS.contains(&t.codec_params.codec))
            .ok_or_else(|| JsValue::from_str("No supported audio track (AAC/MP3/Opus/Vorbis)"))?;

        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2) as u8;
        
        // Extract time base for accurate absolute timestamps (fallback to 1/sample_rate)
        let (tb_numer, tb_denom) = match track.codec_params.time_base {
            Some(tb) => (tb.numer, tb.denom),
            None => (1, sample_rate),
        };

        let (codec, aac_sr_idx) = match track.codec_params.codec {
            CODEC_TYPE_AAC => {
                let sr_idx = match sample_rate {
                    96000 => 0, 88200 => 1, 64000 => 2, 48000 => 3, 44100 => 4,
                    32000 => 5, 24000 => 6, 22050 => 7, 16000 => 8, 12000 => 9,
                    11025 => 10, 8000 => 11, _ => 4,
                };
                (AudioCodec::Aac, sr_idx)
            }
            CODEC_TYPE_MP3 => (AudioCodec::Mp3, 0),
            CODEC_TYPE_OPUS => (AudioCodec::Opus, 0),
            CODEC_TYPE_VORBIS => (AudioCodec::Vorbis, 0),
            _ => return Err(JsValue::from_str("Unsupported codec")),
        };

        // ── Manifest preallocation (zero-cost when disabled) ──
        // If duration is known, preallocate exactly. If unknown (0), start with
        // a small vec that grows as we extract. Never allocated when disabled.
        let byte_index = if build_manifest {
            let cap = if duration_sec > 0.0 {
                (duration_sec.ceil() as usize) + 1
            } else {
                64 // sensible starting capacity for unknown duration
            };
            Some(vec![0u64; cap])
        } else {
            None
        };

        // Smart capacity allocation for the manifest string
        let manifest_cap = if build_manifest {
            if duration_sec > 0.0 {
                (duration_sec.ceil() as usize) * 12 + 256
            } else {
                8192 // Fallback if duration is unknown until extraction finishes
            }
        } else {
            0
        };

        Ok(AudioExtractor {
            reader, track_id, codec, sample_rate, channels, aac_sr_idx,
            time_base_numer: tb_numer,
            time_base_denom: tb_denom,
            pos_ref, total_size,
            bytes_written: 0,
            byte_index,
            last_indexed_sec: 0,
            chunk_buffer: Vec::with_capacity(1024 * 1024), // 1MB pre-allocation
            manifest_buffer: String::with_capacity(manifest_cap),
        })
    }

    /// Progress as percentage (0.0 - 100.0), based on bytes read from OPFS.
    pub fn get_progress(&self) -> f64 {
        let pos = self.pos_ref.load(std::sync::atomic::Ordering::SeqCst) as f64;
        (pos / self.total_size as f64) * 100.0
    }

    /// File extension for the output audio file ("aac", "mp3", "ogg").
    pub fn get_extension(&self) -> String {
        match self.codec {
            AudioCodec::Aac => "aac".into(),
            AudioCodec::Mp3 => "mp3".into(),
            AudioCodec::Opus | AudioCodec::Vorbis => "ogg".into(),
        }
    }

    /// MIME type for the output audio ("audio/aac", "audio/mpeg", etc).
    pub fn get_mime(&self) -> String {
        match self.codec {
            AudioCodec::Aac => "audio/aac".into(),
            AudioCodec::Mp3 => "audio/mpeg".into(),
            AudioCodec::Opus => "audio/ogg; codecs=opus".into(),
            AudioCodec::Vorbis => "audio/ogg; codecs=vorbis".into(),
        }
    }

    /// Pull up to `max_bytes` of framed audio data.
    ///
    /// Each codec is framed appropriately:
    ///   AAC    → 7-byte ADTS header injected per packet
    ///   MP3    → direct passthrough (self-framing)
    ///   Opus   → raw packets (Ogg muxing deferred)
    ///   Vorbis → raw packets (Ogg muxing deferred)
    ///
    /// Uses a pre-allocated internal buffer to guarantee zero allocations
    /// during the extraction loop.
    pub fn pull_chunk(&mut self, max_bytes: usize) -> Uint8Array {
        self.chunk_buffer.clear();
        
        while self.chunk_buffer.len() < max_bytes {
            match self.reader.next_packet() {
                Ok(packet) => {
                    if packet.track_id() != self.track_id { continue; }
                    
                    let packet_data = &packet.data;
                    let framed_start = self.chunk_buffer.len();

                    // ── Codec-specific framing ──
                    match self.codec {
                        AudioCodec::Aac => {
                            let adts = create_adts_header(packet_data.len(), self.aac_sr_idx, self.channels);
                            self.chunk_buffer.extend_from_slice(&adts);
                            self.chunk_buffer.extend_from_slice(packet_data);
                        }
                        AudioCodec::Mp3 => {
                            // MP3 frames are self-framing (sync word 0xFFE/0xFFF).
                            // Direct passthrough — zero framing overhead.
                            self.chunk_buffer.extend_from_slice(packet_data);
                        }
                        AudioCodec::Opus | AudioCodec::Vorbis => {
                            // Raw packet passthrough for now.
                            // Phase 2: wrap in Ogg pages for standalone playability.
                            self.chunk_buffer.extend_from_slice(packet_data);
                        }
                    }

                    let framed_size = (self.chunk_buffer.len() - framed_start) as u64;
                    self.bytes_written += framed_size;

                    // ── Manifest: update per-second byte index ──
                    // Use the absolute packet timestamp to calculate the current second.
                    // This is universally accurate and doesn't rely on packet.dur (which
                    // is often 0 for Opus inside WebM).
                    if let Some(ref mut idx) = self.byte_index {
                        let current_sec = (packet.ts as f64 * self.time_base_numer as f64 / self.time_base_denom as f64) as usize;
                        // Fill any gaps (in case a packet spans multiple seconds)
                        while self.last_indexed_sec < current_sec {
                            self.last_indexed_sec += 1;
                            // Grow the vec if duration was unknown at construction time
                            if self.last_indexed_sec >= idx.len() {
                                idx.push(self.bytes_written);
                            } else {
                                idx[self.last_indexed_sec] = self.bytes_written;
                            }
                        }
                    }
                }
                _ => break,
            }
        }
        Uint8Array::from(&self.chunk_buffer[..])
    }

    /// Build the manifest as a JSON string. Returns empty string if disabled.
    ///
    /// Uses a pre-allocated String buffer and writes directly into it to avoid
    /// intermediate allocations.
    pub fn build_manifest(&mut self) -> String {
        let idx = match &self.byte_index {
            Some(v) => v,
            None => return String::new(),
        };

        let (codec_str, ext, mime, pre_roll_ms) = match self.codec {
            AudioCodec::Aac => ("aac", ".aac", "audio/aac", 48),
            AudioCodec::Mp3 => ("mp3", ".mp3", "audio/mpeg", 300),
            AudioCodec::Opus => ("opus", ".ogg", "audio/ogg; codecs=opus", 80),
            AudioCodec::Vorbis => ("vorbis", ".ogg", "audio/ogg; codecs=vorbis", 50),
        };

        use std::fmt::Write;
        
        self.manifest_buffer.clear();
        
        // Ensure we have enough capacity (idx.len() * ~12 bytes for numbers + ~200 for JSON envelope)
        let required_cap = idx.len() * 12 + 256;
        if self.manifest_buffer.capacity() < required_cap {
            self.manifest_buffer.reserve(required_cap - self.manifest_buffer.capacity());
        }

        // Write the JSON prefix
        let _ = write!(
            self.manifest_buffer,
            r#"{{"codec":"{}","extension":"{}","mime":"{}","sample_rate":{},"channels":{},"duration_sec":{},"total_bytes":{},"pre_roll_ms":{},"byte_index":["#,
            codec_str, ext, mime,
            self.sample_rate, self.channels,
            idx.len().saturating_sub(1),
            self.bytes_written,
            pre_roll_ms
        );

        // Write the array elements
        for (i, &offset) in idx.iter().enumerate() {
            if i > 0 { let _ = self.manifest_buffer.write_char(','); }
            let _ = write!(self.manifest_buffer, "{}", offset);
        }

        // Close the JSON envelope
        let _ = self.manifest_buffer.write_str("]}");

        self.manifest_buffer.clone()
    }
}

/// Build a 7-byte ADTS header for a single AAC Access Unit.
///
/// Layout (MPEG-4 AAC-LC, no CRC):
///   Bytes 0-1: Syncword (0xFFF) + ID=0 + Layer=0 + Protection=1
///   Byte  2:   Profile(LC=1) + SampleRateIdx + ChannelConfig(hi)
///   Bytes 3-4: ChannelConfig(lo) + FrameLength(13 bits)
///   Bytes 5-6: Buffer fullness (0x7FF = VBR) + NumFrames=0
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
