/*
 * "pcm" test backend: a tiny, dependency-free, all-intra H.264 encoder (Constrained Baseline, every macroblock I_PCM, every frame an IDR).
 * It exists ONLY so capture, transport, injection and decoding can be proven on a machine with no GPU: the output is a valid H.264
 * stream any decoder reads, at the cost of uncompressed size (1.5 bytes/pixel). It is never selected for a real share (decideShareBackend
 * only knows nvenc/vaapi) and must not be given large frames or high frame rates. Colour: BT.709, limited range (what the VUI-less
 * default of a receiver assumes for HD).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "encoder.h"

typedef struct { uint8_t *p; size_t len, cap; uint32_t cur; int nbits; } BW;
static void bw_byte(BW *b, uint8_t v) { if (b->len == b->cap) { b->cap = b->cap ? b->cap * 2 : 4096; b->p = realloc(b->p, b->cap); } b->p[b->len++] = v; }
static void bw_bit(BW *b, int v) { b->cur = (b->cur << 1) | (uint32_t)(v & 1); if (++b->nbits == 8) { bw_byte(b, (uint8_t)b->cur); b->cur = 0; b->nbits = 0; } }
static void bw_bits(BW *b, uint32_t v, int n) { for (int i = n - 1; i >= 0; i--) bw_bit(b, (int)((v >> i) & 1)); }
static void bw_ue(BW *b, uint32_t v) { uint32_t x = v + 1; int n = 0; while ((x >> n) > 1) n++; bw_bits(b, 0, n); bw_bits(b, x, n + 1); }
static void bw_se(BW *b, int v) { bw_ue(b, v <= 0 ? (uint32_t)(-2 * v) : (uint32_t)(2 * v - 1)); }
static void bw_trailing(BW *b) { bw_bit(b, 1); while (b->nbits) bw_bit(b, 0); }
static void bw_align_zero(BW *b) { while (b->nbits) bw_bit(b, 0); }

struct ClEncoder {
    int w, h, mbw, mbh; int have; uint32_t n;   /* n: IDR counter (idr_pic_id must differ between consecutive IDRs) */
    uint8_t *y, *u, *v;           /* padded to whole macroblocks */
    uint8_t *out; size_t cap;
};

/* NAL with emulation prevention and a 4-byte start code appended to out */
static void put_nal(uint8_t **out, size_t *len, size_t *cap, int ref_idc, int type, const uint8_t *rbsp, size_t n) {
    size_t need = *len + 4 + 1 + n + n / 2 + 8;
    if (need > *cap) { *cap = need * 2; *out = realloc(*out, *cap); }
    uint8_t *o = *out + *len;
    *o++ = 0; *o++ = 0; *o++ = 0; *o++ = 1; *o++ = (uint8_t)((ref_idc << 5) | type);
    int zeros = 0;
    for (size_t i = 0; i < n; i++) {
        if (zeros >= 2 && rbsp[i] <= 3) { *o++ = 3; zeros = 0; }
        *o++ = rbsp[i]; zeros = rbsp[i] == 0 ? zeros + 1 : 0;
    }
    *len = (size_t)(o - *out);
}

static int pcm_open(ClEncoder **outp, ClEncCfg *c, char *err, size_t errlen) {
    if (c->width < 16 || c->height < 16 || (c->width & 1) || (c->height & 1)) { snprintf(err, errlen, "pcm backend needs even dimensions >= 16"); return -1; }
    if ((long)c->width * c->height > 1920L * 1080) { snprintf(err, errlen, "pcm test backend refuses frames above 1920x1080 (uncompressed)"); c->max_w = 1920; c->max_h = 1080; c->fail_code = 3; return -1; }
    ClEncoder *e = calloc(1, sizeof *e);
    e->w = c->width; e->h = c->height; e->mbw = (e->w + 15) / 16; e->mbh = (e->h + 15) / 16;
    size_t ysz = (size_t)e->mbw * 16 * e->mbh * 16;
    e->y = malloc(ysz); e->u = malloc(ysz / 4); e->v = malloc(ysz / 4);
    *outp = e; return 0;
}
static void pcm_close(ClEncoder *e) { if (!e) return; free(e->y); free(e->u); free(e->v); free(e->out); free(e); }

