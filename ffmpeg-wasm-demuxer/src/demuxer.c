#include <stdint.h>
#include <stddef.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavcodec/avcodec.h>
#include <libavutil/mem.h>
#include <libavutil/display.h>

// ============================================================================
// FFmpeg WASM Core Demuxer (FFmpeg 8.1 Compatible)
//
// CRITICAL ARCHITECTURE NOTES (DO NOT REFACTOR OR REMOVE):
//
// 1. JS FUNCTION POINTERS:
//    JS functions (registered via addFunction) are passed here as integer table 
//    indices (int32) and cast to function pointers internally. Do not attempt 
//    to pass typed function pointers across the WASM boundary.
// ============================================================================

// ── JS callback function pointer types ──
// These are function pointers registered via Emscripten's addFunction().
// They point into the WASM function table → JS closures.
typedef int (*js_read_fn)(uint8_t *buf, int buf_size);
typedef int64_t (*js_seek_fn)(int64_t offset, int whence);

// Checks an FFmpeg return code. On failure, stores the human-readable error
// string into demuxer->last_error and immediately returns the error code.
#define FFRET_CHECK(ret, demuxer) \
    if ((ret) < 0) { \
        av_strerror((ret), (demuxer)->last_error, sizeof((demuxer)->last_error)); \
        return (ret); \
    }

typedef struct {
    AVFormatContext *fmt_ctx;
    AVIOContext *avio_ctx;
    int video_stream_idx;
    int audio_stream_idx;
    // JS callbacks stored here so C wrappers can forward to them
    js_read_fn read_callback;
    js_seek_fn seek_callback;
    char last_error[256];      // human-readable FFmpeg error string
} CustomDemuxer;

// Struct to pass back to JS without exposing AVPacket internals
typedef struct {
    uint8_t *data;
    int size;
    int64_t pts;
    int64_t dts;
    int64_t duration;
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
    double rotation; // Degrees (0, 90, 180, 270)
    int32_t display_matrix[9]; // Raw 3x3 transformation matrix
} StreamInfo;

// ── C callback wrappers for FFmpeg ──
// These act as proxy functions. FFmpeg calls these natively in C, and they
// turn around and invoke the JavaScript callbacks via the Emscripten function table.

static int c_read_packet(void *opaque, uint8_t *buf, int buf_size) {
    CustomDemuxer *d = (CustomDemuxer *)opaque;
    if (!d || !d->read_callback) return AVERROR(EINVAL);
    int ret = d->read_callback(buf, buf_size);
    if (ret == 0) return AVERROR_EOF;
    if (ret < 0) return AVERROR(EIO);
    return ret;
}

static int64_t c_seek(void *opaque, int64_t offset, int whence) {
    CustomDemuxer *d = (CustomDemuxer *)opaque;
    if (!d || !d->seek_callback) return AVERROR(EINVAL);
    return d->seek_callback(offset, whence);
}
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

    // Extract Display Rotation & Matrix (mobile portrait video fix)
    info->rotation = 0.0;
    memset(info->display_matrix, 0, sizeof(info->display_matrix));
    
    if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        const AVPacketSideData *sd = av_packet_side_data_get(st->codecpar->coded_side_data, 
                                                             st->codecpar->nb_coded_side_data, 
                                                             AV_PKT_DATA_DISPLAYMATRIX);
        if (sd && sd->size >= 9 * sizeof(int32_t)) {
            info->rotation = av_display_rotation_get((int32_t *)sd->data);
            memcpy(info->display_matrix, sd->data, 9 * sizeof(int32_t));
        }
    }

    return info;
}

// ── Demuxer Lifecycle ──

