#!/bin/bash
set -e

FFMPEG_VERSION="8.1"
BUILD_DIR="ffmpeg_build"
LIB_OUT_DIR="$(pwd)/lib"

echo "=== FFmpeg WASM Sandbox Builder ==="

# 1. Setup directories
mkdir -p $BUILD_DIR
mkdir -p $LIB_OUT_DIR

# 2. Download FFmpeg source
if [ ! -d "$BUILD_DIR/ffmpeg-$FFMPEG_VERSION" ]; then
    echo "Downloading FFmpeg $FFMPEG_VERSION..."
    cd $BUILD_DIR
    curl -LO https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
    tar -xf ffmpeg-$FFMPEG_VERSION.tar.xz
    cd ..
fi

# 3. Configure and compile using Emscripten
cd $BUILD_DIR/ffmpeg-$FFMPEG_VERSION

# We must ensure emcc is in the path. The user's terminal session has it.
echo "Configuring FFmpeg for WASM..."

# The magic Emscripten configure wrapper
emconfigure ./configure \
  --cc=emcc \
  --cxx=em++ \
  --ar=emar \
  --ranlib=emranlib \
  --target-os=none \
  --arch=x86_32 \
  --enable-cross-compile \
  --disable-x86asm \
  --disable-inline-asm \
  --disable-stripping \
  --disable-programs \
  --disable-doc \
  --disable-everything \
  --enable-avformat \
  --enable-avcodec \
  --enable-avutil \
  --enable-demuxer=mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,flv,avi,mpegts,flac,wav,mp3,aac \
  --enable-parser=h264,hevc,vp8,vp9,av1,aac,mpegaudio,opus,vorbis \
  --disable-pthreads \
  --disable-w32threads \
  --disable-os2threads \
  --disable-network \
  --disable-hwaccels \
  --disable-decoders \
  --disable-encoders \
  --disable-muxers \
  --disable-filters \
  --disable-swscale \
  --disable-swresample \
  --extra-cflags="-O3 -s USE_PTHREADS=0" \
  --extra-ldflags="-O3"

echo "Compiling FFmpeg static libraries..."
emmake make -j$(nproc)

echo "Copying static libraries to $LIB_OUT_DIR..."
cp libavformat/libavformat.a $LIB_OUT_DIR/
cp libavcodec/libavcodec.a $LIB_OUT_DIR/
cp libavutil/libavutil.a $LIB_OUT_DIR/

echo "Done! Libraries built successfully."
ls -lh $LIB_OUT_DIR
