#!/usr/bin/env python3
"""Where did the test stroke land? Finds the bounding box of the zig-zag's pink core (ff3b6b-ish) in a
screenshot and compares it with where drive.py draws it: x 0.05..0.95, y 0.1..0.9 of the output.
usage: check-shot.py <png> [expect: yes|no]   -> prints the box as fractions; exit 1 on a miss"""
import sys

from PIL import Image

img = Image.open(sys.argv[1]).convert("RGB")
want = (sys.argv[2] if len(sys.argv) > 2 else "yes") == "yes"
w, h = img.size
px = img.load()
xs, ys, n = [], [], 0
for y in range(0, h, 1):
    for x in range(0, w, 1):
        r, g, b = px[x, y]
        if r > 200 and g < 140 and b < 170 and r - g > 80:
            xs.append(x)
            ys.append(y)
            n += 1
if not n:
    print("%s: no stroke pixels (%dx%d)" % (sys.argv[1], w, h))
    sys.exit(0 if not want else 1)
box = (min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h)
print("%s: %dx%d, stroke box x %.3f..%.3f y %.3f..%.3f (%d px)" % (sys.argv[1], w, h, box[0], box[2], box[1], box[3], n))
ok = abs(box[0] - 0.05) < 0.01 and abs(box[2] - 0.95) < 0.01 and abs(box[1] - 0.10) < 0.012 and abs(box[3] - 0.90) < 0.012
if want and not ok:
    print("  -> NOT where the helper was told to draw (expected x 0.05..0.95, y 0.10..0.90)")
    sys.exit(1)
sys.exit(0 if want else 1)