static CustomDemuxer* init_custom_demuxer(int read_cb_idx, int seek_cb_idx, int buffer_size, int debug_mode) {
    if (debug_mode) {
        av_log_set_level(AV_LOG_INFO);
    } else {
        av_log_set_level(AV_LOG_QUIET);
    }
    CustomDemuxer *demuxer = (CustomDemuxer *)av_mallocz(sizeof(CustomDemuxer));
    if (!demuxer) return NULL;

    demuxer->read_callback = (js_read_fn)(uintptr_t)read_cb_idx;
    demuxer->seek_callback = (js_seek_fn)(uintptr_t)seek_cb_idx;

    int avio_ctx_buffer_size = buffer_size > 0 ? buffer_size : 1048576; // Default to 1MB
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

static int open_demuxer(CustomDemuxer *demuxer) {
    demuxer->last_error[0] = '\0'; // Clear previous errors

    int ret = avformat_open_input(&demuxer->fmt_ctx, NULL, NULL, NULL);
    FFRET_CHECK(ret, demuxer);

    ret = avformat_find_stream_info(demuxer->fmt_ctx, NULL);
    FFRET_CHECK(ret, demuxer);

    demuxer->video_stream_idx = av_find_best_stream(demuxer->fmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    demuxer->audio_stream_idx = av_find_best_stream(demuxer->fmt_ctx, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);

    return 0;
}

// ── Container Metadata ──

static double get_duration(CustomDemuxer *demuxer) {
    if (demuxer->fmt_ctx->duration == AV_NOPTS_VALUE) return -1.0;
    return (double)demuxer->fmt_ctx->duration / (double)AV_TIME_BASE;
}

static int get_stream_count(CustomDemuxer *demuxer) {
    return (int)demuxer->fmt_ctx->nb_streams;
}

// ── Stream Info ──

static StreamInfo* get_video_stream_info(CustomDemuxer *demuxer) {
    if (demuxer->video_stream_idx < 0) return NULL;
    return build_stream_info(demuxer->fmt_ctx->streams[demuxer->video_stream_idx]);
}

static StreamInfo* get_audio_stream_info(CustomDemuxer *demuxer) {
    if (demuxer->audio_stream_idx < 0) return NULL;
    return build_stream_info(demuxer->fmt_ctx->streams[demuxer->audio_stream_idx]);
}

static StreamInfo* get_stream_info_by_index(CustomDemuxer *demuxer, int idx) {
    if (idx < 0 || idx >= (int)demuxer->fmt_ctx->nb_streams) return NULL;
    return build_stream_info(demuxer->fmt_ctx->streams[idx]);
}

static void free_stream_info(StreamInfo *info) {
    if (info) av_freep(&info);
}

// ── Packet Reading ──

static DemuxerPacket* read_next_packet(CustomDemuxer *demuxer) {
    demuxer->last_error[0] = '\0'; // Clear previous errors

    AVPacket *pkt = av_packet_alloc();
    if (!pkt) {
        snprintf(demuxer->last_error, sizeof(demuxer->last_error), "Out of memory: av_packet_alloc failed");
        return NULL;
    }

    int ret = av_read_frame(demuxer->fmt_ctx, pkt);
    if (ret < 0) {
        av_packet_free(&pkt);
        if (ret != AVERROR_EOF) {
            av_strerror(ret, demuxer->last_error, sizeof(demuxer->last_error));
        }
        return NULL; // EOF or Error
    }

    DemuxerPacket *dp = (DemuxerPacket*)av_mallocz(sizeof(DemuxerPacket));
    if (!dp) {
        av_packet_free(&pkt);
        snprintf(demuxer->last_error, sizeof(demuxer->last_error), "Out of memory: DemuxerPacket alloc failed");
        return NULL;
    }
    dp->data = pkt->data;
    dp->size = pkt->size;
    dp->pts = pkt->pts;
    dp->dts = pkt->dts;
    dp->duration = pkt->duration;
    dp->is_keyframe = (pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
    dp->stream_index = pkt->stream_index;
    dp->raw_pkt = pkt; // Store to free later

    return dp;
}

static void free_packet(DemuxerPacket *dp) {
    if (!dp) return;
    if (dp->raw_pkt) {
        av_packet_free(&dp->raw_pkt);
    }
    av_freep(&dp);
}

// ── Seeking ──

static int seek_stream(CustomDemuxer *demuxer, int stream_idx, int64_t timestamp) {
    demuxer->last_error[0] = '\0';
    int ret = av_seek_frame(demuxer->fmt_ctx, stream_idx, timestamp, AVSEEK_FLAG_BACKWARD);
    FFRET_CHECK(ret, demuxer);
    return 0;
}

// ── Cleanup ──

static void free_custom_demuxer(CustomDemuxer *demuxer) {
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

static const char* get_last_error(CustomDemuxer *demuxer) {
    return demuxer->last_error;
}

// ============================================================================
// WASM EXPORT LAYER
//
// These functions are the public API that JavaScript calls directly via
// Emscripten's ccall(). They form a stable, versioned contract between
// the C implementation and the TypeScript wrapper in index.ts.
// ============================================================================

CustomDemuxer* wasm_demuxer_new(int read_cb_idx, int seek_cb_idx, int buffer_size, int debug_mode) {
    return init_custom_demuxer(read_cb_idx, seek_cb_idx, buffer_size, debug_mode);
}

int wasm_demuxer_init(CustomDemuxer *handle) {
    if (!handle) return -1;
    return open_demuxer(handle);
}

double wasm_demuxer_get_duration(CustomDemuxer *handle) {
    if (!handle) return -1.0;
    return get_duration(handle);
}

int wasm_demuxer_get_stream_count(CustomDemuxer *handle) {
    if (!handle) return 0;
    return get_stream_count(handle);
}

StreamInfo* wasm_demuxer_get_video_info(CustomDemuxer *handle) {
    if (!handle) return NULL;
    return get_video_stream_info(handle);
}

StreamInfo* wasm_demuxer_get_audio_info(CustomDemuxer *handle) {
    if (!handle) return NULL;
    return get_audio_stream_info(handle);
}

StreamInfo* wasm_demuxer_get_stream_info(CustomDemuxer *handle, int idx) {
    if (!handle) return NULL;
    return get_stream_info_by_index(handle, idx);
}

void wasm_demuxer_free_stream_info(StreamInfo *info) {
    free_stream_info(info);
}

DemuxerPacket* wasm_demuxer_read_c_packet(CustomDemuxer *handle) {
    if (!handle) return NULL;
    return read_next_packet(handle);
}

void wasm_demuxer_free_c_packet(DemuxerPacket *packet) {
    free_packet(packet);
}

int wasm_demuxer_seek(CustomDemuxer *handle, int stream_idx, int64_t timestamp) {
    if (!handle) return -1;
    return seek_stream(handle, stream_idx, timestamp);
}

const char* wasm_demuxer_get_last_error(CustomDemuxer *handle) {
    if (!handle) return "";
    return get_last_error(handle);
}

void wasm_demuxer_free(CustomDemuxer *handle) {
    if (handle) {
        free_custom_demuxer(handle);
    }
}
