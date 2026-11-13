#!/usr/bin/env python3
"""Answer the xdg-desktop-portal-gnome ScreenCast chooser through mutter's RemoteDesktop D-Bus API.

mutter (headless) lets any session-bus client open an input-only RemoteDesktop session and inject keyboard events
(org.gnome.Mutter.RemoteDesktop.Session.NotifyKeyboardKeysym). The session lives exactly as long as THIS process's bus
connection, which is why this is Python (a `gdbus call` exits and takes the session with it).

It watches the dbus-monitor log for backend `ScreenCast.Start` calls (= a chooser just opened) and, for each, sends a key
sequence given by $BOT_KEYS (default: Tab Return) after a short delay. Every attempt is logged to stdout.
"""
import os, sys, time, re

try:
    import dbus
except ImportError:
    print("python3-dbus is not installed in this image: cannot drive the chooser"); sys.exit(0)

OUT = os.environ.get("OUT", "/out")
LOG = os.path.join(OUT, "dbus-portal.log")
KEYS = {"Return": 0xff0d, "Tab": 0xff09, "space": 0x20, "Right": 0xff53, "Down": 0xff54, "Escape": 0xff1b}
seq = [k for k in os.environ.get("BOT_KEYS", "Tab Return").split()]

bus = dbus.SessionBus()
try:
    rd = dbus.Interface(bus.get_object("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop"), "org.gnome.Mutter.RemoteDesktop")
    path = rd.CreateSession()
    si = dbus.Interface(bus.get_object("org.gnome.Mutter.RemoteDesktop", path), "org.gnome.Mutter.RemoteDesktop.Session")
    si.Start()
    print("RemoteDesktop session started:", path, flush=True)
except Exception as e:
    print("RemoteDesktop unavailable:", e, flush=True); sys.exit(0)


def press(name):
    sym = dbus.UInt32(KEYS[name])
    si.NotifyKeyboardKeysym(sym, True); time.sleep(0.05); si.NotifyKeyboardKeysym(sym, False)


def starts():
    try:
        return len(re.findall(r"interface=org\.freedesktop\.impl\.portal\.ScreenCast; member=Start", open(LOG, errors="replace").read()))
    except FileNotFoundError:
        return 0


def opens():
    try:
        return len(re.findall(r"interface=org\.freedesktop\.portal\.ScreenCast; member=OpenPipeWireRemote", open(LOG, errors="replace").read()))
    except FileNotFoundError:
        return 0


# What to press, in order, until the dialog is gone (the app then calls OpenPipeWireRemote). GNOME's dialog layout is
# not stable across versions, so several plausible sequences are tried and the winner is recorded in the log.
ATTEMPTS = [["Return"], ["Tab", "Return"], ["Tab", "Tab", "Return"], ["Tab", "Tab", "Tab", "Return"], ["space", "Tab", "Tab", "Return"], ["Down", "Tab", "Tab", "Return"]]
seen = 0
while True:
    n = starts()
    if n > seen:
        seen = n
        base = opens()
        print(time.strftime("%H:%M:%S"), f"backend Start #{n}: dialog assumed open", flush=True)
        time.sleep(2.0)
        for i, att in enumerate(ATTEMPTS):
            if opens() > base:
                if i == 0:
                    print("  SILENT: the portal opened the stream with no dialog (a restored session) - no key was needed", flush=True)
                else:
                    print(f"  dialog answered by attempt #{i - 1}: {ATTEMPTS[i - 1]}", flush=True)
                break
            print(f"  attempt #{i}: {att}", flush=True)
            for k in att:
                try:
                    press(k)
                except Exception as e:
                    print("  key failed:", e, flush=True)
                time.sleep(0.4)
            time.sleep(2.5)
        else:
            print("  dialog NOT answered by any attempt" if opens() <= base else "  dialog answered", flush=True)
    time.sleep(0.4)
