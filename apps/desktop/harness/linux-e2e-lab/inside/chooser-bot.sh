#!/usr/bin/env bash
# Best-effort answerer for the KDE / GNOME portal chooser. It watches the ScreenCast `Start` calls (the same D-Bus traffic
# the harness counts) and, for each, tries to confirm the dialog. What it can reach is recorded verbatim so the report can
# say "chooser could NOT be automated here" with evidence instead of guessing:
#   1. restore: nothing to restore (Chromium's PipeWire capturer never requests persistence), so no token shortcut exists;
#   2. keyboard: Wayland offers no synthetic input to a non-compositor client; mutter exposes org.gnome.Mutter.RemoteDesktop,
#      which this bot uses on GNOME to send Tab/Return/space to the focused dialog;
#   3. KWin: org_kde_kwin_fake_input is unreachable from shell tools, so on KDE the bot only logs what it sees.
# Output: one line per attempt in chooser-bot.log.
KIND=${1:?kde|gnome}
H=${H:-/lab}
source $H/inside/common.sh
OUT=${OUT:-/out}
echo "bot start kind=$KIND"
seen=0
# Remote-desktop session on mutter, created once; keys are sent through NotifyKeyboardKeysym.
rd_session() {
  gdbus call --session --dest org.gnome.Mutter.RemoteDesktop --object-path /org/gnome/Mutter/RemoteDesktop \
    --method org.gnome.Mutter.RemoteDesktop.CreateSession 2>&1
}
RDPATH=""
if [ "$KIND" = gnome ]; then
  r=$(rd_session); echo "RemoteDesktop.CreateSession -> $r"
  RDPATH=$(echo "$r" | grep -o "/org/gnome/Mutter/RemoteDesktop/Session/[A-Za-z0-9_]*" | head -1)
  if [ -n "$RDPATH" ]; then
    echo "Start -> $(gdbus call --session --dest org.gnome.Mutter.RemoteDesktop --object-path "$RDPATH" --method org.gnome.Mutter.RemoteDesktop.Session.Start 2>&1)"
  fi
fi
key() {  # key <keysym int>
  [ -n "$RDPATH" ] || return 1
  gdbus call --session --dest org.gnome.Mutter.RemoteDesktop --object-path "$RDPATH" --method org.gnome.Mutter.RemoteDesktop.Session.NotifyKeyboardKeysym "$1" true >/dev/null 2>&1
  gdbus call --session --dest org.gnome.Mutter.RemoteDesktop --object-path "$RDPATH" --method org.gnome.Mutter.RemoteDesktop.Session.NotifyKeyboardKeysym "$1" false >/dev/null 2>&1
}
while :; do
  n=$(grep -c "interface=org.freedesktop.impl.portal.ScreenCast; member=Start" "$OUT/dbus-portal.log" 2>/dev/null); n=${n:-0}
  if [ "$n" -gt "$seen" ]; then
    seen=$n
    echo "$(date +%T) backend Start #$n seen; trying to answer the dialog"
    sleep 1.5
    if [ "$KIND" = gnome ]; then
      # Tab to the Share button is fragile across GNOME versions: try Return first (default response), then space.
      key 0xff0d; echo "  sent Return -> rc=$?"
      sleep 1; key 0xff0d
    else
      echo "  KDE: no synthetic-input route available from a shell client; dialog left open"
    fi
  fi
  sleep 0.5
done
