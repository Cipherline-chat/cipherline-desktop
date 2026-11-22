"""Frame strip of the rail around one click of a step-record.mjs recording.

    python3 -I strip.py <rec dir> <click index> <out.png> [fps=30] [before_ms=100] [after_ms=900] [crop_h_css=300]

Takes the screencast frame on screen at each 1/fps tick (the latest frame whose timestamp is <= the tick, so a
frozen renderer shows as repeated frames, like a screen recording), crops the rail (CSS box from rail.json, top
`crop_h_css` px), labels each tile with its ms offset from the click and tiles them in rows of 15.
"""
import json, sys, bisect
from PIL import Image, ImageDraw

d, ci, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
fps = float(sys.argv[4]) if len(sys.argv) > 4 else 30
before = float(sys.argv[5]) if len(sys.argv) > 5 else 100
after = float(sys.argv[6]) if len(sys.argv) > 6 else 900
crop_h = float(sys.argv[7]) if len(sys.argv) > 7 else 300
frames = json.load(open(f"{d}/frames.json"))
marks = json.load(open(f"{d}/geo.json"))["marks"]
rail = json.load(open(f"{d}/rail.json"))
t0 = marks[ci]["wall"]
ts = [f["ts"] for f in frames]
tiles = []
t = -before
while t <= after:
    i = bisect.bisect_right(ts, t0 + t / 1000) - 1
    if i >= 0:
        im = Image.open(f"{d}/frames/{frames[i]['file']}")
        s = im.width / rail["vw"]
        box = (int(rail["x"] * s), int(rail["y"] * s), int((rail["x"] + rail["w"]) * s), int((rail["y"] + crop_h) * s))
        c = im.crop(box).convert("RGB")
        c = c.resize((int(c.width * 2 / s), int(c.height * 2 / s)))
        dr = ImageDraw.Draw(c)
        dr.rectangle((0, c.height - 16, c.width, c.height), fill=(0, 0, 0))
        dr.text((3, c.height - 14), f"{t:+.0f}ms", fill=(255, 255, 255))
        tiles.append(c)
    t += 1000 / fps
cols = 15
w, h = tiles[0].size
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (w * min(cols, len(tiles)), h * rows), (0, 0, 0))
for k, c in enumerate(tiles):
    sheet.paste(c, ((k % cols) * w, (k // cols) * h))
sheet.save(out)
print(out, len(tiles), "tiles")
