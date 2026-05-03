#include <stdint.h>
#include <stddef.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavcodec/avcodec.h>
#include <libavutil/mem.h>

// ============================================================================
// FFmpeg WASM Core Demuxer (FFmpeg 8.1 Compatible)
//
// CRITICAL ARCHITECTURE NOTES (DO NOT REFACTOR OR REMOVE):
// 
// 1. WHY CALLBACKS ARE IN C: 
//    FFmpeg 8.x changed how it invokes read/seek callbacks internally. If these
//    callbacks are written in Rust (wasm32-unknown-unknown target) and called 
//    from Emscripten-compiled FFmpeg, it triggers a fatal WASM crash:
//    "RuntimeError: null function or function signature mismatch".
//    This happens because Emscripten and Rust encode the `int64_t` signatures 
//    differently in the WASM function table. 
//    FIX: All callbacks MUST remain in this C file so they are compiled by `emcc`.
//
// 2. JS FUNCTION POINTERS:
//    JS functions (registered via addFunction) are passed here as integer table 
//    indices (int32) and cast to function pointers internally. Do not attempt 
//    to pass typed function pointers across the FFI boundary.
// ============================================================================

// ── JS callback function pointer types ──
// These are function pointers registered via Emscripten's addFunction().
// They point into the WASM function table → JS closures.
typedef int (*js_read_fn)(uint8_t *buf, int buf_size);
typedef int (*js_seek_fn)(int offset_hi, int offset_lo, int whence);

typedef struct {
    AVFormatContext *fmt_ctx;
    AVIOContext *avio_ctx;
    int video_stream_idx;
    int audio_stream_idx;
    // JS callbacks stored here so C wrappers can forward to them
    js_read_fn read_callback;
    js_seek_fn seek_callback;
    int32_t *seek_result_buf;  // shared [lo, hi] buffer for 64-bit seek results
    char last_error[256];      // human-readable FFmpeg error string
} CustomDemuxer;

// Struct to pass back to Rust/JS without exposing AVPacket internals
typedef struct {
    uint8_t *data;
    int size;
    int64_t pts;
    int64_t dts;
    int is_keyframe;
    int stream_index;
    AVPacket *raw_pkt;
} DemuxerPacket;

typedef struct {
    int stream_index;
    uint8_t *extradata;
    int extradata_size;
    int codec_id;
    int time_base_num;
    int time_base_den;
    int sample_rate;
    int channels;
    int width;
    int height;
    int bit_rate;
    int codec_type;  // AVMEDIA_TYPE_VIDEO=0, AVMEDIA_TYPE_AUDIO=1, AVMEDIA_TYPE_SUBTITLE=3
} StreamInfo;

// ── C callback wrappers for FFmpeg ──
// These are compiled by emcc (same compiler as FFmpeg), so function table
// signatures always match. This is the fix for the FFmpeg 8.x crash.

static int c_read_packet(void *opaque, uint8_t *buf, int buf_size) {
    CustomDemuxer *d = (CustomDemuxer *)opaque;
    if (!d || !d->read_callback) return 0;
    return d->read_callback(buf, buf_size);
}

static int64_t c_seek(void *opaque, int64_t offset, int whence) {
    CustomDemuxer *d = (CustomDemuxer *)opaque;
    if (!d || !d->seek_callback) return -1;

    int offset_hi = (int)(offset >> 32);
    int offset_lo = (int)(offset & 0xFFFFFFFF);

    int status = d->seek_callback(offset_hi, offset_lo, whence);
    if (status < 0) return -1;

    int64_t lo = (int64_t)(uint32_t)d->seek_result_buf[0];
    int64_t hi = (int64_t)d->seek_result_buf[1];
    return (hi << 32) | lo;
}

// ── Internal helper: populate StreamInfo from any AVStream ──

static StreamInfo* build_stream_info(AVStream *st) {
    if (!st) return NULL;
    StreamInfo *info = (StreamInfo*)av_mallocz(sizeof(StreamInfo));
    if (!info) return NULL;

    info->stream_index   = st->index;
    info->extradata      = st->codecpar->extradata;
    info->extradata_size = st->codecpar->extradata_size;
    info->codec_id       = st->codecpar->codec_id;
    info->time_base_num  = st->time_base.num;
    info->time_base_den  = st->time_base.den;
    info->sample_rate    = st->codecpar->sample_rate;
    info->channels       = st->codecpar->ch_layout.nb_channels;
    info->width          = st->codecpar->width;
    info->height         = st->codecpar->height;
    info->bit_rate       = (int)(st->codecpar->bit_rate / 1000); // kbps
    info->codec_type     = st->codecpar->codec_type;

    return info;
}

// ── Demuxer Lifecycle ──

