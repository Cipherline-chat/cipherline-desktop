/*
 * share-encoder-helper (SPIKE): drives one ClEncoderOps backend from a synthetic
 * moving source. Stands in for the capture stage; the real design feeds it
 * PipeWire dmabufs (docs/plans/native-share-encoder.md).
 *
 *   --probe                       print the backend's capabilities and exit
 *   --bench N [--paced] [--out f] encode N frames; unpaced = max throughput, paced = real time at --fps
 *   --serve                       paced source -> framed access units on stdout; control on stdin
 *   --capture                     REAL screen: portal ScreenCast -> PipeWire -> encoder -> framed AUs on stdout (see share-capture.c)
 *        [--source monitor|window|any] [--persist] [--restore-stdin] [--idle-ms N]; --width/--height are the MAX encode size
 *   --list-va                     JSON: every /dev/dri render node with its VA driver and H.264 encode entrypoints/attributes (stdout)
 *   --probe [--calibrate N]       open the backend, print what it is (GPU/driver/API/caps), optionally time N unpaced frames
 *
 * Common: --backend vaapi|nvenc|pcm --width W --height H --fps F --bitrate BPS --device PATH
 *
 * Wire format on stdout (little endian), one record per access unit:
 *   u32 len | u8 flags (bit0 = IDR, bit1 = low layer: --capture's lighter copy) | u8 0 | u16 0 | u64 capture_us | u64 done_us | len bytes of Annex-B
 *   (len counts the payload only). Timestamps are CLOCK_MONOTONIC microseconds.
 * stdin lines: "IDR", "BITRATE <bps>", "STOP".
 * stderr: one JSON object with the run's numbers when the run ends.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <poll.h>
#include <unistd.h>
#include <signal.h>
#include "encoder.h"
#include "share-capture.h"

static uint64_t now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000; }

static int cmp_u32(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : x > y; }

/* ── synthetic source: textured wide canvas scrolled 7 px/frame, a bouncing square, a 16-bit frame counter ── */
typedef struct { uint8_t *base; int w, h, bw; uint8_t *frame; } Src;

static void src_init(Src *s, int w, int h) {
    s->w = w; s->h = h; s->bw = w * 2;
    s->base = malloc((size_t)s->bw * h * 3 / 2); s->frame = malloc((size_t)w * h * 3 / 2);
    uint32_t r = 12345;
    uint8_t *Y = s->base, *UV = s->base + (size_t)s->bw * h;
    for (int y = 0; y < h; y++) for (int x = 0; x < s->bw; x++) {
        int bx = x / 16, by = y / 16;
        r = r * 1664525u + 1013904223u;
        int detail = ((bx * 7 + by * 13) % 5) < 2;           /* ~40% of macroblocks are textured */
        int v = 40 + (x * 150) / s->bw + ((y / 4) & 1) * 10;
        if (detail) v += (int)((r >> 24) % 48) - 24;
        Y[(size_t)y * s->bw + x] = (uint8_t)(v < 16 ? 16 : v > 235 ? 235 : v);
    }
    for (int y = 0; y < h / 2; y++) for (int x = 0; x < s->bw; x += 2) {
        UV[(size_t)y * s->bw + x] = (uint8_t)(90 + (x * 80) / s->bw);       /* U */
        UV[(size_t)y * s->bw + x + 1] = (uint8_t)(110 + (y * 60) / (h / 2)); /* V */
    }
}

static void src_frame(Src *s, int n) {
    int off = (n * 7) % s->w & ~1;
    for (int y = 0; y < s->h; y++) memcpy(s->frame + (size_t)y * s->w, s->base + (size_t)y * s->bw + off, s->w);
    uint8_t *uv = s->frame + (size_t)s->w * s->h, *buv = s->base + (size_t)s->bw * s->h;
    for (int y = 0; y < s->h / 2; y++) memcpy(uv + (size_t)y * s->w, buv + (size_t)y * s->bw + off, s->w);
    int sq = 96, px = abs(((n * 11) % (2 * (s->w - sq))) - (s->w - sq)), py = abs(((n * 5) % (2 * (s->h - sq))) - (s->h - sq));
    for (int y = 0; y < sq; y++) memset(s->frame + (size_t)(py + y) * s->w + px, 235, sq);
    for (int b = 0; b < 16; b++) {                           /* counter: 16 blocks of 32x32 at the top-left, MSB first */
        int bit = (n >> (15 - b)) & 1;
        for (int y = 0; y < 32; y++) memset(s->frame + (size_t)y * s->w + b * 32, bit ? 235 : 16, 32);
    }
}

