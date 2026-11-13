#!/usr/bin/env bash
# Cross-checks the hand-written protocol tables in cl_wayland_overlay.c (layer-shell + xdg-output,
# written by hand because the helper dlopens libwayland and links no generated code) against what
# `wayland-scanner private-code` generates from the vendored XML: same interfaces, versions, request
# and event names, order (= opcodes) and signatures. Runs inside the lab image:
#
#   docker run --rm -v "$PWD/apps/desktop:/d:ro" cl-wayland-lab bash /d/harness/wayland-annotation/check-protocol-tables.sh
set -euo pipefail
D=/d/src-native/wayland_overlay
W=$(mktemp -d)
gcc -std=gnu11 -O1 -o "$W/h" "$D/cl_wayland_overlay.c" -I"$D" -lm -ldl
"$W/h" --dump-tables > "$W/mine.txt"
for x in wlr-layer-shell-unstable-v1 xdg-output-unstable-v1; do
  wayland-scanner private-code "$D/protocols/$x.xml" "$W/$x.c"
done
python3 - "$W" <<'EOF'
import re, sys
w = sys.argv[1]
want = {}
order = []
for x in ("wlr-layer-shell-unstable-v1", "xdg-output-unstable-v1"):
    src = open(f"{w}/{x}.c").read()
    for m in re.finditer(r'WL_PRIVATE const struct wl_interface (\w+)_interface = \{\s*"(\w+)", (\d+),\s*(\d+), (\w+),\s*(\d+), (\w+),', src):
        sym, name, ver, nreq, reqs, nev, evs = m.groups()
        order.append(name)
        lines = [f"{name} {ver}"]
        def msgs(arr):
            if arr == "NULL": return []
            body = re.search(r'static const struct wl_message ' + arr + r'\[\] = \{(.*?)\};', src, re.S).group(1)
            return re.findall(r'\{ "(\w+)", "([^"]*)",', body)
        for n, s in msgs(reqs): lines.append(f"  request {n} {s}")
        for n, s in msgs(evs): lines.append(f"  event {n} {s}")
        want[name] = lines
mine = {}
cur = None
for line in open(f"{w}/mine.txt").read().splitlines():
    if not line.startswith(" "):
        cur = line.split()[0]; mine[cur] = [line]
    else:
        mine[cur].append(line)
bad = 0
for name in order:
    a = [l.rstrip() for l in want[name]]
    b = [l.rstrip() for l in mine.get(name, [])]
    if a == b:
        print(f"OK   {name} ({len(a) - 1} messages)")
    else:
        bad += 1
        print(f"DIFF {name}\n  scanner: {a}\n  ours:    {b}")
if set(mine) != set(order):
    bad += 1; print("interface set differs", set(mine) ^ set(order))
sys.exit(1 if bad else 0)
EOF
