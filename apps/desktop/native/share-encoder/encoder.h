/*
 * Native share encoder: backend-neutral interface (off by default).
 * See docs/plans/native-share-encoder.md.
 *
 * One backend = one H.264 encoder driven outside Chromium. The helper (share-encoder-helper.c) owns a backend, feeds it frames
 * and frames its Annex-B output for the Electron main process. Backends: nvenc (NVIDIA), vaapi (Intel/AMD reference), pcm
 * (software I_PCM test backend, used to prove capture + transport with no GPU; NOT a shipping encoder).
 */
#ifndef CL_ENCODER_H
#define CL_ENCODER_H
#include <stddef.h>
#include <stdint.h>

typedef struct ClEncCfg {
    int width, height, fps;
    int bitrate_bps;        /* target (CBR) */
    const char *device;     /* e.g. /dev/dri/renderD128 (VA-API); CUDA ordinal string for NVENC */
    int want_bgrx;          /* in: the caller will use encode_bgrx (4-byte-pixel input, no CPU colour conversion) */
    int max_w, max_h;       /* out: the backend's hard size limit if it has one (0 = unknown); set even when open fails because of it */
    int fail_code;          /* out: 0 generic, 1 session limit / out of encoder memory, 2 driver too old, 3 size over the hardware limit */
} ClEncCfg;

typedef struct ClEncPacket {
    const uint8_t *data;    /* one Annex-B access unit, 4-byte start codes; valid until the next call */
    size_t size;
    int is_key;             /* IDR (SPS+PPS+IDR slice) */
    uint64_t capture_us;    /* echoed from the input */
} ClEncPacket;

typedef struct ClEncoder ClEncoder;

typedef struct ClEncoderOps {
    const char *name;
    /* 0 ok; <0 failure with a human-readable reason in err */
    int  (*open)(ClEncoder **out, ClEncCfg *cfg, char *err, size_t errlen);
    /* nv12: width*height*3/2 bytes, stride == width. Synchronous: returns the AU for THIS frame. */
    int  (*encode)(ClEncoder *e, const uint8_t *nv12, uint64_t capture_us, ClEncPacket *out);
    void (*request_idr)(ClEncoder *e);           /* next encode() is an IDR */
    /* Start a gradual intra-refresh wave (no big IDR): P frames carry rolling intra columns plus a recovery-point SEI, SPS/PPS repeated on the
       first one. Falls back to an IDR when the backend/driver has no intra refresh. Opt-in (CL_ENC_INTRA_REFRESH=1). */
    void (*request_refresh)(ClEncoder *e);
    int  (*set_bitrate)(ClEncoder *e, int bps);  /* takes effect on the next frame */
    void (*close)(ClEncoder *e);
    /* Optional (NULL when unsupported). 4-byte pixels, BGRx byte order in memory (swap_rb: RGBx). Only valid if cfg.want_bgrx was set. */
    int  (*encode_bgrx)(ClEncoder *e, const uint8_t *px, int stride, int swap_rb, uint64_t capture_us, ClEncPacket *out);
    /* Optional: encode the previous input again (idle keep-alive: no new capture frame, the receiver's watchdog must still see AUs). */
    int  (*encode_repeat)(ClEncoder *e, uint64_t capture_us, ClEncPacket *out);
    /* Optional: append `"k":v,...` JSON members describing the device/driver/API/caps actually in use (diagnostics, tester reports). */
    void (*describe)(ClEncoder *e, char *buf, size_t n);
} ClEncoderOps;

extern const ClEncoderOps cl_enc_vaapi;
extern const ClEncoderOps cl_enc_nvenc;
extern const ClEncoderOps cl_enc_pcm;
int cl_vaapi_report(char *buf, size_t n);   /* enc_vaapi.c: JSON array of all render nodes + their H.264 encode candidates */

#endif