static void json_stats(const char *backend, const char *mode, int w, int h, int fps, int target, int frames, double wall, uint32_t *lat, int nlat,
                       uint64_t bytes, int idrs, int dropped, uint32_t *gen, uint64_t idr_bytes, uint64_t idr_max) {
    qsort(lat, nlat, sizeof *lat, cmp_u32);
    #define P(q) (nlat ? lat[(int)((nlat - 1) * (q))] / 1000.0 : 0)
    double gsum = 0; for (int i = 0; i < nlat; i++) gsum += gen[i];
    fprintf(stderr, "{\"backend\":\"%s\",\"mode\":\"%s\",\"w\":%d,\"h\":%d,\"fps_target\":%d,\"frames\":%d,\"wall_s\":%.3f,\"fps\":%.1f,"
            "\"enc_ms_p50\":%.2f,\"enc_ms_p95\":%.2f,\"enc_ms_p99\":%.2f,\"enc_ms_max\":%.2f,\"gen_ms_avg\":%.2f,"
            "\"kbps\":%.0f,\"kbps_target\":%d,\"idrs\":%d,\"dropped\":%d,\"idr_bytes_avg\":%llu,\"idr_bytes_max\":%llu}\n",
            backend, mode, w, h, fps, frames, wall, frames / wall, P(0.5), P(0.95), P(0.99), P(1.0), nlat ? gsum / nlat / 1000.0 : 0,
            bytes * 8.0 / 1000.0 / wall, target / 1000, idrs, dropped, (unsigned long long)(idrs ? idr_bytes / idrs : 0), (unsigned long long)idr_max);
}

