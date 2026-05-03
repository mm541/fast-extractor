#!/bin/bash
set -e

echo "Building Rust staticlib..."
cargo build --target wasm32-unknown-unknown --release

echo "Linking with Emscripten..."
emcc target/wasm32-unknown-unknown/release/libffmpeg_wasm_core.a \
  lib/libavformat.a \
  lib/libavcodec.a \
  lib/libavutil.a \
  -o pkg/ffmpeg_core.js \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createFFmpegModule" \
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','addFunction','HEAPU8','wasmMemory','getValue','UTF8ToString']" \
  -s EXPORTED_FUNCTIONS="[
    '_wasm_get_seek_result_ptr',
    '_wasm_demuxer_new', 
    '_wasm_demuxer_init', 
    '_wasm_demuxer_free',
    '_wasm_demuxer_get_duration',
    '_wasm_demuxer_get_stream_count',
    '_wasm_demuxer_get_video_info',
    '_wasm_demuxer_get_audio_info',
    '_wasm_demuxer_get_stream_info',
    '_wasm_demuxer_free_stream_info',
    '_wasm_demuxer_read_c_packet',
    '_wasm_demuxer_free_c_packet',
    '_wasm_demuxer_seek',
    '_wasm_demuxer_get_last_error'
  ]" \
  -s ALLOW_TABLE_GROWTH=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3

echo "Done! WASM bundle available in pkg/"
