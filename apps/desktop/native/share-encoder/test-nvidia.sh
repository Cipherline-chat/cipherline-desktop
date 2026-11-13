#!/usr/bin/env bash
# One-command NVENC test for a Linux + NVIDIA machine (also works on a cloud GPU VM with the NVIDIA driver installed).
#   bash test-nvidia.sh            -> builds the helper with NVENC, runs the matrix, writes nvenc-results.json + prints a summary
# Needs: gcc, make, libva-dev (headers; the VA-API backend is compiled but not used), and the NVENC headers (nv-codec-headers).
# On Debian/Ubuntu both come from apt (the script downloads the .debs and extracts them, no root, nothing installed):
#   libva-dev libffmpeg-nvenc-dev.  Optional: ffmpeg/ffprobe (validates that the output decodes).
# Send back: nvenc-results.json  and  the "SUMMARY" block.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE" || exit 1
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="${OUT:-$HERE/nvenc-results.json}"

echo "== environment"
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1 | head -4 || echo "nvidia-smi not found"
[ -e /usr/lib/x86_64-linux-gnu/libnvidia-encode.so.1 ] || ldconfig -p 2>/dev/null | grep -q libnvidia-encode || echo "WARNING: libnvidia-encode.so.1 not found (install the NVIDIA driver's encode libs, e.g. libnvidia-encode-<ver> on Ubuntu)"

echo "== headers"
VA_INC=/usr/include; NV_INC=""
[ -f /usr/include/va/va.h ] || { (cd "$WORK" && apt-get download libva-dev >/dev/null 2>&1 && dpkg -x libva-dev*.deb va) && VA_INC="$WORK/va/usr/include"; }
if [ -f /usr/include/ffnvcodec/nvEncodeAPI.h ]; then NV_INC=/usr/include
elif [ -f /usr/local/include/ffnvcodec/nvEncodeAPI.h ]; then NV_INC=/usr/local/include
else (cd "$WORK" && apt-get download libffmpeg-nvenc-dev >/dev/null 2>&1 && dpkg -x libffmpeg-nvenc-dev*.deb nv) && NV_INC="$WORK/nv/usr/include"; fi
[ -f "$VA_INC/va/va.h" ] || { echo "need libva headers (apt install libva-dev)"; exit 2; }
[ -n "$NV_INC" ] && [ -f "$NV_INC/ffnvcodec/nvEncodeAPI.h" ] || { echo "need nv-codec-headers (apt install libffmpeg-nvenc-dev)"; exit 2; }

echo "== build"
make clean >/dev/null; make VA_INC="$VA_INC" NV_INC="$NV_INC" 2>&1 | tail -3
H="$HERE/build/share-encoder-helper"; [ -x "$H" ] || { echo "build failed"; exit 2; }

echo "== probe"
"$H" --backend nvenc --probe 2>&1 | tail -3
"$H" --backend nvenc --probe >/dev/null 2>&1 || { echo "NVENC UNAVAILABLE on this machine (see message above). Send that message back."; exit 3; }

echo "== matrix (unpaced = max throughput; paced = real time; IDR requested every 120 frames; software scroller as the source)"
: > "$WORK/lines.jsonl"
run() { # label args...
  label=$1; shift
  line=$("$H" --backend nvenc --idr-every 120 --out "$WORK/$label.h264" "$@" 2>&1 >/dev/null | grep '^{"backend"' | tail -1)
  echo "$label: $line"; echo "{\"label\":\"$label\",\"result\":${line:-null}}" >> "$WORK/lines.jsonl"
}
for res in "1920 1080" "2560 1440" "3440 1440"; do
  set -- $res; w=$1; h=$2
  run "${w}x${h}_unpaced" --bench 600 --width "$w" --height "$h" --fps 90 --bitrate 40000000
  run "${w}x${h}_paced90" --bench 900 --paced --width "$w" --height "$h" --fps 90 --bitrate 40000000
  run "${w}x${h}_paced60" --bench 600 --paced --width "$w" --height "$h" --fps 60 --bitrate 30000000
done

echo "== decode check (the 1080p stream)"
DEC="not run (no ffmpeg)"
if command -v ffprobe >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  P=$(ffprobe -v error -show_entries stream=codec_name,profile,width,height -of csv=p=0 "$WORK/1920x1080_paced60.h264" 2>&1 | head -1)
  N=$(ffmpeg -v error -i "$WORK/1920x1080_paced60.h264" -f null - 2>&1 | wc -l)
  DEC="stream=$P decode_error_lines=$N"
fi
echo "$DEC"

{ echo "{\"gpu\":\"$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)\",\"decode_check\":\"$DEC\",\"runs\":["; paste -sd, "$WORK/lines.jsonl"; echo "]}"; } > "$OUT"
echo
echo "SUMMARY (fps = achieved, enc_ms_* = per-frame encode latency, idrs should be ~5 for 600 frames at --idr-every 120)"
python3 - "$OUT" <<'EOF' 2>/dev/null || cat "$OUT"
import json,sys
d=json.load(open(sys.argv[1])); print(d["gpu"]); print(d["decode_check"])
for r in d["runs"]:
    x=r["result"] or {}
    print("%-24s fps=%-6s p50=%-6s p99=%-6s kbps=%-7s idrs=%s idr_max_bytes=%s" % (r["label"],x.get("fps"),x.get("enc_ms_p50"),x.get("enc_ms_p99"),x.get("kbps"),x.get("idrs"),x.get("idr_bytes_max")))
EOF
echo "Results written to $OUT - please send that file back."
