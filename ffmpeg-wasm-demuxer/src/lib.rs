use std::ffi::c_void;

// ============================================================================
// FFmpeg WASM Core - Rust FFI Layer
//
// CRITICAL ARCHITECTURE NOTES (DO NOT REFACTOR OR REMOVE):
//
// 1. ZERO RUST HEAP ALLOCATION:
//    This library is compiled with `wasm32-unknown-unknown` and linked against
//    Emscripten's C libraries. Rust uses its own `dlmalloc` allocator, which is
//    COMPLETELY SEPARATE from Emscripten's heap.
//    If you allocate memory in Rust (e.g., using `Box`, `Vec`, `String`), it 
//    will be placed in Rust's hidden heap. When JS or Emscripten tries to read 
//    that pointer, it will result in "memory access out of bounds" or garbage data.
//    FIX: This file must remain a pure pass-through. ALL memory must be allocated
//    by C (`av_mallocz`) and passed around as raw raw pointers (`*mut c_void`).
//
// 2. SAFE 64-BIT TRANSFERS:
//    Native `i64` can cause ABI signature mismatches across the FFI boundary. 
//    64-bit values (like seek offsets) are safely passed by splitting them into
//    two 32-bit integers (`hi` and `lo`) and reconstructing them in C/JS.
// ============================================================================

// ── SEEK RESULT BUFFER ───────────────────────────────────────────────
//
// Shared buffer for 64-bit seek results. The C-side c_seek() reads from
// this after the JS callback writes to it. Safe because WASM is single-threaded.

static mut SEEK_RESULT: [i32; 2] = [0, 0]; // [lo, hi]

// ── C-API FFI ────────────────────────────────────────────────────────

// Opaque pointer to CustomDemuxer (C-side, allocated by av_mallocz)
type DemuxerPtr = *mut c_void;

#[repr(C)]
pub struct StreamInfoC {
    pub stream_index: i32,
    pub extradata: *const u8,
    pub extradata_size: i32,
    pub codec_id: i32,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub sample_rate: i32,
    pub channels: i32,
    pub width: i32,
    pub height: i32,
    pub bit_rate: i32,
    pub codec_type: i32,
}

#[repr(C)]
pub struct DemuxerPacketC {
    pub data: *const u8,
    pub size: i32,
    pub pts: i64,
    pub dts: i64,
    pub is_keyframe: i32,
    pub stream_index: i32,
    _raw_pkt: *mut c_void, // Opaque AVPacket*
}

unsafe extern "C" {
    fn init_custom_demuxer(read_cb_idx: i32, seek_cb_idx: i32, seek_result: *mut i32) -> DemuxerPtr;
    fn open_demuxer(demuxer: DemuxerPtr) -> i32;
    fn get_duration(demuxer: DemuxerPtr) -> f64;
    fn get_stream_count(demuxer: DemuxerPtr) -> i32;
    fn get_video_stream_info(demuxer: DemuxerPtr) -> *mut StreamInfoC;
    fn get_audio_stream_info(demuxer: DemuxerPtr) -> *mut StreamInfoC;
    fn get_stream_info_by_index(demuxer: DemuxerPtr, idx: i32) -> *mut StreamInfoC;
    fn free_stream_info(info: *mut StreamInfoC);
    fn read_next_packet(demuxer: DemuxerPtr) -> *mut DemuxerPacketC;
    fn free_packet(dp: *mut DemuxerPacketC);
    fn seek_to_keyframe(demuxer: DemuxerPtr, stream_idx: i32, timestamp: i64) -> i32;
    fn get_last_error(demuxer: DemuxerPtr) -> *const u8;
    fn free_custom_demuxer(demuxer: DemuxerPtr);
}

// ── EMSCRIPTEN C-API EXPORTS ──────────────────────────────────────
//
// All functions are thin passthroughs to C. No Rust heap allocation.
// The DemuxerPtr is a raw C pointer (av_mallocz'd) passed directly to/from JS.

/// Returns a pointer to the 8-byte shared seek result buffer.
/// JS must write [lo, hi] i32 pair here before returning from the seek callback.
#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_seek_result_ptr() -> *mut i32 {
    std::ptr::addr_of_mut!(SEEK_RESULT) as *mut i32
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_new(read_cb_idx: i32, seek_cb_idx: i32) -> DemuxerPtr {
    let seek_result_ptr = std::ptr::addr_of_mut!(SEEK_RESULT) as *mut i32;
    unsafe { init_custom_demuxer(read_cb_idx, seek_cb_idx, seek_result_ptr) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_init(handle: DemuxerPtr) -> i32 {
    if handle.is_null() { return -1; }
    unsafe { open_demuxer(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_get_duration(handle: DemuxerPtr) -> f64 {
    if handle.is_null() { return -1.0; }
    unsafe { get_duration(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_get_stream_count(handle: DemuxerPtr) -> i32 {
    if handle.is_null() { return 0; }
    unsafe { get_stream_count(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_get_video_info(handle: DemuxerPtr) -> *mut StreamInfoC {
    if handle.is_null() { return std::ptr::null_mut(); }
    unsafe { get_video_stream_info(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_get_audio_info(handle: DemuxerPtr) -> *mut StreamInfoC {
    if handle.is_null() { return std::ptr::null_mut(); }
    unsafe { get_audio_stream_info(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_get_stream_info(handle: DemuxerPtr, idx: i32) -> *mut StreamInfoC {
    if handle.is_null() { return std::ptr::null_mut(); }
    unsafe { get_stream_info_by_index(handle, idx) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_read_c_packet(handle: DemuxerPtr) -> *mut DemuxerPacketC {
    if handle.is_null() { return std::ptr::null_mut(); }
    unsafe { read_next_packet(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_free_c_packet(packet: *mut DemuxerPacketC) {
    unsafe { free_packet(packet) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_free_stream_info(info: *mut StreamInfoC) {
    unsafe { free_stream_info(info) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_seek(handle: DemuxerPtr, stream_idx: i32, timestamp_hi: i32, timestamp_lo: i32) -> i32 {
    if handle.is_null() { return -1; }
    let timestamp = ((timestamp_hi as i64) << 32) | ((timestamp_lo as i64) & 0xFFFFFFFF);
    unsafe { seek_to_keyframe(handle, stream_idx, timestamp) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_get_last_error(handle: DemuxerPtr) -> *const u8 {
    if handle.is_null() { return std::ptr::null(); }
    unsafe { get_last_error(handle) }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_demuxer_free(handle: DemuxerPtr) {
    if !handle.is_null() {
        unsafe { free_custom_demuxer(handle) }
    }
}
