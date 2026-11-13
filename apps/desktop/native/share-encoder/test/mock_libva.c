/*
 * A MOCK libva (test only, never shipped): just enough of the API for enc_vaapi.c, behaving like different driver families so the
 * helper's capability-driven selection, ladder, self-test and report can be exercised with NO GPU. Selected by CL_MOCK:
 *   radeonsi  Mesa-like: ConstrainedBaseline+Main EncSlice, CBR|VBR|CQP, NO packed headers (driver writes SPS/PPS/slice itself,
 *             SPS without VUI, IDR slice_type 7), max 4096x2304
 *   ihd-lp    iHD on Gen9.5-like: ConstrainedBaseline EncSliceLP only, CQP only, all packed headers, intra refresh
 *   i965      legacy Intel: EncSlice, CBR|CQP, all packed headers
 *   noenc     driver with no encode entrypoint
 *   badsps    radeonsi-like but its SPS describes the wrong picture size (self-test must reject every candidate)
 *   small     radeonsi-like with a 1280x720 limit
 *   nosps     packed-header-less driver that forgets SPS/PPS on the IDR (self-test must reject)
 * It does NOT encode anything: the "access units" are structurally valid NAL sequences with filler slice data.
 * This validates the control logic, not any real driver's behaviour.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <va/va.h>
#include <va/va_drm.h>
#include <va/va_enc_h264.h>

static const char *MODE(void) { const char *m = getenv("CL_MOCK"); return m ? m : "radeonsi"; }
static int is(const char *m) { return !strcmp(MODE(), m); }
static int radeon_like(void) { return is("radeonsi") || is("badsps") || is("small") || is("nosps"); }

typedef struct { int used; VABufferType type; unsigned size; uint8_t *data; } Buf;
static Buf bufs[256];
static int g_mbw, g_mbh, g_idr, g_packed_seq, g_packed_pic, g_packed_slice;
static uint8_t g_seq[256], g_pic[256], g_slc[256]; static int g_seq_n, g_pic_n, g_slc_n;
static VAEncPackedHeaderType g_last_ph;
static unsigned g_cfg_packed;
static VABufferID g_coded;

static struct { int dummy; } disp;
VADisplay vaGetDisplayDRM(int fd) { (void)fd; return &disp; }
VAStatus vaInitialize(VADisplay d, int *a, int *b) { (void)d; *a = 1; *b = 20; return VA_STATUS_SUCCESS; }
VAStatus vaTerminate(VADisplay d) { (void)d; return VA_STATUS_SUCCESS; }
const char *vaQueryVendorString(VADisplay d) {
    (void)d;
    if (is("ihd-lp")) return "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()";
    if (is("i965")) return "Intel i965 driver - 2.4.1";
    if (is("noenc")) return "Mesa Gallium driver 24.0.5 for AMD Radeon (radeonsi, mock)";
    return "Mesa Gallium driver 24.0.5 for AMD Radeon RX 6600 (radeonsi, navi23, LLVM 17.0.6, DRM 3.57, mock)";
}
const char *vaErrorStr(VAStatus s) { (void)s; return "mock error"; }
int vaMaxNumProfiles(VADisplay d) { (void)d; return 8; }
int vaMaxNumEntrypoints(VADisplay d) { (void)d; return 8; }
VAStatus vaQueryConfigProfiles(VADisplay d, VAProfile *p, int *n) { (void)d; p[0] = VAProfileH264ConstrainedBaseline; p[1] = VAProfileH264Main; *n = 2; return VA_STATUS_SUCCESS; }
VAStatus vaQueryConfigEntrypoints(VADisplay d, VAProfile p, VAEntrypoint *e, int *n) {
    (void)d; *n = 0;
    if (is("noenc")) { e[(*n)++] = VAEntrypointVLD; return VA_STATUS_SUCCESS; }
    if (is("ihd-lp")) { if (p == VAProfileH264ConstrainedBaseline) e[(*n)++] = VAEntrypointEncSliceLP; return VA_STATUS_SUCCESS; }
    e[(*n)++] = VAEntrypointVLD; e[(*n)++] = VAEntrypointEncSlice;
    return VA_STATUS_SUCCESS;
}
VAStatus vaGetConfigAttributes(VADisplay d, VAProfile p, VAEntrypoint ep, VAConfigAttrib *a, int n) {
    (void)d; (void)p; (void)ep;
    for (int i = 0; i < n; i++) {
        unsigned v = VA_ATTRIB_NOT_SUPPORTED;
        switch (a[i].type) {
        case VAConfigAttribRTFormat: v = VA_RT_FORMAT_YUV420; break;
        case VAConfigAttribRateControl: v = is("ihd-lp") ? VA_RC_CQP : is("i965") ? (VA_RC_CBR | VA_RC_CQP) : (VA_RC_CBR | VA_RC_VBR | VA_RC_CQP); break;
        case VAConfigAttribEncPackedHeaders: v = radeon_like() ? VA_ENC_PACKED_HEADER_NONE : (VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE | VA_ENC_PACKED_HEADER_SLICE | VA_ENC_PACKED_HEADER_MISC); break;
        case VAConfigAttribMaxPictureWidth: v = is("small") ? 1280 : radeon_like() ? 4096 : 8192; break;
        case VAConfigAttribMaxPictureHeight: v = is("small") ? 720 : radeon_like() ? 2304 : 8192; break;
        case VAConfigAttribEncIntraRefresh: if (is("ihd-lp")) v = VA_ENC_INTRA_REFRESH_ROLLING_COLUMN | VA_ENC_INTRA_REFRESH_ROLLING_ROW; break;
        case VAConfigAttribEncMaxSlices: v = 32; break;
        case VAConfigAttribEncMaxRefFrames: v = 1; break;
        default: break;
        }
        a[i].value = v;
    }
    return VA_STATUS_SUCCESS;
}
VAStatus vaCreateConfig(VADisplay d, VAProfile p, VAEntrypoint e, VAConfigAttrib *a, int n, VAConfigID *id) {
    (void)d; (void)p; (void)e; g_cfg_packed = 0;
    for (int i = 0; i < n; i++) if (a[i].type == VAConfigAttribEncPackedHeaders) g_cfg_packed = a[i].value;
    *id = 1; return VA_STATUS_SUCCESS;
}
VAStatus vaDestroyConfig(VADisplay d, VAConfigID c) { (void)d; (void)c; return VA_STATUS_SUCCESS; }
VAStatus vaCreateSurfaces(VADisplay d, unsigned f, unsigned w, unsigned h, VASurfaceID *s, unsigned n, VASurfaceAttrib *a, unsigned na) {
    (void)d; (void)f; (void)w; (void)h; (void)a; (void)na; for (unsigned i = 0; i < n; i++) s[i] = 100 + i; return VA_STATUS_SUCCESS;
}
VAStatus vaDestroySurfaces(VADisplay d, VASurfaceID *s, int n) { (void)d; (void)s; (void)n; return VA_STATUS_SUCCESS; }
VAStatus vaCreateContext(VADisplay d, VAConfigID c, int w, int h, int fl, VASurfaceID *s, int n, VAContextID *id) {
    (void)d; (void)c; (void)fl; (void)s; (void)n; g_mbw = w / 16; g_mbh = h / 16; *id = 1; return VA_STATUS_SUCCESS;
}
VAStatus vaDestroyContext(VADisplay d, VAContextID c) { (void)d; (void)c; return VA_STATUS_SUCCESS; }

VAStatus vaCreateBuffer(VADisplay d, VAContextID c, VABufferType t, unsigned size, unsigned num, void *data, VABufferID *id) {
    (void)d; (void)c;
    for (int i = 1; i < 256; i++) if (!bufs[i].used) {
        bufs[i].used = 1; bufs[i].type = t; bufs[i].size = size * num; bufs[i].data = calloc(1, size * num + 8);
        if (data) memcpy(bufs[i].data, data, size * num);
        *id = (VABufferID)i; if (t == VAEncCodedBufferType) g_coded = *id; return VA_STATUS_SUCCESS;
    }
    return VA_STATUS_ERROR_ALLOCATION_FAILED;
}
VAStatus vaDestroyBuffer(VADisplay d, VABufferID b) { (void)d; if (b < 256 && bufs[b].used) { free(bufs[b].data); bufs[b].used = 0; } return VA_STATUS_SUCCESS; }
static VACodedBufferSegment seg;
VAStatus vaMapBuffer(VADisplay d, VABufferID b, void **p) {
    (void)d;
    if (b == g_coded) { seg.size = g_seq_n; seg.buf = bufs[b].data; seg.next = NULL; seg.bit_offset = 0; seg.status = 0; *p = &seg; return VA_STATUS_SUCCESS; }
    *p = bufs[b].data; return VA_STATUS_SUCCESS;
}
VAStatus vaUnmapBuffer(VADisplay d, VABufferID b) { (void)d; (void)b; return VA_STATUS_SUCCESS; }
VAStatus vaCreateImage(VADisplay d, VAImageFormat *f, int w, int h, VAImage *im) {
    memset(im, 0, sizeof *im); VABufferID b; vaCreateBuffer(d, 1, VAImageBufferType, (unsigned)(w * h * 3 / 2), 1, NULL, &b);
    im->image_id = 500 + b; im->buf = b; im->format = *f; im->width = w; im->height = h; im->num_planes = 2;
    im->pitches[0] = im->pitches[1] = (uint32_t)w; im->offsets[0] = 0; im->offsets[1] = (uint32_t)(w * h); return VA_STATUS_SUCCESS;
}
VAStatus vaDestroyImage(VADisplay d, VAImageID i) { (void)d; (void)i; return VA_STATUS_SUCCESS; }
VAStatus vaDeriveImage(VADisplay d, VASurfaceID s, VAImage *im) { (void)d; (void)s; (void)im; return VA_STATUS_ERROR_OPERATION_FAILED; }
VAStatus vaPutImage(VADisplay d, VASurfaceID s, VAImageID i, int a, int b, unsigned c, unsigned e, int f, int g, unsigned h, unsigned k) { (void)d; (void)s; (void)i; (void)a; (void)b; (void)c; (void)e; (void)f; (void)g; (void)h; (void)k; return VA_STATUS_SUCCESS; }

VAStatus vaBeginPicture(VADisplay d, VAContextID c, VASurfaceID s) { (void)d; (void)c; (void)s; g_seq_n = 0; g_idr = 0; g_packed_seq = g_packed_pic = g_packed_slice = 0; g_pic_n = g_slc_n = 0; return VA_STATUS_SUCCESS; }

/* tiny bit writer for the mock driver's own SPS/PPS */
typedef struct { uint8_t b[128]; int n; } W;
static void wb(W *w, int bits, unsigned v) { for (int i = bits - 1; i >= 0; i--) { if ((v >> i) & 1) w->b[w->n >> 3] |= 0x80 >> (w->n & 7); w->n++; } }
static void wue(W *w, unsigned v) { v++; int l = 0; for (unsigned t = v; t; t >>= 1) l++; wb(w, l - 1, 0); wb(w, l, v); }
static void wtrail(W *w) { wb(w, 1, 1); while (w->n & 7) wb(w, 1, 0); }
static int put_nal(uint8_t *o, int ref, int type, const uint8_t *r, int n) { int k = 0; o[k++] = 0; o[k++] = 0; o[k++] = 0; o[k++] = 1; o[k++] = (uint8_t)((ref << 5) | type); memcpy(o + k, r, (size_t)n); return k + n; }

