/*
 * VA-API H.264 backend for the native share encoder: Intel (iHD, legacy i965) and AMD (Mesa radeonsi: VCE on GCN/Polaris, VCN on
 * Vega/RDNA).
 *
 * libva (MIT) headers are build-time only; libva.so.2 / libva-drm.so.2 are dlopen()ed, so the helper starts on a machine without VA-API
 * and reports "unavailable" instead of failing to load.
 *
 * Nothing is assumed about the driver. open() ENUMERATES the render nodes, asks each one what it can do (profiles, entrypoints,
 * VAConfigAttrib: rate control, packed headers, max picture size, max slices/refs, intra refresh), builds a LADDER of candidate
 * configurations and takes the first that (a) opens and (b) passes a SELF-TEST: two real frames are encoded (IDR + P) and the access
 * units are checked structurally (SPS+PPS+IDR slice, the picture size the driver wrote into its SPS matches ours, a non-IDR slice
 * follows). A candidate that fails for any reason is skipped and the reason recorded, so a driver quirk costs a fallback step, not a
 * broken share. The helper reports the node, GPU, driver and the chosen configuration (describe) and, for the tester, everything it
 * saw (cl_vaapi_report).
 *
 * Stream shape (makes the receiver's life trivial and the E2EE injector's normaliser a near no-op): H.264 Constrained Baseline (or Main
 * with CAVLC and no B frames when the driver has no Baseline), one slice per frame, POC type 2, 1 reference frame, IDR only on request.
 * Every IDR carries SPS+PPS. Two driver families, handled by capability not by name:
 *   - drivers with packed-header support (iHD, i965): WE write SPS (with VUI bitstream_restriction), PPS and the slice header;
 *   - drivers without it (Mesa radeonsi does not take packed sequence/picture/slice headers: it writes them itself): we only fill the
 *     VAEncSequenceParameterBuffer (incl. the VUI hint fields) and the driver's SPS/PPS/slice headers are used as they are; the injector
 *     (utils/h264ReceiverView.ts) repairs the receiver-visible parts of whatever the driver wrote.
 * Rate control: CBR when the driver offers it, else VBR with target = max, else CQP with a software per-frame controller (iHD EncSliceLP
 * without HuC firmware is CQP-only).
 *
 * NOT verified on hardware here (there is no GPU on the dev box): see docs/plans/native-share-encoder.md "Phase 5". The control logic is
 * exercised against a mock libva (test/mock_libva.c, `make test-vaapi`).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <dlfcn.h>
#include <dirent.h>
#include <time.h>
#include <stdarg.h>
#include <va/va.h>
#include <va/va_drm.h>
#include <va/va_enc_h264.h>
#include "encoder.h"

/* ── libva through dlopen ────────────────────────────────────────────────────────────────────────────────────────────── */
#define VA_FUNCS(X) X(vaGetDisplayDRM) X(vaInitialize) X(vaTerminate) X(vaQueryVendorString) X(vaErrorStr) X(vaMaxNumProfiles) \
    X(vaMaxNumEntrypoints) X(vaQueryConfigProfiles) X(vaQueryConfigEntrypoints) X(vaGetConfigAttributes) X(vaCreateConfig) X(vaDestroyConfig) \
    X(vaCreateSurfaces) X(vaDestroySurfaces) X(vaCreateContext) X(vaDestroyContext) X(vaCreateBuffer) X(vaDestroyBuffer) X(vaMapBuffer) \
    X(vaUnmapBuffer) X(vaCreateImage) X(vaDestroyImage) X(vaDeriveImage) X(vaPutImage) X(vaBeginPicture) X(vaRenderPicture) X(vaEndPicture) \
    X(vaSyncSurface)
static struct { void *h1, *h2;
#define X(n) __typeof__(&n) n;
    VA_FUNCS(X)
#undef X
} g_va;

static int va_load(char *err, size_t errlen) {
    if (g_va.h1) return 0;
    const char *p1 = "libva.so.2", *p2 = "libva-drm.so.2";
#ifdef CL_TEST_HOOKS
    if (getenv("CL_LIBVA_PATH")) p1 = p2 = getenv("CL_LIBVA_PATH");   /* test builds only: point both at a mock libva */
#endif
    g_va.h1 = dlopen(p1, RTLD_NOW | RTLD_LOCAL);
    if (!g_va.h1) { snprintf(err, errlen, "VA-API not available: %s could not be loaded", p1); return -1; }
    g_va.h2 = dlopen(p2, RTLD_NOW | RTLD_LOCAL);
    if (!g_va.h2) { snprintf(err, errlen, "VA-API not available: %s could not be loaded", p2); return -1; }
#define X(n) if (!(g_va.n = (__typeof__(&n))dlsym(!strcmp(#n, "vaGetDisplayDRM") ? g_va.h2 : g_va.h1, #n))) { snprintf(err, errlen, "libva lacks %s", #n); return -1; }
    VA_FUNCS(X)
#undef X
    return 0;
}
#define X(n)
#undef X
#define vaGetDisplayDRM g_va.vaGetDisplayDRM
#define vaInitialize g_va.vaInitialize
#define vaTerminate g_va.vaTerminate
#define vaQueryVendorString g_va.vaQueryVendorString
#define vaErrorStr g_va.vaErrorStr
#define vaMaxNumProfiles g_va.vaMaxNumProfiles
#define vaMaxNumEntrypoints g_va.vaMaxNumEntrypoints
#define vaQueryConfigProfiles g_va.vaQueryConfigProfiles
#define vaQueryConfigEntrypoints g_va.vaQueryConfigEntrypoints
#define vaGetConfigAttributes g_va.vaGetConfigAttributes
#define vaCreateConfig g_va.vaCreateConfig
#define vaDestroyConfig g_va.vaDestroyConfig
#define vaCreateSurfaces g_va.vaCreateSurfaces
#define vaDestroySurfaces g_va.vaDestroySurfaces
#define vaCreateContext g_va.vaCreateContext
#define vaDestroyContext g_va.vaDestroyContext
#define vaCreateBuffer g_va.vaCreateBuffer
#define vaDestroyBuffer g_va.vaDestroyBuffer
#define vaMapBuffer g_va.vaMapBuffer
#define vaUnmapBuffer g_va.vaUnmapBuffer
#define vaCreateImage g_va.vaCreateImage
#define vaDestroyImage g_va.vaDestroyImage
#define vaDeriveImage g_va.vaDeriveImage
#define vaPutImage g_va.vaPutImage
#define vaBeginPicture g_va.vaBeginPicture
#define vaRenderPicture g_va.vaRenderPicture
#define vaEndPicture g_va.vaEndPicture
#define vaSyncSurface g_va.vaSyncSurface

static uint64_t tnow(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (uint64_t)t.tv_sec*1000000+t.tv_nsec/1000;}
static uint64_t T_up,T_sub,T_sync,T_rd; static int T_n;
static void t_report(void){ if(getenv("CL_ENC_TIMING")&&T_n) fprintf(stderr,"{\"stage_ms_avg\":{\"upload\":%.2f,\"submit\":%.2f,\"sync\":%.2f,\"readback\":%.2f}}\n",T_up/1000.0/T_n,T_sub/1000.0/T_n,T_sync/1000.0/T_n,T_rd/1000.0/T_n);}
#define NSRC 2
#define NREC 2