CustomDemuxer* init_custom_demuxer(int read_cb_idx, int seek_cb_idx, int32_t *seek_result) {
    av_log_set_level(AV_LOG_QUIET);
    CustomDemuxer *demuxer = (CustomDemuxer *)av_mallocz(sizeof(CustomDemuxer));
    if (!demuxer) return NULL;

    demuxer->read_callback = (js_read_fn)(uintptr_t)read_cb_idx;
    demuxer->seek_callback = (js_seek_fn)(uintptr_t)seek_cb_idx;
    demuxer->seek_result_buf = seek_result;

    int avio_ctx_buffer_size = 32768;
    uint8_t *avio_ctx_buffer = (uint8_t *)av_malloc(avio_ctx_buffer_size);
    if (!avio_ctx_buffer) {
        av_freep(&demuxer);
        return NULL;
    }

    // opaque = demuxer itself, so c_read_packet/c_seek can access callbacks
    demuxer->avio_ctx = avio_alloc_context(
        avio_ctx_buffer, avio_ctx_buffer_size,
        0, demuxer,
        &c_read_packet,
        NULL,
        &c_seek
    );

    if (!demuxer->avio_ctx) {
        av_freep(&avio_ctx_buffer);
        av_freep(&demuxer);
        return NULL;
    }

    demuxer->fmt_ctx = avformat_alloc_context();
    if (!demuxer->fmt_ctx) {
        av_freep(&demuxer->avio_ctx->buffer);
        avio_context_free(&demuxer->avio_ctx);
        av_freep(&demuxer);
        return NULL;
    }

    demuxer->fmt_ctx->pb = demuxer->avio_ctx;
    demuxer->video_stream_idx = -1;
    demuxer->audio_stream_idx = -1;

    return demuxer;
}

int open_demuxer(CustomDemuxer *demuxer) {
    if (!demuxer || !demuxer->fmt_ctx) return -1;
    demuxer->last_error[0] = '\0'; // Clear previous errors

    int ret = avformat_open_input(&demuxer->fmt_ctx, NULL, NULL, NULL);
    if (ret < 0) {
        av_strerror(ret, demuxer->last_error, sizeof(demuxer->last_error));
        return ret;
    }

    ret = avformat_find_stream_info(demuxer->fmt_ctx, NULL);
    if (ret < 0) {
        av_strerror(ret, demuxer->last_error, sizeof(demuxer->last_error));
        return ret;
    }

    demuxer->video_stream_idx = av_find_best_stream(demuxer->fmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    demuxer->audio_stream_idx = av_find_best_stream(demuxer->fmt_ctx, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);

    return 0;
}

// ── Container Metadata ──

double get_duration(CustomDemuxer *demuxer) {
    if (!demuxer || !demuxer->fmt_ctx) return -1.0;
    if (demuxer->fmt_ctx->duration == AV_NOPTS_VALUE) return -1.0;
    return (double)demuxer->fmt_ctx->duration / (double)AV_TIME_BASE;
}

int get_stream_count(CustomDemuxer *demuxer) {
    if (!demuxer || !demuxer->fmt_ctx) return 0;
    return (int)demuxer->fmt_ctx->nb_streams;
}

// ── Stream Info ──

StreamInfo* get_video_stream_info(CustomDemuxer *demuxer) {
    if (!demuxer || demuxer->video_stream_idx < 0) return NULL;
    return build_stream_info(demuxer->fmt_ctx->streams[demuxer->video_stream_idx]);
}

StreamInfo* get_audio_stream_info(CustomDemuxer *demuxer) {
    if (!demuxer || demuxer->audio_stream_idx < 0) return NULL;
    return build_stream_info(demuxer->fmt_ctx->streams[demuxer->audio_stream_idx]);
}

StreamInfo* get_stream_info_by_index(CustomDemuxer *demuxer, int idx) {
    if (!demuxer || !demuxer->fmt_ctx) return NULL;
    if (idx < 0 || idx >= (int)demuxer->fmt_ctx->nb_streams) return NULL;
    return build_stream_info(demuxer->fmt_ctx->streams[idx]);
}

void free_stream_info(StreamInfo *info) {
    if (info) av_freep(&info);
}

// ── Packet Reading ──

DemuxerPacket* read_next_packet(CustomDemuxer *demuxer) {
    if (!demuxer || !demuxer->fmt_ctx) return NULL;
    demuxer->last_error[0] = '\0'; // Clear previous errors

    AVPacket *pkt = av_packet_alloc();
    if (!pkt) return NULL;

    int ret = av_read_frame(demuxer->fmt_ctx, pkt);
    if (ret < 0) {
        av_packet_free(&pkt);
        if (ret != AVERROR_EOF) {
            av_strerror(ret, demuxer->last_error, sizeof(demuxer->last_error));
        }
        return NULL; // EOF or Error
    }

    DemuxerPacket *dp = (DemuxerPacket*)av_mallocz(sizeof(DemuxerPacket));
    dp->data = pkt->data;
    dp->size = pkt->size;
    dp->pts = pkt->pts;
    dp->dts = pkt->dts;
    dp->is_keyframe = (pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
    dp->stream_index = pkt->stream_index;
    dp->raw_pkt = pkt; // Store to free later

    return dp;
}

void free_packet(DemuxerPacket *dp) {
    if (!dp) return;
    if (dp->raw_pkt) {
        av_packet_free(&dp->raw_pkt);
    }
    av_freep(&dp);
}

// ── Seeking ──

int seek_to_keyframe(CustomDemuxer *demuxer, int stream_idx, int64_t timestamp) {
    if (!demuxer || !demuxer->fmt_ctx) return -1;
    return av_seek_frame(demuxer->fmt_ctx, stream_idx, timestamp, AVSEEK_FLAG_BACKWARD);
}

// ── Cleanup ──

void free_custom_demuxer(CustomDemuxer *demuxer) {
    if (!demuxer) return;
    if (demuxer->fmt_ctx) {
        avformat_close_input(&demuxer->fmt_ctx);
    }
    if (demuxer->avio_ctx) {
        av_freep(&demuxer->avio_ctx->buffer);
        avio_context_free(&demuxer->avio_ctx);
    }
    av_freep(&demuxer);
}

// ── Error Handling ──

const char* get_last_error(CustomDemuxer *demuxer) {
    if (!demuxer) return "";
    return demuxer->last_error;
}
