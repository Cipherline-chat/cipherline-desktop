/* Tests for lowlayer.h (the native share's "lighter copy" session) against the pcm software backend: no GPU, no PipeWire. `make test`. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lowlayer.h"

static int failures = 0;
#define CHECK(cond, ...) do { if (cond) printf("ok    "); else { printf("FAIL  "); failures++; } printf(__VA_ARGS__); printf("\n"); } while (0)

static int has_idr(const uint8_t *d, size_t n) { for (size_t i = 0; i + 4 < n; i++) if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 && (d[i + 3] & 0x1f) == 5) return 1; return 0; }

static int always_fail_encode_bgrx(ClEncoder *e, const uint8_t *px, int stride, int swap, uint64_t c, ClEncPacket *o) { (void)e; (void)px; (void)stride; (void)swap; (void)c; (void)o; return -1; }

int main(void) {
    ClLowCmd c;
    /* ── command parsing ── */
    CHECK(cl_low_parse("OFF", 1920, 1080, &c) == 0, "OFF closes the session");
    CHECK(cl_low_parse("1280 720 30 3000000", 1920, 1080, &c) == 1 && c.w == 1280 && c.h == 720 && c.fps == 30 && c.bps == 3000000, "a valid start is parsed");
    CHECK(cl_low_parse("1280 720 30 3000000", 1280, 720, &c) == 1, "low may equal the full size");
    CHECK(cl_low_parse("1281 720 30 3000000", 1920, 1080, &c) == -1, "odd width rejected");
    CHECK(cl_low_parse("1280 720 30 3000000", 1000, 600, &c) == -1, "low larger than the full encode size rejected");
    CHECK(cl_low_parse("8 8 30 3000000", 1920, 1080, &c) == -1, "tiny size rejected");
    CHECK(cl_low_parse("1280 720 0 3000000", 1920, 1080, &c) == -1, "fps 0 rejected");
    CHECK(cl_low_parse("1280 720 61 3000000", 1920, 1080, &c) == -1, "fps above 60 rejected");
    CHECK(cl_low_parse("1280 720 30 99999", 1920, 1080, &c) == -1, "bitrate below the floor rejected");
    CHECK(cl_low_parse("1280 720 30 999999999", 1920, 1080, &c) == -1, "bitrate above the ceiling rejected");
    CHECK(cl_low_parse("1280 720 30", 1920, 1080, &c) == -1, "missing argument rejected");
    CHECK(cl_low_parse("1280 720 30 3000000 x", 1920, 1080, &c) == -1, "trailing junk rejected");
    CHECK(cl_low_parse("", 1920, 1080, &c) == -1, "empty rejected");

    /* ── header: the layer is carried in flag bit1, the key flag in bit0, the rest of the format is unchanged ── */
    uint8_t hd[24]; cl_au_header(hd, 0x01020304, 1, 0, 11, 22);
    CHECK(hd[4] == 1 && hd[0] == 4 && hd[3] == 1 && hd[5] == 0 && hd[7] == 0 && hd[8] == 11 && hd[16] == 22, "full-layer IDR header: flags 1, length LE, timestamps");
    cl_au_header(hd, 10, 0, 1, 0, 0); CHECK(hd[4] == 2, "low-layer delta header: flags 2");
    cl_au_header(hd, 10, 1, 1, 0, 0); CHECK(hd[4] == 3, "low-layer IDR header: flags 3");

    /* ── a real session on the pcm backend: 1920x1080 source at 60 fps, low layer 1280x720 at 30 fps ── */
    const int SW = 1920, SH = 1080; uint8_t *src = malloc((size_t)SW * SH * 4);
    for (size_t i = 0; i < (size_t)SW * SH; i++) { uint8_t *p = src + i * 4; p[0] = (uint8_t)(i * 3); p[1] = (uint8_t)(i / SW); p[2] = (uint8_t)(i % SW); p[3] = 255; }
    ClEncCfg base = { SW, SH, 60, 20000000, NULL, 0, 0, 0, 0 };
    ClLowCmd cmd = { 1280, 720, 30, 3000000 };
    ClLow low; memset(&low, 0, sizeof low); char err[256] = ""; int fc = 0;
    CHECK(cl_low_open(&low, &cl_enc_pcm, &base, &cmd, err, sizeof err, &fc) == 0 && cl_low_is_open(&low), "the second session opens");
    int aus = 0, keys = 0, bad = 0; size_t first = 0;
    for (int i = 0; i < 120; i++) {                                   /* 2 s of a 60 fps source */
        ClEncPacket p; int produced = 0; uint64_t t = 1000000 + (uint64_t)i * 16667;
        if (cl_low_encode(&low, src, SW, SH, SW * 4, 0, t, t, &p, &produced) < 0) { bad++; break; }
        if (!produced) continue;
        aus++; if (!first) first = p.size; if (p.is_key && has_idr(p.data, p.size)) keys++;
    }
    CHECK(!bad, "no encode error over 2 s");
    CHECK(aus >= 58 && aus <= 62, "60 fps in -> 30 fps out (the copy's own pacer): %d AUs", aus);
    CHECK(keys == aus, "every pcm AU is an IDR carrying an IDR slice (%d/%d)", keys, aus);
    /* pcm is uncompressed: the size proves the AU is 1280x720, not the 1920x1080 source */
    CHECK(first > (size_t)(1280 * 720 * 1.45) && first < (size_t)(1280 * 720 * 1.6), "the AU is 720p-sized (%zu bytes), not source-sized (%d)", first, 1920 * 1080 * 3 / 2);
    /* idle keep-alive */
    { ClEncPacket p; int produced = 0; CHECK(cl_low_repeat(&low, 9999999, &p, &produced) == 0 && produced == 1 && has_idr(p.data, p.size), "idle keep-alive re-encodes the last frame"); }
    /* RGBx swap path runs */
    { ClEncPacket p; int produced = 0; uint64_t t = 100000000; CHECK(cl_low_encode(&low, src, SW, SH, SW * 4, 1, t, t, &p, &produced) == 0 && produced == 1, "RGBx input encodes"); }
    cl_low_close(&low); CHECK(!cl_low_is_open(&low), "close leaves no session");
    { ClEncPacket p; int produced = 1; CHECK(cl_low_encode(&low, src, SW, SH, SW * 4, 0, 1, 1, &p, &produced) == 0 && produced == 0, "a closed session produces nothing (never an error)"); }

    /* ── failures: reported, nothing crashes, the caller keeps the full layer ── */
    ClLowCmd big = { 2560, 1440, 30, 8000000 }; fc = -1;
    ClEncCfg base4k = { 2560, 1440, 60, 20000000, NULL, 0, 0, 0, 0 };
    CHECK(cl_low_open(&low, &cl_enc_pcm, &base4k, &big, err, sizeof err, &fc) < 0 && fc == 3 && !cl_low_is_open(&low), "an encoder that refuses the size: open fails with its code (%d), no half-open session", fc);
    ClEncoderOps failing = cl_enc_pcm; failing.encode_bgrx = always_fail_encode_bgrx;
    CHECK(cl_low_open(&low, &failing, &base, &cmd, err, sizeof err, &fc) == 0, "open with a failing-encode backend");
    { ClEncPacket p; int produced = 1; uint64_t t = 5000000; CHECK(cl_low_encode(&low, src, SW, SH, SW * 4, 0, t, t, &p, &produced) < 0 && produced == 0, "an encode error is returned (caller drops the low session)"); }
    cl_low_close(&low);
    cl_low_close(&low); CHECK(1, "double close is harmless");
    free(src);
    printf("lowlayer_test: %d failures\n", failures);
    return failures ? 1 : 0;
}