/* ── bit writer / reader ─────────────────────────────────────────────────────────────────────────────────────────────── */
typedef struct { uint8_t b[1024]; int n; } BW; /* n = bits */
static void bw_put(BW *w, int bits, uint32_t v) {
    for (int i = bits - 1; i >= 0; i--) {
        if (w->n >= (int)sizeof(w->b) * 8) return;
        if ((v >> i) & 1) w->b[w->n >> 3] |= 0x80 >> (w->n & 7);
        w->n++;
    }
}
static void bw_ue(BW *w, uint32_t v) {
    v += 1; int len = 0; for (uint32_t t = v; t; t >>= 1) len++;
    bw_put(w, len - 1, 0); bw_put(w, len, v);
}
static void bw_se(BW *w, int v) { bw_ue(w, v <= 0 ? (uint32_t)(-2 * v) : (uint32_t)(2 * v - 1)); }
static void bw_trailing(BW *w) { bw_put(w, 1, 1); while (w->n & 7) bw_put(w, 1, 0); }

typedef struct { const uint8_t *d; int n, pos; int bad; } BR; /* RBSP bytes, n = bytes */
static int br_bit(BR *r) { if (r->pos >= r->n * 8) { r->bad = 1; return 0; } int v = (r->d[r->pos >> 3] >> (7 - (r->pos & 7))) & 1; r->pos++; return v; }
static uint32_t br_u(BR *r, int n) { uint32_t v = 0; while (n-- > 0) v = (v << 1) | (uint32_t)br_bit(r); return v; }
static uint32_t br_ue(BR *r) { int z = 0; while (!br_bit(r)) { if (++z > 31 || r->bad) { r->bad = 1; return 0; } } return ((1u << z) - 1) + (z ? br_u(r, z) : 0); }

/* start code + NAL header + RBSP with emulation prevention -> out; returns length */
static int nal_wrap(uint8_t *out, int nal_ref_idc, int nal_type, const uint8_t *rbsp, int rbsp_len) {
    int o = 0; out[o++] = 0; out[o++] = 0; out[o++] = 0; out[o++] = 1;
    out[o++] = (uint8_t)((nal_ref_idc << 5) | nal_type);
    int zeros = 0;
    for (int i = 0; i < rbsp_len; i++) {
        if (zeros >= 2 && rbsp[i] <= 3) { out[o++] = 3; zeros = 0; }
        out[o++] = rbsp[i];
        zeros = rbsp[i] == 0 ? zeros + 1 : 0;
    }
    return o;
}

/* ── structures ──────────────────────────────────────────────────────────────────────────────────────────────────────── */
#define MAXNODES 8
#define MAXCAND 8
typedef struct {
    VAProfile prof; VAEntrypoint ep;
    unsigned rc, packed, ir, slices, refs;   /* attribute masks / values (0 = not reported) */
    unsigned max_w, max_h;                   /* 0 = not reported */
    int has_rt420;
} VaCand;

typedef struct {
    char path[64];
    int vendor, device;                      /* PCI ids from sysfs, -1 unknown */
    char kdrv[32];                           /* kernel driver: i915 / xe / amdgpu / radeon / nvidia / nouveau ... */
    char vendor_str[160];                    /* vaQueryVendorString */
    int major, minor;                        /* libva version the driver was initialised with */
    VaCand cand[MAXCAND]; int ncand;
    int usable;                              /* has at least one H.264 encode candidate */
    char note[160];                          /* why not */
} VaNode;

struct ClEncoder {
    int fd; VADisplay dpy; VAConfigID cfg; VAContextID ctx; VaCand sel; VaNode node;
    VASurfaceID src[NSRC], rec[NREC]; VAImage img[NSRC]; VABufferID coded;
    int w, h, aw, ah, mbw, mbh, fps, bps, lp;
    int profile_idc;
    unsigned packed;           /* packed-header mask we actually supply (0 = driver writes its own headers) */
    int frame_num, cur_rec, have_ref, prev_frame_num, idr_pic_id, src_i;
    int idr_pending, rc_dirty, first;
    int derive_ok, idr_dq;
    int ir_ok, ir_left, ir_col, ir_size, ir_total, ir_hdr; /* rolling-column intra refresh state */
    uint8_t sei[24]; int sei_len;
    int swrc, qp, rcmode;      /* software rate control over CQP; rcmode: 0 CBR, 1 CQP(sw), 2 VBR */
    double vbuf;               /* virtual buffer fullness, bytes over the per-frame budget */
    uint8_t sps[128]; int sps_len; uint8_t pps[64]; int pps_len;
    uint8_t *out; size_t out_cap;
    char attempts[1024];       /* ladder log for the report */
    int in_selftest;
};

static const char *ep_name(VAEntrypoint e) { return e == VAEntrypointEncSlice ? "EncSlice" : e == VAEntrypointEncSliceLP ? "EncSliceLP" : "other"; }
static const char *prof_name(VAProfile p) { return p == VAProfileH264ConstrainedBaseline ? "ConstrainedBaseline" : p == VAProfileH264Main ? "Main" : p == VAProfileH264High ? "High" : "other"; }
static void sanitize(char *s) { for (; *s; s++) if (*s == '"' || *s == '\\' || (unsigned char)*s < 32 || (unsigned char)*s > 126) *s = ' '; }

/* ── sysfs ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */
static int sysfs_hex(const char *render, const char *file) {
    char p[160], b[32]; snprintf(p, sizeof p, "/sys/class/drm/%s/device/%s", render, file);
    FILE *f = fopen(p, "r"); if (!f) return -1;
    int v = -1; if (fgets(b, sizeof b, f)) v = (int)strtol(b, NULL, 16);
    fclose(f); return v;
}
static void sysfs_driver(const char *render, char *out, size_t n) {
    char p[160], t[256]; out[0] = 0; snprintf(p, sizeof p, "/sys/class/drm/%s/device/driver", render);
    ssize_t k = readlink(p, t, sizeof t - 1); if (k <= 0) return; t[k] = 0;
    const char *base = strrchr(t, '/'); snprintf(out, n, "%s", base ? base + 1 : t);
}

static int cmp_str(const void *a, const void *b) { return strcmp((const char *)a, (const char *)b); }

/* Render nodes, sorted by name. CL_VAAPI_DEVICE (a path) restricts to one. */
static int list_nodes(const char *forced, char paths[][64], int max) {
    int n = 0;
    if (forced && *forced) { snprintf(paths[n++], 64, "%s", forced); return n; }
    DIR *d = opendir("/dev/dri"); if (!d) return 0;
    struct dirent *e; char names[MAXNODES * 2][64]; int k = 0;
    while ((e = readdir(d)) && k < MAXNODES * 2) if (!strncmp(e->d_name, "renderD", 7)) snprintf(names[k++], 64, "%s", e->d_name);
    closedir(d);
    qsort(names, (size_t)k, 64, cmp_str);
    for (int i = 0; i < k && n < max; i++) snprintf(paths[n++], 64, "/dev/dri/%s", names[i]);
    return n;
}