VAStatus vaRenderPicture(VADisplay d, VAContextID c, VABufferID *ids, int n) {
    (void)d; (void)c;
    for (int i = 0; i < n; i++) {
        Buf *b = &bufs[ids[i]];
        if (b->type == VAEncSequenceParameterBufferType) { VAEncSequenceParameterBufferH264 *s = (void *)b->data; g_mbw = s->picture_width_in_mbs; g_mbh = s->picture_height_in_mbs; }
        else if (b->type == VAEncPictureParameterBufferType) { VAEncPictureParameterBufferH264 *p = (void *)b->data; g_idr = p->pic_fields.bits.idr_pic_flag; }
        else if (b->type == VAEncPackedHeaderParameterBufferType) g_last_ph = ((VAEncPackedHeaderParameterBuffer *)b->data)->type;
        else if (b->type == VAEncPackedHeaderDataBufferType) {
            if (!(g_cfg_packed & (VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE))) return VA_STATUS_ERROR_INVALID_PARAMETER; /* like a driver that rejects them */
            if (g_last_ph == VAEncPackedHeaderSequence) { memcpy(g_seq, b->data, b->size); g_seq_n = (int)b->size; g_packed_seq = 1; }
            else if (g_last_ph == VAEncPackedHeaderPicture) { memcpy(g_pic, b->data, b->size); g_pic_n = (int)b->size; g_packed_pic = 1; }
            else if (g_last_ph == VAEncPackedHeaderSlice) { memcpy(g_slc, b->data, b->size); g_slc_n = (int)b->size; g_packed_slice = 1; }
        }
    }
    return VA_STATUS_SUCCESS;
}

