#!/usr/bin/env bash
# Fail (exit 1) if any given Linux binary needs a glibc / libstdc++ symbol version above the floor.
#
#   check-glibc-floor.sh <glibc-floor> <binary>...        e.g.  check-glibc-floor.sh 2.31 build/Release/audio_capture.node
#   GLIBCXX_FLOOR=3.4.28 (default) is the matching libstdc++ ceiling (Ubuntu 20.04 / gcc 9).
#
# Why this exists: a binary built on a newer distro links that distro's glibc (an Ubuntu 24.04 build needs
# GLIBC_2.38 and will not dlopen on Ubuntu 22.04 / Debian 12), and the failure is SILENT at run time - the
# app starts and just logs "Native audio capture addon NOT loaded". A failed build is better than that.
# Reads only the dynamic symbol table's UNDEFINED symbols (what the binary needs from libc), via objdump.
set -euo pipefail

FLOOR="${1:-}"
[ -n "$FLOOR" ] && shift || { echo "usage: $0 <glibc-floor e.g. 2.31> <binary>..." >&2; exit 2; }
[[ "$FLOOR" =~ ^[0-9]+(\.[0-9]+)+$ ]] || { echo "::error::glibc floor '$FLOOR' is not a version number" >&2; exit 2; }
[ "$#" -gt 0 ] || { echo "::error::no binaries given to check" >&2; exit 2; }
CXX_FLOOR="${GLIBCXX_FLOOR:-3.4.28}"
OBJDUMP="${OBJDUMP:-objdump}"
command -v "$OBJDUMP" >/dev/null || { echo "::error::$OBJDUMP not found (apt-get install binutils)" >&2; exit 2; }

# true when $1 <= $2 as dotted versions
le() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$2" ]; }

bad=0
for f in "$@"; do
  if [ ! -f "$f" ]; then echo "::error::$f does not exist"; bad=1; continue; fi
  if ! dyn="$("$OBJDUMP" -T "$f" 2>&1)"; then
    echo "::error::$OBJDUMP -T $f failed (not a dynamic ELF?): $dyn"; bad=1; continue
  fi
  und="$(printf '%s\n' "$dyn" | grep -F '*UND*' || true)"
  glibc_max="$(printf '%s\n' "$und" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -u -V | tail -n 1 || true)"
  cxx_max="$(printf '%s\n' "$und" | grep -o 'GLIBCXX_[0-9][0-9.]*' | sed 's/^GLIBCXX_//' | sort -u -V | tail -n 1 || true)"
  echo "$f: max GLIBC_${glibc_max:-none} (floor $FLOOR), max GLIBCXX_${cxx_max:-none} (ceiling $CXX_FLOOR)"
  if [ -n "$glibc_max" ] && ! le "$glibc_max" "$FLOOR"; then
    echo "::error::$f needs GLIBC_$glibc_max, above the GLIBC_$FLOOR floor - it will fail to load on older distros. Offending symbols:"
    printf '%s\n' "$und" | grep -o '(GLIBC_[0-9.]*) *[A-Za-z0-9_@.]*' | sort -u | while read -r line; do
      v="${line#(GLIBC_}"; v="${v%%)*}"
      le "$v" "$FLOOR" || echo "    $line"
    done
    bad=1
  fi
  if [ -n "$cxx_max" ] && ! le "$cxx_max" "$CXX_FLOOR"; then
    echo "::error::$f needs GLIBCXX_$cxx_max, above the GLIBCXX_$CXX_FLOOR ceiling."
    bad=1
  fi
done
[ "$bad" -eq 0 ] && echo "glibc floor OK (<= GLIBC_$FLOOR)" || exit 1