/* ── node scan: what can this node do? ───────────────────────────────────────────────────────────────────────────────── */
static void scan_node(const char *path, VaNode *nd) {
    memset(nd, 0, sizeof *nd); nd->vendor = nd->device = -1; snprintf(nd->path, sizeof nd->path, "%s", path);
    const char *base = strrchr(path, '/'); base = base ? base + 1 : path;
    nd->vendor = sysfs_hex(base, "vendor"); nd->device = sysfs_hex(base, "device"); sysfs_driver(base, nd->kdrv, sizeof nd->kdrv);
    if (!strcmp(nd->kdrv, "nvidia") || !strcmp(nd->kdrv, "nouveau")) { snprintf(nd->note, sizeof nd->note, "NVIDIA node: VA-API has no H.264 encode here (NVENC is the path)"); return; }
    int fd = open(path, O_RDWR | O_CLOEXEC);
    if (fd < 0) { snprintf(nd->note, sizeof nd->note, "cannot open %s", path); return; }
    VADisplay dpy = vaGetDisplayDRM(fd);
    int maj = 0, min = 0;
    if (!dpy || vaInitialize(dpy, &maj, &min) != VA_STATUS_SUCCESS) { snprintf(nd->note, sizeof nd->note, "vaInitialize failed (no VA driver for this GPU)"); close(fd); return; }
    nd->major = maj; nd->minor = min;
    const char *vs = vaQueryVendorString(dpy); snprintf(nd->vendor_str, sizeof nd->vendor_str, "%s", vs ? vs : ""); sanitize(nd->vendor_str);
    static const VAProfile profs[] = { VAProfileH264ConstrainedBaseline, VAProfileH264Main };
    for (unsigned pi = 0; pi < sizeof profs / sizeof profs[0]; pi++) {
        int ne = vaMaxNumEntrypoints(dpy); if (ne <= 0 || ne > 32) ne = 16;
        VAEntrypoint eps[32]; int neps = 0;
        if (vaQueryConfigEntrypoints(dpy, profs[pi], eps, &neps) != VA_STATUS_SUCCESS) continue;
        for (int i = 0; i < neps && nd->ncand < MAXCAND; i++) {
            if (eps[i] != VAEntrypointEncSlice && eps[i] != VAEntrypointEncSliceLP) continue;
            VaCand *c = &nd->cand[nd->ncand]; memset(c, 0, sizeof *c); c->prof = profs[pi]; c->ep = eps[i];
            VAConfigAttrib at[8] = { { VAConfigAttribRTFormat, 0 }, { VAConfigAttribRateControl, 0 }, { VAConfigAttribEncPackedHeaders, 0 },
                                     { VAConfigAttribMaxPictureWidth, 0 }, { VAConfigAttribMaxPictureHeight, 0 }, { VAConfigAttribEncIntraRefresh, 0 },
                                     { VAConfigAttribEncMaxSlices, 0 }, { VAConfigAttribEncMaxRefFrames, 0 } };
            if (vaGetConfigAttributes(dpy, profs[pi], eps[i], at, 8) != VA_STATUS_SUCCESS) continue;
            c->has_rt420 = at[0].value != VA_ATTRIB_NOT_SUPPORTED && (at[0].value & VA_RT_FORMAT_YUV420);
            c->rc = at[1].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[1].value;
            c->packed = at[2].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[2].value;
            c->max_w = at[3].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[3].value;
            c->max_h = at[4].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[4].value;
            c->ir = at[5].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[5].value;
            c->slices = at[6].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[6].value;
            c->refs = at[7].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : at[7].value;
            nd->ncand++;
        }
    }
    nd->usable = nd->ncand > 0;
    if (!nd->usable) snprintf(nd->note, sizeof nd->note, "driver '%s' offers no H.264 encode entrypoint", nd->vendor_str);
    vaTerminate(dpy); close(fd);
}

static int cand_score(const VaCand *c) {
    int s = 0;
    if (c->rc & VA_RC_CBR) s += 40; else if (c->rc & VA_RC_VBR) s += 20;
    if ((c->packed & (VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE)) == (VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE)) s += 4;
    if (c->prof == VAProfileH264ConstrainedBaseline) s += 8;
    if (c->ep == VAEntrypointEncSlice) s += 2;       /* the full-featured entrypoint first, LP second */
    return s;
}
static int node_score(const VaNode *n) { int b = -1; for (int i = 0; i < n->ncand; i++) { int s = cand_score(&n->cand[i]); if (s > b) b = s; } return b; }

/* ── headers (packed-header drivers) ─────────────────────────────────────────────────────────────────────────────────── */
static int level_for(int mbs, int fps) {
    long mbps = (long)mbs * fps;
    static const struct { int idc; long mbps; int fs; } L[] = {
        {31, 108000, 3600}, {40, 245760, 8192}, {42, 522240, 8704}, {50, 589824, 22080}, {51, 983040, 36864}, {52, 2073600, 36864}, {62, 16711680, 139264} };
    for (unsigned i = 0; i < sizeof L / sizeof L[0]; i++) if (mbps <= L[i].mbps && mbs <= L[i].fs) return L[i].idc;
    return 62;
}

static void build_headers(ClEncoder *e, int level) {
    BW w; memset(&w, 0, sizeof w);
    bw_put(&w, 8, e->profile_idc);
    bw_put(&w, 8, e->profile_idc == 66 ? 0x40 : 0x00);   /* constraint_set1_flag for Constrained Baseline */
    bw_put(&w, 8, level);
    bw_ue(&w, 0);                 /* sps id */
    bw_ue(&w, 4);                 /* log2_max_frame_num_minus4 -> 8 bits */
    bw_ue(&w, 2);                 /* pic_order_cnt_type 2 */
    bw_ue(&w, 1);                 /* max_num_ref_frames */
    bw_put(&w, 1, 0);             /* gaps_in_frame_num_value_allowed_flag */
    bw_ue(&w, e->mbw - 1);
    bw_ue(&w, e->mbh - 1);
    bw_put(&w, 1, 1);             /* frame_mbs_only_flag */
    bw_put(&w, 1, 1);             /* direct_8x8_inference_flag */
    int cr = (e->ah - e->h) / 2, cx = (e->aw - e->w) / 2;
    if (cr || cx) { bw_put(&w, 1, 1); bw_ue(&w, 0); bw_ue(&w, cx); bw_ue(&w, 0); bw_ue(&w, cr); } else bw_put(&w, 1, 0);
    bw_put(&w, 1, 1);             /* vui_parameters_present_flag */
    bw_put(&w, 1, 0);             /* aspect_ratio_info_present */
    bw_put(&w, 1, 0);             /* overscan_info_present */
    bw_put(&w, 1, 1);             /* video_signal_type_present */
    bw_put(&w, 3, 5); bw_put(&w, 1, 0); /* video_format unspecified, limited range */
    bw_put(&w, 1, 1); bw_put(&w, 8, 1); bw_put(&w, 8, 1); bw_put(&w, 8, 1); /* colour: BT.709 */
    bw_put(&w, 1, 0);             /* chroma_loc_info_present */
    bw_put(&w, 1, 0);             /* timing_info_present */
    bw_put(&w, 1, 0); bw_put(&w, 1, 0); bw_put(&w, 1, 0); /* nal_hrd, vcl_hrd, pic_struct */
    /* bitstream_restriction: WebRTC's receiver rewrites an SPS without it before LiveKit's cryptor sees the frame (utils/h264ReceiverView.ts) */
    bw_put(&w, 1, 1);             /* bitstream_restriction_flag */
    bw_put(&w, 1, 1);             /* motion_vectors_over_pic_boundaries */
    bw_ue(&w, 0); bw_ue(&w, 0);   /* max_bytes_per_pic_denom, max_bits_per_mb_denom */
    bw_ue(&w, 15); bw_ue(&w, 15); /* log2_max_mv_length_h/v */
    bw_ue(&w, 0);                 /* max_num_reorder_frames: decoder may output at once */
    bw_ue(&w, 1);                 /* max_dec_frame_buffering */
    bw_trailing(&w);
    e->sps_len = nal_wrap(e->sps, 3, 7, w.b, w.n >> 3);

    memset(&w, 0, sizeof w);
    bw_ue(&w, 0); bw_ue(&w, 0);
    bw_put(&w, 1, 0);             /* CAVLC */
    bw_put(&w, 1, 0);
    bw_ue(&w, 0);                 /* num_slice_groups_minus1 */
    bw_ue(&w, 0); bw_ue(&w, 0);   /* num_ref_idx_default_active_minus1 l0 l1 */
    bw_put(&w, 1, 0); bw_put(&w, 2, 0);
    bw_se(&w, 0); bw_se(&w, 0); bw_se(&w, 0);
    bw_put(&w, 1, 1);             /* deblocking_filter_control_present_flag */
    bw_put(&w, 1, 0); bw_put(&w, 1, 0);
    bw_trailing(&w);
    e->pps_len = nal_wrap(e->pps, 3, 8, w.b, w.n >> 3);
}

