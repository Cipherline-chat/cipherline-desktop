#!/usr/bin/env bash
# Build everything the native "Strong" noise suppression needs, for the OS this runs on, and NEVER fail the build because of it:
#   1. the model   apps/desktop/resources/dfn/DeepFilterNet3_ll_onnx.tar.gz   (RETIRED path: nothing downloads it any more, supply it by hand)
#   2. the addon   apps/desktop/build/Release/cl_audio_node.node            (Rust, scripts/build-audio-node.sh)
# If either fails the app simply offers Light (audioEngine.available() is false and Settings says so), so a broken Rust toolchain or a
# GitHub hiccup on one runner must not block a release. A PARTIAL result is removed so a stale/foreign binary can never ship.
# CL_REQUIRE_AUDIO_NODE=1 turns failures into exit 1 (use it once the engine is the default, or to prove a runner works).
#
#   bash scripts/build-audio-engine.sh                 run from apps/desktop; picks the mode by OS:
#     Linux   -> inside an Ubuntu 20.04 container (glibc 2.31 floor, like rebuild-native-linux-compat.sh), needs docker
#     macOS   -> arm64 + x64 builds joined with lipo into ONE universal .node
#     Windows -> x86_64-pc-windows-msvc (Git Bash); installs rustup non-interactively when cargo is missing
#   AUDIO_ENGINE_MODE=host forces a plain host build (what a dev box does). Output lines starting with ::warning:: are GitHub annotations.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$DESKTOP/../.." && pwd)"
OUT="$DESKTOP/build/Release/cl_audio_node.node"
MODEL="$DESKTOP/resources/dfn/DeepFilterNet3_ll_onnx.tar.gz"
REQUIRED="${CL_REQUIRE_AUDIO_NODE:-0}"
OS="$(uname -s)"
MODE="${AUDIO_ENGINE_MODE:-auto}"
GLIBC_FLOOR="${GLIBC_FLOOR:-2.31}"
fail=0
warn() { echo "::warning title=Native Strong noise suppression::$*"; }
softfail() { warn "$* - this build ships WITHOUT native Strong (the app offers Light)."; fail=1; }

# ── rust toolchain (install non-interactively if absent) ────────────────────────────────────────────────────────────────────────
ensure_rust() {
  export PATH="$HOME/.cargo/bin:${USERPROFILE:+$(cygpath -u "$USERPROFILE" 2>/dev/null)/.cargo/bin:}$PATH"
  if command -v cargo >/dev/null 2>&1; then return 0; fi
  echo "cargo not found: installing rustup (stable, minimal profile, non-interactive)"
  case "$OS" in
    MINGW*|MSYS*|CYGWIN*)
      local tmp="${RUNNER_TEMP:-/tmp}/rustup-init.exe"
      curl -sSf -o "$tmp" https://win.rustup.rs/x86_64 || return 1
      "$tmp" -y --default-toolchain stable --default-host x86_64-pc-windows-msvc --profile minimal || return 1 ;;
    *)
      curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal || return 1 ;;
  esac
  export PATH="$HOME/.cargo/bin:${USERPROFILE:+$(cygpath -u "$USERPROFILE" 2>/dev/null)/.cargo/bin:}$PATH"
  command -v cargo >/dev/null 2>&1
}

host_build() { # TARGET optional
  ( cd "$ROOT" && JOBS="${JOBS:-4}" bash scripts/build-audio-node.sh )
}

linux_container_build() {
  command -v docker >/dev/null 2>&1 || { echo "docker is required for the glibc-$GLIBC_FLOOR build"; return 1; }
  local image="cipherline-audio-engine-linux-compat:glibc-$GLIBC_FLOOR" cache="${AUDIO_ENGINE_CACHE:-$HOME/.cache/cl-audio-engine}"
  docker build -q -t "$image" -f "$HERE/linux-compat/Dockerfile.audio" "$HERE/linux-compat" >/dev/null || return 1
  mkdir -p "$cache/cargo" "$cache/rustup" "$cache/target" "$(dirname "$OUT")"
  rm -f "$OUT"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_HOME=/cargo -e RUSTUP_HOME=/rustup -e CARGO_TARGET_DIR=/target -e JOBS="${JOBS:-4}" \
    -v "$ROOT":/src:ro -v "$cache/cargo":/cargo -v "$cache/rustup":/rustup -v "$cache/target":/target -v "$(dirname "$OUT")":/out \
    "$image" bash -euc '
      export PATH=/cargo/bin:$PATH
      command -v cargo >/dev/null || { curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal; }
      cargo build --profile addon --locked -j "$JOBS" --manifest-path /src/crates/Cargo.toml -p cl-audio-node
      cp /target/addon/libcl_audio_node.so /out/cl_audio_node.node' || return 1
  [ -f "$OUT" ] && bash "$HERE/check-glibc-floor.sh" "$GLIBC_FLOOR" "$OUT"
}

mac_universal_build() {
  local stage; stage="$(mktemp -d)"; trap 'rm -rf "$stage"' RETURN
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    ( cd "$ROOT" && TARGET="$t" JOBS="${JOBS:-4}" bash scripts/build-audio-node.sh ) || return 1
    cp "$OUT" "$stage/$t.node"
  done
  lipo -create -output "$OUT" "$stage/aarch64-apple-darwin.node" "$stage/x86_64-apple-darwin.node" || return 1
  lipo -info "$OUT"
  lipo "$OUT" -verify_arch arm64 && lipo "$OUT" -verify_arch x86_64
}

# ── 1. model ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
echo "── model"
# The download script was removed with the in-app DeepFilterNet worker (Strong is FastEnhancer, compiled into the page's wasm).
[ -f "$MODEL" ] || softfail "no DeepFilterNet model at $MODEL (nothing fetches it any more)"

# ── 2. addon ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
echo "── addon ($OS, mode $MODE)"
rm -f "$OUT"   # never package a stale binary from an earlier run
if [ -f "$MODEL" ]; then
  if ! ensure_rust; then softfail "the Rust toolchain could not be installed"
  else
    case "$OS:$MODE" in
      Linux:auto)   linux_container_build || { rm -f "$OUT"; softfail "the Linux addon build failed"; } ;;
      Darwin:auto)  mac_universal_build || { rm -f "$OUT"; softfail "the macOS universal addon build failed"; } ;;
      *)            host_build || { rm -f "$OUT"; softfail "the addon build failed"; } ;;
    esac
  fi
else
  echo "no model: skipping the addon build (without the model the engine is unavailable anyway)"
  fail=1
fi

if [ -f "$OUT" ] && [ -f "$MODEL" ]; then echo "native Strong ready: $(ls -l "$OUT" | awk '{print $5}') byte addon + model"; fail=0; else rm -f "$OUT"; fi
if [ "$fail" != 0 ] && [ "$REQUIRED" = "1" ]; then echo "::error::CL_REQUIRE_AUDIO_NODE=1 and the native Strong engine is not complete"; exit 1; fi
exit 0