int main(int argc, char **argv) {
    const char *backend = "vaapi", *mode = NULL, *dev = NULL, *outf = NULL;
    int w = 1920, h = 1080, fps = 90, bps = 20000000, n = 900, paced = 0, idr_every = 0, refresh_every = 0, calibrate = 0;
    CapOpts co = {0};
    for (int i = 1; i < argc; i++) {
        #define A(k) (!strcmp(argv[i], k) && i + 1 < argc)
        if (A("--backend")) backend = argv[++i]; else if (A("--width")) w = atoi(argv[++i]); else if (A("--height")) h = atoi(argv[++i]);
        else if (A("--fps")) fps = atoi(argv[++i]); else if (A("--bitrate")) bps = atoi(argv[++i]); else if (A("--device")) dev = argv[++i];
        else if (A("--out")) outf = argv[++i]; else if (A("--idr-every")) idr_every = atoi(argv[++i]); else if (A("--refresh-every")) refresh_every = atoi(argv[++i]); else if (A("--bench")) { mode = "bench"; n = atoi(argv[++i]); }
        else if (!strcmp(argv[i], "--paced")) paced = 1; else if (!strcmp(argv[i], "--serve")) mode = "serve";
        else if (!strcmp(argv[i], "--probe")) mode = "probe"; else if (!strcmp(argv[i], "--list-va")) mode = "list-va";
        else if (!strcmp(argv[i], "--capture")) mode = "capture"; else if (!strcmp(argv[i], "--persist")) co.persist = 1; else if (!strcmp(argv[i], "--restore-stdin")) co.restore_stdin = 1;
        else if (A("--idle-ms")) co.idle_ms = atoi(argv[++i]); else if (A("--pw-node")) co.pw_node = atoi(argv[++i]); else if (A("--calibrate")) calibrate = atoi(argv[++i]);
        else if (A("--source")) { const char *v = argv[++i]; co.source_types = !strcmp(v, "monitor") ? 1 : !strcmp(v, "window") ? 2 : 0; }
    }
    if (!mode) { fprintf(stderr, "usage: see header of share-encoder-helper.c\n"); return 2; }
    if (mode && !strcmp(mode, "list-va")) {   /* every render node and what its VA driver reports for H.264 encode (tester report) */
        static char rep[32768]; int rc = cl_vaapi_report(rep, sizeof rep); printf("%s\n", rep); return rc == 0 ? 0 : 3;
    }
    const ClEncoderOps *ops = !strcmp(backend, "nvenc") ? &cl_enc_nvenc : !strcmp(backend, "pcm") ? &cl_enc_pcm : &cl_enc_vaapi;
    if (!strcmp(mode, "capture")) { co.fps = fps; co.max_w = w; co.max_h = h; ClEncCfg cc = { w, h, fps, bps, dev, 0, 0, 0, 0 }; return run_capture(ops, cc, &co); }
    ClEncCfg cfg = { w, h, fps, bps, dev, 0, 0, 0, 0 };
    ClEncoder *enc = NULL; char err[256] = "";
    if (ops->open(&enc, &cfg, err, sizeof err) != 0) {
        static const char *codes[] = { "open_failed", "session_limit", "driver_too_old", "size_over_limit" };
        fprintf(stderr, "{\"error\":\"%s\",\"code\":\"%s\",\"max_w\":%d,\"max_h\":%d}\n", err, codes[cfg.fail_code >= 0 && cfg.fail_code <= 3 ? cfg.fail_code : 0], cfg.max_w, cfg.max_h);
        return cfg.fail_code == 1 ? 16 : cfg.fail_code == 2 ? 17 : cfg.fail_code == 3 ? 18 : 3;
    }
    if (!strcmp(mode, "probe")) {
        char d[1500] = ""; if (ops->describe) ops->describe(enc, d, sizeof d);
        fprintf(stderr, "{\"backend\":\"%s\",\"open\":\"ok\"%s%s,\"bgrx_input\":%d}\n", ops->name, d[0] ? "," : "", d, ops->encode_bgrx != NULL);
        if (calibrate <= 0) { ops->close(enc); return 0; }
        mode = "bench"; n = calibrate; paced = 0;             /* calibration = an unpaced bench at the asked size; its stats line carries "fps" */
    }
    signal(SIGPIPE, SIG_IGN);

    Src src; src_init(&src, w, h);
    int serve = !strcmp(mode, "serve"); FILE *of = outf ? fopen(outf, "wb") : NULL;
    int cap = serve ? 1 << 30 : n;
    uint32_t *lat = malloc(sizeof(uint32_t) * (serve ? 1 << 20 : n)), *gen = malloc(sizeof(uint32_t) * (serve ? 1 << 20 : n));
    int nlat = 0, idrs = 0, dropped = 0; uint64_t idr_bytes = 0, idr_max = 0, bytes = 0, t0 = now_us(), period = 1000000 / fps, next = t0;
    int frame_no = 0, stop = 0; char line[128]; int ll = 0;

    for (int i = 0; i < cap && !stop; i++) {
        if (serve || paced) {
            uint64_t t = now_us();
            if (t < next) { struct timespec ts = { (time_t)((next - t) / 1000000), (long)((next - t) % 1000000) * 1000 }; nanosleep(&ts, NULL); }
            else if (t > next + period) { int skip = (int)((t - next) / period); dropped += skip; next += (uint64_t)skip * period; } /* behind: drop, don't queue */
            next += period;
        }
        if (serve) {                                  /* control, non-blocking */
            struct pollfd pf = { 0, POLLIN, 0 };
            while (poll(&pf, 1, 0) > 0 && (pf.revents & POLLIN)) {
                char c; if (read(0, &c, 1) != 1) { stop = 1; break; }
                if (c != '\n' && ll < (int)sizeof line - 1) { line[ll++] = c; continue; }
                line[ll] = 0; ll = 0;
                if (!strcmp(line, "IDR")) ops->request_idr(enc);
                else if (!strcmp(line, "REFRESH")) ops->request_refresh(enc);
                else if (!strncmp(line, "BITRATE ", 8)) { int b = atoi(line + 8); if (ops->set_bitrate(enc, b) == 0) fprintf(stderr, "{\"applied_bitrate\":%d}\n", b < 100000 ? 100000 : b); }
                else if (!strcmp(line, "STOP")) stop = 1;
            }
            if (pf.revents & (POLLHUP | POLLERR)) stop = 1;
            if (stop) break;
        }
        if (idr_every > 0 && i > 0 && i % idr_every == 0) ops->request_idr(enc);
        if (refresh_every > 0 && i > 0 && i % refresh_every == 0) ops->request_refresh(enc); /* bench: IDR-on-request check */
        uint64_t cap_us = now_us();
        src_frame(&src, frame_no++);
        uint64_t g1 = now_us();
        ClEncPacket p;
        if (ops->encode(enc, src.frame, cap_us, &p) != 0) { fprintf(stderr, "{\"error\":\"encode failed at frame %d\"}\n", i); return 4; }
        uint64_t done = now_us();
        if (nlat < (serve ? 1 << 20 : n)) { lat[nlat] = (uint32_t)(done - g1); gen[nlat] = (uint32_t)(g1 - cap_us); nlat++; }
        bytes += p.size; idrs += p.is_key; if (p.is_key) { idr_bytes += p.size; if (p.size > idr_max) idr_max = p.size; }
        if (of) fwrite(p.data, 1, p.size, of);
        if (serve) {
            uint8_t hd[24]; uint32_t len = (uint32_t)p.size; memset(hd, 0, sizeof hd);
            memcpy(hd, &len, 4); hd[4] = p.is_key ? 1 : 0; memcpy(hd + 8, &cap_us, 8); memcpy(hd + 16, &done, 8);
            if (fwrite(hd, 1, 24, stdout) != 24 || fwrite(p.data, 1, p.size, stdout) != p.size || fflush(stdout) != 0) stop = 1;
        }
    }
    double wall = (now_us() - t0) / 1e6;
    json_stats(ops->name, serve ? "serve" : paced ? "paced" : "unpaced", w, h, fps, bps, nlat, wall, lat, nlat, bytes, idrs, dropped, gen, idr_bytes, idr_max);
    if (of) fclose(of);
    ops->close(enc);
    return 0;
}