/* ── access-unit validation (the self-test, and a guard on the first frames of every run) ───────────────────────────── */
/* Remove emulation prevention from n bytes into out; returns the new length. */
static int unescape(const uint8_t *in, int n, uint8_t *out) { int o = 0, z = 0; for (int i = 0; i < n; i++) { if (z >= 2 && in[i] == 3) { z = 0; continue; } out[o++] = in[i]; z = in[i] == 0 ? z + 1 : 0; } return o; }

/* 0 ok, else a short reason. Checks NAL structure and that the SPS describes the picture size we asked for. */
static const char *au_check(const uint8_t *d, size_t n, int idr, int mbw, int mbh) {
    int seen7 = 0, seen8 = 0, seen5 = 0, seen1 = 0; size_t i = 0;
    while (i + 3 < n && !(d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1)) i++;
    if (i + 3 >= n) return "no Annex-B start code";
    if (i > 1) return "bytes before the first start code";
    while (i + 3 < n) {
        size_t hdr = i + 3, j = hdr + 1;
        while (j + 2 < n && !(d[j] == 0 && d[j + 1] == 0 && d[j + 2] == 1)) j++;
        size_t end = j + 2 < n ? j : n; while (end > hdr + 1 && end < n && d[end - 1] == 0) end--; /* trailing zero byte of a 4-byte start code */
        int type = d[hdr] & 0x1f;
        if (d[hdr] & 0x80) return "forbidden_zero_bit set";
        if (type == 7) {
            seen7 = 1; uint8_t rb[256]; int len = unescape(d + hdr + 1, (int)(end - hdr - 1 > 256 ? 256 : end - hdr - 1), rb);
            BR r = { rb, len, 0, 0 }; int profile = (int)br_u(&r, 8); br_u(&r, 16); br_ue(&r);
            if (profile != 66 && profile != 77 && profile != 100) return "SPS profile is not 66/77/100";
            if (profile == 100) { uint32_t cf = br_ue(&r); if (cf == 3) br_bit(&r); br_ue(&r); br_ue(&r); br_bit(&r); if (br_bit(&r)) goto skip_dims; }
            br_ue(&r); uint32_t poc = br_ue(&r); if (poc == 0) br_ue(&r); else if (poc == 1) goto skip_dims;
            br_ue(&r); br_bit(&r);
            { uint32_t w = br_ue(&r) + 1, h = br_ue(&r) + 1;
              if (r.bad) return "SPS unparsable";
              if ((int)w != mbw || (int)h != mbh) return "SPS picture size differs from the requested one"; }
        skip_dims: ;
        } else if (type == 8) seen8 = 1; else if (type == 5) seen5 = 1; else if (type == 1) seen1 = 1;
        i = end < n ? end : n; while (i + 3 < n && !(d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1)) i++;
    }
    if (idr) { if (!seen7 || !seen8) return "IDR access unit lacks SPS/PPS"; if (!seen5) return "no IDR slice in the IDR access unit"; }
    else { if (seen5) return "an IDR slice where a P frame was expected"; if (!seen1) return "no non-IDR slice in the P access unit"; }
    return NULL;
}

/* ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────────────── */
#define CK(call, what) do { VAStatus s_ = (call); if (s_ != VA_STATUS_SUCCESS) { snprintf(err, errlen, "%s: %s", what, vaErrorStr(s_)); goto fail; } } while (0)

static void teardown_va(ClEncoder *e) {
    if (e->dpy) {
        for (int i = 0; i < NSRC; i++) if (e->img[i].image_id) vaDestroyImage(e->dpy, e->img[i].image_id);
        if (e->coded) vaDestroyBuffer(e->dpy, e->coded);
        if (e->ctx) vaDestroyContext(e->dpy, e->ctx);
        if (e->cfg) vaDestroyConfig(e->dpy, e->cfg);
        if (e->src[0]) vaDestroySurfaces(e->dpy, e->src, NSRC);
        if (e->rec[0]) vaDestroySurfaces(e->dpy, e->rec, NREC);
        vaTerminate(e->dpy);
    }
    if (e->fd >= 0) close(e->fd);
    memset(e->img, 0, sizeof e->img); e->coded = 0; e->ctx = 0; e->cfg = 0; memset(e->src, 0, sizeof e->src); memset(e->rec, 0, sizeof e->rec);
    e->dpy = NULL; e->fd = -1;
}
static void vaapi_close(ClEncoder *e) {
    if (!e) return;
    t_report(); teardown_va(e);
    free(e->out); free(e);
}

static int vaapi_encode(ClEncoder *e, const uint8_t *nv12, uint64_t capture_us, ClEncPacket *pkt);

/* Open the given candidate on the given node. 0 ok, -1 with err. */
static int try_candidate(ClEncoder *e, const VaNode *nd, const VaCand *c, char *err, size_t errlen) {
    e->fd = open(nd->path, O_RDWR | O_CLOEXEC);
    if (e->fd < 0) { snprintf(err, errlen, "open %s failed", nd->path); return -1; }
    e->dpy = vaGetDisplayDRM(e->fd);
    if (!e->dpy) { snprintf(err, errlen, "vaGetDisplayDRM failed"); return -1; }
    int maj, min; CK(vaInitialize(e->dpy, &maj, &min), "vaInitialize");
    e->sel = *c; e->lp = c->ep == VAEntrypointEncSliceLP; e->profile_idc = c->prof == VAProfileH264Main ? 77 : 66;
    if (!c->has_rt420) { snprintf(err, errlen, "no YUV420 render target"); return -1; }
    if (c->max_w && (unsigned)e->aw > c->max_w) { snprintf(err, errlen, "width %d over the hardware limit %u", e->w, c->max_w); return -1; }
    if (c->max_h && (unsigned)e->ah > c->max_h) { snprintf(err, errlen, "height %d over the hardware limit %u", e->h, c->max_h); return -1; }
    /* rate control: CBR > VBR (target = max) > CQP with a software controller */
    if (c->rc & VA_RC_CBR) { e->rcmode = 0; e->swrc = 0; } else if (c->rc & VA_RC_VBR) { e->rcmode = 2; e->swrc = 0; }
    else if (c->rc & VA_RC_CQP) { e->rcmode = 1; e->swrc = 1; }
    else { snprintf(err, errlen, "no CBR/VBR/CQP rate control (mask 0x%x)", c->rc); return -1; }
    unsigned want = VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE | VA_ENC_PACKED_HEADER_SLICE;
    e->packed = c->packed & want;
    if (getenv("CL_VAAPI_NO_PACKED")) e->packed = 0;            /* test aid: force the "driver writes its own headers" path */
    if ((e->packed & (VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE)) != (VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE)) e->packed = 0; /* all or nothing */
    VAConfigAttrib ca[4] = { { VAConfigAttribRTFormat, VA_RT_FORMAT_YUV420 },
                             { VAConfigAttribRateControl, e->swrc ? VA_RC_CQP : e->rcmode == 2 ? VA_RC_VBR : VA_RC_CBR },
                             { VAConfigAttribEncPackedHeaders, e->packed ? e->packed : VA_ENC_PACKED_HEADER_NONE }, { VAConfigAttribEncIntraRefresh, 0 } };
    int nca = 3;
    e->ir_ok = 0;
    if (getenv("CL_ENC_INTRA_REFRESH") && (c->ir & VA_ENC_INTRA_REFRESH_ROLLING_COLUMN) && e->packed) { ca[3].value = VA_ENC_INTRA_REFRESH_ROLLING_COLUMN; nca = 4; e->ir_ok = 1; }
    CK(vaCreateConfig(e->dpy, c->prof, c->ep, ca, nca, &e->cfg), "vaCreateConfig");
    CK(vaCreateSurfaces(e->dpy, VA_RT_FORMAT_YUV420, e->aw, e->ah, e->src, NSRC, NULL, 0), "vaCreateSurfaces(src)");
    CK(vaCreateSurfaces(e->dpy, VA_RT_FORMAT_YUV420, e->aw, e->ah, e->rec, NREC, NULL, 0), "vaCreateSurfaces(rec)");
    VASurfaceID all[NSRC + NREC]; memcpy(all, e->src, sizeof e->src); memcpy(all + NSRC, e->rec, sizeof e->rec);
    CK(vaCreateContext(e->dpy, e->cfg, e->aw, e->ah, VA_PROGRESSIVE, all, NSRC + NREC, &e->ctx), "vaCreateContext");
    CK(vaCreateBuffer(e->dpy, e->ctx, VAEncCodedBufferType, e->aw * e->ah * 3 / 2, 1, NULL, &e->coded), "coded buffer");
    VAImageFormat fmt; memset(&fmt, 0, sizeof fmt); fmt.fourcc = VA_FOURCC_NV12; fmt.byte_order = VA_LSB_FIRST; fmt.bits_per_pixel = 12;
    for (int i = 0; i < NSRC; i++) CK(vaCreateImage(e->dpy, &fmt, e->aw, e->ah, &e->img[i]), "vaCreateImage");
    build_headers(e, level_for(e->mbw * e->mbh, e->fps));
    if (e->ir_ok) {
        int frames = e->fps / 4 > 8 ? e->fps / 4 : 8;          /* a wave takes ~250 ms */
        e->ir_size = (e->mbw + frames - 1) / frames; e->ir_total = (e->mbw + e->ir_size - 1) / e->ir_size;
        BW w; memset(&w, 0, sizeof w);                          /* SEI recovery point: lets a decoder start / resume at the wave start */
        bw_put(&w, 8, 6); bw_put(&w, 8, 2);
        bw_ue(&w, e->ir_total - 1); bw_put(&w, 1, 0); bw_put(&w, 1, 0); bw_put(&w, 2, 0);
        bw_put(&w, 1, 1); while (w.n & 7) bw_put(&w, 1, 0);
        bw_put(&w, 8, 0x80);
        e->sei_len = nal_wrap(e->sei, 0, 6, w.b, w.n >> 3);
    }
    return 0;
fail:
    return -1;
}

