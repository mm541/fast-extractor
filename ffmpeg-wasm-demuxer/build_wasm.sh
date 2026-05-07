#!/bin/bash
set -e

FFMPEG_INCLUDE="ffmpeg_build/ffmpeg-8.1"

echo "Compiling C demuxer directly with Emscripten (no Rust)..."

emcc src/demuxer.c \
  lib/libavformat.a \
  lib/libavcodec.a \
  lib/libavutil.a \
  -I "$FFMPEG_INCLUDE" \
  -o pkg/ffmpeg_demuxer.js \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createDemuxerModule" \
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','addFunction','HEAPU8','wasmMemory','getValue','UTF8ToString','removeFunction']" \
  -s EXPORTED_FUNCTIONS="[
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
  -s WASM_BIGINT=1 \
  -s FILESYSTEM=0 \
  -s SINGLE_FILE=1 \
  -O3

echo "Done! WASM bundle available in pkg/"
