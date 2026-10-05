/**
 * badge.ts — Cross-platform unread-count badge + taskbar flash.
 *
 * Platform behaviour:
 *   macOS:   app.dock.setBadge() shows a red circle with the number on the
 *            dock icon. Cleared by passing ''.
 *   Windows: BrowserWindow.setOverlayIcon() renders a small image in the
 *            bottom-right corner of the taskbar button.
 *   Linux:   app.setBadgeCount() works on Unity and some KDE/GNOME setups;
 *            silently no-ops on other desktops.
 *   All:     Tray tooltip is updated to "Cipherline · N unread".
 *
 * Flash behaviour (Windows only — others handle it natively):
 *   win.flashFrame(true) makes the taskbar button flash until the user
 *   activates the window. win.flashFrame(false) stops it.
 */

import * as zlib from 'zlib';
import { app, BrowserWindow, nativeImage } from 'electron';
import { setTrayBadgeIcon, getCallState } from './tray';

let currentCount = 0;

// ── Minimal pure-Node PNG encoder ─────────────────────────────────────────────
// nativeImage.createFromDataURL cannot decode SVG data URLs on Windows — the
// main-process Chromium image decoder only understands PNG/JPEG.  We build
// valid PNG buffers directly using only Node's built-in `zlib`.

const CRC_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        t[i] = c;
    }
    return t;
})();

function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeB = Buffer.from(type, 'ascii');
    const lenB  = Buffer.alloc(4);
    lenB.writeUInt32BE(data.length, 0);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
    return Buffer.concat([lenB, typeB, data, crcB]);
}

/**
 * Encode a solid-colour anti-aliased circle on a transparent background as
 * an RGBA PNG buffer.  Uses only Node's built-in `zlib` — no canvas or
 * native addons needed, works in the Electron main process on all platforms.
 *
 * @param size  Width and height in pixels (square image).
 * @param r     Circle radius in pixels.
 * @param fill  Opaque fill colour [R, G, B] 0–255.
 */
function buildCirclePng(
    size: number,
    r: number,
    fill: readonly [number, number, number],
): Buffer {
    const cx = size / 2, cy = size / 2;
    const rows: number[] = [];
    for (let y = 0; y < size; y++) {
        rows.push(0); // scanline filter byte: None
        for (let x = 0; x < size; x++) {
            const dx = x - cx + 0.5, dy = y - cy + 0.5;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // 1-pixel anti-aliased edge
            const alpha = dist <= r - 0.5 ? 255
                        : dist <  r + 0.5 ? Math.round((r + 0.5 - dist) * 255)
                        : 0;
            if (alpha > 0) rows.push(fill[0], fill[1], fill[2], alpha);
            else           rows.push(0, 0, 0, 0);
        }
    }
    const raw        = Buffer.from(rows);
    const compressed = zlib.deflateSync(raw);
    const ihdr       = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6; // bit-depth=8, color-type=RGBA
    const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([
        PNG_SIG,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Overlay icon builder ──────────────────────────────────────────────────────

function makeBadgeBuffer(): Buffer {
    return buildCirclePng(20, 9.5, [240, 71, 71]); // #F04747
}

// ── Call state overlay builder (Windows) ─────────────────────────────────────
// Amber for muted, purple for deafened. The tooltip ("Muted" / "Deafened")
// provides the accessible label; the colour provides the visual state at a glance.

function makeCallOverlayBuffer(state: 'muted' | 'deafened'): Buffer {
    const fill: readonly [number, number, number] =
        state === 'muted' ? [245, 158, 11] : [168, 85, 247]; // amber / purple
    return buildCirclePng(32, 15.5, fill);
}

// ── Overlay application (Windows) ────────────────────────────────────────────
// Every setOverlayIcon is a synchronous call into Explorer (ITaskbarList3), and
// the renderer pushes call state on EVERY speaking start/stop — several times a
// second in a lively call — although the overlay depends only on mute/deafen
// and the unread count. Identical repeats are skipped (per window), and the
// three PNGs are encoded once instead of on every push.
type OverlayKind = 'deafened' | 'muted' | 'unread' | 'none';
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
            png = kind === 'unread' ? makeBadgeBuffer() : makeCallOverlayBuffer(kind);
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
    trayRef?: { setToolTip: (s: string) => void } | null,
): void {
    currentCount = Math.max(0, count);

    // macOS dock badge
    if (process.platform === 'darwin') {
        try {
            app.dock?.setBadge(currentCount > 0 ? String(currentCount) : '');
        } catch {}
    }

    // Windows taskbar overlay icon — call states take priority over unread badge.
    if (process.platform === 'win32' && !win.isDestroyed()) {
        try {
            const cs = getCallState();
            if (cs.inCall && cs.isDeafened) {
                applyOverlay(win, 'deafened', 'Deafened');
            } else if (cs.inCall && cs.isMuted) {
                applyOverlay(win, 'muted', 'Muted');
            } else if (currentCount > 0) {
                applyOverlay(win, 'unread', `${currentCount} unread`);
            } else {
                applyOverlay(win, 'none', '');
            }
        } catch {}
    }

    // Linux Unity/GNOME badge
    if (process.platform === 'linux') {
        try { app.setBadgeCount(currentCount); } catch {}
    }

    // Tray tooltip
    if (trayRef) {
        try {
            const tip = currentCount > 0
                ? `Cipherline · ${currentCount} unread`
                : 'Cipherline';
            trayRef.setToolTip(tip);
        } catch {}
    }

    // Tray icon: swap to badge variant when unreads present.
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
                    try { win.flashFrame(false); } catch {}
                });
            }
        }
    } catch {}
}

/**
 * Re-apply the Windows taskbar overlay when call state changes (mute/deafen
 * toggle). Call state is already stored in tray.ts via setTrayCallState before
 * this is called, so getCallState() reflects the new values.
 */
export function applyWindowsCallOverlay(win: BrowserWindow): void {
    if (process.platform !== 'win32' || win.isDestroyed()) return;
    try {
        const cs = getCallState();
        if (cs.inCall && cs.isDeafened) {
            applyOverlay(win, 'deafened', 'Deafened');
        } else if (cs.inCall && cs.isMuted) {
            applyOverlay(win, 'muted', 'Muted');
        } else if (cs.inCall) {
            applyOverlay(win, 'none', '');
        } else if (currentCount > 0) {
            applyOverlay(win, 'unread', `${currentCount} unread`);
        } else {
            applyOverlay(win, 'none', '');
        }
    } catch {}
}

export function getCurrentBadgeCount(): number {
    return currentCount;
}
