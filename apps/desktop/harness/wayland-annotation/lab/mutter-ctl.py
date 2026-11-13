#!/usr/bin/env python3
"""Screenshots and input for a headless Mutter, over its own D-Bus APIs (the ones GNOME's screen
sharing and remote-desktop portals use): org.gnome.Mutter.ScreenCast streams the monitor into
PipeWire (gstreamer takes a frame) and org.gnome.Mutter.RemoteDesktop injects a real pointer.
Reads commands on stdin:  shot <out.png> | move <x> <y> | press | release | quit
(Mutter has no layer-shell, so this lab is about the XWayland experiment; see run-mutter.sh.)"""
import os
import shutil
import subprocess
import sys

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(dest, path, iface, method, args, rtype):
    return bus.call_sync(dest, path, iface, method, args, GLib.VariantType(rtype), Gio.DBusCallFlags.NONE, 15000, None)


rd_path = call("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop",
               "CreateSession", None, "(o)").unpack()[0]
sid = bus.call_sync("org.gnome.Mutter.RemoteDesktop", rd_path, "org.freedesktop.DBus.Properties", "Get",
                    GLib.Variant("(ss)", ("org.gnome.Mutter.RemoteDesktop.Session", "SessionId")),
                    GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 15000, None).unpack()[0]
sc_path = call("org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast", "org.gnome.Mutter.ScreenCast",
               "CreateSession", GLib.Variant("(a{sv})", ({"remote-desktop-session-id": GLib.Variant("s", sid)},)), "(o)").unpack()[0]
stream_path = call("org.gnome.Mutter.ScreenCast", sc_path, "org.gnome.Mutter.ScreenCast.Session", "RecordMonitor",
                   GLib.Variant("(sa{sv})", ("", {})), "(o)").unpack()[0]

node = {"id": None}


def on_signal(conn, sender, path, iface, name, params, data):
    if name == "PipeWireStreamAdded":
        node["id"] = params.unpack()[0]


bus.signal_subscribe("org.gnome.Mutter.ScreenCast", "org.gnome.Mutter.ScreenCast.Stream", "PipeWireStreamAdded",
                     stream_path, None, Gio.DBusSignalFlags.NONE, on_signal, None)
call("org.gnome.Mutter.RemoteDesktop", rd_path, "org.gnome.Mutter.RemoteDesktop.Session", "Start", None, "()")
ctx = GLib.MainContext.default()
for _ in range(200):
    while ctx.iteration(False):
        pass
    if node["id"] is not None:
        break
    GLib.usleep(25000)
print("mutter-ctl ready node=%s" % node["id"], flush=True)


def rd(method, sig, *a):
    bus.call_sync("org.gnome.Mutter.RemoteDesktop", rd_path, "org.gnome.Mutter.RemoteDesktop.Session", method,
                  GLib.Variant(sig, a), None, Gio.DBusCallFlags.NONE, 15000, None)


for line in sys.stdin:
    p = line.split()
    if not p:
        continue
    if p[0] == "move":
        rd("NotifyPointerMotionAbsolute", "(sdd)", stream_path, float(p[1]), float(p[2]))
    elif p[0] == "press":
        rd("NotifyPointerButton", "(ib)", 0x110, True)
    elif p[0] == "release":
        rd("NotifyPointerButton", "(ib)", 0x110, False)
    elif p[0] == "shot":
        tmp = "/tmp/mshot-%03d.png"
        subprocess.run("rm -f /tmp/mshot-*.png; timeout 20 gst-launch-1.0 -q pipewiresrc path=%s always-copy=true num-buffers=1 ! "
                       "videoconvert ! pngenc ! multifilesink location=%s >/dev/null 2>&1" % (node["id"], tmp), shell=True)
        frames = sorted(f for f in os.listdir("/tmp") if f.startswith("mshot-"))
        if frames:
            shutil.move("/tmp/" + frames[-1], p[1])
            print("shot", p[1], flush=True)
        else:
            print("shot FAILED", flush=True)
    elif p[0] == "quit":
        break
