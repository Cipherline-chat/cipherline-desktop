/*
 * share-encoder-helper --capture: portal ScreenCast -> PipeWire (SHM) -> encoder -> framed access units on stdout.
 * Wire format on stdout is the same as --serve (24-byte header + Annex-B). Everything else is one JSON object per line on stderr:
 *   {"event":"portal",...}   session granted (size, restore_token to persist, cursor mode)
 *   {"event":"format",...}   encoder (re)opened for a source size (first frame and every source size change)
 *   {"event":"stats",...}    once a second (encoded fps, drops, encode latency, bitrate, effective fps ceiling)
 *   {"event":"fps_limited",...} the encoder cannot sustain the asked fps at this size: we lowered it instead of stuttering
 *   {"event":"ended","reason":...}  compositor/portal/PipeWire stopped the source
 *   {"error":"...","code":"..."}     a clean, explicit failure the app can fall back from
 *   (PREVIEW <max_w> <fps> / PREVIEW OFF on stdin: the sharer's own thumbnail as a flag-bit2 (value 4) record in the AU stream, see preview.h)
 *   {"event":"low","state":"on|off",...} / {"event":"low_failed","code":...}  the lighter copy (below)
 * stdin: optional first line "TOKEN <restore_token>" (only with --restore-stdin), then IDR | REFRESH | BITRATE <bps> | STOP,
 *   and the lighter-copy commands (lowlayer.h): LOW <w> <h> <fps> <bps> (open a SECOND encoder session fed from the same frames; AUs on stdout
 *   carry header flag bit1 = low layer), LOW OFF, LOW_IDR, LOW_BITRATE <bps>. The renderer decides when and how big; a failure here is
 *   reported ("low_failed") and drops only that session - never the full layer.
 * Exit codes: 0 stopped; 4 encode error; 5 source ended; 6 no frames; 10 no D-Bus; 11 no portal; 12 denied/cancelled; 13 portal protocol;
 *   14 PipeWire unavailable; 15 encoder open failed; 16 encoder session limit; 17 driver too old; 18 size over the hardware limit.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "capture.h"
#include "encoder.h"
#include "portal.h"
#include "share-capture.h"
#include "pacer.h"
#include "lowlayer.h"
#include "preview.h"

#define LAT_N 256

typedef struct S {
    const ClEncoderOps *ops; ClEncCfg cfg; CapOpts o;
    ClEncoder *enc; int ew, eh, sw, sh; uint32_t pix;
    uint8_t *scratch; size_t scratch_cap;   /* downscaled BGRx */
    uint8_t *nv12; size_t nv12_cap; int nv12_valid;
    Capture *cap; Portal portal;
    int stop, exit_code, target_fps, eff_fps, headroom_s, have_enc;
    ClPacer pacer;
    uint64_t t0, last_enc_us, last_au_us, period_us, next_stats_us;
    uint32_t lat[LAT_N]; int nlat, lat_pos;
    uint64_t frames, dropped, repeats, bytes, win_frames, win_bytes, win_dropped, frames_in;
    char line[160]; int ll; int first_frame;
    char enc_desc[1500];
    ClPreview preview;   /* the sharer's own preview thumbnail, only while the renderer asks (preview.h) */
    ClLow low;   /* the lighter copy: a second session, only while the renderer asks (lowlayer.h) */
} S;

static uint64_t now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000 + (uint64_t)t.tv_nsec / 1000; }
static void jesc(const char *s, char *o, size_t n) { size_t j = 0; for (; *s && j + 7 < n; s++) { if (*s == '"' || *s == '\\') o[j++] = '\\'; if ((unsigned char)*s >= 32) o[j++] = *s; } o[j] = 0; }
static void err_json(const char *msg, const char *code) { char m[600]; jesc(msg, m, sizeof m); fprintf(stderr, "{\"error\":\"%s\",\"code\":\"%s\"}\n", m, code); fflush(stderr); }
static int cmp_u32(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : x > y; }

static void lat_stats(S *s, double *p50, double *p95, double *mx) {
    uint32_t tmp[LAT_N]; int n = s->nlat < LAT_N ? s->nlat : LAT_N; memcpy(tmp, s->lat, sizeof(uint32_t) * (size_t)n);
    qsort(tmp, (size_t)n, sizeof(uint32_t), cmp_u32);
    *p50 = n ? tmp[(int)((n - 1) * 0.5)] / 1000.0 : 0; *p95 = n ? tmp[(int)((n - 1) * 0.95)] / 1000.0 : 0; *mx = n ? tmp[n - 1] / 1000.0 : 0;
}

