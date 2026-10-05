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

import { spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

/**
 * Start watching for the session lock signal. Calls `onLock()` each time
 * ActiveChanged fires with `true` (screen just locked). Returns a cleanup
 * function that stops watching — always call it on app quit.
 *
 * No-ops (returns a no-op cleanup) on non-Linux platforms or if `gdbus`
 * isn't available; never throws.
 */
export function watchLinuxScreenLock(onLock: () => void): () => void {
  if (process.platform !== 'linux') return () => {};

  let child: ChildProcessByStdio<null, Readable, null> | null;
  let buffer = '';

  try {
    child = spawn('gdbus', ['monitor', '--session', '--dest', 'org.freedesktop.ScreenSaver'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return () => {}; // gdbus not on PATH — best-effort feature, skip quietly
  }

  child.on('error', () => {}); // e.g. ENOENT if gdbus is missing — swallow, best-effort

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    // gdbus streams line-by-line; process whatever complete lines we have.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.includes('ScreenSaver.ActiveChanged') && line.includes('(true')) {
        onLock();
      }
    }
  });

  return () => {
    if (!child) return;
    try { child.kill(); } catch { /* already exited */ }
    child = null;
  };
}
