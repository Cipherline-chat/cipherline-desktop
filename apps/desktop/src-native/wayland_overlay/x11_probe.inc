/*
 * Plain-X11 probe / watch modes (included by cl_wayland_overlay.c, after x11_backend.inc).
 *
 * The X11 annotation overlay is an Electron BrowserWindow (electron/annotation-overlay.ts), not
 * something this helper draws. What Electron cannot tell it is (1) whether a COMPOSITING MANAGER
 * is running — without one a "transparent" window is painted opaque black over the whole shared
 * screen — and (2) where another client's window is. Both are plain X11 queries, answered here
 * with the same dlopen()ed libX11 (no link-time dependency, no new package):
 *
 *   --x11-probe   print one `CM <0|1>` and exit. CM 1 = some client owns the `_NET_WM_CM_S<n>`
 *                 manager selection (EWMH; the very signal Chromium's own ARGB-visual decision
 *                 uses), CM 0 = nobody does. `ERR <code>` + exit 2 when X cannot be queried
 *                 (main then falls back to guessing from the desktop's name).
 *   --x11-watch   stay up: `CM <0|1>` at start and on every change (re-checked ~2x/s), and for the
 *                 window main names with `WIN <xid>` (0 = stop tracking) a line
 *                 `W <state> <x> <y> <w> <h>` at start and on every change (polled ~12x/s):
 *                   ok         viewable on the current workspace; x y w h = the window's client
 *                              area in ROOT coordinates, physical pixels
 *                   unmapped   not viewable (minimized windows are unmapped by most window managers)
 *                   minimized  viewable but _NET_WM_STATE_HIDDEN
 *                   workspace  _NET_WM_DESKTOP is not the current desktop (and not "all desktops")
 *                   gone       the window no longer exists
 *                 `QUIT` / EOF ends it.
 * Read-only: nothing here creates, moves or selects anything on the X server.
 */
static struct {
    void *lib;
    cx_Display *dpy;
    int scr;
    cx_Window root;
    cx_Atom cm_atom, a_state, a_hidden, a_desktop, a_cur_desktop;
    cx_Display *(*XOpenDisplay)(const char *);
    int (*XCloseDisplay)(cx_Display *);
    int (*XDefaultScreen)(cx_Display *);
    cx_Window (*XRootWindow)(cx_Display *, int);
    cx_Atom (*XInternAtom)(cx_Display *, const char *, cx_Bool);
    cx_Window (*XGetSelectionOwner)(cx_Display *, cx_Atom);
    int (*XGetWindowAttributes)(cx_Display *, cx_Window, cx_XWindowAttributes *);
    cx_Bool (*XTranslateCoordinates)(cx_Display *, cx_Window, cx_Window, int, int, int *, int *, cx_Window *);
    int (*XGetWindowProperty)(cx_Display *, cx_Window, cx_Atom, long, long, cx_Bool, cx_Atom, cx_Atom *, int *,
                              unsigned long *, unsigned long *, unsigned char **);
    int (*XFree)(void *);
    int (*XSync)(cx_Display *, cx_Bool);
    cx_error_handler (*XSetErrorHandler)(cx_error_handler);
    cx_io_error_handler (*XSetIOErrorHandler)(cx_io_error_handler);
} P;

/* NULL = ok; otherwise the ERR code to report. */
static const char *xp_open(void)
{
    if (!getenv("DISPLAY")) return "no_display";
    P.lib = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
    if (!P.lib) return "no_libx11";
#define PSYM(f) do { *(void **)&P.f = dlsym(P.lib, #f); if (!P.f) return "no_libx11"; } while (0)
    PSYM(XOpenDisplay); PSYM(XCloseDisplay); PSYM(XDefaultScreen); PSYM(XRootWindow); PSYM(XInternAtom);
    PSYM(XGetSelectionOwner); PSYM(XGetWindowAttributes); PSYM(XTranslateCoordinates); PSYM(XGetWindowProperty);
    PSYM(XFree); PSYM(XSync); PSYM(XSetErrorHandler); PSYM(XSetIOErrorHandler);
#undef PSYM
    P.XSetErrorHandler(x_error_ignore);       /* a stale window id is an answer ("gone"), not a crash */
    P.XSetIOErrorHandler(x_io_error);
    P.dpy = P.XOpenDisplay(NULL);
    if (!P.dpy) return "no_x_server";
    P.scr = P.XDefaultScreen(P.dpy);
    P.root = P.XRootWindow(P.dpy, P.scr);
    char nm[40];
    snprintf(nm, sizeof nm, "_NET_WM_CM_S%d", P.scr);
    P.cm_atom = P.XInternAtom(P.dpy, nm, 0);
    P.a_state = P.XInternAtom(P.dpy, "_NET_WM_STATE", 0);
    P.a_hidden = P.XInternAtom(P.dpy, "_NET_WM_STATE_HIDDEN", 0);
    P.a_desktop = P.XInternAtom(P.dpy, "_NET_WM_DESKTOP", 0);
    P.a_cur_desktop = P.XInternAtom(P.dpy, "_NET_CURRENT_DESKTOP", 0);
    return NULL;
}