static void reset_stream(ClEncoder *e) {
    e->frame_num = 0; e->cur_rec = 0; e->have_ref = 0; e->prev_frame_num = 0; e->src_i = 0; e->idr_pending = 1; e->rc_dirty = 1; e->first = 1;
    e->vbuf = 0; e->qp = 30; e->ir_left = 0; e->ir_hdr = 0;
}

/* Two real frames through the candidate, then structural checks. The picture is mid-grey with a gradient so a driver cannot skip it. */
static int selftest(ClEncoder *e, char *err, size_t errlen) {
    size_t sz = (size_t)e->w * e->h * 3 / 2; uint8_t *f = malloc(sz); if (!f) { snprintf(err, errlen, "oom"); return -1; }
    for (int y = 0; y < e->h; y++) for (int x = 0; x < e->w; x++) f[(size_t)y * e->w + x] = (uint8_t)(40 + (x + 2 * y) % 160);
    memset(f + (size_t)e->w * e->h, 128, sz - (size_t)e->w * e->h);
    reset_stream(e); e->in_selftest = 1; int rc = 0; ClEncPacket p;
    for (int i = 0; i < 3 && !rc; i++) {
        if (i == 0 || vaapi_encode(e, f, 0, &p) == 0) { if (i == 0 && vaapi_encode(e, f, 0, &p) != 0) { snprintf(err, errlen, "self-test: the IDR frame failed to encode"); rc = -1; break; } }
        else { snprintf(err, errlen, "self-test: frame %d failed to encode", i); rc = -1; break; }
        if (p.size == 0) { snprintf(err, errlen, "self-test: frame %d produced an empty access unit (frame skipped by the rate controller?)", i); rc = -1; break; }
        const char *bad = au_check(p.data, p.size, i == 0, e->mbw, e->mbh);
        if (bad) { snprintf(err, errlen, "self-test: access unit %d invalid: %s", i, bad); rc = -1; break; }
    }
    free(f); e->in_selftest = 0; reset_stream(e);
    return rc;
}

static void log_attempt(ClEncoder *e, const VaNode *nd, const VaCand *c, const char *result) {
    size_t n = strlen(e->attempts);
    snprintf(e->attempts + n, sizeof e->attempts - n, "%s%s %s/%s: %s", n ? "; " : "", strrchr(nd->path, '/') ? strrchr(nd->path, '/') + 1 : nd->path, prof_name(c->prof), ep_name(c->ep), result);
    sanitize(e->attempts);
}

static int vaapi_open(ClEncoder **outp, ClEncCfg *c, char *err, size_t errlen) {
    if (va_load(err, errlen) != 0) return -1;
    ClEncoder *e = calloc(1, sizeof *e); e->fd = -1;
    e->w = c->width; e->h = c->height; e->fps = c->fps; e->bps = c->bitrate_bps;
    e->mbw = (e->w + 15) / 16; e->mbh = (e->h + 15) / 16; e->aw = e->mbw * 16; e->ah = e->mbh * 16;
    e->derive_ok = getenv("CL_ENC_DERIVE") != NULL;
    e->idr_dq = getenv("CL_ENC_IDR_QP_DELTA") ? atoi(getenv("CL_ENC_IDR_QP_DELTA")) : 10; /* coarser IDR = smaller burst (fewer lost packets / PLIs) */
    char paths[MAXNODES][64]; const char *forced = c->device && *c->device ? c->device : getenv("CL_VAAPI_DEVICE");
    int nn = list_nodes(forced, paths, MAXNODES);
    if (nn == 0) { snprintf(err, errlen, "no render node (/dev/dri/renderD*) found"); free(e); return -1; }
    VaNode nodes[MAXNODES]; int order[MAXNODES], no = 0;
    for (int i = 0; i < nn; i++) { scan_node(paths[i], &nodes[i]); }
    for (int i = 0; i < nn; i++) if (nodes[i].usable) order[no++] = i;
    for (int a = 1; a < no; a++) { int k = order[a], b = a - 1; while (b >= 0 && node_score(&nodes[order[b]]) < node_score(&nodes[k])) { order[b + 1] = order[b]; b--; } order[b + 1] = k; } /* stable: best node first, then by name */
    if (no == 0) {
        size_t n = 0; err[0] = 0;
        for (int i = 0; i < nn; i++) n += (size_t)snprintf(err + n, n < errlen ? errlen - n : 0, "%s%s: %s", i ? "; " : "", nodes[i].path, nodes[i].note);
        free(e); return -1;
    }
    int only_size = 1; unsigned seen_w = 0, seen_h = 0; char last[256] = "";
    const char *force_ep = getenv("CL_ENC_VAAPI_ENTRYPOINT"), *force_prof = getenv("CL_VAAPI_PROFILE");
    for (int oi = 0; oi < no; oi++) {
        VaNode *nd = &nodes[order[oi]];
        VaCand cs[MAXCAND]; int ncs = nd->ncand; memcpy(cs, nd->cand, sizeof cs);
        for (int a = 1; a < ncs; a++) { VaCand k = cs[a]; int b = a - 1; while (b >= 0 && cand_score(&cs[b]) < cand_score(&k)) { cs[b + 1] = cs[b]; b--; } cs[b + 1] = k; }
        for (int ci = 0; ci < ncs; ci++) {
            if (force_ep && ((!strcmp(force_ep, "lp") && cs[ci].ep != VAEntrypointEncSliceLP) || (!strcmp(force_ep, "slice") && cs[ci].ep != VAEntrypointEncSlice))) continue;
            if (force_prof && ((!strcmp(force_prof, "cb") && cs[ci].prof != VAProfileH264ConstrainedBaseline) || (!strcmp(force_prof, "main") && cs[ci].prof != VAProfileH264Main))) continue;
            if (cs[ci].max_w > seen_w) seen_w = cs[ci].max_w; if (cs[ci].max_h > seen_h) seen_h = cs[ci].max_h;
            char why[200] = "";
            if (try_candidate(e, nd, &cs[ci], why, sizeof why) == 0 && selftest(e, why, sizeof why) == 0) {
                log_attempt(e, nd, &cs[ci], "ok");
                e->node = *nd; reset_stream(e);
                e->out_cap = (size_t)e->aw * e->ah * 3 / 2 + 512; e->out = malloc(e->out_cap);
                *outp = e; return 0;
            }
            if (!strstr(why, "hardware limit")) only_size = 0;
            log_attempt(e, nd, &cs[ci], why); snprintf(last, sizeof last, "%s", why);
            teardown_va(e);
        }
    }
    if (only_size && seen_w && seen_h) { c->max_w = (int)seen_w; c->max_h = (int)seen_h; c->fail_code = 3; }
    snprintf(err, errlen, "no VA-API configuration passed (%s)", e->attempts);
    if (strlen(e->attempts) == 0) snprintf(err, errlen, "no VA-API H.264 encode candidate matched the forced settings (last: %s)", last);
    free(e->out); free(e); return -1;
}

