/*
 * DEV/TEST ONLY: a PipeWire BGRx video producer that behaves like a compositor's screencast stream, so the helper's PipeWire consumer
 * can be proven against the real PipeWire daemon without a GPU/compositor. Script (wall clock from the first frame):
 *   0-1.5 s grey | red 1.2 s | green 1.2 s | blue 1.2 s | 3 s NO frames at all (a static screen produces none) |
 *   3 s burst (a new colour every frame) | renegotiate to 1024x768 (a source size change) | red 2 s | blue 2 s | exit (stream gone)
 * Build (host): gcc -O2 -I<pw>/pipewire-0.3 -I<pw>/spa-0.2 pw-test-source.c -o pw-test-source -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/video/type-info.h>
#include <spa/pod/builder.h>
#include <pipewire/pipewire.h>

#define SYMS(X) X(pw_init) X(pw_main_loop_new) X(pw_main_loop_get_loop) X(pw_main_loop_run) X(pw_main_loop_quit) X(pw_context_new) X(pw_context_connect) \
    X(pw_stream_new) X(pw_stream_add_listener) X(pw_stream_connect) X(pw_stream_dequeue_buffer) X(pw_stream_queue_buffer) X(pw_stream_update_params) \
    X(pw_stream_trigger_process) X(pw_properties_new_string)
#define X(n) typedef __typeof__(&n) t_##n; static t_##n p_##n;
SYMS(X)
#undef X
#define pw_init p_pw_init
#define pw_main_loop_new p_pw_main_loop_new
#define pw_main_loop_get_loop p_pw_main_loop_get_loop
#define pw_main_loop_run p_pw_main_loop_run
#define pw_main_loop_quit p_pw_main_loop_quit
#define pw_context_new p_pw_context_new
#define pw_context_connect p_pw_context_connect
#define pw_stream_new p_pw_stream_new
#define pw_stream_add_listener p_pw_stream_add_listener
#define pw_stream_connect p_pw_stream_connect
#define pw_stream_dequeue_buffer p_pw_stream_dequeue_buffer
#define pw_stream_queue_buffer p_pw_stream_queue_buffer
#define pw_stream_update_params p_pw_stream_update_params
#define pw_stream_trigger_process p_pw_stream_trigger_process
#define pw_properties_new_string p_pw_properties_new_string

static struct pw_main_loop *loop; static struct pw_stream *stream; static struct spa_hook hook;
static int W = 1280, H = 720; static uint64_t t0; static int resized, quit_after;
static uint64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000; }

static const struct spa_pod *enum_format(struct spa_pod_builder *b, int w, int h) {
    struct spa_rectangle sz = SPA_RECTANGLE((uint32_t)w, (uint32_t)h); struct spa_fraction fr = SPA_FRACTION(60, 1);
    return spa_pod_builder_add_object(b, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat, SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw), SPA_FORMAT_VIDEO_format, SPA_POD_Id(SPA_VIDEO_FORMAT_BGRx),
        SPA_FORMAT_VIDEO_size, SPA_POD_Rectangle(&sz), SPA_FORMAT_VIDEO_framerate, SPA_POD_Fraction(&fr));
}
static void on_param(void *d, uint32_t id, const struct spa_pod *param) {
    (void)d; if (!param || id != SPA_PARAM_Format) return;
    struct spa_video_info_raw vi; if (spa_format_video_raw_parse(param, &vi) < 0) return;
    W = (int)vi.size.width; H = (int)vi.size.height;
    uint8_t buf[256]; struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof buf);
    const struct spa_pod *p = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
        SPA_PARAM_BUFFERS_buffers, SPA_POD_CHOICE_RANGE_Int(4, 2, 8), SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_size, SPA_POD_Int(W * H * 4), SPA_PARAM_BUFFERS_stride, SPA_POD_Int(W * 4), SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int(1 << SPA_DATA_MemFd));
    pw_stream_update_params(stream, &p, 1);
    fprintf(stderr, "producer: negotiated %dx%d\n", W, H);
}
static void colour(uint64_t ms, int *r, int *g, int *bl, int *emit) {
    *emit = 1; uint64_t s = ms;
    if (s < 1500) { *r = *g = *bl = 32; return; }
    s -= 1500; if (s < 1200) { *r = 255; *g = 0; *bl = 0; return; }
    s -= 1200; if (s < 1200) { *r = 0; *g = 255; *bl = 0; return; }
    s -= 1200; if (s < 1200) { *r = 0; *g = 0; *bl = 255; return; }
    s -= 1200; if (s < 3000) { *emit = 0; return; }                                   /* static screen: the compositor sends nothing */
    s -= 3000; if (s < 3000) { int n = (int)(ms / 16); *r = n * 7 % 256; *g = n * 13 % 256; *bl = n * 29 % 256; return; }
    s -= 3000;
    if (!resized) { resized = 1; uint8_t buf[512]; struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof buf); const struct spa_pod *p = enum_format(&b, 1024, 768); pw_stream_update_params(stream, &p, 1); }
    if (s < 2000) { *r = 255; *g = 0; *bl = 0; return; }
    s -= 2000; if (s < 2000) { *r = 0; *g = 0; *bl = 255; return; }
    quit_after = 1; *emit = 0;
}
static void on_timer(void *d, uint64_t e) {
    (void)d; (void)e; if (!t0) t0 = now_ms();
    int r = 0, g = 0, bl = 0, emit; colour(now_ms() - t0, &r, &g, &bl, &emit);
    if (quit_after) { pw_main_loop_quit(loop); return; }
    if (emit) pw_stream_trigger_process(stream);
    (void)r; (void)g; (void)bl;
}
static void on_process(void *d) {
    (void)d; struct pw_buffer *b = pw_stream_dequeue_buffer(stream); if (!b) return;
    struct spa_data *dt = &b->buffer->datas[0]; if (!dt->data) { pw_stream_queue_buffer(stream, b); return; }
    int r = 0, g = 0, bl = 0, emit; colour(now_ms() - t0, &r, &g, &bl, &emit);
    uint8_t *p = dt->data; size_t need = (size_t)W * H * 4;
    if (need <= dt->maxsize) {
        for (size_t i = 0; i < need; i += 4) { p[i] = (uint8_t)bl; p[i + 1] = (uint8_t)g; p[i + 2] = (uint8_t)r; p[i + 3] = 0; }
        dt->chunk->offset = 0; dt->chunk->size = (uint32_t)need; dt->chunk->stride = W * 4;
    }
    pw_stream_queue_buffer(stream, b);
}
static const struct pw_stream_events ev = { PW_VERSION_STREAM_EVENTS, .param_changed = on_param, .process = on_process };

