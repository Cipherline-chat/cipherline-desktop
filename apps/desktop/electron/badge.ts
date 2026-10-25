/**
 * badge.ts — Cross-platform unread-count badge + taskbar flash.
 *
 * Platform behaviour:
 *   macOS:   app.dock.setBadge() shows a red circle with the number on the
 *            dock icon. Cleared by passing ''.
 *   Windows: BrowserWindow.setOverlayIcon() renders a small image in the
 *            bottom-right corner of the taskbar button. ONE glyph at a time:
 *            @mention > deafened > muted > unread dot > nothing (the choice
 *            and the pixels live in overlay-glyphs.ts).
 *   Linux:   app.setBadgeCount() works on Unity and some KDE/GNOME setups;
 *            silently no-ops on other desktops.
 *   All:     Tray tooltip is updated to "Cipherline · N unread".
 *
 * Flash behaviour (Windows only — others handle it natively):
 *   win.flashFrame(true) makes the taskbar button flash until the user
 *   activates the window. win.flashFrame(false) stops it.
 */

import { app, BrowserWindow, nativeImage } from 'electron';
import { setTrayBadgeIcon, getCallState } from './tray';
import { buildOverlayPng, resolveOverlay, type OverlayKind } from './overlay-glyphs';

let currentCount = 0;
let currentMention = false;

// ── Overlay application (Windows) ────────────────────────────────────────────
// Every setOverlayIcon is a synchronous call into Explorer (ITaskbarList3), and
// the renderer pushes call state on EVERY speaking start/stop — several times a
// second in a lively call — although the overlay depends only on mute/deafen,
// the unread count and whether an @mention is pending. Identical repeats are
// skipped (per window), and each PNG is encoded once instead of on every push.
// Re-applied anyway after OVERLAY_REFRESH_MS, so an overlay Explorer dropped
// (e.g. explorer.exe restarted) comes back on the next push.
const OVERLAY_REFRESH_MS = 30_000;
const lastOverlay = new WeakMap<BrowserWindow, { key: string; at: number }>();
const overlayPng = new Map<OverlayKind, Buffer>();

function applyOverlay(win: BrowserWindow, kind: OverlayKind, description: string): void {
    const key = `${kind}|${description}`;
    const prev = lastOverlay.get(win);
    if (prev && prev.key === key && Date.now() - prev.at < OVERLAY_REFRESH_MS) return;
    if (kind === 'none') {
        win.setOverlayIcon(null, '');
    } else {
        let png = overlayPng.get(kind);
        if (!png) {
            png = buildOverlayPng(kind);
            overlayPng.set(kind, png);
        }
        win.setOverlayIcon(nativeImage.createFromBuffer(png), description);
    }
    lastOverlay.set(win, { key, at: Date.now() });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Update the unread badge everywhere: dock (macOS), taskbar overlay (Windows),
 * app badge count (Linux), and tray tooltip (all platforms).
 */
export function setBadgeCount(
    win: BrowserWindow,
    count: number,
    hasMention?: boolean,
): void {
    currentCount = Math.max(0, count);
    // Several IPC channels end up here; only the ones that know about mentions
    // pass the flag, and the rest must not clear it.
    if (hasMention !== undefined) currentMention = hasMention;

    // macOS dock badge
    if (process.platform === 'darwin') {
        try {
            app.dock?.setBadge(currentCount > 0 ? String(currentCount) : '');
        } catch { /* best-effort; failure is non-fatal and intentionally ignored */ }
    }

    // Windows taskbar overlay icon: one glyph, mention > deafened > muted > unread.
    syncWindowsOverlay(win);

    // Linux Unity/GNOME badge
    if (process.platform === 'linux') {
        try { app.setBadgeCount(currentCount); } catch { /* OS badge / taskbar flash is cosmetic; failure is non-fatal */ }
    }

    // Tray icon AND tooltip ("Cipherline · N unread", or the call state, which
    // outranks it): tray.ts owns both and sends only what changed. This used
    // to set the tooltip here too — a second Shell_NotifyIcon round trip per
    // unread change that tray.ts then immediately overwrote.
    // setTrayBadgeIcon is a no-op when the tray isn't enabled.
    setTrayBadgeIcon(currentCount);
}

/**
 * Flash the Windows taskbar button until the user activates the window.
 * No-op on macOS/Linux (they handle urgency differently).
 */
// P2-ELEC-20: guard prevents stacking one once('focus') per notification.
let _flashPending = false;

export function flashTaskbar(win: BrowserWindow): void {
    if (process.platform !== 'win32') return;
    try {
        if (!win.isDestroyed() && !win.isFocused()) {
            win.flashFrame(true);
            if (!_flashPending) {
                _flashPending = true;
                win.once('focus', () => {
                    _flashPending = false;
                    try { win.flashFrame(false); } catch { /* OS badge / taskbar flash is cosmetic; failure is non-fatal */ }
                });
            }
        }
    } catch { /* teardown is best-effort; the node/handle may already be closed */ }
}

/**
 * Re-apply the Windows taskbar overlay from the current call state, unread
 * count and mention flag. Call state is stored in tray.ts via setTrayCallState
 * before this runs, so getCallState() reflects the new values. Unchanged
 * results never reach Explorer (see applyOverlay).
 */
function syncWindowsOverlay(win: BrowserWindow): void {
    if (process.platform !== 'win32' || win.isDestroyed()) return;
    try {
        const cs = getCallState();
        const { kind, description } = resolveOverlay({
            inCall: cs.inCall,
            isDeafened: cs.isDeafened,
            isMuted: cs.isMuted,
            hasMention: currentMention,
            unreadCount: currentCount,
        });
        applyOverlay(win, kind, description);
    } catch { /* best-effort; failure is non-fatal and intentionally ignored */ }
}

/** Re-apply the overlay when call state changes (mute/deafen toggle). */
export function applyWindowsCallOverlay(win: BrowserWindow): void {
    syncWindowsOverlay(win);
}

export function getCurrentBadgeCount(): number {
    return currentCount;
}
