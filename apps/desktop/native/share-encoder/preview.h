/*
 * The sharer's own preview of a native share, helper side. The real frames only exist as encoded bytes inside the E2EE flow, so the
 * tile cannot draw the (stand-in) track; instead, WHILE THE RENDERER ASKS, the helper hands it a small downscaled copy of the frame it
 * is already encoding: a nearest-neighbour sample of at most max_w x ~max_w*9/16 pixels (a few hundred KB) a few times a second.
 * No second encoder session, no decode, no extra capture: the cost is one strided read of ~100k pixels per preview frame, and nothing
 * at all while it is off ("PREVIEW OFF", the default, and whenever the tile is not on screen).
 *
 * Stdin: "PREVIEW <max_w> <fps>" / "PREVIEW OFF". Stdout record: the usual 24-byte header with flag bit2 set, then
 *   u16 w | u16 h | w*h*4 bytes of R,G,B,255 (canvas ImageData order). Never carries a key/low flag; the injector ignores it as an access unit.
 * Header-only so test/preview_test.c exercises exactly the code the capture loop runs.
 */
#ifndef CL_PREVIEW_H
#define CL_PREVIEW_H
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CL_AU_FLAG_PREVIEW 4
#define CL_PREVIEW_MIN_W 64
#define CL_PREVIEW_MAX_W 1280
#define CL_PREVIEW_MAX_FPS 15
#define CL_PREVIEW_RESEND_US 1000000u   /* a static screen sends no frames: re-send the last picture this often so the tile is never blank */

typedef struct ClPreview {
    int on, max_w, fps;
    uint64_t period_us, last_us;
    uint8_t *buf; size_t cap, len;   /* u16 w | u16 h | pixels: the last picture, kept only while on */
} ClPreview;

/* Arguments after "PREVIEW ". 1 = on (w/fps filled), 0 = "OFF", -1 = invalid. Plain digits only (see cl_low_int: no sscanf/strtol). */
static inline int cl_preview_parse(const char *args, int *w, int *fps) {
    if (!strcmp(args, "OFF")) return 0;
    long v[2]; const char *p = args;
    for (int i = 0; i < 2; i++) {
        if (i > 0) { if (*p != ' ') return -1; p++; }
        long x = 0; int n = 0;
        while (*p >= '0' && *p <= '9') { x = x * 10 + (*p - '0'); if (x > 100000) return -1; p++; n++; }
        if (n == 0) return -1;
        v[i] = x;
    }
    if (*p != 0) return -1;
    if (v[0] < CL_PREVIEW_MIN_W || v[0] > CL_PREVIEW_MAX_W || v[1] < 1 || v[1] > CL_PREVIEW_MAX_FPS) return -1;
    *w = (int)v[0]; *fps = (int)v[1]; return 1;
}

static inline void cl_preview_set(ClPreview *p, int on, int w, int fps) {
    if (!on) { free(p->buf); memset(p, 0, sizeof *p); return; }
    p->on = 1; p->max_w = w; p->fps = fps; p->period_us = 1000000u / (uint64_t)fps; p->last_us = 0; p->len = 0;
}

/* Output size for a source: fits max_w wide, keeps the aspect, never upscales, even-free (any size >= 1). */
static inline void cl_preview_size(int sw, int sh, int max_w, int *dw, int *dh) {
    int w = sw < max_w ? sw : max_w; int64_t h = (int64_t)sh * w / sw;
    if (h < 1) h = 1;
    *dw = w; *dh = (int)h;
}

/*
 * One captured frame -> (when due) the preview picture in p->buf/p->len. Returns 1 when a NEW picture was made. `swap` = the source is RGBx
 * (R and B already in canvas order), otherwise BGRx is swapped here. 0 when off, not due, or the allocation failed.
 */
static inline int cl_preview_frame(ClPreview *p, const uint8_t *px, int sw, int sh, int stride, int swap, uint64_t t_us) {
    if (!p->on || sw < 1 || sh < 1 || (p->last_us && t_us - p->last_us < p->period_us)) return 0;
    int dw, dh; cl_preview_size(sw, sh, p->max_w, &dw, &dh);
    size_t need = 4 + (size_t)dw * dh * 4;
    if (need > p->cap) { uint8_t *n = realloc(p->buf, need); if (!n) return 0; p->buf = n; p->cap = need; }
    p->buf[0] = (uint8_t)dw; p->buf[1] = (uint8_t)(dw >> 8); p->buf[2] = (uint8_t)dh; p->buf[3] = (uint8_t)(dh >> 8);
    uint8_t *d = p->buf + 4;
    for (int y = 0; y < dh; y++) {
        const uint8_t *s = px + (size_t)((int64_t)y * sh / dh) * (size_t)stride;
        for (int x = 0; x < dw; x++) {
            const uint8_t *q = s + (size_t)((int64_t)x * sw / dw) * 4;
            *d++ = swap ? q[0] : q[2]; *d++ = q[1]; *d++ = swap ? q[2] : q[0]; *d++ = 255;
        }
    }
    p->len = need; p->last_us = t_us;
    return 1;
}

/* Idle tick: 1 when the last picture is due for a re-send (a screen that stopped changing). */
static inline int cl_preview_resend_due(const ClPreview *p, uint64_t t_us) {
    return p->on && p->len > 0 && t_us - p->last_us >= CL_PREVIEW_RESEND_US;
}
#endif
