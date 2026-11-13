#!/usr/bin/env bash
# Cipherline native share: one-command NVIDIA test for a Linux machine (Arch/CachyOS, Ubuntu, Fedora ...). Nothing is installed.
#   bash run.sh            encoder matrix + capabilities report                      (~2 min, no desktop session needed)
#   bash run.sh capture    ALSO a REAL screen capture -> NVENC test (needs a graphical Wayland session; a portal dialog appears once, pick a screen)
#   bash run.sh install    build, then copy the helper to ~/.config/Cipherline/native/ so a normal staging build of the app can use it
#                          (then turn on Settings -> Advanced -> "Hardware screen share (Linux, experimental)" and restart the app)
#   CL_TEST_BACKEND=pcm bash run.sh   dry-run of this script on a machine without a GPU (software test backend)
# Writes report.json and prints a SUMMARY. Please send report.json back (it contains GPU name, driver, NVENC API version, caps; no screen content).
# Needs: gcc + make (Arch: sudo pacman -S --needed base-devel), the NVIDIA driver, libva + pipewire runtime (normally already installed).
# Optional: ffmpeg/ffprobe (checks that the encoder's output decodes with 0 errors).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE" || exit 1
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="${OUT:-$HERE/report.json}"
BACKEND="${CL_TEST_BACKEND:-nvenc}"
MODE="${1:-matrix}"
J() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }   # string -> JSON string