/* ── per-frame ───────────────────────────────────────────────────────────────────────────────────────────────────────── */
static VABufferID mk(ClEncoder *e, VABufferType t, unsigned size, const void *data) {
    VABufferID id = VA_INVALID_ID;
    if (vaCreateBuffer(e->dpy, e->ctx, t, size, 1, (void *)data, &id) != VA_STATUS_SUCCESS) return VA_INVALID_ID;
    return id;
}
static VABufferID mk_packed(ClEncoder *e, int type, const uint8_t *d, int bits, int emu, VABufferID *dataid) {
    VAEncPackedHeaderParameterBuffer ph; memset(&ph, 0, sizeof ph);
    ph.type = type; ph.bit_length = bits; ph.has_emulation_bytes = emu;
    VABufferID a = mk(e, VAEncPackedHeaderParameterBufferType, sizeof ph, &ph);
    *dataid = mk(e, VAEncPackedHeaderDataBufferType, (bits + 7) / 8, d);
    return a;
}
static VABufferID mk_misc(ClEncoder *e, VAEncMiscParameterType t, const void *p, unsigned psz) {
    unsigned n = sizeof(VAEncMiscParameterBuffer) + psz;
    uint8_t *tmp = calloc(1, n); VAEncMiscParameterBuffer *h = (VAEncMiscParameterBuffer *)tmp;
    h->type = t; memcpy(h->data, p, psz);
    VABufferID id = mk(e, VAEncMiscParameterBufferType, n, tmp); free(tmp); return id;
}

