#!/usr/bin/env python3
# Close an X11 window the way a window manager's X button does: a WM_DELETE_WINDOW client message (the harness
# Xvfb has no window manager, and the page's own window.close() destroys the window without the 'close' event).
# libX11 through ctypes (no headers / python-xlib on this box).   DISPLAY=:132 python3 -I wm-close.py <window id>
import ctypes, sys

x = ctypes.cdll.LoadLibrary('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x.XFlush.argtypes = [ctypes.c_void_p]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('l', ctypes.c_long * 5)]


class XEvent(ctypes.Union):
    _fields_ = [('xclient', XClientMessageEvent), ('pad', ctypes.c_long * 24)]


win = int(sys.argv[1], 0)
d = x.XOpenDisplay(None)
if not d:
    sys.exit('no display')
ev = XEvent()
ev.xclient.type = 33  # ClientMessage
ev.xclient.window = win
ev.xclient.message_type = x.XInternAtom(d, b'WM_PROTOCOLS', 0)
ev.xclient.format = 32
ev.xclient.l[0] = x.XInternAtom(d, b'WM_DELETE_WINDOW', 0)
ev.xclient.l[1] = 0  # CurrentTime
x.XSendEvent(d, win, 0, 0, ctypes.byref(ev))
x.XFlush(d)
print('sent WM_DELETE_WINDOW to', hex(win))
