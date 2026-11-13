#!/usr/bin/env bash
# Runs INSIDE the cipherline-pw-test container (see run.sh): getPidFromSourceId('window:<xid>:0') on a real
# X11 window (xterm under Xvfb) must return the window owner's pid, and a window id that does not exist must
# return null WITHOUT killing the process (X's default error handler exits the program; the addon swallows it).
set -u
export PATH=/opt/node/bin:$PATH
export DISPLAY=:99
Xvfb :99 -screen 0 800x600x24 >/tmp/xvfb.log 2>&1 &
sleep 1.5
xterm -geometry 40x5+10+10 -e sleep 30 >/tmp/xterm.log 2>&1 &
XTERM_PID=$!
sleep 1.5
XID_HEX=$(xwininfo -root -children | awk '/xterm/ && /0x/ {print $1; exit}')
XID=$((XID_HEX))
echo "xterm pid=$XTERM_PID  window id=$XID_HEX ($XID)"
cat > /tmp/x11-check.mjs <<EOF
import { createRequire } from 'node:module';
const a = createRequire(import.meta.url)('/addon/audio_capture.node');
let bad = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  -- ' + d : '')); if (!ok) bad++; };
const got = a.getPidFromSourceId('window:$XID:0');
check('real X11 window -> its _NET_WM_PID', got === $XTERM_PID, 'got ' + got + ', xterm is $XTERM_PID');
check('a screen source has no pid', a.getPidFromSourceId('screen:0:0') === null);
check('a window id that does not exist -> null, and the process survives the X error', a.getPidFromSourceId('window:99999999:0') === null);
check('malformed ids -> null', a.getPidFromSourceId('window:abc:0') === null && a.getPidFromSourceId('window:0:0') === null && a.getPidFromSourceId('window:') === null && a.getPidFromSourceId('window:99999999999999999999:0') === null);
check('still alive and answering afterwards', a.getPidFromSourceId('window:$XID:0') === $XTERM_PID);
delete process.env.DISPLAY;
check('no DISPLAY (Wayland-only session) -> null', a.getPidFromSourceId('window:$XID:0') === null);
console.log(bad === 0 ? 'X11-PID: ALL PASSED' : 'X11-PID: ' + bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
EOF
node /tmp/x11-check.mjs