static int write_au(S *s, const ClEncPacket *p, uint64_t cap_us, uint64_t done, int low) {
    uint8_t hd[24]; cl_au_header(hd, p->size, p->is_key, low, cap_us, done);
    if (fwrite(hd, 1, 24, stdout) != 24 || fwrite(p->data, 1, p->size, stdout) != p->size || fflush(stdout) != 0) { s->stop = 1; return -1; }
    if (!low) { s->bytes += p->size; s->win_bytes += p->size; s->last_au_us = done; }
    return 0;
}

/* One preview picture (preview.h) onto the same stdout stream, flag bit2. A failed write is the same "reader gone" as for an AU. */
static int write_preview(S *s, uint64_t t_us) {
    uint8_t hd[24]; cl_au_header(hd, s->preview.len, 0, 0, t_us, t_us); hd[4] = CL_AU_FLAG_PREVIEW;
    if (fwrite(hd, 1, 24, stdout) != 24 || fwrite(s->preview.buf, 1, s->preview.len, stdout) != s->preview.len || fflush(stdout) != 0) { s->stop = 1; return -1; }
    return 0;
}

static void low_event(const char *state, const char *reason, const ClLow *l) {
    fprintf(stderr, "{\"event\":\"low\",\"state\":\"%s\",\"reason\":\"%s\",\"w\":%d,\"h\":%d}\n", state, reason, l ? l->w : 0, l ? l->h : 0); fflush(stderr);
}
/* The lighter copy failed: report, drop ONLY that session. The full layer and the share are untouched. */
static void low_failed(S *s, const char *msg, const char *code) {
    char m[400]; jesc(msg, m, sizeof m);
    fprintf(stderr, "{\"event\":\"low_failed\",\"code\":\"%s\",\"message\":\"%s\"}\n", code, m); fflush(stderr);
    cl_low_close(&s->low);
}

static void open_encoder(S *s, int sw, int sh) {
    if (cl_low_is_open(&s->low)) { cl_low_close(&s->low); low_event("off", "resize", NULL); }   /* a new source size: the renderer re-asks with the new size */
    if (s->enc) { s->ops->close(s->enc); s->enc = NULL; s->have_enc = 0; }
    int W = sw & ~1, H = sh & ~1;
    double sc = 1.0;
    if (W > s->o.max_w || H > s->o.max_h) { double a = (double)s->o.max_w / W, b = (double)s->o.max_h / H; sc = a < b ? a : b; }
    for (int attempt = 0; attempt < 2; attempt++) {
        int ow = ((int)(W * sc)) & ~1, oh = ((int)(H * sc)) & ~1; if (ow < 16) ow = 16; if (oh < 16) oh = 16;
        s->cfg.width = ow; s->cfg.height = oh; s->cfg.want_bgrx = s->ops->encode_bgrx != NULL;
        char err[300] = "";
        if (s->ops->open(&s->enc, &s->cfg, err, sizeof err) == 0) { s->ew = ow; s->eh = oh; s->sw = sw; s->sh = sh; s->have_enc = 1; break; }
        if (s->cfg.fail_code == 3 && s->cfg.max_w > 0 && s->cfg.max_h > 0 && attempt == 0) {   /* over the hardware limit: scale into it instead of failing */
            double a = (double)s->cfg.max_w / W, b = (double)s->cfg.max_h / H; sc = a < b ? a : b; continue;
        }
        static const char *codes[] = { "encoder_open_failed", "session_limit", "driver_too_old", "size_over_limit" };
        static const int exits[] = { 15, 16, 17, 18 };
        int fc = s->cfg.fail_code >= 0 && s->cfg.fail_code <= 3 ? s->cfg.fail_code : 0;
        err_json(err, codes[fc]); s->exit_code = exits[fc]; s->stop = 1; capture_quit(s->cap); return;
    }
    s->enc_desc[0] = 0; if (s->ops->describe) s->ops->describe(s->enc, s->enc_desc, sizeof s->enc_desc);
    s->ops->request_idr(s->enc); s->nv12_valid = 0;
    fprintf(stderr, "{\"event\":\"format\",\"src_w\":%d,\"src_h\":%d,\"w\":%d,\"h\":%d,\"encoder\":\"%s\"%s%s}\n", sw, sh, s->ew, s->eh, s->ops->name, s->enc_desc[0] ? "," : "", s->enc_desc);
    fflush(stderr);
}

