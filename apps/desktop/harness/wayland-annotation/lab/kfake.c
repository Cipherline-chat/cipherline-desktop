/*
 * A persistent fake-input pointer for KWin (org_kde_kwin_fake_input; KWin only advertises it when
 * started with KWIN_WAYLAND_NO_PERMISSION_CHECKS=1). Reads commands from stdin:
 *     move <x> <y>      absolute, compositor logical coordinates
 *     press | release   left button
 *     quit
 * Lets the KWin proof push a REAL click through KWin's own hit-testing, which is the only thing
 * that can show the layer surface is click-through.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "fake-input-client.h"

static struct org_kde_kwin_fake_input *fi;

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver)
{
    (void)d;
    if (!strcmp(iface, "org_kde_kwin_fake_input")) fi = wl_registry_bind(r, name, &org_kde_kwin_fake_input_interface, ver < 4 ? ver : 4);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener rl = { reg_global, reg_remove };

int main(void)
{
    struct wl_display *dpy = wl_display_connect(NULL);
    if (!dpy) { fprintf(stderr, "kfake: no display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &rl, NULL);
    wl_display_roundtrip(dpy);
    if (!fi) { fprintf(stderr, "kfake: org_kde_kwin_fake_input not advertised\n"); return 1; }
    org_kde_kwin_fake_input_authenticate(fi, "cl-harness", "click-through test");
    wl_display_roundtrip(dpy);
    printf("kfake ready\n");
    fflush(stdout);
    char line[128];
    while (fgets(line, sizeof line, stdin)) {
        int x, y;
        if (sscanf(line, "move %d %d", &x, &y) == 2) org_kde_kwin_fake_input_pointer_motion_absolute(fi, wl_fixed_from_int(x), wl_fixed_from_int(y));
        else if (!strncmp(line, "press", 5)) org_kde_kwin_fake_input_button(fi, 0x110, 1);
        else if (!strncmp(line, "release", 7)) org_kde_kwin_fake_input_button(fi, 0x110, 0);
        else if (!strncmp(line, "quit", 4)) break;
        wl_display_roundtrip(dpy);
    }
    return 0;
}
