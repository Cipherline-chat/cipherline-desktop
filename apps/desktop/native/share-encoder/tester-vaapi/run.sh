#!/usr/bin/env bash
# Cipherline native share: one-command AMD / Intel (VA-API) test for a Linux machine (Arch/CachyOS, Debian/Ubuntu, Fedora ...).
# Installs NOTHING, needs no root. Builds the helper from bundled MIT headers and runs it from this folder.
#
#   bash run.sh            probe + capability report + encode matrix              (~3-5 min, no desktop session needed)
#   bash run.sh capture    ALSO a REAL screen capture -> VA-API test (graphical Wayland session; a portal dialog appears ONCE, pick a screen)
#   bash run.sh install    build, then copy the helper to ~/.config/Cipherline/native/ (a normal UNPACKAGED/dev build uses it; packaged builds
#                          ship their own helper and ignore this folder by design)
#
# Needs: gcc + make (Arch: sudo pacman -S --needed base-devel | Debian/Ubuntu: sudo apt install build-essential | Fedora: sudo dnf install gcc make),
# the GPU's VA driver (Intel: intel-media-driver [iHD] or libva-intel-driver [i965]; AMD: mesa-va-drivers / mesa-va-gallium), libva, pipewire.
# Optional: ffmpeg/ffprobe (decode check), vainfo (extra diagnostics), python3 (report assembly + summary).
#
# OUTPUT goes next to the tarball (the folder this bundle was unpacked from): report.json, and with `capture` also capture-frame.png.
# Override with OUT_DIR=/some/dir. Nothing leaves the machine; the report holds GPU / driver / VA capability data, no screen content.
#
# Exit codes:  0 ran, report written (check report.json "verdict")      2 gcc/make missing or the build failed
#              3 no usable VA-API H.264 encoder (no render node / no VA driver / driver has no encode entrypoint / all configs failed the self-test)
#              4 an encode run failed        18 the requested size is over the GPU's limit (the report has the limit)
#              20 the encoded stream does not decode cleanly (ffmpeg)        21 capture mode failed (capture_exit in the report: 12 dialog denied,
#              11 no portal, 14 PipeWire missing, 5 source ended, 6 no frames)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE" || exit 1
OUTDIR="${OUT_DIR:-$(dirname "$HERE")}"; [ -w "$OUTDIR" ] || OUTDIR="$HERE"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
MODE="${1:-matrix}"
for t in gcc make; do command -v $t >/dev/null 2>&1 || { echo "need $t (see the header of this script)"; exit 2; }; done
command -v python3 >/dev/null 2>&1 || echo "note: python3 not found, report.json will be minimal and there is no summary"

echo "== build (MIT headers bundled in ./third_party; libva/pipewire are loaded at run time, nothing is linked)"
make clean >/dev/null 2>&1; make vendored 2>&1 | grep -E "error|Error" | head -5
H="$HERE/build/share-encoder-helper"; [ -x "$H" ] || { echo "build failed"; exit 2; }

if [ "$MODE" = install ]; then
  D="${CL_USERDATA:-${XDG_CONFIG_HOME:-$HOME/.config}/Cipherline}/native"; mkdir -p "$D" && cp "$H" "$D/share-encoder-helper" && chmod 755 "$D/share-encoder-helper" \
    && echo "installed $D/share-encoder-helper (used by unpackaged builds only)." || echo "could not install into $D"
  exit 0
fi