echo "== environment"
GPU="$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null | head -4)"; echo "${GPU:-no nvidia-smi}"
{ . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME  kernel $(uname -r)  session=${XDG_SESSION_TYPE:-?}  desktop=${XDG_CURRENT_DESKTOP:-?}"; } | tee "$WORK/os.txt"
echo "pipewire: $(pipewire --version 2>/dev/null | tail -1)   portal: $(pgrep -a xdg-desktop-portal 2>/dev/null | head -3 | tr '\n' ' ')" | tee "$WORK/pw.txt"
if [ "$BACKEND" = nvenc ]; then ldconfig -p 2>/dev/null | grep -q libnvidia-encode || echo "WARNING: libnvidia-encode.so.1 not found (NVIDIA driver encode libs missing)"; fi
for t in gcc make; do command -v $t >/dev/null 2>&1 || { echo "need $t"; exit 2; }; done

echo "== build (headers bundled in ./include: nv-codec-headers, libva, pipewire/spa; all MIT)"
make clean >/dev/null 2>&1; make VA_INC="$HERE/include" PW_INC="$HERE/include" NV_INC="$HERE/include" 2>&1 | grep -E "error|Error" | head -5
H="$HERE/build/share-encoder-helper"; [ -x "$H" ] || { echo "build failed (is libva installed? Arch: sudo pacman -S --needed libva)"; exit 2; }

if [ "$MODE" = install ]; then
  D="${CL_USERDATA:-${XDG_CONFIG_HOME:-$HOME/.config}/Cipherline}/native"; mkdir -p "$D" && cp "$H" "$D/share-encoder-helper" && chmod 755 "$D/share-encoder-helper" \
    && echo "installed $D/share-encoder-helper - quit and restart Cipherline, then enable the setting." || echo "could not install into $D"
  exit 0
fi

echo "== probe (what the GPU/driver offer; API version negotiated; size limits)"
"$H" --backend "$BACKEND" --probe --width 3440 --height 1440 --fps 90 --bitrate 40000000 2>"$WORK/probe.err" >/dev/null; PRC=$?
grep '^{' "$WORK/probe.err" | tail -2
if [ $PRC -ne 0 ]; then
  echo "NVENC UNAVAILABLE here (exit $PRC): see the line above. exit 16 = encoder session limit, 17 = driver too old, 18 = size over the GPU limit."
  { echo "{\"ok\":false,\"probe_exit\":$PRC,\"gpu\":$(echo "$GPU" | J),\"os\":$(J < "$WORK/os.txt"),\"probe\":$(grep '^{' "$WORK/probe.err" | tail -1 | J)}"; } > "$OUT"
  echo "Wrote $OUT - please send it back."; exit 3
fi
PROBE_LINE="$(grep '"open":"ok"' "$WORK/probe.err" | tail -1)"

echo "== matrix (unpaced = max throughput; paced = real time; IDR every 120 frames; synthetic moving source)"
: > "$WORK/lines.jsonl"
run() { label=$1; shift
  line=$("$H" --backend "$BACKEND" --idr-every 120 --out "$WORK/$label.h264" "$@" 2>&1 >/dev/null | grep '^{"backend"' | tail -1)
  echo "$label: $line"; echo "{\"label\":\"$label\",\"result\":${line:-null}}" >> "$WORK/lines.jsonl"; }
for res in "1920 1080" "2560 1440" "3440 1440" "3840 2160"; do
  set -- $res; w=$1; h=$2
  run "${w}x${h}_unpaced" --bench 400 --width "$w" --height "$h" --fps 90 --bitrate 40000000
  run "${w}x${h}_paced90" --bench 450 --paced --width "$w" --height "$h" --fps 90 --bitrate 40000000
  run "${w}x${h}_paced60" --bench 300 --paced --width "$w" --height "$h" --fps 60 --bitrate 30000000
done
echo "== calibration as the app runs it (--probe --calibrate 45 at 3440x1440@90)"
"$H" --backend "$BACKEND" --probe --calibrate 45 --width 3440 --height 1440 --fps 90 --bitrate 40000000 2>&1 >/dev/null | grep '^{"backend"' | tail -1 | tee "$WORK/calib.json"

echo "== intra-refresh (what the app would use for PLI instead of an IDR; the app has it OFF until this reports 0 errors)"
CL_ENC_INTRA_REFRESH=1 "$H" --backend "$BACKEND" --refresh-every 60 --bench 360 --paced --width 1920 --height 1080 --fps 60 --bitrate 20000000 --out "$WORK/ir.h264" 2>&1 >/dev/null | grep '^{"backend"' | tail -1 | tee "$WORK/ir.json"

DEC="not run (no ffmpeg)"; IRDEC="not run"
if command -v ffprobe >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  P=$(ffprobe -v error -show_entries stream=codec_name,profile,width,height -of csv=p=0 "$WORK/1920x1080_paced60.h264" 2>&1 | head -1)
  N=$(ffmpeg -v error -i "$WORK/1920x1080_paced60.h264" -f null - 2>&1 | wc -l); DEC="stream=$P decode_error_lines=$N"
  N2=$(ffmpeg -v error -i "$WORK/ir.h264" -f null - 2>&1 | wc -l); IRDEC="intra-refresh stream decode_error_lines=$N2"
  # cut the intra-refresh stream away from its first IDR: a viewer that joins mid-stream must still start at a refresh wave
  python3 - "$WORK/ir.h264" "$WORK/ir_cut.h264" <<'PYCUT'
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
N3=$(ffmpeg -v error -i "$WORK/ir_cut.h264" -f null - 2>&1 | grep -vc "non-existing PPS\|no frame\|Invalid data" ); IRDEC="$IRDEC; cut-stream non-start-up errors=$N3"
fi
echo "decode: $DEC"; echo "decode: $IRDEC"

CAP_JSON=null
if [ "$MODE" = capture ]; then
  echo "== REAL capture test: a screen-share dialog will appear ONCE. Pick the screen (move something on it; you have 60 s to answer)."
  echo "   Capturing 15 s at up to 3440x1440@90 through the portal and NVENC; nothing is sent anywhere, the video stays in a temp file and is deleted."
  ( sleep 17; echo STOP ) | timeout 90 "$H" --capture --backend "$BACKEND" --width 3440 --height 1440 --fps 90 --bitrate 40000000 > "$WORK/cap.bin" 2> "$WORK/cap.err"; CRC=$?
  echo "capture exit=$CRC (0 = fine, 12 = dialog cancelled/denied, 11 = no portal, 14 = PipeWire missing, 16 = session limit, 5 = source ended)"
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
print(json.dumps({
    'exit': int(sys.argv[3]), 'aus': len(recs), 'keyframes': sum(r[2] for r in recs), 'seconds': round(span, 1),
    'mean_fps': round(len(recs) / span, 1) if span else 0, 'max_gap_ms': round(max(gaps), 1) if gaps else 0,
    'enc_fps_max': max((s['fps'] for s in stats), default=0), 'in_fps_max': max((s['in_fps'] for s in stats), default=0),
    'enc_ms_p95_max': max((s['enc_ms_p95'] for s in stats), default=0), 'kbps_max': max((s['kbps'] for s in stats), default=0),
    'events': [{k: v for k, v in e.items() if k != 'restore_token'} for e in ev if e.get('event') in ('portal', 'format', 'ended', 'fps_limited') or 'error' in e][:12],
}))
PY
  CAP_JSON="$(cat "$WORK/cap.json")"
  if command -v ffmpeg >/dev/null 2>&1 && [ -s "$WORK/cap.h264" ]; then
    CN=$(ffmpeg -v error -i "$WORK/cap.h264" -f null - 2>&1 | wc -l); echo "captured stream decode_error_lines=$CN"
    ffmpeg -v error -y -i "$WORK/cap.h264" -frames:v 1 -vf "select=eq(n\,30)" "$HERE/capture-frame.png" 2>/dev/null && echo "wrote capture-frame.png (one frame; LOOK at it: colours right? (red should be red), cursor visible?) - you can send it, or not."
  fi
  echo "capture summary: $CAP_JSON"
fi

{ echo "{\"ok\":true,\"mode\":\"$MODE\",\"backend\":\"$BACKEND\",\"gpu\":$(echo "$GPU" | J),\"os\":$(J < "$WORK/os.txt"),\"pipewire\":$(J < "$WORK/pw.txt"),"
  echo "\"probe\":${PROBE_LINE:-null},\"calibration\":$(cat "$WORK/calib.json" 2>/dev/null | grep . || echo null),\"intra_refresh_bench\":$(cat "$WORK/ir.json" 2>/dev/null | grep . || echo null),"
  echo "\"decode_check\":$(echo "$DEC" | J),\"intra_refresh_decode\":$(echo "$IRDEC" | J),\"capture\":$CAP_JSON,\"runs\":["; paste -sd, "$WORK/lines.jsonl"; echo "]}"; } > "$OUT"
echo
echo "SUMMARY"
python3 - "$OUT" <<'PY' 2>/dev/null || cat "$OUT"
import json, sys
d = json.load(open(sys.argv[1])); print(d['gpu']); pr = d.get('probe') or {}
print('NVENC API negotiated %s (driver max %s, built with %s), profile %s, size limit %sx%s, intra-refresh cap %s' % (pr.get('nvenc_api'), pr.get('nvenc_api_driver_max'), pr.get('nvenc_api_compiled'), pr.get('profile'), pr.get('cap_w'), pr.get('cap_h'), pr.get('cap_intra_refresh')))
print(d['decode_check']); print(d['intra_refresh_decode'])
for r in d['runs']:
    x = r['result'] or {}
    print('%-22s fps=%-6s p50=%-5s p99=%-5s kbps=%-7s idrs=%s' % (r['label'], x.get('fps'), x.get('enc_ms_p50'), x.get('enc_ms_p99'), x.get('kbps'), x.get('idrs')))
if d.get('capture'): print('capture:', json.dumps(d['capture'])[:400])
PY
echo "Results written to $OUT - please send that file back."
