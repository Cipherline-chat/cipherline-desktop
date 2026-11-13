#define _GNU_SOURCE
#include "capture.h"
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <spa/param/video/format-utils.h>
#include <spa/param/video/type-info.h>
#include <spa/param/props.h>
#include <spa/debug/types.h>
#include <spa/pod/builder.h>
#include <pipewire/pipewire.h>

/* Resolve the pw_* entry points at run time. The declarations come from the (MIT) headers; the typeof trick keeps the signatures exact. */
#define PW_SYMS(X) \
    X(pw_init) X(pw_main_loop_new) X(pw_main_loop_get_loop) X(pw_main_loop_run) X(pw_main_loop_quit) X(pw_main_loop_destroy) \
    X(pw_context_new) X(pw_context_connect_fd) X(pw_context_connect) X(pw_context_destroy) X(pw_core_disconnect) \
    X(pw_stream_new) X(pw_stream_add_listener) X(pw_stream_connect) X(pw_stream_dequeue_buffer) X(pw_stream_queue_buffer) \
    X(pw_stream_update_params) X(pw_stream_destroy) X(pw_stream_disconnect) X(pw_properties_new_string)
#define X(n) typedef __typeof__(&n) t_##n; static t_##n p_##n;
PW_SYMS(X)
#undef X
#define pw_init p_pw_init
#define pw_main_loop_new p_pw_main_loop_new
#define pw_main_loop_get_loop p_pw_main_loop_get_loop
#define pw_main_loop_run p_pw_main_loop_run
#define pw_main_loop_quit p_pw_main_loop_quit
#define pw_main_loop_destroy p_pw_main_loop_destroy
#define pw_context_new p_pw_context_new
#define pw_context_connect_fd p_pw_context_connect_fd
#define pw_context_connect p_pw_context_connect
#define pw_context_destroy p_pw_context_destroy
#define pw_core_disconnect p_pw_core_disconnect
#define pw_stream_new p_pw_stream_new
#define pw_stream_add_listener p_pw_stream_add_listener
#define pw_stream_connect p_pw_stream_connect
#define pw_stream_dequeue_buffer p_pw_stream_dequeue_buffer
#define pw_stream_queue_buffer p_pw_stream_queue_buffer
#define pw_stream_update_params p_pw_stream_update_params
#define pw_stream_destroy p_pw_stream_destroy
#define pw_stream_disconnect p_pw_stream_disconnect
#define pw_properties_new_string p_pw_properties_new_string

static int load_pw(char *err, size_t errlen) {
    static int loaded;
    if (loaded) return 0;
    void *h = dlopen("libpipewire-0.3.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!h) { snprintf(err, errlen, "PipeWire is not available (libpipewire-0.3.so.0 could not be loaded)"); return -1; }
#define X(n) if (!(p_##n = (t_##n)dlsym(h, #n))) { snprintf(err, errlen, "libpipewire is missing %s", #n); return -1; }
    PW_SYMS(X)
#undef X
    loaded = 1; return 0;
}

#define MAX_WATCH 4
struct Capture {
    struct pw_main_loop *loop; struct pw_context *ctx; struct pw_core *core; struct pw_stream *stream;
    struct spa_hook core_hook, stream_hook;
    struct spa_source *timer, *io[MAX_WATCH]; int io_which[MAX_WATCH], nio;
    CapCallbacks cb; void *u; int max_fps;
    struct spa_video_info_raw vi; int have_format, streaming, ended;
    uint32_t last_w, last_h, last_pix; uint64_t paused_since;
};

static uint64_t now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000 + (uint64_t)t.tv_nsec / 1000; }

static void end_once(Capture *c, const char *why) { if (c->ended) return; c->ended = 1; c->cb.on_end(c->u, why); pw_main_loop_quit(c->loop); }

static void on_core_error(void *d, uint32_t id, int seq, int res, const char *msg) {
    Capture *c = d; (void)seq;
    if (id == PW_ID_CORE && (res == -EPIPE || res == -ECONNRESET)) end_once(c, "PipeWire connection lost");
    else if (id == PW_ID_CORE) end_once(c, msg ? msg : "PipeWire core error");
}
static const struct pw_core_events core_events = { PW_VERSION_CORE_EVENTS, .error = on_core_error };

static void on_state(void *d, enum pw_stream_state old, enum pw_stream_state st, const char *error) {
    Capture *c = d; (void)old;
    fprintf(stderr, "{\"event\":\"pw_state\",\"state\":%d,\"was\":%d}\n", (int)st, (int)old);
    if (st == PW_STREAM_STATE_STREAMING) { c->streaming = 1; c->paused_since = 0; }
    else if (st == PW_STREAM_STATE_PAUSED && c->streaming) c->paused_since = now_us();   /* a vanished/stopped source pauses the consumer; see on_timer */
    else if (st == PW_STREAM_STATE_ERROR) end_once(c, error ? error : "PipeWire stream error");
    else if (st == PW_STREAM_STATE_UNCONNECTED && c->streaming) end_once(c, "the screen source went away (stopped by the compositor or the portal)");
}

