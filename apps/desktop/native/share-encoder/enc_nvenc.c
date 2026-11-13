/*
 * NVENC backend for the native share encoder.
 *
 * PROVEN on an RTX 5070 (driver 615.78.08): 3440x1440 paced at 90 fps = 90.1 fps, p50 3.3 ms / max 4.4 ms per frame, output decodes with 0
 * ffmpeg errors. Everything that makes it work on OTHER generations (API-version negotiation against older drivers, capability-driven size
 * limits, session-limit handling) is written but has NOT run on older cards: tester-bundle/ exists to collect that evidence.
 *
 * Licensing / shipping: headers only at build time (nv-codec-headers, MIT); libcuda.so.1 and libnvidia-encode.so.1 are dlopen'd by
 * ffnvcodec's loader at run time, so nothing proprietary is linked or shipped.
 *
 * API version negotiation. The headers pin one NVENC API version (compiled below as NVENCAPI_*). A driver only accepts struct versions
 * stamped with an API version it supports, so at runtime we ask NvEncodeAPIGetMaxSupportedVersion and stamp every struct with
 * min(compiled, driver). The (small) set of struct-version NUMBERS that differ between API 11.x and 12.x is tabled in ver_*() below (taken
 * from a diff of nv-codec-headers 11.1.5.1 vs 12.1.14.0: CONFIG 7->8, INITIALIZE_PARAMS 5->6, PIC_PARAMS 4->6, REGISTER_RESOURCE 3->4,
 * LOCK_BITSTREAM gains the high bit). Struct LAYOUT is the 12.1 one; newer fields live in what 11.x calls reserved space, which is how
 * FFmpeg's own older-driver compatibility works. Drivers below API 11.0 are refused with a clear message.
 *
 * Stream shape (matches the VA-API backend so the injection layer sees the same thing): H.264 Constrained Baseline when the GPU offers
 * it (else Main), CBR, low latency (P1 + ULTRA_LOW_LATENCY), no B frames, infinite GOP (IDR only on request), SPS+PPS repeated on every
 * IDR, one slice per frame, 4-byte Annex-B start codes, no AUD. Input: NV12 or 32-bit RGB from system memory.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "encoder.h"

#ifndef CL_HAVE_NVENC_HEADERS

static int nv_open(ClEncoder **out, ClEncCfg *cfg, char *err, size_t errlen) {
    (void)out; (void)cfg;
    snprintf(err, errlen, "NVENC backend not compiled in (build with -DCL_HAVE_NVENC_HEADERS and nv-codec-headers)");
    return -1;
}
static int nv_encode(ClEncoder *e, const uint8_t *nv12, uint64_t t, ClEncPacket *p) { (void)e; (void)nv12; (void)t; (void)p; return -1; }
static void nv_idr(ClEncoder *e) { (void)e; }
static void nv_refresh(ClEncoder *e) { (void)e; }
static int nv_br(ClEncoder *e, int bps) { (void)e; (void)bps; return -1; }
static void nv_close(ClEncoder *e) { (void)e; }
#define NV_EXTRA_OPS NULL, NULL, NULL

#else /* CL_HAVE_NVENC_HEADERS */

#include <ffnvcodec/dynlink_loader.h>

struct ClEncoder {
    CudaFunctions *cu; NvencFunctions *nv; NV_ENCODE_API_FUNCTION_LIST fn;
    CUcontext ctx; void *enc;
    NV_ENC_INITIALIZE_PARAMS init; NV_ENC_CONFIG cfg;
    NV_ENC_INPUT_PTR in; NV_ENC_OUTPUT_PTR out;
    int w, h, fps, bps, idr_pending, first, ir_on, refresh_pending, bgrx;
    int api_major, api_minor, drv_max, have_last;
    uint32_t pitch_last;
    uint64_t frame_no;
    uint8_t *buf; size_t buf_cap;
    char gpu[96], driver[48], profile[16];
    int cap_w, cap_h, cap_ir, cap_async, cap_rc_mask, cap_lvl;
};

