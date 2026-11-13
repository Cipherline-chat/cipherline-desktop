#!/usr/bin/env bash
# x11_min.h hand-declares the Xlib / XRandR structs the XWayland fallback uses (the helper dlopens
# libX11 and needs no X headers to build). This compiles those declarations next to the REAL
# <X11/...> headers and asserts every size and field offset is identical, so a layout drift is a
# failing check here rather than a crash on a user's desktop. Runs in the lab image:
#
#   docker run --rm -v "$PWD/apps/desktop:/d:ro" cl-wayland-lab bash /d/harness/wayland-annotation/check-x11-abi.sh
set -euo pipefail
D=/d/src-native/wayland_overlay
W=$(mktemp -d)
cat > "$W/abi.c" <<'EOF'
#include <stddef.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/extensions/shape.h>
#include <X11/extensions/Xrandr.h>
#include "x11_min.h"

#define SAME_FIELD(real, mine, f) _Static_assert(offsetof(real, f) == offsetof(mine, f), #real "." #f " offset differs")
#define SAME_SIZE(real, mine) _Static_assert(sizeof(real) == sizeof(mine), #real " size differs")

SAME_SIZE(XSetWindowAttributes, cx_XSetWindowAttributes);
SAME_FIELD(XSetWindowAttributes, cx_XSetWindowAttributes, background_pixel);
SAME_FIELD(XSetWindowAttributes, cx_XSetWindowAttributes, border_pixel);
SAME_FIELD(XSetWindowAttributes, cx_XSetWindowAttributes, override_redirect);
SAME_FIELD(XSetWindowAttributes, cx_XSetWindowAttributes, colormap);
SAME_FIELD(XSetWindowAttributes, cx_XSetWindowAttributes, cursor);

SAME_SIZE(XVisualInfo, cx_XVisualInfo);
SAME_FIELD(XVisualInfo, cx_XVisualInfo, visual);
SAME_FIELD(XVisualInfo, cx_XVisualInfo, depth);
SAME_FIELD(XVisualInfo, cx_XVisualInfo, red_mask);
SAME_FIELD(XVisualInfo, cx_XVisualInfo, green_mask);
SAME_FIELD(XVisualInfo, cx_XVisualInfo, blue_mask);

SAME_FIELD(XImage, cx_XImageHead, width);
SAME_FIELD(XImage, cx_XImageHead, data);
SAME_FIELD(XImage, cx_XImageHead, depth);
SAME_FIELD(XImage, cx_XImageHead, bytes_per_line);
SAME_FIELD(XImage, cx_XImageHead, bits_per_pixel);
SAME_FIELD(XImage, cx_XImageHead, blue_mask);

/* x11_probe.inc (plain-X11 probe / watch modes) */
SAME_SIZE(XWindowAttributes, cx_XWindowAttributes);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, x);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, y);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, width);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, height);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, border_width);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, visual);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, root);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, colormap);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, map_state);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, override_redirect);
SAME_FIELD(XWindowAttributes, cx_XWindowAttributes, screen);
_Static_assert(sizeof(((XWindowAttributes *)0)->map_state) == sizeof(((cx_XWindowAttributes *)0)->map_state), "map_state width differs");
_Static_assert(IsViewable == CX_IS_VIEWABLE, "IsViewable");
_Static_assert(XA_ATOM == CX_XA_ATOM, "XA_ATOM");
_Static_assert(XA_CARDINAL == CX_XA_CARDINAL, "XA_CARDINAL");
/* The cx_ typedefs the new calls are declared with are the same widths as the real ones. */
_Static_assert(sizeof(Window) == sizeof(cx_Window), "Window width differs");
_Static_assert(sizeof(Atom) == sizeof(cx_Atom), "Atom width differs");
_Static_assert(sizeof(Bool) == sizeof(cx_Bool), "Bool width differs");

SAME_SIZE(XRectangle, cx_XRectangle);
SAME_SIZE(XRRMonitorInfo, cx_XRRMonitorInfo);
SAME_FIELD(XRRMonitorInfo, cx_XRRMonitorInfo, name);
SAME_FIELD(XRRMonitorInfo, cx_XRRMonitorInfo, x);
SAME_FIELD(XRRMonitorInfo, cx_XRRMonitorInfo, width);
SAME_FIELD(XRRMonitorInfo, cx_XRRMonitorInfo, outputs);
_Static_assert(sizeof(XEvent) == sizeof(cx_XEvent), "XEvent size differs");
_Static_assert(offsetof(XEvent, type) == offsetof(cx_XEvent, type), "XEvent.type offset differs");

_Static_assert(AllocNone == CX_ALLOC_NONE, "AllocNone");
_Static_assert(InputOutput == CX_INPUT_OUTPUT, "InputOutput");
_Static_assert(TrueColor == CX_TRUE_COLOR, "TrueColor");
_Static_assert(ZPixmap == CX_Z_PIXMAP, "ZPixmap");
_Static_assert(CWBackPixel == CX_CW_BACK_PIXEL, "CWBackPixel");
_Static_assert(CWBorderPixel == CX_CW_BORDER_PIXEL, "CWBorderPixel");
_Static_assert(CWOverrideRedirect == CX_CW_OVERRIDE_REDIRECT, "CWOverrideRedirect");
_Static_assert(CWColormap == CX_CW_COLORMAP, "CWColormap");
_Static_assert(Expose == CX_EXPOSE, "Expose");
_Static_assert(ShapeInput == CX_SHAPE_INPUT, "ShapeInput");
_Static_assert(ShapeSet == CX_SHAPE_SET, "ShapeSet");
_Static_assert(Unsorted == CX_UNSORTED, "Unsorted");
_Static_assert(ExposureMask == CX_EXPOSURE_MASK, "ExposureMask");

int main(void) { return 0; }
EOF
gcc -std=gnu11 -Wall -o "$W/abi" "$W/abi.c" -I"$D"
echo "OK   x11_min.h matches the real Xlib/XShape/XRandR headers (sizes, offsets, constants)"