echo "== environment"
{ . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown OS}  kernel $(uname -r)  session=${XDG_SESSION_TYPE:-?}  desktop=${XDG_CURRENT_DESKTOP:-?}  LIBVA_DRIVER_NAME=${LIBVA_DRIVER_NAME:-unset}"; } | tee "$WORK/os.txt"
{ command -v lspci >/dev/null 2>&1 && lspci -nn 2>/dev/null | grep -Ei "vga|display|3d" ; for d in /sys/class/drm/renderD*; do [ -e "$d" ] && echo "$(basename "$d") vendor=$(cat "$d/device/vendor" 2>/dev/null) device=$(cat "$d/device/device" 2>/dev/null) driver=$(basename "$(readlink "$d/device/driver" 2>/dev/null)")"; done; } 2>/dev/null | tee "$WORK/gpu.txt"
echo "pipewire: $(pipewire --version 2>/dev/null | tail -1)   portal: $(pgrep -a xdg-desktop-portal 2>/dev/null | head -3 | tr '\n' ' ')" | tee "$WORK/pw.txt"
if command -v vainfo >/dev/null 2>&1; then vainfo 2>&1 | head -40 > "$WORK/vainfo.txt"; grep -E "Driver version|H264.*Enc" "$WORK/vainfo.txt" | head -8; else echo "(vainfo not installed: not needed)"; : > "$WORK/vainfo.txt"; fi

echo "== every render node and what its VA driver reports for H.264 encode"
"$H" --list-va > "$WORK/va.json" 2>"$WORK/va.err"; python3 - "$WORK/va.json" <<'PY' 2>/dev/null || cat "$WORK/va.json"
import json, sys
for n in json.load(open(sys.argv[1])):
    print('%s  %s [%s]  vendor-string: %s' % (n['node'], n.get('kernel_driver'), n.get('vendor_id'), n.get('vendor_string') or n.get('note')))
    for c in n.get('candidates', []):
        print('    %-20s %-11s rc=%-12s packed-headers=%-3s max=%sx%s intra-refresh=%s slices=%s' % (c['profile'], c['entrypoint'], c['rc'].strip(), c['packed_headers'], c['max_w'], c['max_h'], c['intra_refresh'], c['max_slices']))
PY

echo "== open (device choice, ladder, self-test) at 3440x1440@90, then 1920x1080@60"
probe() { "$H" --probe --backend vaapi --width "$1" --height "$2" --fps "$3" --bitrate 30000000 2>&1 >/dev/null | grep '^{' | tail -1; }
P1="$("$H" --probe --backend vaapi --width 3440 --height 1440 --fps 90 --bitrate 40000000 2>"$WORK/p1.err" >/dev/null; echo $? > "$WORK/p1.rc"; grep '^{' "$WORK/p1.err" | tail -1)"; PRC1="$(cat "$WORK/p1.rc")"
P2="$("$H" --probe --backend vaapi --width 1920 --height 1080 --fps 60 --bitrate 20000000 2>"$WORK/p2.err" >/dev/null; echo $? > "$WORK/p2.rc"; grep '^{' "$WORK/p2.err" | tail -1)"; PRC2="$(cat "$WORK/p2.rc")"
echo "3440x1440@90 -> exit $PRC1: $P1"; echo "1920x1080@60 -> exit $PRC2: $P2"
verdict() { echo "$1" > "$WORK/verdict.txt"; }
write_report() {
python3 - "$WORK" "$HERE" "$OUTDIR/report.json" "$MODE" <<'PY'
import json, os, sys
W, HERE, OUT, MODE = sys.argv[1:5]
def rd(n, d=''):
    try: return open(os.path.join(W, n), errors='replace').read().strip()
    except Exception: return d
def jl(n):
    try: return json.loads(rd(n))
    except Exception: return None
def lines(n):
    o = []
    for l in rd(n).splitlines():
        try: o.append(json.loads(l))
        except Exception: pass
    return o
r = {'verdict': rd('verdict.txt', 'unknown'), 'mode': MODE, 'os': rd('os.txt'), 'gpus': rd('gpu.txt').splitlines(), 'pipewire': rd('pw.txt'),
     'render_nodes': jl('va.json'), 'vainfo_head': rd('vainfo.txt').splitlines()[:40],
     'probe_3440x1440_90': {'exit': int(rd('p1.rc', '-1') or -1), 'line': (lines('p1.err') or [None])[-1]},
     'probe_1920x1080_60': {'exit': int(rd('p2.rc', '-1') or -1), 'line': (lines('p2.err') or [None])[-1]},
     'matrix': lines('matrix.jsonl'), 'variants': lines('variants.jsonl'), 'calibration': (lines('calib.json') or [None])[-1],
     'intra_refresh': {'bench': (lines('ir.json') or [None])[-1], 'decode': rd('ir_dec.txt')},
     'decode_check': rd('dec.txt'), 'stream_properties': rd('props.txt'), 'capture': jl('cap.json'), 'capture_exit': rd('cap.rc')}
json.dump(r, open(OUT, 'w'), indent=1)
print('wrote', OUT)
PY
}
if [ "$PRC1" -ne 0 ] && [ "$PRC2" -ne 0 ]; then
  echo "NO usable VA-API H.264 encoder here (exit $PRC1/$PRC2). The lines above say why (no render node / no VA driver / no encode entrypoint / every configuration failed its self-test)."
  verdict "no_vaapi_encoder_exit_${PRC1}_${PRC2}"; write_report
  [ "$PRC1" = 18 ] && exit 18; exit 3