static int vaapi_encode(ClEncoder *e, const uint8_t *nv12, uint64_t capture_us, ClEncPacket *pkt) {
    VAStatus st; int idr = e->idr_pending || e->first; e->idr_pending = 0;
    int si = e->src_i; e->src_i = (e->src_i + 1) % NSRC;
    uint64_t t1 = tnow();
    /* upload */
    {
        uint8_t *m; VAImage dimg; const VAImage *im; int derived = 0;
        if (e->derive_ok && vaDeriveImage(e->dpy, e->src[si], &dimg) == VA_STATUS_SUCCESS) { im = &dimg; derived = 1; }
        else im = &e->img[si];
        if (vaMapBuffer(e->dpy, im->buf, (void **)&m) != VA_STATUS_SUCCESS) return -1;
        for (int y = 0; y < e->ah; y++) memcpy(m + im->offsets[0] + (size_t)y * im->pitches[0], nv12 + (size_t)(y < e->h ? y : e->h - 1) * e->w, e->w);
        const uint8_t *uv = nv12 + (size_t)e->w * e->h; int ch = e->h / 2;
        for (int y = 0; y < e->ah / 2; y++) memcpy(m + im->offsets[1] + (size_t)y * im->pitches[1], uv + (size_t)(y < ch ? y : ch - 1) * e->w, e->w);
        vaUnmapBuffer(e->dpy, im->buf);
        if (derived) vaDestroyImage(e->dpy, dimg.image_id);
        else if (vaPutImage(e->dpy, e->src[si], im->image_id, 0, 0, e->aw, e->ah, 0, 0, e->aw, e->ah) != VA_STATUS_SUCCESS) return -1;
    }
    uint64_t t2 = tnow();
    if (idr) { e->frame_num = 0; e->have_ref = 0; e->idr_pic_id = (e->idr_pic_id + 1) & 0xffff; }
    int cur = e->cur_rec, prev = cur ^ 1;
    VABufferID bufs[16]; int nb = 0; VABufferID dummy;

    VAEncSequenceParameterBufferH264 sp; memset(&sp, 0, sizeof sp);
    VAEncPictureParameterBufferH264 pp; VAEncSliceParameterBufferH264 sl;
    if (idr) {
        sp.seq_parameter_set_id = 0; sp.level_idc = (uint8_t)level_for(e->mbw * e->mbh, e->fps);
        sp.intra_period = 0; sp.intra_idr_period = 0; sp.ip_period = 1;
        sp.bits_per_second = e->bps; sp.max_num_ref_frames = 1;
        sp.picture_width_in_mbs = e->mbw; sp.picture_height_in_mbs = e->mbh;
        sp.seq_fields.bits.chroma_format_idc = 1; sp.seq_fields.bits.frame_mbs_only_flag = 1;
        sp.seq_fields.bits.direct_8x8_inference_flag = 1; sp.seq_fields.bits.log2_max_frame_num_minus4 = 4;
        sp.seq_fields.bits.pic_order_cnt_type = 2;
        sp.time_scale = e->fps * 2; sp.num_units_in_tick = 1;
        if (e->aw != e->w || e->ah != e->h) {
            sp.frame_cropping_flag = 1; sp.frame_crop_right_offset = (e->aw - e->w) / 2; sp.frame_crop_bottom_offset = (e->ah - e->h) / 2;
        }
        if (!e->packed) {   /* the driver writes the SPS: hand it the VUI hints (bitstream_restriction, timing) it may honour */
            sp.vui_parameters_present_flag = 1; sp.vui_fields.bits.bitstream_restriction_flag = 1; sp.vui_fields.bits.timing_info_present_flag = 1;
            sp.vui_fields.bits.log2_max_mv_length_horizontal = 15; sp.vui_fields.bits.log2_max_mv_length_vertical = 15;
            sp.vui_fields.bits.motion_vectors_over_pic_boundaries_flag = 1; sp.vui_fields.bits.fixed_frame_rate_flag = 1;
        }
        bufs[nb++] = mk(e, VAEncSequenceParameterBufferType, sizeof sp, &sp);
        if (e->first || e->rc_dirty) {
            VAEncMiscParameterFrameRate fr; memset(&fr, 0, sizeof fr); fr.framerate = e->fps;
            bufs[nb++] = mk_misc(e, VAEncMiscParameterTypeFrameRate, &fr, sizeof fr);
        }
        if (e->packed) {
            bufs[nb++] = mk_packed(e, VAEncPackedHeaderSequence, e->sps, e->sps_len * 8, 1, &dummy); bufs[nb++] = dummy;
            bufs[nb++] = mk_packed(e, VAEncPackedHeaderPicture, e->pps, e->pps_len * 8, 1, &dummy); bufs[nb++] = dummy;
        }
    }
    if (!e->swrc && (e->rc_dirty || e->first)) {
        VAEncMiscParameterRateControl rc; memset(&rc, 0, sizeof rc);
        rc.bits_per_second = e->bps; rc.target_percentage = 100; rc.window_size = 500;
        rc.initial_qp = 26; rc.min_qp = 8; rc.basic_unit_size = 0; rc.rc_flags.bits.reset = 1;
        rc.rc_flags.bits.disable_frame_skip = 1;   /* one access unit per input frame, always (the receiver's watchdog and the injector count on it) */
        bufs[nb++] = mk_misc(e, VAEncMiscParameterTypeRateControl, &rc, sizeof rc);
        VAEncMiscParameterHRD hrd; memset(&hrd, 0, sizeof hrd);
        hrd.buffer_size = e->bps / 2; hrd.initial_buffer_fullness = hrd.buffer_size * 3 / 4;
        bufs[nb++] = mk_misc(e, VAEncMiscParameterTypeHRD, &hrd, sizeof hrd);
        e->rc_dirty = 0;
    }
    e->rc_dirty = 0;
    if (idr) e->ir_left = 0;
    if (!idr && e->ir_left > 0) {
        VAEncMiscParameterRIR rir; memset(&rir, 0, sizeof rir);
        rir.rir_flags.bits.enable_rir_column = 1; rir.intra_insertion_location = (uint16_t)e->ir_col; rir.intra_insert_size = (uint16_t)e->ir_size;
        bufs[nb++] = mk_misc(e, VAEncMiscParameterTypeRIR, &rir, sizeof rir);
        e->ir_col += e->ir_size; e->ir_left--;
    }
    memset(&pp, 0, sizeof pp);
    pp.CurrPic.picture_id = e->rec[cur]; pp.CurrPic.frame_idx = e->frame_num; pp.CurrPic.flags = 0;
    pp.CurrPic.TopFieldOrderCnt = pp.CurrPic.BottomFieldOrderCnt = 2 * e->frame_num;
    for (int i = 0; i < 16; i++) { pp.ReferenceFrames[i].picture_id = VA_INVALID_SURFACE; pp.ReferenceFrames[i].flags = VA_PICTURE_H264_INVALID; }
    if (!idr) {
        pp.ReferenceFrames[0].picture_id = e->rec[prev]; pp.ReferenceFrames[0].frame_idx = e->prev_frame_num;
        pp.ReferenceFrames[0].flags = VA_PICTURE_H264_SHORT_TERM_REFERENCE;
        pp.ReferenceFrames[0].TopFieldOrderCnt = pp.ReferenceFrames[0].BottomFieldOrderCnt = 2 * e->prev_frame_num;
    }
    pp.coded_buf = e->coded; pp.pic_parameter_set_id = 0; pp.seq_parameter_set_id = 0;
    pp.last_picture = 0; pp.frame_num = e->frame_num; pp.pic_init_qp = 26;
    int fqp = e->swrc ? (idr ? e->qp + e->idr_dq : e->qp) : 26; if (fqp > 51) fqp = 51;
    pp.num_ref_idx_l0_active_minus1 = 0; pp.num_ref_idx_l1_active_minus1 = 0;
    pp.pic_fields.bits.idr_pic_flag = idr; pp.pic_fields.bits.reference_pic_flag = 1;
    pp.pic_fields.bits.deblocking_filter_control_present_flag = 1;
    bufs[nb++] = mk(e, VAEncPictureParameterBufferType, sizeof pp, &pp);

    if (e->packed & VA_ENC_PACKED_HEADER_SLICE) {
        BW w; memset(&w, 0, sizeof w);
        bw_ue(&w, 0); bw_ue(&w, idr ? 2 : 0);       /* first_mb, slice_type I / P (NOT 7/5: the short code keeps pps_id inside the one clear byte, see utils/h264ReceiverView.ts) */
        bw_ue(&w, 0); bw_put(&w, 8, e->frame_num);
        if (idr) bw_ue(&w, e->idr_pic_id);
        if (!idr) { bw_put(&w, 1, 0); bw_put(&w, 1, 0); }          /* num_ref_idx_override, ref_pic_list_modification_l0 */
        if (idr) { bw_put(&w, 1, 0); bw_put(&w, 1, 0); } else bw_put(&w, 1, 0); /* dec_ref_pic_marking */
        bw_se(&w, fqp - 26);                                       /* slice_qp_delta */
        bw_ue(&w, 0); bw_se(&w, 0); bw_se(&w, 0);                  /* deblocking: idc 0, alpha, beta */
        uint8_t buf[128]; int o = 0; buf[o++] = 0; buf[o++] = 0; buf[o++] = 0; buf[o++] = 1; buf[o++] = (uint8_t)((3 << 5) | (idr ? 5 : 1));
        int hb = w.n; int bytes = (hb + 7) / 8; memcpy(buf + o, w.b, bytes); /* (EPB: driver adds, has_emulation_bytes=0) */
        bufs[nb++] = mk_packed(e, VAEncPackedHeaderSlice, buf, o * 8 + hb, 0, &dummy); bufs[nb++] = dummy;
    }
    memset(&sl, 0, sizeof sl);
    sl.macroblock_address = 0; sl.num_macroblocks = e->mbw * e->mbh; sl.macroblock_info = VA_INVALID_ID;
    sl.slice_type = idr ? 2 : 0; sl.pic_parameter_set_id = 0; sl.idr_pic_id = e->idr_pic_id;
    for (int i = 0; i < 32; i++) { sl.RefPicList0[i].picture_id = VA_INVALID_SURFACE; sl.RefPicList0[i].flags = VA_PICTURE_H264_INVALID;
                                   sl.RefPicList1[i].picture_id = VA_INVALID_SURFACE; sl.RefPicList1[i].flags = VA_PICTURE_H264_INVALID; }
    if (!idr) sl.RefPicList0[0] = pp.ReferenceFrames[0];
    sl.slice_qp_delta = fqp - 26; sl.disable_deblocking_filter_idc = 0;
    bufs[nb++] = mk(e, VAEncSliceParameterBufferType, sizeof sl, &sl);

    for (int i = 0; i < nb; i++) if (bufs[i] == VA_INVALID_ID) return -2;
    uint64_t t3 = tnow();
    if ((st = vaBeginPicture(e->dpy, e->ctx, e->src[si])) != VA_STATUS_SUCCESS) return -3;
    if ((st = vaRenderPicture(e->dpy, e->ctx, bufs, nb)) != VA_STATUS_SUCCESS) { fprintf(stderr, "vaRenderPicture: %s\n", vaErrorStr(st)); return -4; }
    if ((st = vaEndPicture(e->dpy, e->ctx)) != VA_STATUS_SUCCESS) return -5;
    uint64_t t4 = tnow();
    if ((st = vaSyncSurface(e->dpy, e->src[si])) != VA_STATUS_SUCCESS) return -6;
    uint64_t t5 = tnow();
    for (int i = 0; i < nb; i++) vaDestroyBuffer(e->dpy, bufs[i]);

    VACodedBufferSegment *seg = NULL; size_t n = 0;
    if (vaMapBuffer(e->dpy, e->coded, (void **)&seg) != VA_STATUS_SUCCESS) return -7;
    for (; seg; seg = (VACodedBufferSegment *)seg->next) {
        if (n + seg->size > e->out_cap) { e->out_cap = (n + seg->size) * 2; e->out = realloc(e->out, e->out_cap); }
        memcpy(e->out + n, seg->buf, seg->size); n += seg->size;
    }
    vaUnmapBuffer(e->dpy, e->coded);
    T_up += t2 - t1; T_sub += t4 - t3 + (t3 - t2); T_sync += t5 - t4; T_rd += tnow() - t5; T_n++;
    /* Packed-header drivers differ on whether our SPS/PPS are echoed into the coded buffer: guarantee them on every IDR. A driver that wrote its
       own headers (no packed support) is NEVER patched with ours (they would not match its slices); the self-test rejected such a driver already. */
    int has_sps = n > 4 && (e->out[4] & 0x1f) == 7;
    if (idr && !has_sps && e->packed) {
        size_t hl = (size_t)e->sps_len + e->pps_len;
        if (n + hl > e->out_cap) { e->out_cap = (n + hl) * 2; e->out = realloc(e->out, e->out_cap); }
        memmove(e->out + hl, e->out, n); memcpy(e->out, e->sps, e->sps_len); memcpy(e->out + e->sps_len, e->pps, e->pps_len); n += hl;
    }
    if (e->swrc) {   /* frame-level CBR controller: virtual buffer + proportional QP step */
        double budget = (double)e->bps / 8.0 / e->fps;
        if (!idr) {
            double ratio = n / budget;
            e->vbuf += n - budget; if (e->vbuf < -budget * 4) e->vbuf = -budget * 4;
            double fill = e->vbuf / (budget * e->fps / 4);   /* 1.0 = a quarter second of excess */
            int step = ratio > 1.6 ? 3 : ratio > 1.25 ? 2 : ratio > 1.08 ? 1 : ratio < 0.6 ? -2 : ratio < 0.92 ? -1 : 0;
            if (fill > 0.5) step += 1;
            if (fill > 1.0) step += 2;
            if (fill < -0.5 && step > 0) step = 0;
            e->qp += step; if (e->qp < 14) e->qp = 14; if (e->qp > 48) e->qp = 48;
        } else e->vbuf += (n - budget) * 0.25;               /* an IDR is expected to be large: charge a quarter of its excess */
    }
    if (!idr && e->ir_hdr) {                                  /* first frame of a refresh wave: in-band SPS+PPS+recovery point */
        size_t hl = (size_t)e->sps_len + e->pps_len + e->sei_len;
        if (n + hl > e->out_cap) { e->out_cap = (n + hl) * 2; e->out = realloc(e->out, e->out_cap); }
        memmove(e->out + hl, e->out, n);
        memcpy(e->out, e->sps, e->sps_len); memcpy(e->out + e->sps_len, e->pps, e->pps_len); memcpy(e->out + e->sps_len + e->pps_len, e->sei, e->sei_len);
        n += hl; e->ir_hdr = 0;
    }
    if (n == 0 && !e->in_selftest) return -9;                 /* an empty access unit: never hand the pipeline nothing (disable_frame_skip should prevent it) */
    e->prev_frame_num = e->frame_num; e->frame_num = (e->frame_num + 1) & 0xff; e->cur_rec = prev; e->first = 0;
    pkt->data = e->out; pkt->size = n; pkt->is_key = idr; pkt->capture_us = capture_us;
    return 0;
}