static int xp_compositor(void) { return P.XGetSelectionOwner(P.dpy, P.cm_atom) != 0; }

/* First 32-bit item of a CARDINAL property; 0 when absent / not 32-bit. */
static int xp_cardinal(cx_Window w, cx_Atom prop, unsigned long *out)
{
    cx_Atom type = 0; int fmt = 0; unsigned long n = 0, left = 0; unsigned char *data = NULL;
    if (P.XGetWindowProperty(P.dpy, w, prop, 0, 1, 0, CX_XA_CARDINAL, &type, &fmt, &n, &left, &data) != 0) return 0;
    int ok = data && type == CX_XA_CARDINAL && fmt == 32 && n >= 1;
    if (ok) *out = *(unsigned long *)data;    /* format-32 items arrive as C longs */
    if (data) P.XFree(data);
    return ok;
}

static int xp_hidden_flag(cx_Window w)
{
    cx_Atom type = 0; int fmt = 0; unsigned long n = 0, left = 0; unsigned char *data = NULL;
    if (P.XGetWindowProperty(P.dpy, w, P.a_state, 0, 64, 0, CX_XA_ATOM, &type, &fmt, &n, &left, &data) != 0) return 0;
    int hidden = 0;
    if (data && type == CX_XA_ATOM && fmt == 32) {
        unsigned long *a = (unsigned long *)data;
        for (unsigned long i = 0; i < n; i++) if (a[i] == P.a_hidden) hidden = 1;
    }
    if (data) P.XFree(data);
    return hidden;
}

typedef struct { const char *state; int x, y, w, h; } XpWin;

static XpWin xp_window(cx_Window w)
{
    XpWin r = { "gone", 0, 0, 0, 0 };
    cx_XWindowAttributes at;
    memset(&at, 0, sizeof at);
    if (!P.XGetWindowAttributes(P.dpy, w, &at)) return r;
    if (at.map_state != CX_IS_VIEWABLE) { r.state = "unmapped"; return r; }
    if (xp_hidden_flag(w)) { r.state = "minimized"; return r; }
    unsigned long desk = 0, cur = 0;
    if (xp_cardinal(w, P.a_desktop, &desk) && desk != 0xFFFFFFFFUL && xp_cardinal(P.root, P.a_cur_desktop, &cur) && desk != cur) {
        r.state = "workspace";
        return r;
    }
    int rx = 0, ry = 0; cx_Window child = 0;
    if (!P.XTranslateCoordinates(P.dpy, w, P.root, 0, 0, &rx, &ry, &child)) return r;
    if (at.width < 1 || at.height < 1) { r.state = "unmapped"; return r; }
    r.state = "ok"; r.x = rx; r.y = ry; r.w = at.width; r.h = at.height;
    return r;
}

static int x11_probe_main(int watch)
{
    setvbuf(stdout, NULL, _IOLBF, 0);
    say("HELLO %d", HELPER_VERSION);
    const char *err = xp_open();
    if (err) { say("ERR %s", err); return 2; }
    int cm = xp_compositor();
    say("CM %d", cm);
    if (!watch) { P.XCloseDisplay(P.dpy); return 0; }
    say("READY x11_watch=1");
    fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);

    cx_Window target = 0;
    XpWin last = { "", -1, -1, -1, -1 };
    int have_last = 0;
    int64_t last_cm_at = now_ms();
    char line[128]; size_t ll = 0;
    for (;;) {
        struct pollfd pf = { 0, POLLIN, 0 };
        int pr = poll(&pf, 1, 40);
        if (pr < 0 && errno != EINTR) break;
        if (pr > 0 && (pf.revents & (POLLIN | POLLHUP))) {
            char b[64];
            ssize_t r = read(0, b, sizeof b);
            if (r == 0) break;
            for (ssize_t i = 0; i < r; i++) {
                if (b[i] != '\n') { if (ll < sizeof line - 1) line[ll++] = b[i]; continue; }
                line[ll] = 0; ll = 0;
                if (!strcmp(line, "QUIT")) goto done;
                if (!strncmp(line, "WIN ", 4)) {
                    char *end = NULL;
                    unsigned long v = strtoul(line + 4, &end, 10);
                    if (end == line + 4 || *end || v > 0xFFFFFFFFUL) { say("ERR bad_command"); continue; }
                    target = (cx_Window)v;
                    have_last = 0;                       /* answer at once, even if nothing changed */
                } else say("ERR bad_command");
            }
        }
        int64_t now = now_ms();
        if (now - last_cm_at >= 500) {
            last_cm_at = now;
            int c = xp_compositor();
            if (c != cm) { cm = c; say("CM %d", cm); }
        }
        if (target) {
            XpWin w = xp_window(target);
            if (!have_last || strcmp(w.state, last.state) || w.x != last.x || w.y != last.y || w.w != last.w || w.h != last.h) {
                say("W %s %d %d %d %d", w.state, w.x, w.y, w.w, w.h);
                last = w; have_last = 1;
            }
        }
    }
done:
    P.XCloseDisplay(P.dpy);
    return 0;
}
