#!/usr/bin/env bash
# VA-API control-logic tests against build/libva-mock.so (see test/mock_libva.c). No GPU. Run via `make test-vaapi`.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"; H="$HERE/build/share-encoder-helper-test"; export CL_LIBVA_PATH="$HERE/build/libva-mock.so" CL_VAAPI_DEVICE=/dev/null
pass=0; fail=0
check() { # name mode expected-substring [env...]
  local name=$1 mode=$2 want=$3; shift 3
  local out; out=$(env CL_MOCK="$mode" "$@" "$H" --probe --backend vaapi --width "${W:-1920}" --height "${HT:-1080}" --fps 60 2>&1); local rc=$?
  if printf '%s' "$out" | grep -qF -- "$want"; then pass=$((pass+1)); echo "ok   $name"; else fail=$((fail+1)); echo "FAIL $name (rc=$rc, wanted: $want)"; echo "     $out" | cut -c1-700; fi
}
check "radeonsi-like: no packed headers, hardware limits reported" radeonsi '"packed_headers":0'
check "radeonsi-like: max size from the driver attributes" radeonsi '"max_w":4096,"max_h":2304'
check "radeonsi-like: picks CBR (not software CQP)" radeonsi '"rc":"CBR"'
check "radeonsi-like: entrypoint EncSlice, Constrained Baseline" radeonsi '"profile":"ConstrainedBaseline","entrypoint":"EncSlice"'
check "iHD-LP-like: EncSliceLP, CQP+software, packed SPS/PPS/slice" ihd-lp '"entrypoint":"EncSliceLP","rc":"CQP+software","packed_headers":7'
check "iHD-LP-like: driver string identified" ihd-lp '"va_driver":"iHD"'
check "i965-like: CBR with packed headers" i965 '"va_driver":"i965","device":"/dev/null","profile":"ConstrainedBaseline","entrypoint":"EncSlice","rc":"CBR","packed_headers":7'
check "no encode entrypoint: clean error" noenc 'offers no H.264 encode entrypoint'
check "self-test rejects a driver whose SPS has the wrong size" badsps 'SPS picture size differs'
check "self-test rejects a header-less driver that forgot SPS/PPS" nosps 'IDR access unit lacks SPS/PPS'
check "size over the hardware limit -> size_over_limit with the limit" small '"code":"size_over_limit","max_w":1280,"max_h":720'
check "forcing the no-packed path on a packed-header driver (CL_VAAPI_NO_PACKED)" i965 '"packed_headers":0' CL_VAAPI_NO_PACKED=1
check "forced entrypoint the node lacks -> no candidate" ihd-lp 'no VA-API H.264 encode candidate matched' CL_ENC_VAAPI_ENTRYPOINT=slice
out=$(CL_MOCK=radeonsi "$H" --list-va 2>&1); if printf '%s' "$out" | grep -q '"candidates":\[{"profile":"ConstrainedBaseline"'; then pass=$((pass+1)); echo "ok   --list-va report"; else fail=$((fail+1)); echo "FAIL --list-va: $out" | cut -c1-400; fi
echo "vaapi mock tests: $pass passed, $fail failed"; [ "$fail" = 0 ]