static uint8_t clamp8(int v) { return (uint8_t)(v < 1 ? 1 : v > 254 ? 254 : v); }
static void pad_edges(ClEncoder *e) {
    int pw = e->mbw * 16, ph = e->mbh * 16;
    for (int y = 0; y < e->h; y++) for (int x = e->w; x < pw; x++) e->y[(size_t)y * pw + x] = e->y[(size_t)y * pw + e->w - 1];
    for (int y = e->h; y < ph; y++) memcpy(e->y + (size_t)y * pw, e->y + (size_t)(e->h - 1) * pw, (size_t)pw);
    int cw = pw / 2, ch = ph / 2, rw = e->w / 2, rh = e->h / 2;
    for (int y = 0; y < rh; y++) for (int x = rw; x < cw; x++) { e->u[(size_t)y * cw + x] = e->u[(size_t)y * cw + rw - 1]; e->v[(size_t)y * cw + x] = e->v[(size_t)y * cw + rw - 1]; }
    for (int y = rh; y < ch; y++) { memcpy(e->u + (size_t)y * cw, e->u + (size_t)(rh - 1) * cw, (size_t)cw); memcpy(e->v + (size_t)y * cw, e->v + (size_t)(rh - 1) * cw, (size_t)cw); }
}

static int emit(ClEncoder *e, uint64_t cap_us, ClEncPacket *pkt) {
    size_t len = 0;
    BW b = {0};
    /* SPS: Constrained Baseline L5.1, POC type 2 (output order = decode order) */
    bw_bits(&b, 66, 8); bw_bits(&b, 0xC0, 8); bw_bits(&b, 51, 8); bw_ue(&b, 0);
    bw_ue(&b, 0); bw_ue(&b, 2); bw_ue(&b, 1); bw_bit(&b, 0);
    bw_ue(&b, (uint32_t)e->mbw - 1); bw_ue(&b, (uint32_t)e->mbh - 1); bw_bit(&b, 1); bw_bit(&b, 1);
    int cr = e->mbw * 16 != e->w || e->mbh * 16 != e->h;
    bw_bit(&b, cr);
    if (cr) { bw_ue(&b, 0); bw_ue(&b, (uint32_t)(e->mbw * 16 - e->w) / 2); bw_ue(&b, 0); bw_ue(&b, (uint32_t)(e->mbh * 16 - e->h) / 2); }
    /* VUI with bitstream_restriction (num_reorder_frames 0, max_dec_frame_buffering 1). Without it Chromium's RECEIVER rewrites the SPS
       (WebRTC SpsVuiRewriter) before LiveKit's cryptor sees the frame, the clear prefix (SPS+PPS+slice header) that is AES-GCM additional
       data then differs from the sender's, and every E2EE frame fails authentication (see utils/e2eeSpsVui.ts). */
    int legacy = getenv("CL_PCM_LEGACY") != NULL; /* test aid: the pre-fix stream shape (no VUI, slice_type 7) that the injector's normalizer must repair */
    if (legacy) bw_bit(&b, 0); else {
    bw_bit(&b, 1);
    bw_bit(&b, 0); bw_bit(&b, 0); bw_bit(&b, 0); bw_bit(&b, 0); bw_bit(&b, 0); /* aspect, overscan, video_signal, chroma_loc, timing */
    bw_bit(&b, 0); bw_bit(&b, 0); bw_bit(&b, 0);                                /* nal_hrd, vcl_hrd, pic_struct */
    bw_bit(&b, 1); bw_bit(&b, 1); bw_ue(&b, 0); bw_ue(&b, 0); bw_ue(&b, 15); bw_ue(&b, 15); bw_ue(&b, 0); bw_ue(&b, 1); }
    bw_trailing(&b);
    put_nal(&e->out, &len, &e->cap, 3, 7, b.p, b.len); b.len = 0; b.nbits = 0; b.cur = 0;
    /* PPS: CAVLC, deblocking control present */
    bw_ue(&b, 0); bw_ue(&b, 0); bw_bit(&b, 0); bw_bit(&b, 0); bw_ue(&b, 0); bw_ue(&b, 0); bw_ue(&b, 0); bw_bit(&b, 0); bw_bits(&b, 0, 2);
    bw_se(&b, 0); bw_se(&b, 0); bw_se(&b, 0); bw_bit(&b, 1); bw_bit(&b, 0); bw_bit(&b, 0); bw_trailing(&b);
    put_nal(&e->out, &len, &e->cap, 3, 8, b.p, b.len); b.len = 0; b.nbits = 0; b.cur = 0;
    /* IDR slice, all I_PCM */
    /* slice_type 2 (I), not 7 (all-I): first_mb_in_slice + slice_type + pic_parameter_set_id then fit in the ONE byte after the NAL header that
       LiveKit leaves in the clear. With 7 the pps_id bit is ciphertext, the receiver's SPS/PPS tracker reads garbage and drops ~half of the IDRs. */
    bw_ue(&b, 0); bw_ue(&b, legacy ? 7 : 2); bw_ue(&b, 0); bw_bits(&b, 0, 4); bw_ue(&b, e->n++ & 1);
    bw_bit(&b, 0); bw_bit(&b, 0); bw_se(&b, 0); bw_ue(&b, 1);
    int pw = e->mbw * 16, cw = pw / 2;
    for (int my = 0; my < e->mbh; my++) for (int mx = 0; mx < e->mbw; mx++) {
        bw_ue(&b, 25); bw_align_zero(&b);
        for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) bw_byte(&b, e->y[(size_t)(my * 16 + y) * pw + mx * 16 + x]);
        for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) bw_byte(&b, e->u[(size_t)(my * 8 + y) * cw + mx * 8 + x]);
        for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) bw_byte(&b, e->v[(size_t)(my * 8 + y) * cw + mx * 8 + x]);
    }
    bw_trailing(&b);
    put_nal(&e->out, &len, &e->cap, 3, 5, b.p, b.len); free(b.p);
    pkt->data = e->out; pkt->size = len; pkt->is_key = 1; pkt->capture_us = cap_us; return 0;
}