/* ── struct version stamping ── */
#define STAMP_MASK 0x0F0000FFu           /* the API major (low byte) and minor (bits 24-27) */
static uint32_t retarget(uint32_t v, int maj, int min) { return (v & ~STAMP_MASK) | (uint32_t)maj | ((uint32_t)min << 24); }
static uint32_t sv(int maj, int min, int n, int hi) { return (uint32_t)maj | ((uint32_t)min << 24) | ((uint32_t)n << 16) | (7u << 28) | (hi ? 1u << 31 : 0); }
#define V_NEW(e) ((e)->api_major >= 12)
static uint32_t ver_config(const ClEncoder *e)   { return sv(e->api_major, e->api_minor, V_NEW(e) ? 8 : 7, 1); }
static uint32_t ver_init(const ClEncoder *e)     { return sv(e->api_major, e->api_minor, V_NEW(e) ? 6 : 5, 1); }
static uint32_t ver_pic(const ClEncoder *e)      { return sv(e->api_major, e->api_minor, V_NEW(e) ? 6 : 4, 1); }
static uint32_t ver_lockbs(const ClEncoder *e)   { return sv(e->api_major, e->api_minor, 1, V_NEW(e)); }
#define RT(e, m) retarget((m), (e)->api_major, (e)->api_minor)

#define NVOK(call, what) do { NVENCSTATUS s_ = (call); if (s_ != NV_ENC_SUCCESS) { snprintf(err, errlen, "%s failed (NVENCSTATUS %d)", what, (int)s_); if (s_ == NV_ENC_ERR_OUT_OF_MEMORY || s_ == NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY) c->fail_code = 1; else if (s_ == NV_ENC_ERR_INVALID_VERSION) c->fail_code = 2; goto fail; } } while (0)
#define CUOK(call, what) do { CUresult r_ = (call); if (r_ != CUDA_SUCCESS) { snprintf(err, errlen, "%s failed (CUresult %d)", what, (int)r_); goto fail; } } while (0)

static void nv_close(ClEncoder *e) {
    if (!e) return;
    if (e->enc) {
        if (e->in) e->fn.nvEncDestroyInputBuffer(e->enc, e->in);
        if (e->out) e->fn.nvEncDestroyBitstreamBuffer(e->enc, e->out);
        e->fn.nvEncDestroyEncoder(e->enc);
    }
    if (e->ctx && e->cu) e->cu->cuCtxDestroy(e->ctx);
    nvenc_free_functions(&e->nv); cuda_free_functions(&e->cu);
    free(e->buf); free(e);
}

static void set_rc(ClEncoder *e) {
    NV_ENC_RC_PARAMS *rc = &e->cfg.rcParams;
    rc->rateControlMode = NV_ENC_PARAMS_RC_CBR;
    rc->averageBitRate = (uint32_t)e->bps; rc->maxBitRate = (uint32_t)e->bps;
    rc->vbvBufferSize = (uint32_t)(e->bps / e->fps * 4);     /* ~4 frames: low latency, bounds the IDR burst */
    rc->vbvInitialDelay = rc->vbvBufferSize;
}

static int get_cap(ClEncoder *e, GUID codec, NV_ENC_CAPS cap) {
    NV_ENC_CAPS_PARAM p; memset(&p, 0, sizeof p); p.version = RT(e, NV_ENC_CAPS_PARAM_VER); p.capsToQuery = cap;
    int v = 0; if (e->fn.nvEncGetEncodeCaps(e->enc, codec, &p, &v) != NV_ENC_SUCCESS) return -1; return v;
}
static int guid_eq(GUID a, GUID b) { return memcmp(&a, &b, sizeof a) == 0; }

/* "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  615.78.08  Release Build ..." (proprietary: "... Kernel Module  550.54.14  Tue ..."):
   the version is the first dotted-number token after "Kernel Module" (the first word after it is "for", which an earlier parse returned). */
static void read_driver_version(char *out, size_t n) {
    out[0] = 0; FILE *f = fopen("/proc/driver/nvidia/version", "r"); if (!f) return;
    char l[256]; while (fgets(l, sizeof l, f)) {
        char *k = strstr(l, "Kernel Module"); if (!k) continue;
        k += 13;
        while (*k) {
            while (*k == ' ' || *k == '\t') k++;
            size_t m = strcspn(k, " \t\n"); int dots = 0, digits = m > 0;
            for (size_t i = 0; i < m; i++) { if (k[i] == '.') dots++; else if (k[i] < '0' || k[i] > '9') digits = 0; }
            if (digits && dots >= 1) { if (m >= n) m = n - 1; memcpy(out, k, m); out[m] = 0; break; }
            k += m;
        }
        break;
    }
    fclose(f);
}

