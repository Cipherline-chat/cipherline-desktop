/**
 * window-focus.ts — the one way Cipherline brings its window to the front.
 *
 * Three separate call sites used to do this by hand (the single-instance
 * `second-instance` handler, the tray's show/click actions, and the installer
 * reveal), each with a slightly different sequence. Only the installer one
 * bothered with the topmost pin — so a second launch or a tray click on a
 * minimised window could restore it *behind* whatever the user was looking at,
 * which reads as "nothing happened".
 *
 * The topmost pin is the load-bearing part on Windows. `focus()` alone routes
 * through SetForegroundWindow, which the OS refuses for a process that does not
 * own the foreground — it flashes the taskbar button instead of raising the
 * window. Briefly asserting HWND_TOPMOST sidesteps that restriction, and the
 * flag is dropped again a moment later so the window doesn't stay pinned over
 * everything else. (Same trick, and the same reasoning, as the `--fresh-install`
 * reveal path in main.ts.)
 */

import { app, BrowserWindow } from 'electron';

/** How long the topmost pin is held. Long enough for the window manager to
 *  process the Z-order change, short enough that nobody perceives the window
 *  as "always on top". */
const TOPMOST_PIN_MS = 300;

/**
 * Un-minimise, show, raise, and focus a window. Safe to call with null, a
 * destroyed window, or a window that is already frontmost.
 *
 * Never clobbers a deliberate always-on-top state: if the caller (or a call
 * overlay) already pinned the window, the flag is left exactly as it was found.
 */
export function showAndFocusWindow(win: BrowserWindow | null | undefined): void {
    if (!win || win.isDestroyed()) return;

    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();

    const wasPinned = win.isAlwaysOnTop();
    if (!wasPinned) win.setAlwaysOnTop(true);
    win.moveTop();
    win.focus();

    // macOS: raising our own window isn't enough when another application owns
    // the foreground — the whole app has to be activated. `steal` is what makes
    // that work from a background process.
    if (process.platform === 'darwin') {
        try { app.focus({ steal: true }); } catch { /* not fatal */ }
    }

    if (!wasPinned) {
        setTimeout(() => {
            if (!win.isDestroyed()) win.setAlwaysOnTop(false);
        }, TOPMOST_PIN_MS);
    }
}