static int pcm_encode_bgrx(ClEncoder *e, const uint8_t *px, int stride, int swap_rb, uint64_t cap_us, ClEncPacket *pkt) {
    int pw = e->mbw * 16, cw = pw / 2;
    for (int y = 0; y < e->h; y++) {
        const uint8_t *s = px + (size_t)y * (size_t)stride;
        for (int x = 0; x < e->w; x++) {
            int B = s[x * 4], G = s[x * 4 + 1], R = s[x * 4 + 2]; if (swap_rb) { int t = B; B = R; R = t; }
            e->y[(size_t)y * pw + x] = clamp8((int)(16 + (47 * R + 157 * G + 16 * B + 128) / 256));      /* BT.709 limited: Y = 16 + 0.183R + 0.614G + 0.062B */
            if (!(y & 1) && !(x & 1)) {
                const uint8_t *s2 = s + (y + 1 < e->h ? stride : 0); int R2 = (s[x * 4 + 2] + s[x * 4 + 6] + s2[x * 4 + 2] + s2[x * 4 + 6]) / 4, G2 = (s[x * 4 + 1] + s[x * 4 + 5] + s2[x * 4 + 1] + s2[x * 4 + 5]) / 4, B2 = (s[x * 4] + s[x * 4 + 4] + s2[x * 4] + s2[x * 4 + 4]) / 4;
                if (swap_rb) { int t = B2; B2 = R2; R2 = t; }
                e->u[(size_t)(y / 2) * cw + x / 2] = clamp8(128 + (-26 * R2 - 87 * G2 + 112 * B2 + 128) / 256);
                e->v[(size_t)(y / 2) * cw + x / 2] = clamp8(128 + (112 * R2 - 102 * G2 - 10 * B2 + 128) / 256);
            }
        }
    }
    pad_edges(e); e->have = 1; return emit(e, cap_us, pkt);
}
static int pcm_encode(ClEncoder *e, const uint8_t *nv12, uint64_t cap_us, ClEncPacket *pkt) {
    int pw = e->mbw * 16, cw = pw / 2;
    for (int y = 0; y < e->h; y++) memcpy(e->y + (size_t)y * pw, nv12 + (size_t)y * e->w, (size_t)e->w);
    const uint8_t *uv = nv12 + (size_t)e->w * e->h;
    for (int y = 0; y < e->h / 2; y++) for (int x = 0; x < e->w / 2; x++) { e->u[(size_t)y * cw + x] = clamp8(uv[(size_t)y * e->w + x * 2]); e->v[(size_t)y * cw + x] = clamp8(uv[(size_t)y * e->w + x * 2 + 1]); }
    pad_edges(e); e->have = 1; return emit(e, cap_us, pkt);
}
static int pcm_repeat(ClEncoder *e, uint64_t cap_us, ClEncPacket *pkt) { return e->have ? emit(e, cap_us, pkt) : -1; }
static void pcm_idr(ClEncoder *e) { (void)e; }
static int pcm_br(ClEncoder *e, int bps) { (void)e; (void)bps; return 0; }
static void pcm_describe(ClEncoder *e, char *buf, size_t n) { (void)e; snprintf(buf, n, "\"gpu\":\"none (software test backend)\",\"profile\":\"baseline\",\"input\":\"bgrx\""); }

const ClEncoderOps cl_enc_pcm = { "pcm", pcm_open, pcm_encode, pcm_idr, pcm_idr, pcm_br, pcm_close, pcm_encode_bgrx, pcm_repeat, pcm_describe };
