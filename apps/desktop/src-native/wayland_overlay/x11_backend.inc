/*
 * XWayland fallback backend (included by cl_wayland_overlay.c, after the rasteriser).
 *
 * GNOME's Mutter has no wlr-layer-shell, so a Wayland client there cannot pin a surface above
 * other windows. But Mutter does run XWayland, and an X11 OVERRIDE-REDIRECT window is never
 * managed by the window manager: it gets exactly the position we ask for in XWayland's root
 * coordinates, no decoration, no focus, and Mutter stacks override-redirect windows above
 * normal ones, fullscreen included. With an ARGB (32-bit) visual it is translucent, and with an
 * EMPTY XShape input region every click falls through. Proven in a headless Mutter 48 by
 * harness/wayland-annotation (strokes above a fullscreen Wayland window and above one opened
 * AFTER the overlay; clicks reach the window below).
 *
 * libX11 / libXext / libXrandr are dlopen()ed (declarations in x11_min.h); no X header is
 * needed to build. XRandR is optional: without it the whole root is taken as the one monitor.
 */
#include "x11_min.h"

typedef int (*cx_error_handler)(cx_Display *, void *);
typedef int (*cx_io_error_handler)(cx_Display *);

static struct {
    void *x11, *xext, *xrandr;
    cx_Display *(*XOpenDisplay)(const char *);
    int (*XCloseDisplay)(cx_Display *);
    int (*XDefaultScreen)(cx_Display *);
    cx_Window (*XRootWindow)(cx_Display *, int);
    int (*XDisplayWidth)(cx_Display *, int);
    int (*XDisplayHeight)(cx_Display *, int);
    int (*XMatchVisualInfo)(cx_Display *, int, int, int, cx_XVisualInfo *);
    cx_Colormap (*XCreateColormap)(cx_Display *, cx_Window, cx_Visual *, int);
    int (*XFreeColormap)(cx_Display *, cx_Colormap);
    cx_Window (*XCreateWindow)(cx_Display *, cx_Window, int, int, unsigned, unsigned, unsigned, int, unsigned, cx_Visual *,
                               unsigned long, cx_XSetWindowAttributes *);
    int (*XMapRaised)(cx_Display *, cx_Window);
    int (*XDestroyWindow)(cx_Display *, cx_Window);
    cx_GC (*XCreateGC)(cx_Display *, cx_XID, unsigned long, void *);
    int (*XFreeGC)(cx_Display *, cx_GC);
    cx_XImageHead *(*XCreateImage)(cx_Display *, cx_Visual *, unsigned, int, int, char *, unsigned, unsigned, int, int);
    int (*XPutImage)(cx_Display *, cx_XID, cx_GC, cx_XImageHead *, int, int, int, int, unsigned, unsigned);
    int (*XFlush)(cx_Display *);
    int (*XSync)(cx_Display *, cx_Bool);
    int (*XPending)(cx_Display *);
    int (*XNextEvent)(cx_Display *, cx_XEvent *);
    int (*XConnectionNumber)(cx_Display *);
    int (*XSelectInput)(cx_Display *, cx_Window, long);
    char *(*XGetAtomName)(cx_Display *, cx_Atom);
    int (*XFree)(void *);
    cx_error_handler (*XSetErrorHandler)(cx_error_handler);
    cx_io_error_handler (*XSetIOErrorHandler)(cx_io_error_handler);
    void (*XShapeCombineRectangles)(cx_Display *, cx_Window, int, int, int, cx_XRectangle *, int, int, int);
    cx_XRRMonitorInfo *(*XRRGetMonitors)(cx_Display *, cx_Window, cx_Bool, int *);
    void (*XRRFreeMonitors)(cx_XRRMonitorInfo *);
} X;

#define XMAX_MON 16
static struct {
    int n;
    char name[XMAX_MON][40];
    int x[XMAX_MON], y[XMAX_MON], w[XMAX_MON], h[XMAX_MON];
} xmon;

static struct {
    cx_Display *dpy;
    int scr;
    cx_Window root, win;
    cx_GC gc;
    cx_Colormap cmap;
    cx_XVisualInfo vi;
    uint32_t *px;
    cx_XImageHead *img;
    int w, h;
    int active;
    int have_last;
    IRect last;               /* what is drawn in px */
    int64_t presented_at;
    int dirty;
} XS;

static int x_error_ignore(cx_Display *d, void *ev) { (void)d; (void)ev; return 0; }   /* a stale window must not abort us */
static int x_io_error(cx_Display *d) { (void)d; say("ERR x_connection_lost"); _exit(2); }

