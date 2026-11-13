/*
 * Minimal declarations of the Xlib / XShape / XRandR ABI the XWayland fallback uses.
 *
 * Same rule as wl_min.h and as audio_capture_linux.cc's X11 section: libX11, libXext and
 * libXrandr are dlopen()ed at run time and no X11 header is needed to build (a CI image or a
 * contributor's box need not have libx11-dev). The structs below are the LP64 Linux layouts;
 * every size and field offset is asserted against the real <X11/...> headers by
 * harness/wayland-annotation/check-x11-abi.sh, so a drift is a failing check, not a crash.
 * Names carry a `cx_` prefix precisely so that check can include both in one translation unit.
 */
#ifndef CL_X11_MIN_H
#define CL_X11_MIN_H

typedef struct cx_Display cx_Display;
typedef unsigned long cx_XID;
typedef cx_XID cx_Window, cx_Colormap, cx_Pixmap, cx_Cursor, cx_Atom, cx_GC_id;
typedef unsigned long cx_VisualID;
typedef struct cx_Visual cx_Visual;
typedef struct _cx_XGC *cx_GC;
typedef int cx_Bool;

typedef struct {
    cx_Pixmap background_pixmap;
    unsigned long background_pixel;
    cx_Pixmap border_pixmap;
    unsigned long border_pixel;
    int bit_gravity;
    int win_gravity;
    int backing_store;
    unsigned long backing_planes;
    unsigned long backing_pixel;
    cx_Bool save_under;
    long event_mask;
    long do_not_propagate_mask;
    cx_Bool override_redirect;
    cx_Colormap colormap;
    cx_Cursor cursor;
} cx_XSetWindowAttributes;

typedef struct {
    cx_Visual *visual;
    cx_VisualID visualid;
    int screen;
    int depth;
    int c_class;
    unsigned long red_mask;
    unsigned long green_mask;
    unsigned long blue_mask;
    int colormap_size;
    int bits_per_rgb;
} cx_XVisualInfo;

/* Only the leading fields of XImage are touched (XCreateImage allocates the whole struct). */
typedef struct {
    int width, height;
    int xoffset;
    int format;
    char *data;
    int byte_order;
    int bitmap_unit;
    int bitmap_bit_order;
    int bitmap_pad;
    int depth;
    int bytes_per_line;
    int bits_per_pixel;
    unsigned long red_mask, green_mask, blue_mask;
} cx_XImageHead;

typedef struct { short x, y; unsigned short width, height; } cx_XRectangle;

typedef struct {
    cx_Atom name;
    cx_Bool primary;
    cx_Bool automatic;
    int noutput;
    int x, y;
    int width, height;
    int mwidth, mheight;
    unsigned long *outputs;
} cx_XRRMonitorInfo;

/* XWindowAttributes (XGetWindowAttributes): the whole struct, because the caller allocates it. */
typedef struct {
    int x, y;
    int width, height;
    int border_width;
    int depth;
    cx_Visual *visual;
    cx_Window root;
    int c_class;
    int bit_gravity;
    int win_gravity;
    int backing_store;
    unsigned long backing_planes;
    unsigned long backing_pixel;
    cx_Bool save_under;
    cx_Colormap colormap;
    cx_Bool map_installed;
    int map_state;
    long all_event_masks;
    long your_event_mask;
    long do_not_propagate_mask;
    cx_Bool override_redirect;
    void *screen;
} cx_XWindowAttributes;

/* XEvent is a union of 24 longs whose first member is `int type`; only `type` is read. */
typedef union { int type; long pad[24]; } cx_XEvent;

#define CX_ALLOC_NONE 0
#define CX_INPUT_OUTPUT 1
#define CX_TRUE_COLOR 4
#define CX_Z_PIXMAP 2
#define CX_CW_BACK_PIXEL (1L << 1)
#define CX_CW_BORDER_PIXEL (1L << 3)
#define CX_CW_OVERRIDE_REDIRECT (1L << 9)
#define CX_CW_COLORMAP (1L << 13)
#define CX_EXPOSE 12
#define CX_SHAPE_INPUT 2
#define CX_SHAPE_SET 0
#define CX_UNSORTED 0
#define CX_EXPOSURE_MASK (1L << 15)
#define CX_IS_VIEWABLE 2           /* XWindowAttributes.map_state */
#define CX_XA_ATOM 4               /* predefined atoms */
#define CX_XA_CARDINAL 6

#endif
