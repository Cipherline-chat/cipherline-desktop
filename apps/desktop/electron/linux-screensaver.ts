/**
 * Linux screen-lock detection via the freedesktop ScreenSaver D-Bus interface.
 *
 * Electron's `powerMonitor` only emits `'lock-screen'` on Windows + macOS —
 * on Linux the only comparable event is `'suspend'` (sleep/hibernate), which
 * never fires when a user locks their session while the machine stays awake
 * (Meta+L, an idle-timeout lock, closing a laptop lid with "lock on suspend"
 * off, etc.). That's the common case Screen Lock's "lock with your screen
 * lock" toggle is meant to catch, so we need a real signal for it.
 *
 * `org.freedesktop.ScreenSaver`'s `ActiveChanged(bool)` signal on the session
 * bus is the de-facto standard apps rely on for this (mpv/VLC/browsers use
 * the sibling `Inhibit` method on the same interface to prevent locking
 * during video playback) — KDE's kscreenlocker, GNOME's screensaver proxy,
 * and most other DE session-lock daemons all implement it for compatibility.
 *
 * Implemented by shelling out to `gdbus monitor` (ships with glib2, which is
 * already a dependency of virtually every Linux desktop environment) rather
 * than adding a D-Bus npm package, in keeping with this app's minimal-
 * dependency approach — this is Linux-desktop-only, best-effort functionality
 * with no bearing on security (see useScreenLock.ts's threat-model note), so
 * a missing `gdbus` binary should degrade silently, not fail loudly.
 */

import { spawn as nodeSpawn } from 'child_process';
import type { Readable, Writable } from 'stream';

/**
 * The watcher runs `gdbus monitor` under this tiny POSIX sh wrapper instead of
 * spawning gdbus directly.
 *
 * Why: a directly spawned `gdbus monitor` outlives Cipherline whenever the app
 * does not get to run its `will-quit` cleanup (SIGKILL, a crash, and, measured
 * on Fedora 44 / Ubuntu 20.04 / 24.04 with staging.213, an ordinary SIGTERM
 * from logout or a task manager). The orphan (PPID 1) then lives until the
 * next screen-lock signal or the end of the session, holding the ~40-65 file
 * descriptors it inherited from Chromium: files inside the AppImage's
 * /tmp/.mount_* (so the mount cannot go away), the profile's GPU/leveldb
 * cache files, and sockets (one held the old instance's listening port).
 * Every killed launch added one more.
 *
 * The wrapper keeps the READ end of a pipe whose write end only Cipherline
 * holds (the child's stdin). However Cipherline ends, the kernel closes that
 * end, `cat` sees EOF, and the EXIT trap kills gdbus. `wait` (not a foreground
 * `cat`) keeps the shell able to run its traps on SIGTERM, which the cleanup
 * function also sends. An async command's stdin is /dev/null in a
 * non-interactive shell, hence the fd-3 copy. Absent gdbus = a quiet no-op, as
 * before. Plain POSIX sh (dash on Debian/Ubuntu): no bashisms.
 */
export const SCREENSAVER_WATCH_SCRIPT = [
  'command -v gdbus >/dev/null 2>&1 || exit 0',
  'exec 3<&0',
  // Three sources, any of which may be absent (an unowned name makes that gdbus exit at once, harmlessly):
  // freedesktop ScreenSaver (KDE, Cinnamon, MATE, XFCE...), GNOME's own org.gnome.ScreenSaver (same
  // ActiveChanged signature), and logind's per-session LockedHint on the SYSTEM bus (GNOME / KDE / most
  // session managers set it; filtered to our own session in JS, see parseScreenLockLine).
  'gdbus monitor --session --dest org.freedesktop.ScreenSaver </dev/null 3<&- &',
  'g=$!',
  'gdbus monitor --session --dest org.gnome.ScreenSaver </dev/null 3<&- &',
  'g="$g $!"',
  'gdbus monitor --system --dest org.freedesktop.login1 </dev/null 3<&- &',
  'g="$g $!"',
  'cat <&3 >/dev/null 3<&- &',
  'c=$!',
  'exec 3<&-',
  `trap 'kill $g "$c" 2>/dev/null' EXIT`,
  `trap 'exit 0' INT TERM HUP`,
  'wait "$c"',
].join('\n');