static int x_load(void)
{
    X.x11 = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
    X.xext = dlopen("libXext.so.6", RTLD_NOW | RTLD_LOCAL);
    if (!X.x11 || !X.xext) return 0;
    X.xrandr = dlopen("libXrandr.so.2", RTLD_NOW | RTLD_LOCAL);       /* optional */
#define XSYM(lib, field) do { *(void **)&X.field = dlsym(lib, #field); if (!X.field) return 0; } while (0)
    XSYM(X.x11, XOpenDisplay); XSYM(X.x11, XCloseDisplay); XSYM(X.x11, XDefaultScreen); XSYM(X.x11, XRootWindow);
    XSYM(X.x11, XDisplayWidth); XSYM(X.x11, XDisplayHeight); XSYM(X.x11, XMatchVisualInfo);
    XSYM(X.x11, XCreateColormap); XSYM(X.x11, XFreeColormap); XSYM(X.x11, XCreateWindow); XSYM(X.x11, XMapRaised);
    XSYM(X.x11, XDestroyWindow); XSYM(X.x11, XCreateGC); XSYM(X.x11, XFreeGC); XSYM(X.x11, XCreateImage);
    XSYM(X.x11, XPutImage); XSYM(X.x11, XFlush); XSYM(X.x11, XSync); XSYM(X.x11, XPending); XSYM(X.x11, XNextEvent);
    XSYM(X.x11, XConnectionNumber); XSYM(X.x11, XSelectInput); XSYM(X.x11, XGetAtomName); XSYM(X.x11, XFree);
    XSYM(X.x11, XSetErrorHandler); XSYM(X.x11, XSetIOErrorHandler);
    XSYM(X.xext, XShapeCombineRectangles);
#undef XSYM
    if (X.xrandr) {
        *(void **)&X.XRRGetMonitors = dlsym(X.xrandr, "XRRGetMonitors");
        *(void **)&X.XRRFreeMonitors = dlsym(X.xrandr, "XRRFreeMonitors");
    }
    return 1;
}

/* 1 = an ARGB-capable XWayland is reachable and its monitors are known. */
static int x_open(void)
{
    if (!getenv("DISPLAY")) return 0;
    if (!x_load()) return 0;
    X.XSetErrorHandler(x_error_ignore);
    X.XSetIOErrorHandler(x_io_error);
    XS.dpy = X.XOpenDisplay(NULL);
    if (!XS.dpy) return 0;
    XS.scr = X.XDefaultScreen(XS.dpy);
    XS.root = X.XRootWindow(XS.dpy, XS.scr);
    if (!X.XMatchVisualInfo(XS.dpy, XS.scr, 32, CX_TRUE_COLOR, &XS.vi)) goto fail;
    /* Premultiplied ARGB8888 only: anything else would need a different pixel layout. */
    if (XS.vi.red_mask != 0xff0000UL || XS.vi.green_mask != 0xff00UL || XS.vi.blue_mask != 0xffUL) goto fail;
    xmon.n = 0;
    if (X.XRRGetMonitors && X.XRRFreeMonitors) {
        int n = 0;
        cx_XRRMonitorInfo *m = X.XRRGetMonitors(XS.dpy, XS.root, 1, &n);
        for (int i = 0; m && i < n && xmon.n < XMAX_MON; i++) {
            char *nm = X.XGetAtomName(XS.dpy, m[i].name);
            sanitize_name(xmon.name[xmon.n], sizeof xmon.name[0], nm ? nm : "");
            if (nm) X.XFree(nm);
            xmon.x[xmon.n] = m[i].x; xmon.y[xmon.n] = m[i].y; xmon.w[xmon.n] = m[i].width; xmon.h[xmon.n] = m[i].height;
            xmon.n++;
        }
        if (m) X.XRRFreeMonitors(m);
    }
    if (xmon.n == 0) {                       /* no XRandR: the root is the one monitor */
        snprintf(xmon.name[0], sizeof xmon.name[0], "-");
        xmon.x[0] = xmon.y[0] = 0;
        xmon.w[0] = X.XDisplayWidth(XS.dpy, XS.scr); xmon.h[0] = X.XDisplayHeight(XS.dpy, XS.scr);
        xmon.n = 1;
    }
    return 1;
fail:
    X.XCloseDisplay(XS.dpy);
    XS.dpy = NULL;
    return 0;
}

static void x_report(void)
{
    for (int i = 0; i < xmon.n; i++)
        say("XOUT %d %s %d %d %d %d", i, xmon.name[i][0] ? xmon.name[i] : "-", xmon.x[i], xmon.y[i], xmon.w[i], xmon.h[i]);
}

static void x_hide(void)
{
    if (!XS.dpy) return;
    if (XS.win) { X.XDestroyWindow(XS.dpy, XS.win); XS.win = 0; }
    if (XS.gc) { X.XFreeGC(XS.dpy, XS.gc); XS.gc = NULL; }
    if (XS.cmap) { X.XFreeColormap(XS.dpy, XS.cmap); XS.cmap = 0; }
    if (XS.img) { XS.img->data = NULL; X.XFree(XS.img); XS.img = NULL; }   /* the pixels are ours */
    free(XS.px); XS.px = NULL;
    X.XFlush(XS.dpy);
    XS.active = 0; XS.have_last = 0;
}