static int nv_open(ClEncoder **outp, ClEncCfg *c, char *err, size_t errlen) {
    ClEncoder *e = calloc(1, sizeof *e);
    e->w = c->width; e->h = c->height; e->fps = c->fps > 0 ? c->fps : 60; e->bps = c->bitrate_bps; e->idr_pending = 1; e->first = 1; e->bgrx = c->want_bgrx;
    c->fail_code = 0;
    /* "No NVIDIA driver" is a clean, explained unavailable, not a crash. */
    if (cuda_load_functions(&e->cu, NULL) < 0) { snprintf(err, errlen, "NVIDIA driver not available: libcuda.so.1 could not be loaded"); goto fail; }
    if (nvenc_load_functions(&e->nv, NULL) < 0) { snprintf(err, errlen, "NVIDIA driver not available: libnvidia-encode.so.1 could not be loaded"); goto fail; }
    CUOK(e->cu->cuInit(0), "cuInit");
    int ndev = 0; CUOK(e->cu->cuDeviceGetCount(&ndev), "cuDeviceGetCount");
    int ord = c->device && *c->device ? atoi(c->device) : 0;
    if (ndev <= 0 || ord < 0 || ord >= ndev) { snprintf(err, errlen, "no CUDA device %d (found %d)", ord, ndev); goto fail; }
    CUdevice dev; CUOK(e->cu->cuDeviceGet(&dev, ord), "cuDeviceGet");
    if (e->cu->cuDeviceGetName) e->cu->cuDeviceGetName(e->gpu, (int)sizeof e->gpu, dev);
    read_driver_version(e->driver, sizeof e->driver);
    CUOK(e->cu->cuCtxCreate(&e->ctx, 0, dev), "cuCtxCreate");

    /* API version: compiled-in vs what this driver supports. */
    e->api_major = NVENCAPI_MAJOR_VERSION; e->api_minor = NVENCAPI_MINOR_VERSION;
    uint32_t maxv = 0;
    if (e->nv->NvEncodeAPIGetMaxSupportedVersion && e->nv->NvEncodeAPIGetMaxSupportedVersion(&maxv) == NV_ENC_SUCCESS) {
        e->drv_max = (int)maxv;
        int dm = (int)(maxv >> 4), dn = (int)(maxv & 15);
        if (dm < 11) { c->fail_code = 2; snprintf(err, errlen, "NVIDIA driver too old: it supports NVENC API %d.%d, this build needs 11.0 or newer (driver 470+)", dm, dn); goto fail; }
        if (dm < e->api_major || (dm == e->api_major && dn < e->api_minor)) { e->api_major = dm; e->api_minor = dn; }
    }
    e->fn.version = RT(e, NV_ENCODE_API_FUNCTION_LIST_VER);
    NVOK(e->nv->NvEncodeAPICreateInstance(&e->fn), "NvEncodeAPICreateInstance");
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS op; memset(&op, 0, sizeof op);
    op.version = RT(e, NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER); op.deviceType = NV_ENC_DEVICE_TYPE_CUDA; op.device = e->ctx; op.apiVersion = e->api_major | (e->api_minor << 24);
    NVOK(e->fn.nvEncOpenEncodeSessionEx(&op, &e->enc), "nvEncOpenEncodeSessionEx (encoder session limit reached or out of GPU memory?)");

    /* Capabilities: refuse what this GPU cannot do instead of failing deep inside the driver. */
    e->cap_w = get_cap(e, NV_ENC_CODEC_H264_GUID, NV_ENC_CAPS_WIDTH_MAX); e->cap_h = get_cap(e, NV_ENC_CODEC_H264_GUID, NV_ENC_CAPS_HEIGHT_MAX);
    e->cap_ir = get_cap(e, NV_ENC_CODEC_H264_GUID, NV_ENC_CAPS_SUPPORT_INTRA_REFRESH);
    e->cap_async = get_cap(e, NV_ENC_CODEC_H264_GUID, NV_ENC_CAPS_ASYNC_ENCODE_SUPPORT);
    e->cap_rc_mask = get_cap(e, NV_ENC_CODEC_H264_GUID, NV_ENC_CAPS_SUPPORTED_RATECONTROL_MODES);
    e->cap_lvl = get_cap(e, NV_ENC_CODEC_H264_GUID, NV_ENC_CAPS_LEVEL_MAX);
    c->max_w = e->cap_w > 0 ? e->cap_w : 0; c->max_h = e->cap_h > 0 ? e->cap_h : 0;
    if ((e->cap_w > 0 && e->w > e->cap_w) || (e->cap_h > 0 && e->h > e->cap_h)) {
        c->fail_code = 3; snprintf(err, errlen, "%dx%d exceeds this GPU's H.264 NVENC limit of %dx%d", e->w, e->h, e->cap_w, e->cap_h); goto fail;
    }
    if (e->cap_rc_mask >= 0 && !(e->cap_rc_mask & NV_ENC_PARAMS_RC_CBR)) { snprintf(err, errlen, "this GPU's NVENC has no CBR rate control (mask 0x%x)", e->cap_rc_mask); goto fail; }
    /* Profile: Constrained Baseline if offered (what WebRTC receivers expect), else Main. */
    uint32_t np = 0; GUID profs[16]; int has_base = 0, has_main = 0;
    if (e->fn.nvEncGetEncodeProfileGUIDs(e->enc, NV_ENC_CODEC_H264_GUID, profs, 16, &np) == NV_ENC_SUCCESS)
        for (uint32_t i = 0; i < np && i < 16; i++) { if (guid_eq(profs[i], NV_ENC_H264_PROFILE_BASELINE_GUID)) has_base = 1; if (guid_eq(profs[i], NV_ENC_H264_PROFILE_MAIN_GUID)) has_main = 1; }
    else has_base = 1;
    snprintf(e->profile, sizeof e->profile, "%s", has_base ? "baseline" : has_main ? "main" : "high");

    NV_ENC_PRESET_CONFIG pc; memset(&pc, 0, sizeof pc);
    pc.version = RT(e, NV_ENC_PRESET_CONFIG_VER); pc.presetCfg.version = ver_config(e);
    NVOK(e->fn.nvEncGetEncodePresetConfigEx(e->enc, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &pc), "nvEncGetEncodePresetConfigEx");
    memcpy(&e->cfg, &pc.presetCfg, sizeof e->cfg); e->cfg.version = ver_config(e);
    e->cfg.profileGUID = has_base ? NV_ENC_H264_PROFILE_BASELINE_GUID : has_main ? NV_ENC_H264_PROFILE_MAIN_GUID : NV_ENC_H264_PROFILE_HIGH_GUID;
    e->cfg.gopLength = NVENC_INFINITE_GOPLENGTH; e->cfg.frameIntervalP = 1;
    set_rc(e);
    NV_ENC_CONFIG_H264 *h = &e->cfg.encodeCodecConfig.h264Config;
    h->idrPeriod = NVENC_INFINITE_GOPLENGTH; h->repeatSPSPPS = 1; h->outputAUD = 0; h->enableIntraRefresh = 0;
    h->sliceMode = 3; h->sliceModeData = 1;            /* one slice per frame (mode 3 = N slices per picture) */
    h->maxNumRefFrames = 1; h->chromaFormatIDC = 1;
    if (e->bgrx) {                                      /* RGB in, NVENC converts: say how to read the result (BT.709, limited range) */
        h->h264VUIParameters.videoSignalTypePresentFlag = 1; h->h264VUIParameters.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
        h->h264VUIParameters.videoFullRangeFlag = 0; h->h264VUIParameters.colourDescriptionPresentFlag = 1;
        h->h264VUIParameters.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709; h->h264VUIParameters.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709;
        /* NVENC's own RGB->YUV conversion is BT.601 (FFmpeg labels packed RGB input BT.470BG for exactly this reason); labelling the stream 709 would
           shift every colour at the receiver. UNVERIFIED on hardware here: CL_NVENC_MATRIX=709 flips the label for the tester's colour check. */
        h->h264VUIParameters.colourMatrix = getenv("CL_NVENC_MATRIX") && !strcmp(getenv("CL_NVENC_MATRIX"), "709") ? NV_ENC_VUI_MATRIX_COEFFS_BT709 : NV_ENC_VUI_MATRIX_COEFFS_BT470BG;
    }
    /* bitstream_restriction in the VUI (Sunshine sets it too): WebRTC's receiver otherwise rewrites the SPS (utils/h264ReceiverView.ts normalises the values either way) */
    h->h264VUIParameters.bitstreamRestrictionFlag = 1;
    if (getenv("CL_ENC_INTRA_REFRESH") && e->cap_ir > 0) {   /* PLI -> refresh wave instead of an IDR; recovery-point SEI lets decoders resume */
        e->ir_on = 1; h->enableIntraRefresh = 1; h->intraRefreshPeriod = 0x7fffffff; h->intraRefreshCnt = (uint32_t)(e->fps / 4 > 8 ? e->fps / 4 : 8);
        h->outputRecoveryPointSEI = 1;
    }

    memset(&e->init, 0, sizeof e->init);
    e->init.version = ver_init(e); e->init.encodeGUID = NV_ENC_CODEC_H264_GUID; e->init.presetGUID = NV_ENC_PRESET_P1_GUID;
    e->init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    e->init.encodeWidth = e->init.maxEncodeWidth = (uint32_t)e->w; e->init.encodeHeight = e->init.maxEncodeHeight = (uint32_t)e->h;
    e->init.darWidth = (uint32_t)e->w; e->init.darHeight = (uint32_t)e->h;
    e->init.frameRateNum = (uint32_t)e->fps; e->init.frameRateDen = 1;
    e->init.enablePTD = 1; e->init.encodeConfig = &e->cfg;
    NVOK(e->fn.nvEncInitializeEncoder(e->enc, &e->init), "nvEncInitializeEncoder");

    NV_ENC_CREATE_INPUT_BUFFER ib; memset(&ib, 0, sizeof ib);
    ib.version = RT(e, NV_ENC_CREATE_INPUT_BUFFER_VER); ib.width = (uint32_t)e->w; ib.height = (uint32_t)e->h;
    ib.bufferFmt = e->bgrx ? NV_ENC_BUFFER_FORMAT_ARGB : NV_ENC_BUFFER_FORMAT_NV12;
    NVOK(e->fn.nvEncCreateInputBuffer(e->enc, &ib), "nvEncCreateInputBuffer"); e->in = ib.inputBuffer;
    NV_ENC_CREATE_BITSTREAM_BUFFER ob; memset(&ob, 0, sizeof ob); ob.version = RT(e, NV_ENC_CREATE_BITSTREAM_BUFFER_VER);
    NVOK(e->fn.nvEncCreateBitstreamBuffer(e->enc, &ob), "nvEncCreateBitstreamBuffer"); e->out = ob.bitstreamBuffer;
    *outp = e; return 0;
fail:
    nv_close(e); return -1;
}