static void vaapi_request_idr(ClEncoder *e) { e->idr_pending = 1; }
static void vaapi_request_refresh(ClEncoder *e) {
    if (!e->ir_ok) { e->idr_pending = 1; return; }
    if (e->ir_left > 0) return;                              /* a wave is already running: coalesce */
    e->ir_left = e->ir_total; e->ir_col = 0; e->ir_hdr = 1;
}
static int vaapi_set_bitrate(ClEncoder *e, int bps) { if (bps < 100000) bps = 100000; if (bps != e->bps) { e->bps = bps; e->rc_dirty = 1; } return 0; }

static const char *rc_name(int m) { return m == 0 ? "CBR" : m == 2 ? "VBR" : "CQP+software"; }
static int jappend(char *buf, size_t n, size_t *o, const char *fmt, ...) __attribute__((format(printf, 4, 5)));
static int jappend(char *buf, size_t n, size_t *o, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt); int k = vsnprintf(buf + *o, *o < n ? n - *o : 0, fmt, ap); va_end(ap);
    if (k > 0) *o += (size_t)k; return k;
}

/* `"k":v,...` for the probe line / the capture `format` event: what is actually in use. */
static void vaapi_describe(ClEncoder *e, char *buf, size_t n) {
    size_t o = 0; const char *drv = e->node.vendor_str; const char *kind = strstr(drv, "iHD") ? "iHD" : strstr(drv, "i965") ? "i965" : strstr(drv, "Mesa") ? "mesa" : "unknown";
    char gpu[96]; const char *vend = e->node.vendor == 0x8086 ? "Intel" : e->node.vendor == 0x1002 ? "AMD" : "GPU";
    snprintf(gpu, sizeof gpu, "%s %04x (%s)", vend, e->node.device < 0 ? 0 : e->node.device, e->node.kdrv[0] ? e->node.kdrv : "unknown");
    jappend(buf, n, &o, "\"gpu\":\"%s\",\"driver\":\"%.47s\",\"va_driver\":\"%s\",\"device\":\"%s\",\"profile\":\"%s\",\"entrypoint\":\"%s\",\"rc\":\"%s\","
            "\"packed_headers\":%u,\"max_w\":%u,\"max_h\":%u,\"intra_refresh\":%u,\"max_slices\":%u,\"va_version\":\"%d.%d\",\"input\":\"nv12\",\"attempts\":\"%.300s\"",
            gpu, drv, kind, e->node.path, prof_name(e->sel.prof), ep_name(e->sel.ep), rc_name(e->rcmode), e->packed, e->sel.max_w, e->sel.max_h,
            e->sel.ir, e->sel.slices, e->node.major, e->node.minor, e->attempts);
}

/* Everything every render node reported, for the tester / diagnostics. Returns a JSON array body written into buf. */
int cl_vaapi_report(char *buf, size_t n) {
    char err[200] = ""; size_t o = 0;
    if (va_load(err, sizeof err) != 0) { jappend(buf, n, &o, "{\"error\":\"%s\"}", err); return -1; }
    char paths[MAXNODES][64]; int nn = list_nodes(getenv("CL_VAAPI_DEVICE"), paths, MAXNODES);
    jappend(buf, n, &o, "[");
    for (int i = 0; i < nn; i++) {
        VaNode nd; scan_node(paths[i], &nd);
        jappend(buf, n, &o, "%s{\"node\":\"%s\",\"vendor_id\":\"0x%04x\",\"device_id\":\"0x%04x\",\"kernel_driver\":\"%s\",\"vendor_string\":\"%s\",\"va\":\"%d.%d\",\"usable\":%d,\"note\":\"%s\",\"candidates\":[",
                i ? "," : "", nd.path, nd.vendor < 0 ? 0 : nd.vendor, nd.device < 0 ? 0 : nd.device, nd.kdrv, nd.vendor_str, nd.major, nd.minor, nd.usable, nd.note);
        for (int k = 0; k < nd.ncand; k++) {
            VaCand *c = &nd.cand[k];
            jappend(buf, n, &o, "%s{\"profile\":\"%s\",\"entrypoint\":\"%s\",\"rc_mask\":%u,\"rc\":\"%s%s%s\",\"packed_headers\":%u,\"max_w\":%u,\"max_h\":%u,\"intra_refresh\":%u,\"max_slices\":%u,\"max_ref_frames\":%u,\"yuv420\":%d,\"score\":%d}",
                    k ? "," : "", prof_name(c->prof), ep_name(c->ep), c->rc, c->rc & VA_RC_CBR ? "CBR " : "", c->rc & VA_RC_VBR ? "VBR " : "", c->rc & VA_RC_CQP ? "CQP" : "",
                    c->packed, c->max_w, c->max_h, c->ir, c->slices, c->refs, c->has_rt420, cand_score(c));
        }
        jappend(buf, n, &o, "]}");
    }
    jappend(buf, n, &o, "]");
    return 0;
}

const ClEncoderOps cl_enc_vaapi = { "vaapi", vaapi_open, vaapi_encode, vaapi_request_idr, vaapi_request_refresh, vaapi_set_bitrate, vaapi_close, NULL, NULL, vaapi_describe };
