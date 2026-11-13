#!/usr/bin/env python3
"""The 'application window underneath' for the Wayland overlay proof: a GTK3 window that paints a
recognisable test card (so a stroke over it is visibly an overlay, not part of the page) and logs
every pointer press it receives to $UNDERLAY_LOG, as 'press x y' in WINDOW coordinates.
A stroke drawn by the overlay must not stop these presses from arriving."""
import os, sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

log = open(os.environ.get("UNDERLAY_LOG", "/tmp/underlay.log"), "a", buffering=1)
win = Gtk.Window(title="underlay")
win.set_default_size(int(os.environ.get("UL_W", "800")), int(os.environ.get("UL_H", "600")))
if os.environ.get("UL_FULLSCREEN") == "1":
    win.fullscreen()
area = Gtk.DrawingArea()
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK)


def draw(w, cr):
    a = w.get_allocated_width()
    h = w.get_allocated_height()
    cr.set_source_rgb(0.12, 0.2, 0.32)
    cr.paint()
    cell = 80
    for gx in range(0, a, cell):
        for gy in range(0, h, cell):
            if ((gx // cell) + (gy // cell)) % 2:
                cr.set_source_rgb(0.16, 0.26, 0.4)
                cr.rectangle(gx, gy, cell, cell)
                cr.fill()
    cr.set_source_rgb(0.95, 0.85, 0.2)
    cr.rectangle(a // 2 - 60, h // 2 - 60, 120, 120)
    cr.fill()
    cr.set_source_rgb(0, 0, 0)
    cr.move_to(a // 2 - 50, h // 2 + 5)
    cr.show_text("UNDERLAY")
    return False


def press(w, ev):
    log.write("press %d %d\n" % (ev.x, ev.y))
    return True


def release(w, ev):
    log.write("release %d %d\n" % (ev.x, ev.y))
    return True


area.connect("draw", draw)
area.connect("button-press-event", press)
area.connect("button-release-event", release)
win.add(area)
win.connect("destroy", Gtk.main_quit)
win.show_all()
log.write("ready\n")
Gtk.main()