/* Submit the input buffer as it currently is (new frame already copied in, or the previous one for a repeat). */
static int submit(ClEncoder *e, uint32_t pitch, uint64_t capture_us, ClEncPacket *pkt) {
    int idr = e->idr_pending || e->first; e->idr_pending = 0; e->first = 0;
    NV_ENC_PIC_PARAMS pp; memset(&pp, 0, sizeof pp);
    pp.version = ver_pic(e); pp.inputWidth = (uint32_t)e->w; pp.inputHeight = (uint32_t)e->h; pp.inputPitch = pitch;
    pp.inputBuffer = e->in; pp.outputBitstream = e->out; pp.bufferFmt = e->bgrx ? NV_ENC_BUFFER_FORMAT_ARGB : NV_ENC_BUFFER_FORMAT_NV12; pp.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    pp.inputTimeStamp = e->frame_no++;
    if (idr) pp.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    else if (e->refresh_pending) {
        e->refresh_pending = 0;
        pp.encodePicFlags = NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;   /* in-band SPS/PPS with the wave start */
        pp.codecPicParams.h264PicParams.forceIntraRefreshWithFrameCnt = (uint32_t)(e->fps / 4 > 8 ? e->fps / 4 : 8);
    }
    if (e->fn.nvEncEncodePicture(e->enc, &pp) != NV_ENC_SUCCESS) return -2;
    NV_ENC_LOCK_BITSTREAM lb; memset(&lb, 0, sizeof lb); lb.version = ver_lockbs(e); lb.outputBitstream = e->out;
    if (e->fn.nvEncLockBitstream(e->enc, &lb) != NV_ENC_SUCCESS) return -3;
    size_t n = lb.bitstreamSizeInBytes;
    if (n > e->buf_cap) { e->buf_cap = n * 2; e->buf = realloc(e->buf, e->buf_cap); }
    memcpy(e->buf, lb.bitstreamBufferPtr, n);
    int is_idr = lb.pictureType == NV_ENC_PIC_TYPE_IDR;
    e->fn.nvEncUnlockBitstream(e->enc, e->out);
    pkt->data = e->buf; pkt->size = n; pkt->is_key = is_idr; pkt->capture_us = capture_us;
    e->pitch_last = pitch; e->have_last = 1;
    return 0;
}