static void on_param(void *d, uint32_t id, const struct spa_pod *param) {
    Capture *c = d;
    if (!param || id != SPA_PARAM_Format) return;
    uint32_t mt, mst;
    if (spa_format_parse(param, &mt, &mst) < 0 || mt != SPA_MEDIA_TYPE_video || mst != SPA_MEDIA_SUBTYPE_raw) return;
    if (spa_format_video_raw_parse(param, &c->vi) < 0) return;
    uint32_t pix = 0;
    switch (c->vi.format) {
        case SPA_VIDEO_FORMAT_BGRx: case SPA_VIDEO_FORMAT_BGRA: pix = CL_PIX_BGRX; break;
        case SPA_VIDEO_FORMAT_RGBx: case SPA_VIDEO_FORMAT_RGBA: pix = CL_PIX_RGBX; break;
        default: end_once(c, "PipeWire negotiated an unsupported pixel format"); return;
    }
    c->have_format = 1; c->last_pix = pix;
    c->cb.on_format(c->u, (int)c->vi.size.width, (int)c->vi.size.height, pix);
    uint8_t buf[512]; struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof buf);
    const struct spa_pod *params[1];
    params[0] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
        SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd)));
    pw_stream_update_params(c->stream, params, 1);
}

static void on_process(void *d) {
    Capture *c = d;
    struct pw_buffer *b = pw_stream_dequeue_buffer(c->stream), *n;
    if (!b) return;
    while ((n = pw_stream_dequeue_buffer(c->stream)) != NULL) { pw_stream_queue_buffer(c->stream, b); b = n; }   /* newest wins: never queue latency */
    struct spa_buffer *sb = b->buffer;
    if (getenv("CL_CAP_DEBUG")) { static int n; if (n++ < 8) fprintf(stderr, "{\"debug\":\"process\",\"n_datas\":%u,\"type\":%u,\"data\":%d,\"chunk_size\":%u,\"maxsize\":%u,\"stride\":%d,\"have_format\":%d}\n", sb->n_datas, sb->n_datas ? sb->datas[0].type : 0, sb->n_datas && sb->datas[0].data != NULL, sb->n_datas && sb->datas[0].chunk ? sb->datas[0].chunk->size : 0, sb->n_datas ? sb->datas[0].maxsize : 0, sb->n_datas && sb->datas[0].chunk ? sb->datas[0].chunk->stride : 0, c->have_format); }
    if (c->have_format && sb->n_datas > 0 && sb->datas[0].data && sb->datas[0].chunk && sb->datas[0].chunk->size > 0 && !(sb->datas[0].chunk->flags & SPA_CHUNK_FLAG_CORRUPTED)) {
        int w = (int)c->vi.size.width, h = (int)c->vi.size.height, stride = sb->datas[0].chunk->stride > 0 ? sb->datas[0].chunk->stride : w * 4;
        const uint8_t *p = (const uint8_t *)sb->datas[0].data + sb->datas[0].chunk->offset;
        struct spa_meta_region *crop = spa_buffer_find_meta_data(sb, SPA_META_VideoCrop, sizeof *crop);
        if (crop && crop->region.size.width > 0 && crop->region.size.height > 0 &&
            (int)crop->region.position.x + (int)crop->region.size.width <= w && (int)crop->region.position.y + (int)crop->region.size.height <= h &&
            ((int)crop->region.size.width != w || (int)crop->region.size.height != h)) {
            p += (size_t)crop->region.position.y * (size_t)stride + (size_t)crop->region.position.x * 4;
            w = (int)crop->region.size.width; h = (int)crop->region.size.height;
        }
        if ((int)c->last_w != w || (int)c->last_h != h) { c->last_w = (uint32_t)w; c->last_h = (uint32_t)h; c->cb.on_format(c->u, w, h, c->last_pix); }
        if ((size_t)stride * (size_t)h <= sb->datas[0].maxsize) {
            CapFrame f = { p, w, h, stride, c->last_pix, now_us() };
            c->cb.on_frame(c->u, &f);
        }
    }
    pw_stream_queue_buffer(c->stream, b);
}
static const struct pw_stream_events stream_events = { PW_VERSION_STREAM_EVENTS, .state_changed = on_state, .param_changed = on_param, .process = on_process };

