#!/usr/bin/env python3
"""Print the mean brightness (0-255) of a small patch around x,y of a screenshot: `pix.py shot.png x y`."""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
x, y = int(sys.argv[2]), int(sys.argv[3])
vals = []
for dy in range(-3, 4):
    for dx in range(-3, 4):
        r, g, b = im.getpixel((min(max(x + dx, 0), im.width - 1), min(max(y + dy, 0), im.height - 1)))
        vals.append((r + g + b) / 3)
print(int(sum(vals) / len(vals)))
