/*
 * PipeWire video capture for the native share helper. libpipewire (MIT) is dlopen'd at run time, so the helper builds and starts
 * without it and reports a clean "PipeWire not available" instead of failing to load. Buffers are requested as SHM only (MemFd/MemPtr):
 * we advertise no DRM modifiers, so portals fall back to shared memory. (DMA-BUF import is a later optimisation.)
 */
#ifndef CL_CAPTURE_H
#define CL_CAPTURE_H
#include <stddef.h>
#include <stdint.h>

#define CL_PIX_BGRX 1   /* B,G,R,x in memory order (SPA BGRx / BGRA) */
#define CL_PIX_RGBX 2   /* R,G,B,x in memory order (SPA RGBx / RGBA) */

typedef struct CapFrame {
    const uint8_t *data;   /* first visible pixel (crop applied) */
    int width, height, stride;
    uint32_t pix;
    uint64_t pts_us;
} CapFrame;

typedef struct CapCallbacks {
    void (*on_format)(void *u, int width, int height, uint32_t pix);   /* first format and every change */
    void (*on_frame)(void *u, const CapFrame *f);
    void (*on_tick)(void *u);                                          /* every ~100 ms (idle keep-alive, stats, deadlines) */
    void (*on_fd)(void *u, int which);                                 /* a watched fd is readable (which = the index passed to capture_watch) */
    void (*on_end)(void *u, const char *why);                          /* stream error / compositor stopped it / PipeWire gone */
} CapCallbacks;

typedef struct Capture Capture;
/* Takes ownership of pw_fd on success and failure. */
int capture_open(Capture **out, int pw_fd, uint32_t node_id, int max_fps, const CapCallbacks *cb, void *user, char *err, size_t errlen);
int capture_watch(Capture *c, int fd, int which);
void capture_run(Capture *c);
void capture_quit(Capture *c);
void capture_close(Capture *c);
#endif