static int nv_encode(ClEncoder *e, const uint8_t *nv12, uint64_t capture_us, ClEncPacket *pkt) {
    if (e->bgrx) return -1;
    NV_ENC_LOCK_INPUT_BUFFER li; memset(&li, 0, sizeof li); li.version = RT(e, NV_ENC_LOCK_INPUT_BUFFER_VER); li.inputBuffer = e->in;
    if (e->fn.nvEncLockInputBuffer(e->enc, &li) != NV_ENC_SUCCESS) return -1;
    for (int y = 0; y < e->h; y++) memcpy((uint8_t *)li.bufferDataPtr + (size_t)y * li.pitch, nv12 + (size_t)y * e->w, e->w);
    const uint8_t *uv = nv12 + (size_t)e->w * e->h;
    for (int y = 0; y < e->h / 2; y++) memcpy((uint8_t *)li.bufferDataPtr + (size_t)(e->h + y) * li.pitch, uv + (size_t)y * e->w, e->w);
    uint32_t pitch = li.pitch;
    e->fn.nvEncUnlockInputBuffer(e->enc, e->in);
    return submit(e, pitch, capture_us, pkt);
}

static int nv_encode_bgrx(ClEncoder *e, const uint8_t *px, int stride, int swap_rb, uint64_t capture_us, ClEncPacket *pkt) {
    if (!e->bgrx) return -1;
    NV_ENC_LOCK_INPUT_BUFFER li; memset(&li, 0, sizeof li); li.version = RT(e, NV_ENC_LOCK_INPUT_BUFFER_VER); li.inputBuffer = e->in;
    if (e->fn.nvEncLockInputBuffer(e->enc, &li) != NV_ENC_SUCCESS) return -1;
    for (int y = 0; y < e->h; y++) {
        const uint8_t *s = px + (size_t)y * (size_t)stride; uint8_t *d = (uint8_t *)li.bufferDataPtr + (size_t)y * li.pitch;
        if (!swap_rb) memcpy(d, s, (size_t)e->w * 4);
        else for (int x = 0; x < e->w; x++) { d[x * 4] = s[x * 4 + 2]; d[x * 4 + 1] = s[x * 4 + 1]; d[x * 4 + 2] = s[x * 4]; d[x * 4 + 3] = 0; }
    }
    uint32_t pitch = li.pitch;
    e->fn.nvEncUnlockInputBuffer(e->enc, e->in);
    return submit(e, pitch, capture_us, pkt);
}
static int nv_repeat(ClEncoder *e, uint64_t capture_us, ClEncPacket *pkt) { return e->have_last ? submit(e, e->pitch_last, capture_us, pkt) : -1; }