int main(void) {
    void *h = dlopen("libpipewire-0.3.so.0", RTLD_NOW); if (!h) { fprintf(stderr, "no libpipewire\n"); return 2; }
#define X(n) if (!(p_##n = (t_##n)dlsym(h, #n))) { fprintf(stderr, "missing %s\n", #n); return 2; }
    SYMS(X)
#undef X
    pw_init(NULL, NULL); loop = pw_main_loop_new(NULL);
    struct pw_context *ctx = pw_context_new(pw_main_loop_get_loop(loop), NULL, 0); struct pw_core *core = pw_context_connect(ctx, NULL, 0);
    stream = pw_stream_new(core, "cl-test-screen", pw_properties_new_string("media.class=Video/Source node.name=cl-test-screen media.role=Screen node.description=cl-test-screen"));
    pw_stream_add_listener(stream, &hook, &ev, NULL);
    uint8_t buf[512]; struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buf, sizeof buf); const struct spa_pod *p = enum_format(&b, W, H);
    int r = pw_stream_connect(stream, PW_DIRECTION_OUTPUT, PW_ID_ANY, PW_STREAM_FLAG_DRIVER | PW_STREAM_FLAG_MAP_BUFFERS, &p, 1);
    if (r < 0) { fprintf(stderr, "connect failed %d\n", r); return 3; }
    struct spa_source *tm = pw_loop_add_timer(pw_main_loop_get_loop(loop), on_timer, NULL);
    struct timespec first = { 0, 16 * 1000 * 1000 }, every = { 0, 16 * 1000 * 1000 };
    pw_loop_update_timer(pw_main_loop_get_loop(loop), tm, &first, &every, false);
    pw_main_loop_run(loop);
    fprintf(stderr, "producer: done\n");
    return 0;
}
