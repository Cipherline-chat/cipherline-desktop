#!/usr/bin/env python3
"""Bounding box of the lab's laser-pink strokes in a screenshot, plus the share of the screen that is
still the lab's root-window blue. Prints `x0 y0 x1 y1 count bluefrac` (bbox -1 -1 -1 -1 when none).
usage: pink-bbox.py shot.png"""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
x0 = y0 = 10 ** 9
x1 = y1 = -1
n = 0
blue = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 200 and g < 120 and 50 < b < 180:
            n += 1
            if x < x0: x0 = x
            if y < y0: y0 = y
            if x > x1: x1 = x
            if y > y1: y1 = y
        if abs(r - 0x3a) < 12 and abs(g - 0x6e) < 12 and abs(b - 0xa5) < 12:
            blue += 1
if n < 30:
    print("-1 -1 -1 -1 %d %.3f" % (n, blue / (w * h)))
else:
    print("%d %d %d %d %d %.3f" % (x0, y0, x1, y1, n, blue / (w * h)))