static void on_timer(void *d, uint64_t exp) {
    (void)exp; Capture *c = d;
    /* A static screen produces no frames but stays STREAMING; a source that is gone (window closed, output removed, compositor stopped it
       without closing the portal session) drops to PAUSED and stays there. 3 s of grace covers a renegotiation. */
    if (c->paused_since && now_us() - c->paused_since > 3000000) { end_once(c, "the screen source stopped (the stream stayed paused for 3 s)"); return; }
    c->cb.on_tick(c->u);
}
/* spa io callbacks carry one user pointer; give each watch its own small context */
typedef struct { Capture *c; int which; } WatchCtx;
static void on_io_ctx(void *d, int fd, uint32_t mask) { WatchCtx *w = d; (void)fd; (void)mask; w->c->cb.on_fd(w->c->u, w->which); }

int capture_open(Capture **out, int pw_fd, uint32_t node_id, int max_fps, const CapCallbacks *cb, void *user, char *err, size_t errlen) {
    if (load_pw(err, errlen)) { if (pw_fd >= 0) close(pw_fd); return -1; }
    pw_init(NULL, NULL);
    Capture *c = calloc(1, sizeof *c); c->cb = *cb; c->u = user; c->max_fps = max_fps > 0 ? max_fps : 60;
    c->loop = pw_main_loop_new(NULL);
    if (!c->loop) { snprintf(err, errlen, "pw_main_loop_new failed"); if (pw_fd >= 0) close(pw_fd); free(c); return -1; }
    c->ctx = pw_context_new(pw_main_loop_get_loop(c->loop), NULL, 0);
    if (!c->ctx) { snprintf(err, errlen, "pw_context_new failed"); if (pw_fd >= 0) close(pw_fd); capture_close(c); return -1; }
    c->core = pw_fd >= 0 ? pw_context_connect_fd(c->ctx, pw_fd, NULL, 0)    /* takes the fd */
                         : pw_context_connect(c->ctx, NULL, 0);             /* dev/test only: the default PipeWire socket */
    if (!c->core) { snprintf(err, errlen, "cannot connect to the PipeWire remote the portal granted: %s", strerror(errno)); capture_close(c); return -1; }
    pw_core_add_listener(c->core, &c->core_hook, &core_events, c);
    c->stream = pw_stream_new(c->core, "cipherline-share", pw_properties_new_string("media.type=Video media.category=Capture media.role=Screen"));
    if (!c->stream) { snprintf(err, errlen, "pw_stream_new failed"); capture_close(c); return -1; }
    pw_stream_add_listener(c->stream, &c->stream_hook, &stream_events, c);

    uint8_t buf[1024]; struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof buf);
    struct spa_rectangle def = SPA_RECTANGLE(1920, 1080), mn = SPA_RECTANGLE(16, 16), mx = SPA_RECTANGLE(16384, 16384);
    struct spa_fraction fr = SPA_FRACTION((uint32_t)c->max_fps, 1), f0 = SPA_FRACTION(0, 1), fm = SPA_FRACTION(1000, 1);
    const struct spa_pod *params[1];
    params[0] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
        SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video), SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRA, SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_RGBA),
        SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&def, &mn, &mx),
        SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&fr, &f0, &fm));
    int r = pw_stream_connect(c->stream, PW_DIRECTION_INPUT, node_id, PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS, params, 1);
    if (r < 0) { snprintf(err, errlen, "pw_stream_connect failed: %s", strerror(-r)); capture_close(c); return -1; }

    struct timespec first = { 0, 100 * 1000 * 1000 }, every = { 0, 100 * 1000 * 1000 };
    c->timer = pw_loop_add_timer(pw_main_loop_get_loop(c->loop), on_timer, c);
    if (c->timer) pw_loop_update_timer(pw_main_loop_get_loop(c->loop), c->timer, &first, &every, false);
    *out = c; return 0;
}

int capture_watch(Capture *c, int fd, int which) {
    if (c->nio >= MAX_WATCH) return -1;
    WatchCtx *w = malloc(sizeof *w); w->c = c; w->which = which;
    struct spa_source *s = pw_loop_add_io(pw_main_loop_get_loop(c->loop), fd, SPA_IO_IN | SPA_IO_HUP | SPA_IO_ERR, false, on_io_ctx, w);
    if (!s) { free(w); return -1; }
    c->io[c->nio] = s; c->io_which[c->nio++] = which; return 0;
}
void capture_run(Capture *c) { pw_main_loop_run(c->loop); }
void capture_quit(Capture *c) { pw_main_loop_quit(c->loop); }
void capture_close(Capture *c) {
    if (!c) return;
    if (c->stream) { pw_stream_destroy(c->stream); c->stream = NULL; }
    if (c->core) { pw_core_disconnect(c->core); c->core = NULL; }
    if (c->ctx) pw_context_destroy(c->ctx);
    if (c->loop) pw_main_loop_destroy(c->loop);
    free(c);
}
