/* Tests for preview.h (the sharer's own preview thumbnail): pure, no GPU, no PipeWire. `make test`. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lowlayer.h"
#include "preview.h"

static int failures = 0;
#define CHECK(cond, ...) do { if (cond) printf("ok    "); else { printf("FAIL  "); failures++; } printf(__VA_ARGS__); printf("\n"); } while (0)

int main(void) {
    int w = 0, fps = 0;
    CHECK(cl_preview_parse("OFF", &w, &fps) == 0, "OFF turns it off");
    CHECK(cl_preview_parse("512 6", &w, &fps) == 1 && w == 512 && fps == 6, "a valid request is parsed");
    CHECK(cl_preview_parse("63 6", &w, &fps) == -1, "below the minimum width rejected");
    CHECK(cl_preview_parse("1281 6", &w, &fps) == -1, "above the maximum width rejected");
    CHECK(cl_preview_parse("512 0", &w, &fps) == -1, "fps 0 rejected");
    CHECK(cl_preview_parse("512 16", &w, &fps) == -1, "fps above the cap rejected");
    CHECK(cl_preview_parse("512", &w, &fps) == -1, "missing fps rejected");
    CHECK(cl_preview_parse("512 6 x", &w, &fps) == -1, "trailing junk rejected");
    CHECK(cl_preview_parse("", &w, &fps) == -1, "empty rejected");
    CHECK(cl_preview_parse("-5 6", &w, &fps) == -1, "negative rejected");
    CHECK(CL_AU_FLAG_PREVIEW != CL_AU_FLAG_KEY && CL_AU_FLAG_PREVIEW != CL_AU_FLAG_LOW, "the preview flag is its own bit");

    int dw, dh;
    cl_preview_size(3440, 1440, 512, &dw, &dh); CHECK(dw == 512 && dh == 214, "3440x1440 into 512 wide keeps the aspect (%dx%d)", dw, dh);
    cl_preview_size(200, 100, 512, &dw, &dh); CHECK(dw == 200 && dh == 100, "a small source is never upscaled");
    cl_preview_size(4000, 2, 512, &dw, &dh); CHECK(dw == 512 && dh == 1, "a sliver source never gets a zero height");

    /* 8x4 BGRx source: pixel (x,y) = B=x, G=y, R=200 */
    uint8_t src[8 * 4 * 4];
    for (int y = 0; y < 4; y++) for (int x = 0; x < 8; x++) { uint8_t *p = src + (y * 8 + x) * 4; p[0] = (uint8_t)x; p[1] = (uint8_t)y; p[2] = 200; p[3] = 0; }
    ClPreview pv; memset(&pv, 0, sizeof pv);
    CHECK(cl_preview_frame(&pv, src, 8, 4, 32, 0, 1000) == 0, "off: nothing is made (zero cost)");
    cl_preview_set(&pv, 1, 64, 10);
    CHECK(cl_preview_frame(&pv, src, 8, 4, 32, 0, 1000) == 1, "on: the first frame makes a picture");
    CHECK(pv.len == 4 + 8 * 4 * 4 && pv.buf[0] == 8 && pv.buf[1] == 0 && pv.buf[2] == 4 && pv.buf[3] == 0, "header carries w and h little endian, payload is w*h*4");
    const uint8_t *px = pv.buf + 4 + (2 * 8 + 3) * 4;
    CHECK(px[0] == 200 && px[1] == 2 && px[2] == 3 && px[3] == 255, "BGRx source comes out as R,G,B,255");
    CHECK(cl_preview_frame(&pv, src, 8, 4, 32, 0, 1000 + 50000) == 0, "inside the period: skipped (10 fps = 100 ms)");
    CHECK(cl_preview_frame(&pv, src, 8, 4, 32, 1, 1000 + 100000) == 1, "after the period: another picture");
    px = pv.buf + 4 + (2 * 8 + 3) * 4;
    CHECK(px[0] == 3 && px[1] == 2 && px[2] == 200, "RGBx source (swap) keeps R,G,B order");
    CHECK(!cl_preview_resend_due(&pv, 1000 + 100000 + 900000), "a picture younger than 1 s is not re-sent");
    CHECK(cl_preview_resend_due(&pv, 1000 + 100000 + 1000000), "a static screen's last picture is re-sent after 1 s");
    cl_preview_set(&pv, 0, 0, 0);
    CHECK(!pv.on && pv.buf == NULL && !cl_preview_resend_due(&pv, 99999999), "off frees the picture and stops re-sends");

    /* downscale reads only inside the source even with a padded stride */
    uint8_t big[16 * 8 * 4]; memset(big, 7, sizeof big);
    cl_preview_set(&pv, 1, 64, 10);
    CHECK(cl_preview_frame(&pv, big, 15, 8, 64, 0, 5000) == 1 && pv.buf[0] == 15, "a stride wider than the visible width is honoured");
    cl_preview_set(&pv, 0, 0, 0);
    printf(failures ? "\n%d FAILED\n" : "\nall passed\n", failures);
    return failures ? 1 : 0;
}
