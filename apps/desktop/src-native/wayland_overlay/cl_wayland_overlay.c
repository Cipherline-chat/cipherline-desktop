/*
 * cl-wayland-overlay — Cipherline's Wayland annotation overlay helper.
 *
 * The desktop annotation overlay (electron/annotation-overlay.ts) is a transparent,
 * click-through window laid over the shared screen on the sharer's real desktop. Electron
 * cannot make one on Wayland (xdg-shell lets a client neither position nor stack a window),
 * but compositors that implement wlr-layer-shell (KDE Plasma's KWin, Sway, Hyprland, other
 * wlroots desktops, COSMIC — not GNOME's Mutter) let a client pin a surface to the OVERLAY
 * layer of one output, anchored to all four edges, with an empty input region. Electron has
 * no API for layer-shell surfaces, so that surface lives in this small separate process,
 * which main (electron/annotation-overlay-wayland.ts) spawns and feeds.
 *
 * Why a helper process and not a thread of the audio_capture addon: a crash here cannot take
 * the main process down, nothing here can touch the audio paths, and "libwayland missing" is
 * just "helper reports unsupported".
 *
 * Dependencies: libc and libwayland-client, the latter dlopen()ed at run time (never linked).
 * Only the stroke geometry and colours main sends are ever read; the helper opens no network
 * socket and parses nothing but its own stdin protocol. All strokes are drawn by a software
 * rasteriser into wl_shm buffers (no GPU, no cairo).
 *
 * ── Protocol (one ASCII line per message; main validates everything before sending) ──
 *   stdin  SHOW <idx>                              layer-shell overlay on Wayland output <idx>
 *          SHOWX <idx>                             XWayland override-redirect overlay on the same output
 *                                                  (GNOME/Mutter, which has no layer-shell)
 *          HIDE                                    take it down (process stays)
 *          Z                                       clear all strokes
 *          U <sid> <rrggbb> <w10> <upd> <clo> <n> <x,y>...   (re)define stroke
 *          A <sid> <upd> <clo> <n> <x,y>...        append points / refresh stamps
 *          R <sid>                                 remove stroke
 *          QUIT
 *   (`--x11-probe` / `--x11-watch` are separate plain-X11 modes with their own small protocol,
 *    see x11_probe.inc; they never connect to Wayland.)
 *   stdout HELLO <helper-version>
 *          OUT <idx> <name> <lx> <ly> <lw> <lh> <scale> <pw> <ph>   one per output
 *          HZ <idx> <mhz>                          that output's current refresh in mHz (omitted when unknown)
 *   (`--outputs` is a one-shot mode: HELLO, OUT/HZ lines, exit 0; no surface, no X.)
 *          XOUT <idx> <name> <x> <y> <w> <h>        XWayland monitors (the fallback backend)
 *          READY layer_shell=<0|1> x11=<0|1>
 *          SHOWN <idx> <w> <h> <scale>
 *          CLOSED                                  compositor destroyed our surface
 *          ERR <code>
 *   Points are normalised [0,1] scaled to 0..65535; <w10> is the stroke width x10 (authored
 *   for a 960 px wide frame, exactly like the in-app overlay); <upd>/<clo> are epoch ms.
 *   Logs (stderr) carry counts and states only.
 *
 * Rendering mirrors electron/annotation-overlay-preload.ts: a graded stack of translucent
 * halos under a bright core and a white-hot thread, ONE opacity per pass, the same stroke
 * watchdog (live stroke with no new point for 1500 ms closes) and the same 1500 ms fade, run
 * on this process's own clock from the stamps main sends.
 */
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <signal.h>
#include <dlfcn.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <stdarg.h>

#include "wl_min.h"

#define HELPER_VERSION 1
#define LASER_TTL_MS 1500
#define STROKE_IDLE_MS LASER_TTL_MS
#define MAX_STROKES 256
#define MAX_POINTS 8192
#define MAX_LINE (160 * 1024)
#define MAX_OUTPUTS 16
/* one frame buffer is at most this many pixels (8K = 33M); beyond it the overlay is refused, not allocated */
#define MAX_BUFFER_PIXELS (64 * 1024 * 1024)

/* ───────────────────────── libwayland (dlopen) ───────────────────────── */

static struct {
    void *lib;
    pfn_display_connect display_connect;
    pfn_display_disconnect display_disconnect;
    pfn_display_get_fd display_get_fd;
    pfn_display_dispatch_pending display_dispatch_pending;
    pfn_display_flush display_flush;
    pfn_display_roundtrip display_roundtrip;
    pfn_display_prepare_read display_prepare_read;
    pfn_display_read_events display_read_events;
    pfn_display_cancel_read display_cancel_read;
    pfn_display_get_error display_get_error;
    pfn_marshal_array_constructor_versioned ctor;
    pfn_marshal_array marshal;
    pfn_proxy_add_listener add_listener;
    pfn_proxy_destroy destroy;
    const struct wl_interface *registry_i, *compositor_i, *shm_i, *shm_pool_i, *buffer_i,
        *surface_i, *output_i, *region_i, *callback_i;
} W;

static int load_wayland(void)
{
    W.lib = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!W.lib) return 0;
#define SYM(field, name) do { *(void **)&W.field = dlsym(W.lib, name); if (!W.field) return 0; } while (0)
    SYM(display_connect, "wl_display_connect");
    SYM(display_disconnect, "wl_display_disconnect");
    SYM(display_get_fd, "wl_display_get_fd");
    SYM(display_dispatch_pending, "wl_display_dispatch_pending");
    SYM(display_flush, "wl_display_flush");
    SYM(display_roundtrip, "wl_display_roundtrip");
    SYM(display_prepare_read, "wl_display_prepare_read");
    SYM(display_read_events, "wl_display_read_events");
    SYM(display_cancel_read, "wl_display_cancel_read");
    SYM(display_get_error, "wl_display_get_error");
    SYM(ctor, "wl_proxy_marshal_array_constructor_versioned");
    SYM(marshal, "wl_proxy_marshal_array");
    SYM(add_listener, "wl_proxy_add_listener");
    SYM(destroy, "wl_proxy_destroy");
#undef SYM
#define IFACE(field, name) do { W.field = (const struct wl_interface *)dlsym(W.lib, name); if (!W.field) return 0; } while (0)
    IFACE(registry_i, "wl_registry_interface");
    IFACE(compositor_i, "wl_compositor_interface");
    IFACE(shm_i, "wl_shm_interface");
    IFACE(shm_pool_i, "wl_shm_pool_interface");
    IFACE(buffer_i, "wl_buffer_interface");
    IFACE(surface_i, "wl_surface_interface");
    IFACE(output_i, "wl_output_interface");
    IFACE(region_i, "wl_region_interface");
    IFACE(callback_i, "wl_callback_interface");