interface WatchChild {
  stdin: Writable | null;
  stdout: Readable | null;
  on(event: 'error', cb: (err: unknown) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}
/** logind's object path for a session id: sd-bus escapes a leading digit (and any non [A-Za-z0-9_] char) as _hh. */
export function logindSessionPath(sessionId: string | undefined): string | null {
  if (!sessionId || !/^[A-Za-z0-9]+$/.test(sessionId)) return null;
  const first = sessionId[0];
  const head = /[0-9]/.test(first) ? `_${first.charCodeAt(0).toString(16)}` : first;
  return `/org/freedesktop/login1/session/${head}${sessionId.slice(1)}`;
}

/**
 * One gdbus monitor line -> a lock edge, or null. Pure, so each desktop's real output format is unit-tested.
 *  - `...ScreenSaver.ActiveChanged (true,)` (freedesktop or GNOME): screen locked / unlocked.
 *  - logind `PropertiesChanged ... 'LockedHint': <true>` on OUR session path only (other users' sessions
 *    broadcast on the same bus and must never lock this PC's status).
 */
export function parseScreenLockLine(line: string, ownSessionPath: string | null): 'lock' | 'unlock' | null {
  if (line.includes('ScreenSaver.ActiveChanged')) {
    if (line.includes('(true')) return 'lock';
    if (line.includes('(false')) return 'unlock';
    return null;
  }
  if (ownSessionPath && line.startsWith(`${ownSessionPath}:`) && line.includes("'LockedHint'")) {
    if (/'LockedHint':\s*<true>/.test(line)) return 'lock';
    if (/'LockedHint':\s*<false>/.test(line)) return 'unlock';
  }
  return null;
}

export type WatchSpawn = (cmd: string, args: string[], opts: { stdio: ['pipe', 'pipe', 'ignore'] }) => WatchChild;

/**
 * Start watching for the session lock signal. Calls `onLock()` each time
 * ActiveChanged fires with `true` (screen just locked), and the optional
 * `onUnlock()` when it fires with `false` (screen unlocked) — continuity's
 * attention state needs the pair, because Electron's `unlock-screen` event
 * does not exist on Linux and a lock with no matching unlock would leave this
 * PC reported as not-in-use for good. Returns a cleanup function that stops
 * watching — always call it on app quit (the wrapper above also stops it when
 * the app dies without calling it).
 *
 * No-ops (returns a no-op cleanup) on non-Linux platforms or if `gdbus`
 * isn't available; never throws.
 */
export function watchLinuxScreenLock(
  onLock: () => void,
  onUnlock?: () => void,
  deps: { platform?: NodeJS.Platform; spawn?: WatchSpawn; sessionId?: string } = {},
): () => void {
  if ((deps.platform ?? process.platform) !== 'linux') return () => {};
  const spawnFn: WatchSpawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));

  let child: WatchChild | null;
  let buffer = '';
  const ownSessionPath = logindSessionPath('sessionId' in deps ? deps.sessionId : process.env.XDG_SESSION_ID);
  // Several sources can report the same edge: only CHANGES are forwarded.
  let locked = false;

  try {
    child = spawnFn('/bin/sh', ['-c', SCREENSAVER_WATCH_SCRIPT], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return () => {}; // no /bin/sh?! best-effort feature, skip quietly
  }

  child.on('error', () => {}); // best-effort: swallow spawn errors
  // A write to the pipe after the wrapper exited (it never reads, but Node may
  // flush on end()) must not become an uncaught EPIPE in main.
  child.stdin?.on('error', () => {});

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    // gdbus streams line-by-line; process whatever complete lines we have.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const edge = parseScreenLockLine(line, ownSessionPath);
      if (edge === 'lock' && !locked) { locked = true; onLock(); }
      else if (edge === 'unlock' && locked) { locked = false; onUnlock?.(); }
    }
  });

  return () => {
    if (!child) return;
    const c = child;
    child = null;
    try { c.stdin?.end(); } catch { /* already closed */ }
    try { c.kill(); } catch { /* already exited */ }
  };
}