fi
BIGOK=1; [ "$PRC1" -ne 0 ] && BIGOK=0
[ "$PRC1" = 18 ] && echo "3440x1440 is over this GPU's limit (the app scales into the limit instead): the matrix below skips sizes above it."

echo "== matrix (unpaced = max throughput; paced = real time; IDR every 120 frames; synthetic moving source; BGRx->NV12 conversion is NOT included, see enc_ms)"
: > "$WORK/matrix.jsonl"; FAIL4=0
run() { label=$1; out=$2; shift 2
  line=$("$H" --backend vaapi --idr-every 120 --out "$WORK/$out.h264" "$@" 2>&1 >/dev/null | grep '^{"backend"' | tail -1)
  [ -n "$line" ] || FAIL4=1
  echo "$label: ${line:-FAILED}"; echo "{\"label\":\"$label\",\"result\":${line:-null}}" >> "$WORK/matrix.jsonl"; }
for res in "1920 1080" "2560 1440" "3440 1440"; do
  set -- $res; w=$1; h=$2
  "$H" --probe --backend vaapi --width "$w" --height "$h" --fps 60 >/dev/null 2>&1 || { echo "${w}x${h}: not available on this GPU (skipped)"; continue; }
  run "${w}x${h}_unpaced" "m_${w}u" --bench 300 --width "$w" --height "$h" --fps 90 --bitrate 40000000
  run "${w}x${h}_paced60" "m_${w}p60" --bench 300 --paced --width "$w" --height "$h" --fps 60 --bitrate 30000000
  run "${w}x${h}_paced90" "m_${w}p90" --bench 360 --paced --width "$w" --height "$h" --fps 90 --bitrate 40000000
done

echo "== configuration variants at 1920x1080@60 (does each path this GPU offers work? the app uses the default)"
: > "$WORK/variants.jsonl"
variant() { label=$1; shift
  line=$(env "$@" "$H" --backend vaapi --idr-every 120 --out "$WORK/v_$label.h264" --bench 200 --paced --width 1920 --height 1080 --fps 60 --bitrate 20000000 2>&1 >/dev/null | grep -E '^\{"(backend|error)"' | tail -1)
  echo "$label: ${line:-no result}"; echo "{\"label\":\"$label\",\"env\":\"$*\",\"result\":${line:-null}}" >> "$WORK/variants.jsonl"; }
variant default CL_X=1
variant entrypoint_slice CL_ENC_VAAPI_ENTRYPOINT=slice
variant entrypoint_lp CL_ENC_VAAPI_ENTRYPOINT=lp
variant profile_main CL_VAAPI_PROFILE=main
variant driver_writes_headers CL_VAAPI_NO_PACKED=1
for d in /dev/dri/renderD*; do [ -e "$d" ] && variant "node_${d##*/}" CL_VAAPI_DEVICE="$d"; done

echo "== calibration as the app runs it (--probe --calibrate 45 at 1920x1080@60)"
"$H" --backend vaapi --probe --calibrate 45 --width 1920 --height 1080 --fps 60 --bitrate 20000000 2>&1 >/dev/null | grep '^{"backend"' | tail -1 | tee "$WORK/calib.json"

