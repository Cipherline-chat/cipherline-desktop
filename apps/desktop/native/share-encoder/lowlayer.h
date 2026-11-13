/*
 * The "lighter copy" (720p simulcast low layer) of the native share, helper side: a SECOND encoder session fed from the same capture
 * frames, written to the same stdout stream with header flag bit1 set so the renderer's injector can route it to the low simulcast
 * layer (src/utils/nativeShareInject.ts). Header-only so test/lowlayer_test.c exercises exactly the code the capture loop runs.
 *
 * Rules (owner, same as the Chromium path - src/utils/shareLowLayer.ts): the session exists ONLY while the renderer asks for it
 * ("LOW w h fps bps" on stdin; "LOW OFF" closes it). The renderer decides when (hardware encoder, viewers, no cost to the sharer) and
 * the size/rate/bitrate (screenShare.shareLowEncoding); this file only validates and executes. A failure to open or encode the low
 * layer is reported and the low session dropped - it never stops the full layer or the share.
 */
#ifndef CL_LOWLAYER_H
#define CL_LOWLAYER_H
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "encoder.h"
#include "pacer.h"

#define CL_AU_FLAG_KEY 1
#define CL_AU_FLAG_LOW 2

/* 24-byte access-unit header (see share-encoder-helper.c): u32 len | u8 flags | 3 x 0 | u64 capture_us | u64 done_us */
static inline void cl_au_header(uint8_t hd[24], size_t len, int is_key, int low, uint64_t capture_us, uint64_t done_us) {
    uint32_t l = (uint32_t)len; memset(hd, 0, 24);
    memcpy(hd, &l, 4); hd[4] = (uint8_t)((is_key ? CL_AU_FLAG_KEY : 0) | (low ? CL_AU_FLAG_LOW : 0));
    memcpy(hd + 8, &capture_us, 8); memcpy(hd + 16, &done_us, 8);
}

typedef struct { int w, h, fps, bps; } ClLowCmd;

/* Plain digits only (no sscanf/strtol: glibc 2.38+ headers redirect those to GLIBC_2.38 symbols, and the helper must keep the 2.31 floor). */
static inline int cl_low_int(const char **p, int *out) {
    const char *s = *p; long v = 0; int n = 0;
    while (*s >= '0' && *s <= '9') { v = v * 10 + (*s - '0'); if (v > 1000000000L) return 0; s++; n++; }
    if (n == 0) return 0;
    *out = (int)v; *p = s; return 1;
}

/* Arguments after "LOW ". 1 = start (c filled), 0 = "OFF", -1 = invalid. The low layer is never larger than the full encode size. */
static inline int cl_low_parse(const char *args, int full_w, int full_h, ClLowCmd *c) {
    if (!strcmp(args, "OFF")) return 0;
    int v[4]; const char *p = args;
    for (int i = 0; i < 4; i++) {
        if (i > 0) { if (*p != ' ') return -1; p++; }
        if (!cl_low_int(&p, &v[i])) return -1;
    }
    if (*p != 0) return -1;
    int w = v[0], h = v[1], fps = v[2], bps = v[3];
    if (w < 16 || h < 16 || (w & 1) || (h & 1) || w > full_w || h > full_h) return -1;
    if (fps < 1 || fps > 60 || bps < 100000 || bps > 200000000) return -1;
    c->w = w; c->h = h; c->fps = fps; c->bps = bps; return 1;
}

typedef struct ClLow {
    const ClEncoderOps *ops; ClEncoder *enc; int w, h, fps, bps;
    ClPacer pacer; uint64_t period_us;
    uint8_t *scratch; size_t scratch_cap; uint8_t *nv12; size_t nv12_cap;
    uint64_t last_au_us, frames, win_frames, win_bytes;
} ClLow;

static inline int cl_low_is_open(const ClLow *l) { return l->enc != NULL; }

static inline void cl_low_close(ClLow *l) {
    if (l->enc) l->ops->close(l->enc);
    free(l->scratch); free(l->nv12);
    memset(l, 0, sizeof *l);
}

/* Opens the second session. 0 ok; <0 failure (err filled, *fail_code = ClEncCfg.fail_code: 1 = session limit / encoder memory). */
static inline int cl_low_open(ClLow *l, const ClEncoderOps *ops, const ClEncCfg *base, const ClLowCmd *c, char *err, size_t errlen, int *fail_code) {
    cl_low_close(l);
    ClEncCfg cfg = *base; cfg.width = c->w; cfg.height = c->h; cfg.fps = c->fps; cfg.bitrate_bps = c->bps;
    cfg.want_bgrx = ops->encode_bgrx != NULL; cfg.max_w = cfg.max_h = 0; cfg.fail_code = 0;
    ClEncoder *e = NULL;
    if (ops->open(&e, &cfg, err, errlen) != 0) { if (fail_code) *fail_code = cfg.fail_code; return -1; }
    l->ops = ops; l->enc = e; l->w = c->w; l->h = c->h; l->fps = c->fps; l->bps = c->bps; l->period_us = 1000000u / (uint64_t)c->fps;
    ops->request_idr(e);
    return 0;
}

