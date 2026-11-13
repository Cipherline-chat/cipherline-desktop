#!/usr/bin/env python3
"""Drives cl-wayland-overlay the way electron/annotation-overlay-wayland.ts does: reads HELLO/OUT/
READY, sends SHOW <idx>, then draws a test stroke (kept alive with `A` refreshes, like a held
pen) until told to stop. Writes everything the helper said to $DRIVE_LOG.

usage: drive.py <helper> <output-index> <seconds>   (env DRIVE_FLAG: file touched once SHOWN+drawn)
exit: 0 ok, 3 no layer-shell and no XWayland / helper failed, 4 never shown
env DRIVE_MODE: auto (default) | x (force the XWayland backend)"""
import os
import resource
import select
import subprocess
import sys
import time

helper, idx, secs = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
log = open(os.environ.get("DRIVE_LOG", "/tmp/drive.log"), "a", buffering=1)
p = subprocess.Popen([helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
p.stdin.reconfigure(line_buffering=True)


_buf = b""


def readline(timeout):
    """One stdout line, or None on timeout, or '' on EOF. Unbuffered (os.read) on purpose: a
    buffered text reader can hold later lines that select() can no longer see."""
    global _buf
    fd = p.stdout.fileno()
    while b"\n" not in _buf:
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            return None
        chunk = os.read(fd, 65536)
        if not chunk:
            return ""
        _buf += chunk
    line, _, _buf = _buf.partition(b"\n")
    return line.decode("utf-8", "replace")


def send(s):
    p.stdin.write(s + "\n")
    p.stdin.flush()


t_start = time.time()
ready = False
xfallback = False
t0 = time.time()
while time.time() - t0 < 5:
    line = readline(0.5)
    if line is None:
        continue
    if line == "":
        break
    log.write("helper: " + line + "\n")
    if line.startswith("READY"):
        ready = "layer_shell=1" in line
        xfallback = "x11=1" in line
        break
    if line.startswith("ERR"):
        break
# Same choice electron/annotation-overlay-wayland.ts makes: layer-shell when the compositor has it,
# else the XWayland override-redirect fallback, else give up.
mode = os.environ.get("DRIVE_MODE", "auto")
use_x = mode == "x" or (mode == "auto" and not ready and xfallback)
if not ready and not use_x:
    log.write("NO LAYER SHELL (or helper failed)\n")
    p.terminate()
    sys.exit(3)

send(("SHOWX %d" if use_x else "SHOW %d") % idx)
shown = None
t0 = time.time()
while time.time() - t0 < 5 and not shown:
    line = readline(0.5)
    if line is None:
        continue
    log.write("helper: " + line + "\n")
    if line.startswith("SHOWN"):
        shown = line.split()
    if line.startswith("ERR") or line.startswith("CLOSED"):
        sys.exit(4)
if not shown:
    log.write("never SHOWN\n")
    p.terminate()
    sys.exit(4)


def now():
    return int(time.time() * 1000)


def pts(points):
    return " ".join("%d,%d" % (round(x * 65535), round(y * 65535)) for x, y in points)


# A zig-zag across the whole output plus a horizontal bar, both through the centre where the
# underlay's yellow square (and the click target) sit.
zig = [(0.05, 0.1), (0.3, 0.9), (0.5, 0.5), (0.7, 0.1), (0.95, 0.9)]
send("U 1 ff3b6b 40 %d 0 %d %s" % (now(), len(zig), pts(zig)))
bar = [(0.1, 0.5), (0.9, 0.5)]
send("U 2 35e0ff 60 %d 0 %d %s" % (now(), len(bar), pts(bar)))
flag = os.environ.get("DRIVE_FLAG")
if flag:
    open(flag, "w").write("drawn\n")
end = time.time() + secs
while time.time() < end:
    # keep both strokes 'pen down' (the watchdog would otherwise close them after 1.5 s)
    send("A 1 %d 0 0" % now())
    send("A 2 %d 0 0" % now())
    time.sleep(0.25)
    while True:
        line = readline(0)
        if not line:
            break
        log.write("helper: " + line + "\n")
wall = time.time() - t_start
send("QUIT")
try:
    p.wait(timeout=3)
except Exception:
    p.kill()
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
log.write("helper cpu: %.2f s user + %.2f s system over %.1f s wall with two full-screen strokes held\n" % (ru.ru_utime, ru.ru_stime, wall))
log.write("exit %s\n" % p.returncode)