/* Which X monitor shows Wayland output `wl_idx`: same connector name, else the only one. */
static int x_monitor_for(int wl_idx)
{
    if (wl_idx >= 0 && wl_idx < nouts && outs[wl_idx].name[0] && strcmp(outs[wl_idx].name, "-")) {
        for (int i = 0; i < xmon.n; i++) if (!strcmp(xmon.name[i], outs[wl_idx].name)) return i;
    }
    if (xmon.n == 1 && nouts == 1) return 0;
    return -1;
}

static int x_show(int wl_idx)
{
    if (!XS.dpy) { say("ERR no_x11"); return 0; }
    x_hide();
    int m = x_monitor_for(wl_idx);
    if (m < 0) { say("ERR no_x_monitor"); return 0; }
    int w = xmon.w[m], h = xmon.h[m];
    if (w < 1 || h < 1 || w > 16384 || h > 16384 || (int64_t)w * h > MAX_BUFFER_PIXELS) { say("ERR bad_x_monitor"); return 0; }
    XS.px = calloc((size_t)w * (size_t)h, 4);
    if (!XS.px) { say("ERR oom"); return 0; }
    cx_XSetWindowAttributes at;
    memset(&at, 0, sizeof at);
    at.override_redirect = 1;                 /* the window manager never sees it */
    XS.cmap = X.XCreateColormap(XS.dpy, XS.root, XS.vi.visual, CX_ALLOC_NONE);
    at.colormap = XS.cmap;
    at.border_pixel = 0;
    at.background_pixel = 0;
    XS.win = X.XCreateWindow(XS.dpy, XS.root, xmon.x[m], xmon.y[m], (unsigned)w, (unsigned)h, 0, 32, CX_INPUT_OUTPUT, XS.vi.visual,
                             CX_CW_OVERRIDE_REDIRECT | CX_CW_COLORMAP | CX_CW_BORDER_PIXEL | CX_CW_BACK_PIXEL, &at);
    if (!XS.win) { say("ERR x_window"); x_hide(); return 0; }
#ifndef CL_TEST_NEG_CONTROL   /* harness-only: the click test must FAIL without the empty input shape */
    /* EMPTY input region: every click falls through to what is underneath. */
    X.XShapeCombineRectangles(XS.dpy, XS.win, CX_SHAPE_INPUT, 0, 0, NULL, 0, CX_SHAPE_SET, CX_UNSORTED);
#endif
    X.XSelectInput(XS.dpy, XS.win, CX_EXPOSURE_MASK);
    XS.gc = X.XCreateGC(XS.dpy, XS.win, 0, NULL);
    XS.img = X.XCreateImage(XS.dpy, XS.vi.visual, 32, CX_Z_PIXMAP, 0, (char *)XS.px, (unsigned)w, (unsigned)h, 32, 0);
    if (!XS.img) { say("ERR x_image"); x_hide(); return 0; }
    XS.w = w; XS.h = h;
    X.XMapRaised(XS.dpy, XS.win);
    XS.active = 1; XS.have_last = 0; XS.dirty = 1; XS.presented_at = 0;
    X.XSync(XS.dpy, 0);
    say("SHOWN %d %d %d 1", wl_idx, w, h);
    return 1;
}

/* Draw the current stroke state and push only the changed rectangle to the server. */
static void x_render(void)
{
    if (!XS.active) return;
    int64_t now = now_ms();
    strokes_age(now);
    if (!XS.have_last) {
        memset(XS.px, 0, (size_t)XS.w * (size_t)XS.h * 4);
    } else if (!irect_empty(&XS.last)) {
        for (int y = XS.last.y0; y < XS.last.y1; y++)
            memset(XS.px + (size_t)y * (size_t)XS.w + XS.last.x0, 0, (size_t)(XS.last.x1 - XS.last.x0) * 4);
    }
    IRect drawn = render_strokes(XS.px, XS.w, XS.h, XS.w, 1, now);
    IRect damage = drawn;
    if (XS.have_last) irect_union(&damage, &XS.last);
    if (!XS.have_last) { damage.x0 = 0; damage.y0 = 0; damage.x1 = XS.w; damage.y1 = XS.h; }
    XS.last = drawn; XS.have_last = 1;
    if (!irect_empty(&damage)) {
        X.XPutImage(XS.dpy, XS.win, XS.gc, XS.img, damage.x0, damage.y0, damage.x0, damage.y0,
                    (unsigned)(damage.x1 - damage.x0), (unsigned)(damage.y1 - damage.y0));
        X.XFlush(XS.dpy);
    }
    XS.presented_at = now; XS.dirty = 0;
}

/* Expose: the server lost our contents (e.g. the window was just mapped) — repaint everything. */
static void x_events(void)
{
    if (!XS.dpy) return;
    while (X.XPending(XS.dpy)) {
        cx_XEvent ev;
        X.XNextEvent(XS.dpy, &ev);
        if (ev.type == CX_EXPOSE && XS.active) { XS.have_last = 0; XS.dirty = 1; }
    }
}