echo "== intra-refresh (the app keeps it OFF until this decodes with 0 errors)"
CL_ENC_INTRA_REFRESH=1 "$H" --backend vaapi --refresh-every 60 --bench 360 --paced --width 1920 --height 1080 --fps 60 --bitrate 20000000 --out "$WORK/ir.h264" 2>&1 >/dev/null | grep '^{"backend"' | tail -1 | tee "$WORK/ir.json"

: > "$WORK/dec.txt"; : > "$WORK/props.txt"; DECBAD=0
if command -v ffprobe >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  for f in "$WORK"/m_*.h264 "$WORK"/v_*.h264; do
    [ -s "$f" ] || continue; b=$(basename "$f" .h264)
    n=$(ffmpeg -v error -i "$f" -f null - 2>&1 | wc -l); echo "$b decode_error_lines=$n" >> "$WORK/dec.txt"; [ "$n" -gt 0 ] && DECBAD=1
  done
  f="$WORK/v_default.h264"; [ -s "$f" ] && ffprobe -v error -show_entries stream=profile,level,width,height,has_b_frames,color_space,color_range -of default=nw=1 "$f" > "$WORK/props.txt" 2>&1
  if [ -s "$WORK/ir.h264" ]; then
    N=$(ffmpeg -v error -i "$WORK/ir.h264" -f null - 2>&1 | wc -l); python3 - "$WORK/ir.h264" "$WORK/ir_cut.h264" <<'PYCUT'
import sys
d = open(sys.argv[1], 'rb').read()
sc = b'\x00\x00\x00\x01'
# cut at the START of the 2nd refresh wave (the AU begins SPS+PPS+recovery-point SEI), i.e. where a late joiner would start. A byte-offset cut
# lands mid-picture and the partial first NAL alone produces errors that say nothing about recovery.
sei = [i for i in range(len(d) - 4) if d[i:i+4] == sc and (d[i+4] & 0x1f) == 6]
if len(sei) < 2: open(sys.argv[2], 'wb').write(d[200000:])
else:
    i = sei[1]; j = d.rfind(sc + b'\x67', max(0, i - 400), i); open(sys.argv[2], 'wb').write(d[j if j >= 0 else i:])
PYCUT
N3=$(ffmpeg -v error -i "$WORK/ir_cut.h264" -f null - 2>&1 | grep -vc "non-existing PPS\|no frame\|Invalid data")
    echo "intra-refresh stream decode_error_lines=$N; cut-stream non-start-up errors=$N3" > "$WORK/ir_dec.txt"
  fi
  echo "== decode check"; cat "$WORK/dec.txt"; cat "$WORK/props.txt"
else echo "(ffmpeg/ffprobe not installed: decode check skipped; install ffmpeg to include it)" | tee "$WORK/dec.txt"; fi

CAPFAIL=0; echo "null" > "$WORK/cap.json"; : > "$WORK/cap.rc"
if [ "$MODE" = capture ]; then
  echo "== REAL capture test: a screen-share dialog will appear ONCE. Pick the screen (move something on it; you have 60 s to answer)."
  echo "   Captures 15 s through the portal and VA-API; the video stays in a temp file and is deleted."
  ( sleep 17; echo STOP ) | timeout 90 "$H" --capture --backend vaapi --width 3440 --height 1440 --fps 60 --bitrate 30000000 > "$WORK/cap.bin" 2> "$WORK/cap.err"; CRC=$?
  echo "$CRC" > "$WORK/cap.rc"; echo "capture exit=$CRC (0 fine, 12 dialog cancelled/denied, 11 no portal, 14 PipeWire missing, 5 source ended, 6 no frames, 15 encoder open failed)"
  python3 - "$WORK/cap.bin" "$WORK/cap.err" "$CRC" "$WORK/cap.h264" > "$WORK/cap.json" <<'PY'