static void on_format(void *u, int w, int h, uint32_t pix) {
    S *s = u; s->pix = pix;
    if (w < 16 || h < 16) return;
    if (!s->have_enc || w != s->sw || h != s->sh) open_encoder(s, w, h);
}

/* BGRx (or RGBx) -> NV12, BT.709 limited. Only used by backends without a native 4-byte input path. */
static void to_nv12(S *s, const uint8_t *px, int stride, int swap) {
    size_t need = (size_t)s->ew * s->eh * 3 / 2; if (need > s->nv12_cap) { s->nv12 = realloc(s->nv12, need); s->nv12_cap = need; }
    uint8_t *Y = s->nv12, *UV = s->nv12 + (size_t)s->ew * s->eh;
    for (int y = 0; y < s->eh; y++) {
        const uint8_t *r = px + (size_t)y * (size_t)stride;
        for (int x = 0; x < s->ew; x++) {
            int B = r[x * 4], G = r[x * 4 + 1], R = r[x * 4 + 2]; if (swap) { int t = B; B = R; R = t; }
            Y[(size_t)y * s->ew + x] = (uint8_t)(16 + ((47 * R + 157 * G + 16 * B + 128) >> 8));
            if (!(y & 1) && !(x & 1)) {
                const uint8_t *r2 = r + stride; int R2 = (r[x * 4 + 2] + r[x * 4 + 6] + r2[x * 4 + 2] + r2[x * 4 + 6]) >> 2, G2 = (r[x * 4 + 1] + r[x * 4 + 5] + r2[x * 4 + 1] + r2[x * 4 + 5]) >> 2, B2 = (r[x * 4] + r[x * 4 + 4] + r2[x * 4] + r2[x * 4 + 4]) >> 2;
                if (swap) { int t = B2; B2 = R2; R2 = t; }
                int u = 128 + ((-26 * R2 - 87 * G2 + 112 * B2 + 128) >> 8), v = 128 + ((112 * R2 - 102 * G2 - 10 * B2 + 128) >> 8);
                UV[(size_t)(y / 2) * s->ew + x] = (uint8_t)(u < 16 ? 16 : u > 240 ? 240 : u); UV[(size_t)(y / 2) * s->ew + x + 1] = (uint8_t)(v < 16 ? 16 : v > 240 ? 240 : v);
            }
        }
    }
    s->nv12_valid = 1;
}

static void encoded(S *s, int rc, ClEncPacket *p, uint64_t cap_us, uint64_t t_start) {
    uint64_t done = now_us();
    if (rc != 0) { err_json("encoder failed mid-share", "encode_failed"); s->exit_code = 4; s->stop = 1; capture_quit(s->cap); return; }
    s->lat[s->lat_pos] = (uint32_t)(done - t_start); s->lat_pos = (s->lat_pos + 1) % LAT_N; if (s->nlat < LAT_N) s->nlat++;
    s->frames++; s->win_frames++; s->last_enc_us = t_start;
    if (write_au(s, p, cap_us, done, 0) < 0) capture_quit(s->cap);
}

