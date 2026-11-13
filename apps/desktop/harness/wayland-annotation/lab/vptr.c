/*
 * A persistent virtual pointer (zwlr_virtual_pointer_v1) for the harness: unlike `wlrctl`, which
 * creates and destroys a device per invocation (so the seat never keeps a pointer capability and
 * clients never get a wl_pointer), this holds one open and reads commands from stdin:
 *     move <x> <y>   absolute position in an <W>x<H> extent (argv)
 *     press | release
 *     quit
 * Used by the Sway and Mutter-less input tests to make a REAL click go through the compositor's
 * own hit-testing, which is the only thing that can show a layer surface is click-through.
 *   vptr <extent-w> <extent-h>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "wlr-virtual-pointer-unstable-v1-client.h"

static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *mgr;

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver)
{
    (void)d;
    if (!strcmp(iface, "wl_seat") && !seat) seat = wl_registry_bind(r, name, &wl_seat_interface, 1);
    else if (!strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name))
        mgr = wl_registry_bind(r, name, &zwlr_virtual_pointer_manager_v1_interface, ver < 2 ? ver : 2);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener rl = { reg_global, reg_remove };

static uint32_t ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

int main(int argc, char **argv)
{
    uint32_t W = argc > 2 ? (uint32_t)atoi(argv[1]) : 1920, H = argc > 2 ? (uint32_t)atoi(argv[2]) : 1080;
    struct wl_display *dpy = wl_display_connect(NULL);
    if (!dpy) { fprintf(stderr, "vptr: no display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &rl, NULL);
    wl_display_roundtrip(dpy);
    if (!mgr || !seat) { fprintf(stderr, "vptr: no virtual pointer manager\n"); return 1; }
    struct zwlr_virtual_pointer_v1 *vp = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(mgr, seat);
    wl_display_roundtrip(dpy);
    printf("vptr ready\n");
    fflush(stdout);
    char line[128];
    while (fgets(line, sizeof line, stdin)) {
        int x, y;
        if (sscanf(line, "move %d %d", &x, &y) == 2) {
            zwlr_virtual_pointer_v1_motion_absolute(vp, ms(), (uint32_t)x, (uint32_t)y, W, H);
            zwlr_virtual_pointer_v1_frame(vp);
        } else if (!strncmp(line, "press", 5)) {
            zwlr_virtual_pointer_v1_button(vp, ms(), 0x110, WL_POINTER_BUTTON_STATE_PRESSED);
            zwlr_virtual_pointer_v1_frame(vp);
        } else if (!strncmp(line, "release", 7)) {
            zwlr_virtual_pointer_v1_button(vp, ms(), 0x110, WL_POINTER_BUTTON_STATE_RELEASED);
            zwlr_virtual_pointer_v1_frame(vp);
        } else if (!strncmp(line, "quit", 4)) break;
        wl_display_roundtrip(dpy);
    }
    zwlr_virtual_pointer_v1_destroy(vp);
    wl_display_roundtrip(dpy);
    return 0;
}
