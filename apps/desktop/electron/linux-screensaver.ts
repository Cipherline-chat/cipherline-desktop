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
  'gdbus monitor --session --dest org.freedesktop.ScreenSaver </dev/null 3<&- &',
  'g=$!',
  'cat <&3 >/dev/null 3<&- &',
  'c=$!',
  'exec 3<&-',
  `trap 'kill "$g" "$c" 2>/dev/null' EXIT`,
  `trap 'exit 0' INT TERM HUP`,
  'wait "$c"',
].join('\n');

interface WatchChild {
  stdin: Writable | null;
  stdout: Readable | null;
  on(event: 'error', cb: (err: unknown) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
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
  deps: { platform?: NodeJS.Platform; spawn?: WatchSpawn } = {},
): () => void {
  if ((deps.platform ?? process.platform) !== 'linux') return () => {};
  const spawnFn: WatchSpawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));

  let child: WatchChild | null;
  let buffer = '';

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
      if (!line.includes('ScreenSaver.ActiveChanged')) continue;
      if (line.includes('(true')) onLock();
      else if (line.includes('(false')) onUnlock?.();
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