/* Nearest-neighbour BGRx downscale (same filter as the full layer's box fit: cheap, no GPU, text stays legible at 2:1). */
static inline void cl_low_downscale(const uint8_t *px, int sw, int sh, int stride, uint8_t *dst, int dw, int dh) {
    for (int y = 0; y < dh; y++) {
        const uint32_t *s = (const uint32_t *)(px + (size_t)((int64_t)y * sh / dh) * (size_t)stride); uint32_t *d = (uint32_t *)(dst + (size_t)y * dw * 4);
        for (int x = 0; x < dw; x++) d[x] = s[(int64_t)x * sw / dw];
    }
}

static inline void cl_bgrx_to_nv12(const uint8_t *px, int stride, int w, int h, int swap, uint8_t *out) {
    uint8_t *Y = out, *UV = out + (size_t)w * h;
    for (int y = 0; y < h; y++) {
        const uint8_t *r = px + (size_t)y * (size_t)stride;
        for (int x = 0; x < w; x++) {
            int B = r[x * 4], G = r[x * 4 + 1], R = r[x * 4 + 2]; if (swap) { int t = B; B = R; R = t; }
            Y[(size_t)y * w + x] = (uint8_t)(16 + ((47 * R + 157 * G + 16 * B + 128) >> 8));
            if (!(y & 1) && !(x & 1)) {
                const uint8_t *r2 = r + (y + 1 < h ? stride : 0);
                int R2 = (r[x * 4 + 2] + r[x * 4 + 6] + r2[x * 4 + 2] + r2[x * 4 + 6]) >> 2, G2 = (r[x * 4 + 1] + r[x * 4 + 5] + r2[x * 4 + 1] + r2[x * 4 + 5]) >> 2, B2 = (r[x * 4] + r[x * 4 + 4] + r2[x * 4] + r2[x * 4 + 4]) >> 2;
                if (swap) { int t = B2; B2 = R2; R2 = t; }
                int u = 128 + ((-26 * R2 - 87 * G2 + 112 * B2 + 128) >> 8), v = 128 + ((112 * R2 - 102 * G2 - 10 * B2 + 128) >> 8);
                UV[(size_t)(y / 2) * w + x] = (uint8_t)(u < 16 ? 16 : u > 240 ? 240 : u); UV[(size_t)(y / 2) * w + x + 1] = (uint8_t)(v < 16 ? 16 : v > 240 ? 240 : v);
            }
        }
    }
}

/*
 * One captured frame (source size sw x sh, BGRx/RGBx) -> at most one low-layer AU. *produced = 0 when the low pacer skipped it.
 * Returns 0 ok, <0 when the encoder failed (the caller drops the low session, the share goes on).
 */
static inline int cl_low_encode(ClLow *l, const uint8_t *px, int sw, int sh, int stride, int swap, uint64_t pts_us, uint64_t t_us, ClEncPacket *out, int *produced) {
    *produced = 0;
    if (!l->enc || !cl_pacer_accept(&l->pacer, t_us, l->period_us)) return 0;
    size_t need = (size_t)l->w * l->h * 4;
    if (need > l->scratch_cap) { uint8_t *n = realloc(l->scratch, need); if (!n) return -1; l->scratch = n; l->scratch_cap = need; }
    cl_low_downscale(px, sw, sh, stride, l->scratch, l->w, l->h);
    int rc;
    if (l->ops->encode_bgrx) rc = l->ops->encode_bgrx(l->enc, l->scratch, l->w * 4, swap, pts_us, out);
    else {
        size_t n12 = (size_t)l->w * l->h * 3 / 2; if (n12 > l->nv12_cap) { uint8_t *n = realloc(l->nv12, n12); if (!n) return -1; l->nv12 = n; l->nv12_cap = n12; }
        cl_bgrx_to_nv12(l->scratch, l->w * 4, l->w, l->h, swap, l->nv12);
        rc = l->ops->encode(l->enc, l->nv12, pts_us, out);
    }
    if (rc != 0) return -1;
    l->frames++; l->win_frames++; l->win_bytes += out->size; l->last_au_us = t_us; *produced = 1;
    return 0;
}
/* Idle keep-alive for the low layer (a static screen produces no frames; the SFU and receivers still need AUs): re-encode its last input. */
static inline int cl_low_repeat(ClLow *l, uint64_t t_us, ClEncPacket *out, int *produced) {
    *produced = 0;
    if (!l->enc || !l->ops->encode_repeat) return 0;
    if (l->ops->encode_repeat(l->enc, t_us, out) != 0) return -1;
    l->last_au_us = t_us; l->win_frames++; l->win_bytes += out->size; *produced = 1;
    return 0;
}
#endif
