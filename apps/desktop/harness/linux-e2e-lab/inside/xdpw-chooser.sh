#!/usr/bin/env bash
# xdg-desktop-portal-wlr chooser_type=dmenu hook: stdin = one candidate per line (output names), stdout = the pick.
# Every invocation is one portal chooser a person would have been shown. Logged to $LAB_OUT/chooser-calls.log with the
# candidates, then answered from $LAB_OUT/chooser-pick (an output name). Default pick: HEADLESS-1, the output the lab's
# animated pattern window is on (HEADLESS-2 is the empty second monitor used by the Change Source scenario).
OUT=${LAB_OUT:-/out}
mapfile -t cands
pick=$(cat "$OUT/chooser-pick" 2>/dev/null)
[ -n "$pick" ] || pick=HEADLESS-1
sel=${cands[0]}
for c in "${cands[@]}"; do [ "$c" = "$pick" ] && sel=$c; done
printf '%s chooser #%s candidates=[%s] picked=%s\n' "$(date +%s%3N)" "$(( $(wc -l < "$OUT/chooser-calls.log" 2>/dev/null || echo 0) + 1 ))" "${cands[*]}" "$sel" >> "$OUT/chooser-calls.log"
printf '%s\n' "$sel"