static void on_frame(void *u, const CapFrame *f) {
    S *s = u; s->frames_in++;
    if (s->stop || !s->have_enc) return;
    uint64_t t = now_us();
    if (!cl_pacer_accept(&s->pacer, t, s->period_us)) { s->dropped++; s->win_dropped++; return; }   /* accumulated budget, see pacer.h */   /* rate cap: drop, never queue */
    if (f->width != s->sw || f->height != s->sh) { open_encoder(s, f->width, f->height); if (s->stop) return; }
    const uint8_t *px = f->data; int stride = f->stride;
    if (f->width != s->ew || f->height != s->eh) {
        if (f->width - s->ew <= 1 && f->height - s->eh <= 1) { /* odd-size crop: encode the even top-left area */ }
        else {                                                  /* nearest-neighbour downscale into the encoder size */
            size_t need = (size_t)s->ew * s->eh * 4; if (need > s->scratch_cap) { s->scratch = realloc(s->scratch, need); s->scratch_cap = need; }
            for (int y = 0; y < s->eh; y++) {
                const uint32_t *src = (const uint32_t *)(f->data + (size_t)((int64_t)y * f->height / s->eh) * (size_t)f->stride); uint32_t *dst = (uint32_t *)(s->scratch + (size_t)y * s->ew * 4);
                for (int x = 0; x < s->ew; x++) dst[x] = src[(int64_t)x * f->width / s->ew];
            }
            px = s->scratch; stride = s->ew * 4;
        }
    }
    ClEncPacket p; uint64_t t0 = now_us(); int rc;
    int swap = f->pix == CL_PIX_RGBX;
    if (s->ops->encode_bgrx) rc = s->ops->encode_bgrx(s->enc, px, stride, swap, f->pts_us, &p);
    else { to_nv12(s, px, stride, swap); rc = s->ops->encode(s->enc, s->nv12, f->pts_us, &p); }
    encoded(s, rc, &p, f->pts_us, t0);
    if (cl_low_is_open(&s->low) && !s->stop) {                  /* the lighter copy: same frame, its own pacer and session */
        ClEncPacket lp; int produced = 0;
        if (cl_low_encode(&s->low, f->data, f->width, f->height, f->stride, swap, f->pts_us, t, &lp, &produced) < 0) low_failed(s, "low-layer encoder failed", "low_encode_failed");
        else if (produced && write_au(s, &lp, f->pts_us, now_us(), 1) < 0) capture_quit(s->cap);
    }
    if (s->preview.on && !s->stop && cl_preview_frame(&s->preview, f->data, f->width, f->height, f->stride, swap, t) && write_preview(s, t) < 0) capture_quit(s->cap);
}

static void handle_line(S *s, char *l) {
    if (!strcmp(l, "IDR")) { if (s->enc) s->ops->request_idr(s->enc); }
    else if (!strcmp(l, "REFRESH")) { if (s->enc) s->ops->request_refresh(s->enc); }
    else if (!strncmp(l, "BITRATE ", 8)) { int b = atoi(l + 8); if (b >= 100000 && b <= 200000000 && s->enc && s->ops->set_bitrate(s->enc, b) == 0) fprintf(stderr, "{\"applied_bitrate\":%d}\n", b); }
    else if (!strncmp(l, "PREVIEW ", 8)) { int w = 0, fps = 0, r = cl_preview_parse(l + 8, &w, &fps); if (r >= 0) cl_preview_set(&s->preview, r, w, fps); }
    else if (!strcmp(l, "LOW_IDR")) { if (cl_low_is_open(&s->low)) s->low.ops->request_idr(s->low.enc); }
    else if (!strncmp(l, "LOW_BITRATE ", 12)) { int b = atoi(l + 12); if (b >= 100000 && b <= 200000000 && cl_low_is_open(&s->low)) s->low.ops->set_bitrate(s->low.enc, b); }
    else if (!strncmp(l, "LOW ", 4)) {
        ClLowCmd c; int r = s->have_enc ? cl_low_parse(l + 4, s->ew, s->eh, &c) : -1;
        if (r == 0) { if (cl_low_is_open(&s->low)) { cl_low_close(&s->low); low_event("off", "requested", NULL); } }
        else if (r == 1) {
            char err[300] = ""; int fc = 0;
            if (cl_low_open(&s->low, s->ops, &s->cfg, &c, err, sizeof err, &fc) == 0) low_event("on", "", &s->low);
            else low_failed(s, err, fc == 1 ? "low_session_limit" : fc == 3 ? "low_size_over_limit" : "low_open_failed");
        } else low_failed(s, "invalid LOW command or no encoder yet", "low_invalid");
    }
    else if (!strcmp(l, "STOP")) { s->stop = 1; capture_quit(s->cap); }
}
static void on_fd(void *u, int which) {
    S *s = u;
    if (which == 1) { int c = portal_poll_closed(&s->portal); if (c) { fprintf(stderr, "{\"event\":\"ended\",\"reason\":\"%s\"}\n", c > 0 ? "the portal session was closed (the screen source was stopped)" : "the D-Bus connection was lost"); fflush(stderr); if (!s->stop) s->exit_code = 5; s->stop = 1; capture_quit(s->cap); } return; }
    char buf[256]; ssize_t n = read(0, buf, sizeof buf);
    if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) { s->stop = 1; capture_quit(s->cap); return; }   /* the parent went away: stop */
    for (ssize_t i = 0; i < n; i++) {
        if (buf[i] == '\n') { s->line[s->ll] = 0; s->ll = 0; handle_line(s, s->line); }
        else if (s->ll < (int)sizeof s->line - 1) s->line[s->ll++] = buf[i];
    }
}