static void nv_idr(ClEncoder *e) { e->idr_pending = 1; }
static void nv_refresh(ClEncoder *e) { if (e->ir_on) e->refresh_pending = 1; else e->idr_pending = 1; }

static int nv_br(ClEncoder *e, int bps) {
    if (bps < 100000) bps = 100000;
    if (bps == e->bps) return 0;
    e->bps = bps; set_rc(e);
    NV_ENC_RECONFIGURE_PARAMS rp; memset(&rp, 0, sizeof rp);
    rp.version = RT(e, NV_ENC_RECONFIGURE_PARAMS_VER); rp.reInitEncodeParams = e->init; rp.reInitEncodeParams.encodeConfig = &e->cfg;
    rp.resetEncoder = 0; rp.forceIDR = 0;
    return e->fn.nvEncReconfigureEncoder(e->enc, &rp) == NV_ENC_SUCCESS ? 0 : -1;
}

static void nv_describe(ClEncoder *e, char *buf, size_t n) {
    snprintf(buf, n, "\"gpu\":\"%s\",\"driver\":\"%s\",\"nvenc_api\":\"%d.%d\",\"nvenc_api_driver_max\":\"%d.%d\",\"nvenc_api_compiled\":\"%d.%d\",\"profile\":\"%s\","
             "\"cap_w\":%d,\"cap_h\":%d,\"cap_intra_refresh\":%d,\"cap_async\":%d,\"cap_rc_mask\":%d,\"cap_level_max\":%d,\"input\":\"%s\"",
             e->gpu, e->driver, e->api_major, e->api_minor, e->drv_max >> 4, e->drv_max & 15, NVENCAPI_MAJOR_VERSION, NVENCAPI_MINOR_VERSION, e->profile,
             e->cap_w, e->cap_h, e->cap_ir, e->cap_async, e->cap_rc_mask, e->cap_lvl, e->bgrx ? "argb" : "nv12");
}
#define NV_EXTRA_OPS nv_encode_bgrx, nv_repeat, nv_describe

#endif /* CL_HAVE_NVENC_HEADERS */

const ClEncoderOps cl_enc_nvenc = { "nvenc", nv_open, nv_encode, nv_idr, nv_refresh, nv_br, nv_close, NV_EXTRA_OPS };