VAStatus vaEndPicture(VADisplay d, VAContextID c) {
    (void)d; (void)c; uint8_t *o = bufs[g_coded].data; int k = 0;
    /* packed headers are consumed into locals above; g_seq_n is reused as the OUTPUT length, so rebuild from copies */
    static uint8_t seq_copy[256], pic_copy[256], slc_copy[256]; int sn = g_seq_n, pn = g_pic_n, ln = g_slc_n;
    memcpy(seq_copy, g_seq, sizeof seq_copy); memcpy(pic_copy, g_pic, sizeof pic_copy); memcpy(slc_copy, g_slc, sizeof slc_copy);
    uint8_t filler[40]; memset(filler, 0x55, sizeof filler);
    if (g_idr) {
        if (g_packed_seq) { memcpy(o + k, seq_copy, (size_t)sn); k += sn; memcpy(o + k, pic_copy, (size_t)pn); k += pn; }
        else if (!is("nosps")) {
            W w; memset(&w, 0, sizeof w); wb(&w, 8, 66); wb(&w, 8, 0xC0); wb(&w, 8, 40); wue(&w, 0); wue(&w, 4); wue(&w, 2); wue(&w, 1); wb(&w, 1, 0);
            int bad = is("badsps"); wue(&w, (unsigned)(g_mbw - 1 + bad)); wue(&w, (unsigned)(g_mbh - 1)); wb(&w, 1, 1); wb(&w, 1, 1); wb(&w, 1, 0); wb(&w, 1, 0); wtrail(&w);
            k += put_nal(o + k, 3, 7, w.b, w.n >> 3);
            W p; memset(&p, 0, sizeof p); wue(&p, 0); wue(&p, 0); wb(&p, 1, 0); wb(&p, 1, 0); wue(&p, 0); wue(&p, 0); wue(&p, 0); wb(&p, 1, 0); wb(&p, 2, 0); wue(&p, 0); wue(&p, 0); wue(&p, 0); wb(&p, 1, 1); wb(&p, 1, 0); wb(&p, 1, 0); wtrail(&p);
            k += put_nal(o + k, 3, 8, p.b, p.n >> 3);
        }
        /* driver-written (or echoed) slice: IDR NAL with slice_type 7 header bits 1 0001000 1 then filler */
        uint8_t sl[44]; sl[0] = 0x88; sl[1] = 0x80; memcpy(sl + 2, filler, 38); k += put_nal(o + k, 3, 5, sl, 40);
    } else {
        uint8_t sl[44]; sl[0] = 0x9a; sl[1] = 0x00; memcpy(sl + 2, filler, 30); k += put_nal(o + k, 2, 1, sl, 32);
    }
    g_seq_n = k; return VA_STATUS_SUCCESS;
}
VAStatus vaSyncSurface(VADisplay d, VASurfaceID s) { (void)d; (void)s; return VA_STATUS_SUCCESS; }