import json, struct, sys
b = open(sys.argv[1], 'rb').read(); recs = []; p = 0
out = open(sys.argv[4], 'wb')
while p + 24 <= len(b):
    n, fl = struct.unpack_from('<IB', b, p); cap, done = struct.unpack_from('<QQ', b, p + 8)
    if p + 24 + n > len(b): break
    recs.append((cap, n, fl & 1)); out.write(b[p + 24:p + 24 + n]); p += 24 + n
out.close()
ev = []
for l in open(sys.argv[2], errors='replace'):
    l = l.strip()
    if l.startswith('{'):
        try: ev.append(json.loads(l))
        except Exception: pass
gaps = [(recs[i + 1][0] - recs[i][0]) / 1000 for i in range(len(recs) - 1)]
span = (recs[-1][0] - recs[0][0]) / 1e6 if len(recs) > 1 else 0
stats = [e for e in ev if e.get('event') == 'stats']
print(json.dumps({'exit': int(sys.argv[3]), 'aus': len(recs), 'keyframes': sum(r[2] for r in recs), 'seconds': round(span, 1),
    'mean_fps': round(len(recs) / span, 1) if span else 0, 'max_gap_ms': round(max(gaps), 1) if gaps else 0,
    'enc_ms_p95_max': max((s['enc_ms_p95'] for s in stats), default=0), 'kbps_max': max((s['kbps'] for s in stats), default=0),
    'events': [{k: v for k, v in e.items() if k != 'restore_token'} for e in ev if e.get('event') in ('portal', 'format', 'ended', 'fps_limited') or 'error' in e][:12]}))
PY
  if [ "$CRC" != 0 ]; then CAPFAIL=1; fi
  if command -v ffmpeg >/dev/null 2>&1 && [ -s "$WORK/cap.h264" ]; then
    CN=$(ffmpeg -v error -i "$WORK/cap.h264" -f null - 2>&1 | wc -l); echo "captured stream decode_error_lines=$CN"; echo "capture_decode_error_lines=$CN" >> "$WORK/dec.txt"
    ffmpeg -v error -y -i "$WORK/cap.h264" -frames:v 1 -vf "select=eq(n\,30)" "$OUTDIR/capture-frame.png" 2>/dev/null && echo "wrote $OUTDIR/capture-frame.png (one frame; LOOK at it: colours right (red should be red), cursor visible?)"
  fi
fi

verdict "ok"; [ "$FAIL4" = 1 ] && verdict "encode_run_failed"; [ "$DECBAD" = 1 ] && verdict "decode_errors"; [ "$CAPFAIL" = 1 ] && verdict "capture_failed"
write_report
echo; echo "SUMMARY ($(cat "$WORK/verdict.txt"))"
python3 - "$OUTDIR/report.json" <<'PY' 2>/dev/null || cat "$OUTDIR/report.json"
import json, sys
d = json.load(open(sys.argv[1])); print(d['os'])
p = (d['probe_1920x1080_60'] or {}).get('line') or {}
print('chosen: %s | %s | VA driver %s | %s/%s rc=%s packed=%s | %s' % (p.get('gpu'), p.get('device'), p.get('va_driver'), p.get('profile'), p.get('entrypoint'), p.get('rc'), p.get('packed_headers'), p.get('driver')))
if p.get('attempts'): print('ladder:', p['attempts'])
for r in d['matrix']:
    x = r['result'] or {}; print('%-22s fps=%-6s p50=%-5s p99=%-5s kbps=%-7s idrs=%s' % (r['label'], x.get('fps'), x.get('enc_ms_p50'), x.get('enc_ms_p99'), x.get('kbps'), x.get('idrs')))
print('decode:', d['decode_check'].replace('\n', '; ')[:300])
if d.get('capture'): print('capture:', json.dumps(d['capture'])[:400])
PY
echo "Report written to $OUTDIR/report.json - please send that file back."
case "$(cat "$WORK/verdict.txt")" in ok) exit 0;; encode_run_failed) exit 4;; decode_errors) exit 20;; capture_failed) exit 21;; esac; exit 0