static void on_tick(void *u) {
    S *s = u; uint64_t t = now_us();
    if (s->stop) return;
    if (!s->have_enc) { if (t - s->t0 > 10 * 1000000ull) { err_json("no frames from the screen source within 10 s", "no_frames"); s->exit_code = 6; s->stop = 1; capture_quit(s->cap); } return; }
    /* idle keep-alive: a static screen produces no frames; the receiver's watchdog (and the SFU) still need AUs, so re-encode the last frame */
    if (s->last_au_us && t - s->last_au_us > (uint64_t)s->o.idle_ms * 1000 && (s->ops->encode_repeat || s->nv12_valid)) {
        ClEncPacket p; uint64_t t0 = now_us(); int rc;
        if (s->ops->encode_repeat) rc = s->ops->encode_repeat(s->enc, t, &p); else rc = s->ops->encode(s->enc, s->nv12, t, &p);
        s->repeats++; encoded(s, rc, &p, t, t0);
    }
    if (cl_low_is_open(&s->low) && s->low.last_au_us && t - s->low.last_au_us > (uint64_t)s->o.idle_ms * 1000) {
        ClEncPacket lp; int produced = 0;
        if (cl_low_repeat(&s->low, t, &lp, &produced) < 0) low_failed(s, "low-layer encoder failed", "low_encode_failed");
        else if (produced && write_au(s, &lp, t, now_us(), 1) < 0) capture_quit(s->cap);
    }
    if (cl_preview_resend_due(&s->preview, t)) { s->preview.last_us = t; if (write_preview(s, t) < 0) { capture_quit(s->cap); return; } }   /* static screen: keep the tile alive */
    if (t >= s->next_stats_us) {
        s->next_stats_us = t + 1000000;
        double p50, p95, mx; lat_stats(s, &p50, &p95, &mx);
        /* capability-driven ceiling: if the p95 encode time cannot fit the frame period (with margin), lower the fps instead of stuttering */
        if (s->nlat >= 30 && p95 > 0) {
            int sustain = (int)(1000.0 / (p95 * 1.2)); if (sustain < 5) sustain = 5;
            if (sustain < s->eff_fps) { s->eff_fps = sustain; s->period_us = 1000000 / (uint64_t)s->eff_fps; s->headroom_s = 0; fprintf(stderr, "{\"event\":\"fps_limited\",\"fps\":%d,\"requested\":%d,\"enc_ms_p95\":%.2f}\n", s->eff_fps, s->target_fps, p95); }
            else if (s->eff_fps < s->target_fps && sustain >= s->eff_fps * 14 / 10 && ++s->headroom_s >= 10) { s->eff_fps = s->eff_fps * 11 / 10 + 1; if (s->eff_fps > s->target_fps) s->eff_fps = s->target_fps; s->period_us = 1000000 / (uint64_t)s->eff_fps; s->headroom_s = 0; }
        }
        fprintf(stderr, "{\"event\":\"stats\",\"encoder\":\"%s\",\"w\":%d,\"h\":%d,\"fps\":%llu,\"in_fps\":%llu,\"dropped\":%llu,\"idle_repeats\":%llu,\"enc_ms_p50\":%.2f,\"enc_ms_p95\":%.2f,\"enc_ms_max\":%.2f,\"kbps\":%.0f,\"eff_fps\":%d,\"low\":%d,\"low_fps\":%llu,\"low_kbps\":%.0f}\n",
                s->ops->name, s->ew, s->eh, (unsigned long long)s->win_frames, (unsigned long long)s->frames_in, (unsigned long long)s->win_dropped, (unsigned long long)s->repeats, p50, p95, mx, s->win_bytes * 8.0 / 1000.0, s->eff_fps, cl_low_is_open(&s->low), (unsigned long long)s->low.win_frames, s->low.win_bytes * 8.0 / 1000.0);
        fflush(stderr); s->low.win_frames = 0; s->low.win_bytes = 0; s->win_frames = 0; s->win_bytes = 0; s->win_dropped = 0; s->frames_in = 0;
    }
}
static void on_end(void *u, const char *why) {
    S *s = u; char m[400]; jesc(why, m, sizeof m);
    fprintf(stderr, "{\"event\":\"ended\",\"reason\":\"%s\"}\n", m); fflush(stderr);
    if (!s->stop) s->exit_code = 5;
    s->stop = 1;
}