#undef IFACE
    return 1;
}

/* ─────────────── protocol tables for the interfaces libwayland lacks ───────────────
 * zwlr_layer_shell_v1 / zwlr_layer_surface_v1 (wlr-layer-shell-unstable-v1.xml, v5) and
 * zxdg_output_manager_v1 / zxdg_output_v1 (xdg-output-unstable-v1.xml, v3), written out by
 * hand from the XML in ./protocols. Opcodes are the order of <request>/<event> elements.
 * The `types` arrays name interfaces that only exist after dlopen, so they are filled in by
 * init_tables(). check-protocol-tables.sh compares every signature below with the output of
 * wayland-scanner for the same XML.
 */
static const struct wl_interface *t_ls_get[5];          /* get_layer_surface */
static const struct wl_interface *t_ls_popup[1];        /* get_popup (never called) */
static const struct wl_interface *t_xom_get[2];         /* get_xdg_output */

static const struct wl_message ls_methods[] = {
    { "get_layer_surface", "no?ous", t_ls_get },
    { "destroy", "3", NULL },
};
static struct wl_interface layer_shell_i = { "zwlr_layer_shell_v1", 5, 2, ls_methods, 0, NULL };

static const struct wl_message lsurf_methods[] = {
    { "set_size", "uu", NULL },
    { "set_anchor", "u", NULL },
    { "set_exclusive_zone", "i", NULL },
    { "set_margin", "iiii", NULL },
    { "set_keyboard_interactivity", "u", NULL },
    { "get_popup", "o", t_ls_popup },
    { "ack_configure", "u", NULL },
    { "destroy", "", NULL },
    { "set_layer", "2u", NULL },
    { "set_exclusive_edge", "5u", NULL },
};
static const struct wl_message lsurf_events[] = {
    { "configure", "uuu", NULL },
    { "closed", "", NULL },
};
static struct wl_interface layer_surface_i = { "zwlr_layer_surface_v1", 5, 10, lsurf_methods, 2, lsurf_events };

static const struct wl_message xom_methods[] = {
    { "destroy", "", NULL },
    { "get_xdg_output", "no", t_xom_get },
};
static struct wl_interface xdg_output_manager_i = { "zxdg_output_manager_v1", 3, 2, xom_methods, 0, NULL };

static const struct wl_message xo_methods[] = {
    { "destroy", "", NULL },
};
static const struct wl_message xo_events[] = {
    { "logical_position", "ii", NULL },
    { "logical_size", "ii", NULL },
    { "done", "", NULL },
    { "name", "2s", NULL },
    { "description", "2s", NULL },
};
static struct wl_interface xdg_output_i = { "zxdg_output_v1", 3, 1, xo_methods, 5, xo_events };

/* Exposed for check-protocol-tables.sh (prints every signature, one per line). */
static void dump_tables(void)
{
    const struct wl_interface *all[] = { &layer_shell_i, &layer_surface_i, &xdg_output_manager_i, &xdg_output_i };
    for (size_t k = 0; k < sizeof all / sizeof *all; k++) {
        const struct wl_interface *it = all[k];
        printf("%s %d\n", it->name, it->version);
        for (int i = 0; i < it->method_count; i++) printf("  request %s %s\n", it->methods[i].name, it->methods[i].signature);
        for (int i = 0; i < it->event_count; i++) printf("  event %s %s\n", it->events[i].name, it->events[i].signature);
    }
}

static void init_tables(void)
{
    t_ls_get[0] = &layer_surface_i;
    t_ls_get[1] = W.surface_i;
    t_ls_get[2] = W.output_i;
    t_ls_get[3] = NULL;
    t_ls_get[4] = NULL;
    t_ls_popup[0] = NULL;
    t_xom_get[0] = &xdg_output_i;
    t_xom_get[1] = W.output_i;
}

/* ───────────────────────── request helpers ───────────────────────── */

#define PROXY(p) ((struct wl_proxy *)(p))

static struct wl_proxy *new_obj(void *parent, uint32_t opcode, const struct wl_interface *iface, uint32_t version,
                                union wl_argument *args)
{
    return W.ctor(PROXY(parent), opcode, args, iface, version);
}

static void request(void *proxy, uint32_t opcode, union wl_argument *args)
{
    W.marshal(PROXY(proxy), opcode, args);
}

/* wl_surface */
enum { SURF_DESTROY = 0, SURF_ATTACH = 1, SURF_DAMAGE = 2, SURF_FRAME = 3, SURF_SET_OPAQUE = 4,
       SURF_SET_INPUT = 5, SURF_COMMIT = 6, SURF_BUFFER_SCALE = 8 };

/* ───────────────────────── global state ───────────────────────── */

typedef struct {
    struct wl_proxy *wl;       /* wl_output */
    struct wl_proxy *xdg;      /* zxdg_output_v1 or NULL */
    uint32_t global_name;
    uint32_t version;
    int geo_x, geo_y, transform;
    int mode_w, mode_h;        /* current mode, physical px (unrotated) */
    int refresh_mhz;           /* current mode's refresh in mHz (wl_output.mode), 0 = unknown */
    int scale;
    int has_logical;
    int lx, ly, lw, lh;
    char name[40];
} Out;

static struct wl_display *dpy;
static struct wl_proxy *registry, *compositor, *shm, *layer_shell, *xdg_manager;
static uint32_t compositor_name, shm_name, layer_shell_name, xdg_manager_name;
static uint32_t compositor_ver, shm_ver, layer_shell_ver, xdg_manager_ver;
static Out outs[MAX_OUTPUTS];
static int nouts;

static int64_t last_render_at;

