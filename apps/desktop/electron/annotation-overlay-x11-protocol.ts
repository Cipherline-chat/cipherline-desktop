/**
 * Pure half of the X11 annotation overlay's run-time checks (electron/annotation-overlay-x11.ts):
 * parsing what the native helper prints in its plain-X11 modes (src-native/wayland_overlay/
 * x11_probe.inc: `--x11-probe` / `--x11-watch`) and turning the shared window's rectangle
 * from X's physical pixels into Electron's DIP. Electron-free so it is all unit tested
 * (annotation-overlay-x11.test.ts).
 *
 * Nothing the helper prints is trusted beyond "exactly well-formed": anything else is ignored.
 */
import type { Rect } from './annotation-overlay-projection';
import type { WindowInfo } from './annotation-overlay-target';

export type X11WindowState = 'ok' | 'unmapped' | 'minimized' | 'workspace' | 'gone';
const STATES: readonly X11WindowState[] = ['ok', 'unmapped', 'minimized', 'workspace', 'gone'];

export type X11HelperEvent =
    | { kind: 'hello' }
    | { kind: 'ready' }
    /** A compositing manager owns `_NET_WM_CM_S<screen>`. */
    | { kind: 'cm'; compositor: boolean }
    | { kind: 'win'; state: X11WindowState; frame: Rect | null }
    | { kind: 'err'; code: string };

const COORD_LIMIT = 1 << 20;

export function parseX11HelperLine(line: string): X11HelperEvent | null {
    const t = line.trim();
    if (t.length === 0 || t.length > 200) return null;
    if (/^HELLO \d{1,6}$/.test(t)) return { kind: 'hello' };
    if (t === 'READY x11_watch=1') return { kind: 'ready' };
    const cm = /^CM ([01])$/.exec(t);
    if (cm) return { kind: 'cm', compositor: cm[1] === '1' };
    const err = /^ERR ([a-z0-9_]{1,40})$/.exec(t);
    if (err) return { kind: 'err', code: err[1] };
    const w = /^W ([a-z]{2,12}) (-?\d{1,9}) (-?\d{1,9}) (\d{1,9}) (\d{1,9})$/.exec(t);
    if (w) {
        const state = STATES.find(s => s === w[1]);
        if (!state) return null;
        const [x, y, width, height] = [Number(w[2]), Number(w[3]), Number(w[4]), Number(w[5])];
        if (state !== 'ok') return { kind: 'win', state, frame: null };
        if (Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT || width < 1 || height < 1 || width > COORD_LIMIT || height > COORD_LIMIT) return null;
        return { kind: 'win', state, frame: { x, y, width, height } };
    }
    return null;
}

/**
 * `window:<XID>:<n>` → the decimal XID. An XID is a 32-bit id on the wire (29 bits in practice);
 * zero and anything wider are not one. Null for anything else.
 */
export function parseX11WindowId(sourceId: string): string | null {
    const m = /^window:(\d{1,10}):\d{1,6}$/.exec(sourceId);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) && n > 0 && n <= 0xFFFFFFFF ? String(n) : null;
}

/**
 * The helper's window state as the same `WindowInfo` the Windows / macOS backends report, so
 * `windowOverlayPlacement` decides close / hide / show for X11 exactly as it does there.
 * Unmapped, minimized and other-workspace all mean "exists but cannot be seen": hide, keep tracking.
 */
export function x11WindowInfo(state: X11WindowState | null, frame: Rect | null): WindowInfo | null {
    if (!state) return null;
    if (state === 'gone') return { exists: false, visible: false, minimized: false, cloaked: false, frame: null };
    return {
        exists: true,
        visible: state === 'ok',
        minimized: state === 'minimized' || state === 'unmapped',
        cloaked: state === 'workspace',
        frame: state === 'ok' ? frame : null,
    };
}

/**
 * A rectangle in X's root coordinates (physical pixels) → Electron DIP on X11.
 *
 * Chromium on X11 has ONE device scale factor for the whole desktop (display.bounds is the
 * physical RootWindow geometry divided by it), so DIP = px / scale for every display. Edges are
 * rounded independently, so a fractional scale never shrinks the frame by more than half a DIP.
 * A non-finite or non-positive scale is treated as 1.
 */
export function x11FrameToDip(frame: Rect, scaleFactor: number): Rect {
    const s = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    const left = Math.round(frame.x / s);
    const top = Math.round(frame.y / s);
    const right = Math.round((frame.x + frame.width) / s);
    const bottom = Math.round((frame.y + frame.height) / s);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