int run_capture(const ClEncoderOps *ops, ClEncCfg cfg, const CapOpts *o) {
    signal(SIGPIPE, SIG_IGN);
    static S s; memset(&s, 0, sizeof s);
    s.ops = ops; s.cfg = cfg; s.o = *o; s.target_fps = s.eff_fps = o->fps > 0 ? o->fps : 60; s.period_us = 1000000 / (uint64_t)s.eff_fps; s.t0 = now_us(); s.next_stats_us = s.t0 + 1000000;
    if (s.o.idle_ms <= 0) s.o.idle_ms = 250;
    char restore[512] = "";
    if (o->restore_stdin) {                                   /* the token never touches argv/env (visible to other processes) */
        struct pollfd pf = { 0, POLLIN, 0 };
        if (poll(&pf, 1, 2000) > 0) { char l[600]; if (fgets(l, sizeof l, stdin) && !strncmp(l, "TOKEN ", 6)) { size_t n = strcspn(l + 6, "\r\n"); if (n < sizeof restore) { memcpy(restore, l + 6, n); restore[n] = 0; } } }
    }
    int fd = -1, node = 0;
    if (o->pw_node > 0) { memset(&s.portal, 0, sizeof s.portal); s.portal.bus.fd = -1; s.portal.pw_fd = -1; node = o->pw_node; fprintf(stderr, "{\"event\":\"portal\",\"width\":0,\"height\":0,\"source_type\":0,\"cursor\":\"none\",\"portal_version\":0,\"restore_token\":\"\",\"dev_pw_node\":%d}\n", node); fflush(stderr); goto have_remote; }
    PortalOpts po = { o->source_types, restore, o->persist, 0 }; char err[400] = "";
    PortalResult pr = portal_start(&s.portal, &po, err, sizeof err);
    if (pr != PORTAL_OK) {
        static const char *codes[] = { "", "no_dbus", "no_portal", "portal_denied", "portal_protocol" }; static const int exits[] = { 0, 10, 11, 12, 13 };
        err_json(err, codes[pr]); return exits[pr];
    }
    char tok[600]; jesc(s.portal.restore_token, tok, sizeof tok);
    fprintf(stderr, "{\"event\":\"portal\",\"width\":%d,\"height\":%d,\"source_type\":%u,\"has_pos\":%d,\"x\":%d,\"y\":%d,\"start_ms\":%d,\"cursor\":\"%s\",\"portal_version\":%u,\"restore_token\":\"%s\"}\n", s.portal.width, s.portal.height, s.portal.source_type, s.portal.has_pos, s.portal.pos_x, s.portal.pos_y, s.portal.start_ms, s.portal.cursor_mode == 2 ? "embedded" : "none", s.portal.version, tok);
    fflush(stderr);
    fd = s.portal.pw_fd; s.portal.pw_fd = -1; node = (int)s.portal.node_id;   /* capture_open owns the fd now */
have_remote:;
    CapCallbacks cb = { on_format, on_frame, on_tick, on_fd, on_end };
    if (capture_open(&s.cap, fd, (uint32_t)node, s.target_fps, &cb, &s, err, sizeof err)) { err_json(err, "pipewire_unavailable"); portal_close(&s.portal); return 14; }
    capture_watch(s.cap, 0, 0); if (s.portal.bus.fd >= 0) capture_watch(s.cap, s.portal.bus.fd, 1);
    capture_run(s.cap);
    capture_close(s.cap);
    cl_low_close(&s.low);
    cl_preview_set(&s.preview, 0, 0, 0);
    if (s.enc) s.ops->close(s.enc);
    portal_close(&s.portal);
    free(s.scratch); free(s.nv12);
    return s.exit_code;
}
