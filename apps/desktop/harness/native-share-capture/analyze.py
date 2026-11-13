#!/usr/bin/env python3
"""Analyse one run of harness/native-share-capture/run.sh: framing, gaps, decode (ffmpeg), colour sequence, events."""
import json, os, struct, subprocess, sys

out = sys.argv[1]
au = open(os.path.join(out, 'au.bin'), 'rb').read()
recs, p = [], 0
while p + 24 <= len(au):
    n, flags = struct.unpack_from('<IB', au, p)
    cap, done = struct.unpack_from('<QQ', au, p + 8)
    if p + 24 + n > len(au):
        break
    recs.append((cap, done, bool(flags & 1), n))
    p += 24 + n
print(f'AUs: {len(recs)}  bytes: {p}  keyframes: {sum(1 for r in recs if r[2])}  trailing partial bytes: {len(au) - p}')
gaps = [(recs[i + 1][0] - recs[i][0]) / 1000 for i in range(len(recs) - 1)]
if gaps:
    print(f'AU spacing ms: max {max(gaps):.0f}  p99 {sorted(gaps)[int(len(gaps) * .99)]:.0f}  (idle keep-alive must keep max < ~400)')
span = (recs[-1][0] - recs[0][0]) / 1e6 if len(recs) > 1 else 0
print(f'span {span:.1f}s  mean {len(recs) / span:.1f} AU/s' if span else 'span 0')

ev = []
for l in open(os.path.join(out, 'helper.err'), errors='replace'):
    l = l.strip()
    if l.startswith('{'):
        try: ev.append(json.loads(l))
        except Exception: pass
for e in ev:
    if e.get('event') in ('portal', 'format', 'ended', 'fps_limited') or 'error' in e:
        print('EVENT', json.dumps({k: v for k, v in e.items() if k != 'restore_token'}))
stats = [e for e in ev if e.get('event') == 'stats']
if stats:
    print(f"stats: {len(stats)} s, in_fps max {max(s['in_fps'] for s in stats)}, encoded fps max {max(s['fps'] for s in stats)}, "
          f"idle_repeats {stats[-1]['idle_repeats']}, enc_ms_p95 max {max(s['enc_ms_p95'] for s in stats)}")
print('exit:', open(os.path.join(out, 'exit.txt')).read().strip() if os.path.exists(os.path.join(out, 'exit.txt')) else '?')

# strip framing -> raw Annex-B, decode to constant 640x360 RGB, sample the centre pixel
raw = os.path.join(out, 'stream.h264')
with open(raw, 'wb') as f:
    p = 0
    while p + 24 <= len(au):
        n = struct.unpack_from('<I', au, p)[0]
        if p + 24 + n > len(au): break
        f.write(au[p + 24:p + 24 + n]); p += 24 + n
W, H = 640, 360
r = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'h264', '-i', raw, '-vf', f'scale={W}:{H}:in_color_matrix=bt709,format=rgb24', '-f', 'rawvideo', '-'],
                   capture_output=True)
errs = [l for l in r.stderr.decode(errors='replace').splitlines() if l.strip()]
frames = len(r.stdout) // (W * H * 3)
print(f'ffmpeg decode: {frames} frames of {len(recs)} AUs, {len(errs)} error lines' + (' -> ' + errs[0] if errs else ''))
cols = []
for i in range(frames):
    o = i * W * H * 3 + (H // 2 * W + W // 2) * 3
    cols.append(tuple(r.stdout[o:o + 3]))

def cls(c):
    R, G, B = c
    if R > 200 and G < 60 and B < 60: return 'R'
    if G > 200 and R < 60 and B < 60: return 'G'
    if B > 200 and R < 60 and G < 60: return 'B'
    if abs(R - 32) < 12 and abs(G - 32) < 12 and abs(B - 32) < 12: return 'grey'
    return '?'
runs, last, n = [], None, 0
for c in cols:
    k = cls(c)
    if k == last: n += 1
    else:
        if last is not None: runs.append((last, n))
        last, n = k, 1
if last is not None: runs.append((last, n))
solid = [k for k, n in runs if n >= 5 and k != '?']
print('colour runs (>=5 frames):', ' '.join(solid))
want = ['R', 'G', 'B']
it = iter(solid); ok_seq = all(any(x == w for x in it) for w in want)
print('PASS' if ok_seq else 'FAIL', 'decoded picture shows red -> green -> blue in order (proves real pixels, correct R/B order)')
tail = solid[-2:]
print('PASS' if tail == ['R', 'B'] else 'FAIL', 'after the mid-share resize the stream continues and decodes red then blue:', tail)
fm = [e for e in ev if e.get('event') == 'format']
print('PASS' if len(fm) >= 2 and fm[0].get('w') != fm[-1].get('w') else 'FAIL', 'source size change re-opened the encoder:', [(e['src_w'], e['src_h'], e['w'], e['h']) for e in fm])
print('PASS' if not errs else 'FAIL', 'no decode errors')
print('PASS' if gaps and max(gaps) < 600 else 'FAIL', 'no stall > 600 ms (static-screen keep-alive works)')