static int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void say(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void say(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
}

/* ───────────────────────── registry & outputs ───────────────────────── */

static void sanitize_name(char *dst, size_t cap, const char *src)
{
    size_t j = 0;
    for (size_t i = 0; src && src[i] && j + 1 < cap; i++) {
        unsigned char c = (unsigned char)src[i];
        int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':';
        dst[j++] = ok ? (char)c : '_';
    }
    dst[j] = 0;
}

static void out_geometry(void *data, struct wl_proxy *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t subpixel,
                         const char *make, const char *model, int32_t transform)
{
    (void)o; (void)pw; (void)ph; (void)subpixel; (void)make; (void)model;
    Out *out = data;
    out->geo_x = x; out->geo_y = y; out->transform = transform;
}
static void out_mode(void *data, struct wl_proxy *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh)
{
    (void)o;
    Out *out = data;
    int r = (refresh > 0 && refresh <= 1000000) ? refresh : 0;      /* mHz; compositors may send 0 */
    if (flags & 1u) { out->mode_w = w; out->mode_h = h; out->refresh_mhz = r; }          /* WL_OUTPUT_MODE_CURRENT */
    else if (!out->mode_w) { out->mode_w = w; out->mode_h = h; out->refresh_mhz = r; }
}
static void out_done(void *data, struct wl_proxy *o) { (void)data; (void)o; }
static void out_scale(void *data, struct wl_proxy *o, int32_t f) { (void)o; ((Out *)data)->scale = f > 0 ? f : 1; }
static void out_name(void *data, struct wl_proxy *o, const char *n) { (void)o; Out *out = data; sanitize_name(out->name, sizeof out->name, n); }
static void out_desc(void *data, struct wl_proxy *o, const char *d) { (void)data; (void)o; (void)d; }
static void (*out_listener[])(void) = {
    (void (*)(void))out_geometry, (void (*)(void))out_mode, (void (*)(void))out_done,
    (void (*)(void))out_scale, (void (*)(void))out_name, (void (*)(void))out_desc,
};

static void xo_pos(void *data, struct wl_proxy *x, int32_t px, int32_t py) { (void)x; Out *o = data; o->lx = px; o->ly = py; o->has_logical |= 1; }
static void xo_size(void *data, struct wl_proxy *x, int32_t w, int32_t h) { (void)x; Out *o = data; o->lw = w; o->lh = h; o->has_logical |= 2; }
static void xo_done(void *data, struct wl_proxy *x) { (void)data; (void)x; }
static void xo_name(void *data, struct wl_proxy *x, const char *n) { (void)x; Out *o = data; if (!o->name[0]) sanitize_name(o->name, sizeof o->name, n); }
static void xo_desc(void *data, struct wl_proxy *x, const char *d) { (void)data; (void)x; (void)d; }
static void (*xo_listener[])(void) = {
    (void (*)(void))xo_pos, (void (*)(void))xo_size, (void (*)(void))xo_done,
    (void (*)(void))xo_name, (void (*)(void))xo_desc,
};

static uint32_t min_u32(uint32_t a, uint32_t b) { return a < b ? a : b; }

static struct wl_proxy *registry_bind(uint32_t name, const struct wl_interface *iface, uint32_t version)
{
    union wl_argument a[4];
    a[0].u = name; a[1].s = iface->name; a[2].u = version; a[3].o = NULL;
    return new_obj(registry, 0, iface, version, a);
}

static void reg_global(void *data, struct wl_proxy *r, uint32_t name, const char *iface, uint32_t version)
{
    (void)data; (void)r;
    if (!strcmp(iface, "wl_compositor")) { compositor_name = name; compositor_ver = version; }
    else if (!strcmp(iface, "wl_shm")) { shm_name = name; shm_ver = version; }
    else if (!strcmp(iface, "zwlr_layer_shell_v1")) { layer_shell_name = name; layer_shell_ver = version; }
    else if (!strcmp(iface, "zxdg_output_manager_v1")) { xdg_manager_name = name; xdg_manager_ver = version; }
    else if (!strcmp(iface, "wl_output") && nouts < MAX_OUTPUTS) {
        Out *o = &outs[nouts++];
        memset(o, 0, sizeof *o);
        o->global_name = name; o->version = version; o->scale = 1;
    }
}
static void reg_remove(void *data, struct wl_proxy *r, uint32_t name) { (void)data; (void)r; (void)name; }
static void (*reg_listener[])(void) = { (void (*)(void))reg_global, (void (*)(void))reg_remove };

static int connect_and_enumerate(void)
{
    dpy = W.display_connect(NULL);
    if (!dpy) return 0;
    union wl_argument a[1]; a[0].n = 0;
    registry = new_obj(dpy, 1, W.registry_i, 1, a);          /* wl_display.get_registry */
    W.add_listener(registry, reg_listener, NULL);
    if (W.display_roundtrip(dpy) < 0) return 0;
    if (!compositor_name || !shm_name) return 0;
    compositor = registry_bind(compositor_name, W.compositor_i, min_u32(compositor_ver, 4));
    shm = registry_bind(shm_name, W.shm_i, 1);
    if (layer_shell_name) layer_shell = registry_bind(layer_shell_name, &layer_shell_i, min_u32(layer_shell_ver, 5));
    if (xdg_manager_name) xdg_manager = registry_bind(xdg_manager_name, &xdg_output_manager_i, min_u32(xdg_manager_ver, 3));
    for (int i = 0; i < nouts; i++) {
        uint32_t ov = min_u32(outs[i].version, 4);                /* name/description are v4 */
        if (ov > (uint32_t)W.output_i->version) ov = (uint32_t)W.output_i->version;
        outs[i].wl = registry_bind(outs[i].global_name, W.output_i, ov);
        W.add_listener(outs[i].wl, out_listener, &outs[i]);
        if (xdg_manager) {
            union wl_argument g[2]; g[0].n = 0; g[1].o = outs[i].wl;
            outs[i].xdg = new_obj(xdg_manager, 1, &xdg_output_i, min_u32(xdg_manager_ver, 3), g);
            W.add_listener(outs[i].xdg, xo_listener, &outs[i]);
        }
    }
    /* Two round trips: the first delivers the initial burst of events, the second any
     * that depended on it (xdg-output names, wl_output.done). */
    if (W.display_roundtrip(dpy) < 0) return 0;
    if (W.display_roundtrip(dpy) < 0) return 0;
    return 1;
}

/* ───────────────────────── shm buffers ───────────────────────── */

typedef struct {
    struct wl_proxy *buf;
    uint32_t *px;
    int busy;
    int have_last;
    int lx0, ly0, lx1, ly1;   /* bbox of what is drawn in this buffer (device px) */
} Buf;

static struct {
    struct wl_proxy *surface, *lsurf, *pool, *frame_cb;
    Buf buf[2];
    int cur;
    int out_idx;
    int cfg_w, cfg_h, scale;       /* logical size from configure; integer buffer scale */
    int bw, bh;                    /* buffer size in device px */
    int configured, mapped, closed;
    void *map; size_t map_len;
    int frame_pending;
    int64_t frame_sent_at;
    int p_x0, p_y0, p_x1, p_y1;   /* bbox of the last committed frame (damage = this U new) */
    int p_valid;
    int dirty;
} S;

static int make_shm_fd(size_t len)
{
    int fd = (int)syscall(SYS_memfd_create, "cl-annot", 1u /* MFD_CLOEXEC */);
    if (fd < 0) {
        const char *dir = getenv("XDG_RUNTIME_DIR");
        if (!dir) return -1;
        char path[512];
        snprintf(path, sizeof path, "%s/cl-annot-XXXXXX", dir);
        fd = mkstemp(path);
        if (fd < 0) return -1;
        unlink(path);
    }
    if (ftruncate(fd, (off_t)len) < 0) { close(fd); return -1; }
    return fd;
}

static void buf_release(void *data, struct wl_proxy *b) { (void)b; ((Buf *)data)->busy = 0; }
static void (*buf_listener[])(void) = { (void (*)(void))buf_release };

static void free_buffers(void)
{
    for (int i = 0; i < 2; i++) {
        if (S.buf[i].buf) { union wl_argument a[1]; request(S.buf[i].buf, 0, a); W.destroy(S.buf[i].buf); }
        memset(&S.buf[i], 0, sizeof S.buf[i]);
    }
    if (S.pool) { union wl_argument a[1]; request(S.pool, 1, a); W.destroy(S.pool); S.pool = NULL; }   /* wl_shm_pool.destroy */
    if (S.map) { munmap(S.map, S.map_len); S.map = NULL; }
}

static int alloc_buffers(int bw, int bh)
{
    free_buffers();
    size_t stride = (size_t)bw * 4, one = stride * (size_t)bh;
    S.map_len = one * 2;
    int fd = make_shm_fd(S.map_len);
    if (fd < 0) return 0;
    S.map = mmap(NULL, S.map_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (S.map == MAP_FAILED) { S.map = NULL; close(fd); return 0; }
    union wl_argument a[3];
    a[0].n = 0; a[1].h = fd; a[2].i = (int32_t)S.map_len;
    S.pool = new_obj(shm, 0, W.shm_pool_i, 1, a);            /* wl_shm.create_pool */
    close(fd);                                               /* the request carried a dup */
    if (!S.pool) return 0;
    for (int i = 0; i < 2; i++) {
        union wl_argument b[6];
        b[0].n = 0; b[1].i = (int32_t)(one * (size_t)i); b[2].i = bw; b[3].i = bh; b[4].i = (int32_t)stride; b[5].u = 0; /* ARGB8888 */
        S.buf[i].buf = new_obj(S.pool, 0, W.buffer_i, 1, b);  /* wl_shm_pool.create_buffer */
        if (!S.buf[i].buf) return 0;
        S.buf[i].px = (uint32_t *)((char *)S.map + one * (size_t)i);
        S.buf[i].busy = 0;
        S.buf[i].have_last = 0;
        W.add_listener(S.buf[i].buf, buf_listener, &S.buf[i]);
    }
    S.bw = bw; S.bh = bh; S.cur = 0; S.p_valid = 0;
    return 1;
}

/* ───────────────────────── strokes & rasteriser ───────────────────────── */

typedef struct { uint16_t x, y; } Pt;
typedef struct {
    int used;
    uint32_t sid;
    uint32_t seq;
    uint8_t r, g, b;
    float width;           /* CSS-px-equivalent width, 1..24 */
    int64_t updated, closed;
    Pt *pts;
    int n, cap;
} Stroke;
static Stroke strokes[MAX_STROKES];
static uint32_t stroke_seq;

static void stroke_free(Stroke *s) { free(s->pts); memset(s, 0, sizeof *s); }

static Stroke *stroke_find(uint32_t sid)
{
    for (int i = 0; i < MAX_STROKES; i++) if (strokes[i].used && strokes[i].sid == sid) return &strokes[i];
    return NULL;
}
static Stroke *stroke_alloc(uint32_t sid)
{
    Stroke *free_slot = NULL, *oldest = NULL;
    for (int i = 0; i < MAX_STROKES; i++) {
        Stroke *s = &strokes[i];
        if (!s->used) { if (!free_slot) free_slot = s; continue; }
        if (!oldest || s->seq < oldest->seq) oldest = s;
    }
    Stroke *s = free_slot;
    if (!s) { s = oldest; stroke_free(s); }
    memset(s, 0, sizeof *s);
    s->used = 1; s->sid = sid; s->seq = ++stroke_seq;
    return s;
}
static int stroke_push(Stroke *s, uint16_t x, uint16_t y)
{
    if (s->n >= MAX_POINTS) return 0;
    if (s->n == s->cap) {
        int nc = s->cap ? s->cap * 2 : 32;
        if (nc > MAX_POINTS) nc = MAX_POINTS;
        Pt *np = realloc(s->pts, (size_t)nc * sizeof(Pt));
        if (!np) return 0;
        s->pts = np; s->cap = nc;
    }
    s->pts[s->n].x = x; s->pts[s->n].y = y; s->n++;
    return 1;
}
static void strokes_clear(void) { for (int i = 0; i < MAX_STROKES; i++) if (strokes[i].used) stroke_free(&strokes[i]); }

/* Age the strokes exactly like the preload: watchdog first, then fade. */
static void strokes_age(int64_t now)
{
    for (int i = 0; i < MAX_STROKES; i++) {
        Stroke *s = &strokes[i];
        if (!s->used) continue;
        if (s->closed == 0) {
            if (now - s->updated >= STROKE_IDLE_MS) s->closed = now;
            continue;
        }
        if (now - s->closed >= LASER_TTL_MS) stroke_free(s);
    }
}

/* Frame scheduling. A live stroke whose pen is held still (no new points) looks the same every
 * frame, so it is NOT redrawn: only a change (`dirty`), a fade (a closed stroke, or a live one
 * whose idle limit has passed and is about to close) or the watchdog deadline needs a frame.
 * Fades are drawn at ~30 fps: the glow of a stroke over a fullscreen game should cost a fraction
 * of a core for the 1.5 s it lasts, not a core. */
#define FADE_FRAME_MS 33
static int strokes_fading(int64_t now)
{
    for (int i = 0; i < MAX_STROKES; i++) {
        const Stroke *s = &strokes[i];
        if (!s->used) continue;
        if (s->closed != 0 || now - s->updated >= STROKE_IDLE_MS) return 1;
    }
    return 0;
}
/* ms until the earliest live stroke hits its idle limit, or -1 when there is no live stroke */
static int strokes_next_deadline(int64_t now)
{
    int64_t best = -1;
    for (int i = 0; i < MAX_STROKES; i++) {
        const Stroke *s = &strokes[i];
        if (!s->used || s->closed != 0) continue;
        int64_t left = s->updated + STROKE_IDLE_MS - now;
        if (left < 1) left = 1;
        if (best < 0 || left < best) best = left;
    }
    return best > 100000 ? 100000 : (int)best;
}

typedef struct { int x0, y0, x1, y1; } IRect;     /* half-open */
static int irect_empty(const IRect *r) { return r->x1 <= r->x0 || r->y1 <= r->y0; }
static void irect_union(IRect *a, const IRect *b)
{
    if (irect_empty(b)) return;
    if (irect_empty(a)) { *a = *b; return; }
    if (b->x0 < a->x0) a->x0 = b->x0;
    if (b->y0 < a->y0) a->y0 = b->y0;
    if (b->x1 > a->x1) a->x1 = b->x1;
    if (b->y1 > a->y1) a->y1 = b->y1;
}

static float *dist_buf;
static size_t dist_cap;

/* Glow stack: [width multiple of the core, opacity], widest and faintest first. MUST match
 * electron/annotation-overlay-preload.ts GLOW_LAYERS / HOT_CORE_*. */
static const float GLOW_W[3] = { 2.8f, 1.95f, 1.4f };
static const float GLOW_A[3] = { 0.07f, 0.14f, 0.26f };
#define HOT_CORE_WIDTH 0.42f
#define HOT_CORE_ALPHA 0.55f

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Draws one stroke into px (premultiplied ARGB) and returns the touched rect. */
static IRect draw_stroke(uint32_t *px, int bw, int bh, const Stroke *s, float alpha, float wpx)
{
    IRect none = { 0, 0, 0, 0 };
    if (s->n == 0 || alpha <= 0.f) return none;
    float *xs = malloc(sizeof(float) * (size_t)s->n * 2);
    if (!xs) return none;
    float *ys = xs + s->n;
    float minx = 1e9f, miny = 1e9f, maxx = -1e9f, maxy = -1e9f;
    for (int i = 0; i < s->n; i++) {
        xs[i] = (float)s->pts[i].x / 65535.f * (float)bw;
        ys[i] = (float)s->pts[i].y / 65535.f * (float)bh;
        if (xs[i] < minx) minx = xs[i];
        if (xs[i] > maxx) maxx = xs[i];
        if (ys[i] < miny) miny = ys[i];
        if (ys[i] > maxy) maxy = ys[i];
    }
    const float rcore = wpx * 0.5f;
    const float rmax = rcore * GLOW_W[0];
    const float pad = rmax + 1.5f;
    int bx0 = (int)floorf(minx - pad), by0 = (int)floorf(miny - pad);
    int bx1 = (int)ceilf(maxx + pad), by1 = (int)ceilf(maxy + pad);
    if (bx0 < 0) bx0 = 0;
    if (by0 < 0) by0 = 0;
    if (bx1 > bw) bx1 = bw;
    if (by1 > bh) by1 = bh;
    IRect box = { bx0, by0, bx1, by1 };
    if (irect_empty(&box)) { free(xs); return none; }
    int w = bx1 - bx0, h = by1 - by0;
    size_t need = (size_t)w * (size_t)h;
    if (need > dist_cap) {
        float *nb = realloc(dist_buf, need * sizeof(float));
        if (!nb) { free(xs); return none; }
        dist_buf = nb; dist_cap = need;
    }
    for (size_t i = 0; i < need; i++) dist_buf[i] = 1e9f;

    /* Distance from each pixel centre to the polyline. */
    int segs = s->n == 1 ? 1 : s->n - 1;
    for (int k = 0; k < segs; k++) {
        float ax = xs[k], ay = ys[k];
        float bxp = s->n == 1 ? ax + 0.01f : xs[k + 1], byp = s->n == 1 ? ay : ys[k + 1];
        int x0 = (int)floorf((ax < bxp ? ax : bxp) - pad), x1 = (int)ceilf((ax > bxp ? ax : bxp) + pad);
        int y0 = (int)floorf((ay < byp ? ay : byp) - pad), y1 = (int)ceilf((ay > byp ? ay : byp) + pad);
        if (x0 < bx0) x0 = bx0;
        if (y0 < by0) y0 = by0;
        if (x1 > bx1) x1 = bx1;
        if (y1 > by1) y1 = by1;
        float dx = bxp - ax, dy = byp - ay;
        float len2 = dx * dx + dy * dy;
        for (int y = y0; y < y1; y++) {
            float py = (float)y + 0.5f;
            float *row = dist_buf + (size_t)(y - by0) * (size_t)w;
            for (int x = x0; x < x1; x++) {
                float pxx = (float)x + 0.5f;
                float t = len2 > 0.f ? ((pxx - ax) * dx + (py - ay) * dy) / len2 : 0.f;
                t = clampf(t, 0.f, 1.f);
                float ex = pxx - (ax + t * dx), ey = py - (ay + t * dy);
                float d2 = ex * ex + ey * ey;
                float *cell = row + (x - bx0);
                float cur = *cell;
                if (cur >= 1e8f || d2 < cur * cur) {
                    float d = sqrtf(d2);
                    if (d < cur) *cell = d;
                }
            }
        }
    }

    /* Composite the five passes, widest first, each at ONE opacity (source-over). */
    const float cr = (float)s->r / 255.f, cg = (float)s->g / 255.f, cb = (float)s->b / 255.f;
    const float hot_r = (wpx * HOT_CORE_WIDTH > 1.f ? wpx * HOT_CORE_WIDTH : 1.f) * 0.5f;
    const float lim = rmax + 0.5f;
    for (int y = by0; y < by1; y++) {
        const float *drow = dist_buf + (size_t)(y - by0) * (size_t)w;
        uint32_t *prow = px + (size_t)y * (size_t)bw;
        for (int x = bx0; x < bx1; x++) {
            float d = drow[x - bx0];
            if (d >= lim) continue;
            uint32_t old = prow[x];
            float oa = (float)(old >> 24) / 255.f;
            float or_ = (float)((old >> 16) & 255) / 255.f, og = (float)((old >> 8) & 255) / 255.f, ob = (float)(old & 255) / 255.f;
            for (int pass = 0; pass < 5; pass++) {
                float r, a, pr, pg, pb;
                if (pass < 3) { r = rcore * GLOW_W[pass]; a = alpha * GLOW_A[pass]; pr = cr; pg = cg; pb = cb; }
                else if (pass == 3) { r = rcore; a = alpha; pr = cr; pg = cg; pb = cb; }
                else { r = hot_r; a = alpha * HOT_CORE_ALPHA; pr = pg = pb = 1.f; }
                float cov = clampf(r - d + 0.5f, 0.f, 1.f);
                if (cov <= 0.f) continue;
                float ae = a * cov, inv = 1.f - ae;
                or_ = pr * ae + or_ * inv;
                og = pg * ae + og * inv;
                ob = pb * ae + ob * inv;
                oa = ae + oa * inv;
            }
            uint32_t A = (uint32_t)(oa * 255.f + 0.5f), R = (uint32_t)(or_ * 255.f + 0.5f);
            uint32_t G = (uint32_t)(og * 255.f + 0.5f), B = (uint32_t)(ob * 255.f + 0.5f);
            if (R > A) R = A;
            if (G > A) G = A;
            if (B > A) B = A;
            prow[x] = (A << 24) | (R << 16) | (G << 8) | B;
        }
    }
    free(xs);
    return box;
}

/* Frame size the width law is measured against: the LOGICAL width, like the preload's cssWidth. */
static float width_scale(int logical_w, int buf_scale)
{
    float k = (float)logical_w / 960.f;
    return clampf(k, 0.75f, 2.f) * (float)buf_scale;
}

/* Renders every live stroke into px; returns the union of what was drawn. */
static IRect render_strokes(uint32_t *px, int bw, int bh, int logical_w, int buf_scale, int64_t now)
{
    IRect all = { 0, 0, 0, 0 };
    const float ws = width_scale(logical_w, buf_scale);
    for (int i = 0; i < MAX_STROKES; i++) {
        const Stroke *s = &strokes[i];
        if (!s->used) continue;
        float alpha = s->closed == 0 ? 1.f : clampf(1.f - (float)(now - s->closed) / (float)LASER_TTL_MS, 0.f, 1.f);
        IRect r = draw_stroke(px, bw, bh, s, alpha, s->width * ws);
        irect_union(&all, &r);
    }
    return all;
}

#include "x11_backend.inc"
#include "x11_probe.inc"

/* ───────────────────────── layer surface ───────────────────────── */

static void ls_configure(void *data, struct wl_proxy *ls, uint32_t serial, uint32_t w, uint32_t h);
static void ls_closed(void *data, struct wl_proxy *ls);
static void (*ls_listener[])(void) = { (void (*)(void))ls_configure, (void (*)(void))ls_closed };

static void frame_done(void *data, struct wl_proxy *cb, uint32_t t)
{
    (void)data; (void)t;
    W.destroy(cb);
    S.frame_cb = NULL;
    S.frame_pending = 0;
}
static void (*frame_listener[])(void) = { (void (*)(void))frame_done };

static void surface_destroy_all(void)
{
    if (S.frame_cb) { W.destroy(S.frame_cb); S.frame_cb = NULL; }
    free_buffers();
    if (S.lsurf) { union wl_argument a[1]; request(S.lsurf, 7, a); W.destroy(S.lsurf); S.lsurf = NULL; }   /* destroy */
    if (S.surface) { union wl_argument a[1]; request(S.surface, SURF_DESTROY, a); W.destroy(S.surface); S.surface = NULL; }
    S.configured = S.mapped = S.closed = 0;
    S.frame_pending = 0; S.p_valid = 0; S.bw = S.bh = 0;
    if (dpy) W.display_flush(dpy);
}

static void commit_frame(IRect damage)
{
    Buf *b = &S.buf[S.cur];
    union wl_argument a[4];
    a[0].o = b->buf; a[1].i = 0; a[2].i = 0;
    request(S.surface, SURF_ATTACH, a);
    int sc = S.scale > 0 ? S.scale : 1;
    /* damage is in surface-local coordinates: device px / scale, rounded outwards */
    int dx0 = damage.x0 / sc, dy0 = damage.y0 / sc;
    int dx1 = (damage.x1 + sc - 1) / sc, dy1 = (damage.y1 + sc - 1) / sc;
    if (irect_empty(&damage)) { dx0 = 0; dy0 = 0; dx1 = S.cfg_w; dy1 = S.cfg_h; }
    a[0].i = dx0; a[1].i = dy0; a[2].i = dx1 - dx0; a[3].i = dy1 - dy0;
    request(S.surface, SURF_DAMAGE, a);
    union wl_argument f[1]; f[0].n = 0;
    S.frame_cb = new_obj(S.surface, SURF_FRAME, W.callback_i, 1, f);
    if (S.frame_cb) { W.add_listener(S.frame_cb, frame_listener, NULL); S.frame_pending = 1; S.frame_sent_at = now_ms(); }
    union wl_argument c[1];
    request(S.surface, SURF_COMMIT, c);
    b->busy = 1;
    S.cur ^= 1;
}

/* Draw the current stroke state into the next free buffer and commit it. */
static void render_frame(void)
{
    if (!S.configured || !S.surface || !S.buf[0].buf) return;
    Buf *b = &S.buf[S.cur];
    if (b->busy) { b = &S.buf[S.cur ^ 1]; if (b->busy) return; S.cur ^= 1; }
    int64_t now = now_ms();
    strokes_age(now);
    /* erase what this buffer last showed */
    if (!b->have_last) {
        memset(b->px, 0, (size_t)S.bw * (size_t)S.bh * 4);
    } else {
        for (int y = b->ly0; y < b->ly1; y++) memset(b->px + (size_t)y * (size_t)S.bw + b->lx0, 0, (size_t)(b->lx1 - b->lx0) * 4);
    }
    IRect drawn = render_strokes(b->px, S.bw, S.bh, S.cfg_w, S.scale > 0 ? S.scale : 1, now);
    IRect damage = drawn;
    if (S.p_valid) { IRect p = { S.p_x0, S.p_y0, S.p_x1, S.p_y1 }; irect_union(&damage, &p); }
    if (!S.mapped) { damage.x0 = 0; damage.y0 = 0; damage.x1 = S.bw; damage.y1 = S.bh; }
    b->have_last = 1;
    b->lx0 = drawn.x0; b->ly0 = drawn.y0; b->lx1 = drawn.x1; b->ly1 = drawn.y1;
    if (irect_empty(&drawn)) { b->lx0 = b->ly0 = b->lx1 = b->ly1 = 0; }
    S.p_x0 = drawn.x0; S.p_y0 = drawn.y0; S.p_x1 = drawn.x1; S.p_y1 = drawn.y1; S.p_valid = 1;
    commit_frame(damage);
    S.mapped = 1;
    S.dirty = 0;
}

static void ls_configure(void *data, struct wl_proxy *ls, uint32_t serial, uint32_t w, uint32_t h)
{
    (void)data;
    union wl_argument a[1]; a[0].u = serial;
    request(ls, 6, a);                                       /* ack_configure */
    if (w == 0 || h == 0) { say("ERR zero_configure"); return; }
    int sc = outs[S.out_idx].scale > 0 ? outs[S.out_idx].scale : 1;
    if (sc > 4) sc = 4;
    if (S.configured && (int)w == S.cfg_w && (int)h == S.cfg_h && sc == S.scale) { S.dirty = 1; return; }
    S.cfg_w = (int)w; S.cfg_h = (int)h; S.scale = sc;
    if (S.cfg_w > 16384 || S.cfg_h > 16384 || (int64_t)S.cfg_w * S.cfg_h * sc * sc > MAX_BUFFER_PIXELS) { say("ERR too_large"); return; }
    if (!alloc_buffers(S.cfg_w * sc, S.cfg_h * sc)) { say("ERR shm"); return; }
    union wl_argument bs[1]; bs[0].i = sc;
    request(S.surface, SURF_BUFFER_SCALE, bs);
    int first = !S.configured;
    S.configured = 1; S.mapped = 0; S.dirty = 1;
    render_frame();
    if (first) say("SHOWN %d %d %d %d", S.out_idx, S.cfg_w, S.cfg_h, sc);
}

static void ls_closed(void *data, struct wl_proxy *ls)
{
    (void)data; (void)ls;
    S.closed = 1;
}

static int show_overlay(int idx)
{
    if (!layer_shell) { say("ERR no_layer_shell"); return 0; }
    if (idx < 0 || idx >= nouts) { say("ERR bad_output"); return 0; }
    if (S.surface) surface_destroy_all();
    S.out_idx = idx;
    union wl_argument a[1]; a[0].n = 0;
    S.surface = new_obj(compositor, 0, W.surface_i, min_u32(compositor_ver, 4), a);   /* create_surface */
    if (!S.surface) { say("ERR surface"); return 0; }
    union wl_argument g[5];
    g[0].n = 0; g[1].o = S.surface; g[2].o = outs[idx].wl; g[3].u = 3 /* OVERLAY */; g[4].s = "cipherline-annotations";
    S.lsurf = new_obj(layer_shell, 0, &layer_surface_i, min_u32(layer_shell_ver, 5), g);
    if (!S.lsurf) { say("ERR layer_surface"); return 0; }
    W.add_listener(S.lsurf, ls_listener, NULL);
    union wl_argument sz[2]; sz[0].u = 0; sz[1].u = 0;
    request(S.lsurf, 0, sz);                                  /* set_size(0,0): fill the output */
    union wl_argument an[1]; an[0].u = 1 | 2 | 4 | 8;
    request(S.lsurf, 1, an);                                  /* anchor all edges */
    union wl_argument ez[1]; ez[0].i = -1;
    request(S.lsurf, 2, ez);                                  /* exclusive_zone -1: ignore panels */
    union wl_argument ki[1]; ki[0].u = 0;
    request(S.lsurf, 4, ki);                                  /* keyboard_interactivity none */
    /* Empty input region: every click falls through to what is underneath. */
    union wl_argument rg[1]; rg[0].n = 0;
    struct wl_proxy *region = new_obj(compositor, 1, W.region_i, 1, rg);     /* create_region */
    union wl_argument ir[1]; ir[0].o = region;
#ifndef CL_TEST_NEG_CONTROL   /* harness-only: the click test must FAIL without the empty region */
    request(S.surface, SURF_SET_INPUT, ir);
#else
    (void)ir;
#endif
    if (region) { union wl_argument d[1]; request(region, 0, d); W.destroy(region); }
    union wl_argument cm[1];
    request(S.surface, SURF_COMMIT, cm);                      /* no buffer yet: asks for configure */
    W.display_flush(dpy);
    return 1;
}

/* ───────────────────────── stdin protocol ───────────────────────── */

static char inbuf[MAX_LINE + 2];
static size_t inlen;

static int parse_u(const char *s, long long lo, long long hi, long long *out)
{
    if (!s || !*s) return 0;
    char *end;
    errno = 0;
    long long v = strtoll(s, &end, 10);
    if (errno || *end || v < lo || v > hi) return 0;
    *out = v;
    return 1;
}

static int read_points(Stroke *s, char **save, long long n)
{
    for (long long i = 0; i < n; i++) {
        char *tok = strtok_r(NULL, " ", save);
        if (!tok) return 0;
        char *comma = strchr(tok, ',');
        if (!comma) return 0;
        *comma = 0;
        long long x, y;
        if (!parse_u(tok, 0, 65535, &x) || !parse_u(comma + 1, 0, 65535, &y)) return 0;
        if (!stroke_push(s, (uint16_t)x, (uint16_t)y)) { /* over the per-stroke cap: drop the rest */ }
    }
    return 1;
}

/* a stroke changed: whichever presenter is up must redraw */
#define MARK_DIRTY() do { if (XS.active) XS.dirty = 1; else S.dirty = 1; } while (0)

static int cmd_U(char **save)
{
    long long sid, w10, upd, clo, n;
    char *t_sid = strtok_r(NULL, " ", save), *t_col = strtok_r(NULL, " ", save), *t_w = strtok_r(NULL, " ", save);
    char *t_upd = strtok_r(NULL, " ", save), *t_clo = strtok_r(NULL, " ", save), *t_n = strtok_r(NULL, " ", save);
    if (!parse_u(t_sid, 0, 0x7fffffff, &sid) || !t_col || strlen(t_col) != 6 || !parse_u(t_w, 10, 240, &w10)
        || !parse_u(t_upd, 0, 4102444800000LL, &upd) || !parse_u(t_clo, 0, 4102444800000LL, &clo) || !parse_u(t_n, 0, MAX_POINTS, &n)) return 0;
    char *end;
    unsigned long rgb = strtoul(t_col, &end, 16);
    if (*end) return 0;
    Stroke *s = stroke_find((uint32_t)sid);
    if (s) stroke_free(s);
    s = stroke_alloc((uint32_t)sid);
    s->r = (rgb >> 16) & 255; s->g = (rgb >> 8) & 255; s->b = rgb & 255;
    s->width = (float)w10 / 10.f; s->updated = upd; s->closed = clo;
    if (!read_points(s, save, n)) { stroke_free(s); return 0; }
    MARK_DIRTY();
    return 1;
}

static int cmd_A(char **save)
{
    long long sid, upd, clo, n;
    char *t_sid = strtok_r(NULL, " ", save), *t_upd = strtok_r(NULL, " ", save);
    char *t_clo = strtok_r(NULL, " ", save), *t_n = strtok_r(NULL, " ", save);
    if (!parse_u(t_sid, 0, 0x7fffffff, &sid) || !parse_u(t_upd, 0, 4102444800000LL, &upd)
        || !parse_u(t_clo, 0, 4102444800000LL, &clo) || !parse_u(t_n, 0, MAX_POINTS, &n)) return 0;
    Stroke *s = stroke_find((uint32_t)sid);
    if (!s) return 1;            /* never saw its begin: ignore rather than invent */
    if (!read_points(s, save, n)) return 0;
    s->updated = upd; s->closed = clo;
    MARK_DIRTY();
    return 1;
}

static int handle_line(char *line)
{
    char *save = NULL;
    char *cmd = strtok_r(line, " ", &save);
    if (!cmd) return 1;
    if (!strcmp(cmd, "U")) return cmd_U(&save);
    if (!strcmp(cmd, "A")) return cmd_A(&save);
    if (!strcmp(cmd, "R")) {
        long long sid;
        if (!parse_u(strtok_r(NULL, " ", &save), 0, 0x7fffffff, &sid)) return 0;
        Stroke *s = stroke_find((uint32_t)sid);
        if (s) { stroke_free(s); MARK_DIRTY(); }
        return 1;
    }
    if (!strcmp(cmd, "Z")) { strokes_clear(); MARK_DIRTY(); return 1; }
    if (!strcmp(cmd, "SHOW")) {
        long long idx;
        if (!parse_u(strtok_r(NULL, " ", &save), 0, MAX_OUTPUTS - 1, &idx)) return 0;
        show_overlay((int)idx);
        return 1;
    }
    if (!strcmp(cmd, "SHOWX")) {
        long long idx;
        if (!parse_u(strtok_r(NULL, " ", &save), 0, MAX_OUTPUTS - 1, &idx)) return 0;
        if (S.surface) surface_destroy_all();
        x_show((int)idx);
        return 1;
    }
    if (!strcmp(cmd, "HIDE")) { surface_destroy_all(); x_hide(); return 1; }
    if (!strcmp(cmd, "QUIT")) return -1;
    return 0;
}

/* returns -1 on QUIT/EOF */
static int pump_stdin(void)
{
    ssize_t r = read(0, inbuf + inlen, MAX_LINE + 1 - inlen);
    if (r == 0) return -1;
    if (r < 0) return (errno == EAGAIN || errno == EINTR) ? 0 : -1;
    inlen += (size_t)r;
    size_t start = 0;
    for (size_t i = 0; i < inlen; i++) {
        if (inbuf[i] != '\n') continue;
        inbuf[i] = 0;
        int rc = handle_line(inbuf + start);
        if (rc < 0) return -1;
        if (rc == 0) say("ERR bad_command");
        start = i + 1;
    }
    if (start) { memmove(inbuf, inbuf + start, inlen - start); inlen -= start; }
    if (inlen > MAX_LINE) { say("ERR line_too_long"); return -1; }
    return 0;
}

/* ───────────────────────── main loop ───────────────────────── */

static void report_outputs(void)
{
    for (int i = 0; i < nouts; i++) {
        Out *o = &outs[i];
        int odd = o->transform & 1;                              /* 90/270 (and flipped) swap axes */
        int pw = odd ? o->mode_h : o->mode_w, ph = odd ? o->mode_w : o->mode_h;
        int sc = o->scale > 0 ? o->scale : 1;
        int lx = o->geo_x, ly = o->geo_y, lw = pw / sc, lh = ph / sc;
        if ((o->has_logical & 3) == 3) { lx = o->lx; ly = o->ly; lw = o->lw; lh = o->lh; }
        else if (o->has_logical & 1) { lx = o->lx; ly = o->ly; }
        say("OUT %d %s %d %d %d %d %d %d %d", i, o->name[0] ? o->name : "-", lx, ly, lw, lh, sc, pw, ph);
        if (o->refresh_mhz > 0) say("HZ %d %d", i, o->refresh_mhz);       /* separate line: OUT keeps its shape */
    }
}

static int dispatch_display(int readable)
{
    if (readable) {
        if (W.display_read_events(dpy) < 0) return -1;
    }
    if (W.display_dispatch_pending(dpy) < 0) return -1;
    return 0;
}

int main(int argc, char **argv)
{
    prctl(PR_SET_PDEATHSIG, SIGTERM);              /* never outlive main */
    signal(SIGPIPE, SIG_IGN);
    if (argc > 1 && !strcmp(argv[1], "--dump-tables")) { dump_tables(); return 0; }
    /* Plain-X11 modes: no Wayland connection involved (x11_probe.inc). */
    if (argc > 1 && !strcmp(argv[1], "--x11-probe")) return x11_probe_main(0);
    if (argc > 1 && !strcmp(argv[1], "--x11-watch")) return x11_probe_main(1);
    setvbuf(stdout, NULL, _IOLBF, 0);
    say("HELLO %d", HELPER_VERSION);
    if (!load_wayland()) { say("ERR no_libwayland"); return 2; }
    init_tables();
    if (!getenv("WAYLAND_DISPLAY") && !getenv("WAYLAND_SOCKET")) { say("ERR no_wayland_display"); return 2; }
    if (!connect_and_enumerate()) { say("ERR connect"); return 2; }
    if (argc > 1 && !strcmp(argv[1], "--outputs")) {   /* one-shot: list outputs (+ HZ) and leave; no X, no surface */
        report_outputs();
        W.display_disconnect(dpy);
        return 0;
    }
    int have_x = x_open();
    report_outputs();
    if (have_x) x_report();
    say("READY layer_shell=%d x11=%d", layer_shell ? 1 : 0, have_x ? 1 : 0);
    fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);

    int quit = 0;
    while (!quit) {
        W.display_dispatch_pending(dpy);
        if (S.closed) { surface_destroy_all(); say("CLOSED"); }
        W.display_flush(dpy);

        int64_t now = now_ms();
        if (S.frame_pending && now - S.frame_sent_at > 250) S.frame_pending = 0;   /* never wedge on a lost callback */
        int fading = strokes_fading(now);
        if (S.configured && !S.frame_pending && (S.dirty || (fading && now - last_render_at >= FADE_FRAME_MS))) {
            render_frame();
            last_render_at = now;
        }
        if (XS.active) {
            x_events();
            /* ~60 fps at most for changes, ~30 for fades: every present is a PutImage over the X socket */
            if ((XS.dirty && now - XS.presented_at >= 16) || (fading && now - XS.presented_at >= FADE_FRAME_MS)) x_render();
        }

        while (W.display_prepare_read(dpy) != 0) W.display_dispatch_pending(dpy);
        W.display_flush(dpy);
        struct pollfd fds[3] = { { W.display_get_fd(dpy), POLLIN, 0 }, { 0, POLLIN, 0 }, { -1, POLLIN, 0 } };
        if (XS.active) fds[2].fd = X.XConnectionNumber(XS.dpy);
        int timeout = -1;
        if (S.frame_pending) timeout = 50;
        else if ((S.configured && S.dirty) || (XS.active && XS.dirty)) timeout = 4;
        else if (fading) timeout = FADE_FRAME_MS / 2;
        else if (S.configured || XS.active) timeout = strokes_next_deadline(now);     /* -1 when nothing is live */
        int pr = poll(fds, 3, timeout);
        if (pr < 0 && errno != EINTR) { W.display_cancel_read(dpy); break; }
        if (pr > 0 && (fds[0].revents & POLLIN)) {
            if (dispatch_display(1) < 0) { say("ERR display"); break; }
        } else {
            W.display_cancel_read(dpy);
        }
        if (pr > 0 && (fds[0].revents & (POLLERR | POLLHUP))) { say("ERR display"); break; }
        if (pr > 0 && (fds[1].revents & (POLLIN | POLLHUP))) {
            if (pump_stdin() < 0) quit = 1;
        }
        if (W.display_get_error(dpy)) { say("ERR protocol"); break; }
    }
    surface_destroy_all();
    x_hide();
    strokes_clear();
    if (dpy) W.display_disconnect(dpy);
    return 0;
}
