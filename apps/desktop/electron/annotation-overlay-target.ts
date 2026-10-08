/**
 * WHERE the desktop annotation overlay goes (electron/annotation-overlay.ts):
 * which display a `screen:` share captures, and where a `window:` share's
 * window is. Pure and electron-free so all of it is unit tested
 * (annotation-overlay-target.test.ts); the Win32 reads come from the
 * audio_capture addon's window_geometry.cc and are injected.
 *
 * ── Which display? (owner bug: "annotations show up on a different monitor")
 *
 * A screen source is `screen:<id>:0`. What `<id>` means depends on the
 * capturer Chromium uses for the PICKER's enumeration on Windows:
 *
 *   - DXGI (DirectXCapturer enabled): ids are DXGI's output order, and
 *     Electron fills `display_id` with the matching `screen` module id
 *     (electron_api_desktop_capturer.cc, `if (using_directx_capturer_)` —
 *     DisplayIdFromMonitorInfo per GetDeviceNames entry). Matching on it is
 *     exact.
 *   - GDI / WGC (what Automatic picks on Windows 11 24H2+ since a4146169,
 *     which disables DirectXCapturer): `display_id` is EMPTY, and `<id>` is
 *     the EnumDisplayDevicesW adapter index (webrtc GetScreenList pushes
 *     `device_index` for each ACTIVE device; WgcScreenSource maps it back to a
 *     monitor through GetHmonitorFromDeviceIndex → GetScreenRect →
 *     MonitorFromRect).
 *
 * The old fallback indexed `screen.getAllDisplays()` with `<id>`. That list is
 * EnumDisplayMonitors order (ui/display/win/screen_win.cc
 * GetDisplayInfosFromSystem) — a different enumeration, with no defined
 * relation to the adapter index, and adapter indices are not even contiguous
 * (inactive entries are skipped but still counted). On a three-monitor desk
 * that is the wrong monitor more often than not. Nor can the id be
 * re-derived in JS: Chromium 150's display id is a hash of the DISPLAYCONFIG
 * adapter LUID + target id (display_info.cc DisplayIdFromMonitorInfo), which
 * no Electron API exposes.
 *
 * So the native addon answers the question webrtc itself answers — "what is
 * the physical rectangle of adapter index N?" — and we pick the Electron
 * display whose physical rectangle (`screen.dipToScreenRect`) covers it.
 * Physical rectangles are unique per monitor even when two monitors are the
 * same model and mode (the owner's two 1080x1920 portraits), and they are
 * immune to scale-factor and negative-origin layouts because no DIP
 * arithmetic is involved. With neither signal available we show NOTHING
 * rather than guess: a stroke on the wrong monitor is worse than none (the
 * in-app preview still shows every stroke).
 */
import type { Rect } from './annotation-overlay-projection';

export type { Rect };

/** `screen:<n>:<m>` → n. Null for anything else. */
export function parseScreenSourceIndex(sourceId: string): number | null {
    const m = /^screen:(\d{1,6}):\d{1,6}$/.exec(sourceId);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) ? n : null;
}

/**
 * `window:<hwnd>:<m>` → the decimal HWND string (passed to the addon as a
 * string: an HWND is pointer-sized and need not fit a double). Null for
 * anything else, including a zero handle.
 */
export function parseWindowSourceHandle(sourceId: string): string | null {
    const m = /^window:(\d{1,20}):\d{1,6}$/.exec(sourceId);
    if (!m) return null;
    const h = m[1].replace(/^0+/, '');
    if (!h) return null;
    // ≤ 2^64-1, the widest HWND on any Windows we ship.
    if (h.length === 20 && h > '18446744073709551615') return null;
    return h;
}

/** Validate a rectangle that crossed the native boundary. */
export function cleanRect(raw: unknown): Rect | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    const x = n(r.x), y = n(r.y), width = n(r.width), height = n(r.height);
    if ([x, y, width, height].some(Number.isNaN)) return null;
    if (!(width > 0) || !(height > 0)) return null;
    return { x, y, width, height };
}

function intersectionArea(a: Rect, b: Rect): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

export interface DisplayCandidate {
    id: number;
    /** DIP bounds (Electron's `Display.bounds`). */
    bounds: Rect;
    /** Physical desktop rectangle (`screen.dipToScreenRect(null, bounds)`,
     *  Windows only); null where the platform cannot say. */
    physical: Rect | null;
}

export type DisplayMatchHow = 'display-id' | 'monitor-rect' | 'only-display';

/** A monitor must cover at least this share of the captured rectangle. */
export const MIN_MONITOR_OVERLAP = 0.5;

/**
 * The display a screen share captures, or null when it cannot be known.
 *
 * `monitorRect` is the physical rectangle of the capture source's monitor
 * (window_geometry.cc getScreenRectFromDeviceIndex), null when the addon is
 * missing or predates it. Deliberately has NO "index into the display list"
 * fallback — see the header.
 */
export function resolveCapturedDisplay(opts: {
    displayId: string | null | undefined;
    displays: readonly DisplayCandidate[];
    monitorRect: Rect | null;
    /**
     * The same monitor rectangle converted to DIP by Chromium itself
     * (`screen.screenToDipRect(null, monitorRect)`), matched against each
     * display's DIP `bounds`. An independent second path for when the
     * physical one is unavailable (dipToScreenRect threw / is missing).
     */
    monitorDip?: Rect | null;
}): { id: number; how: DisplayMatchHow } | null {
    const { displays } = opts;
    if (opts.displayId) {
        const byId = displays.find(d => String(d.id) === String(opts.displayId));
        if (byId) return { id: byId.id, how: 'display-id' };
    }
    const best = (rect: Rect | null | undefined, pick: (d: DisplayCandidate) => Rect | null): DisplayCandidate | null => {
        if (!rect) return null;
        let found: DisplayCandidate | null = null;
        let bestArea = 0;
        for (const d of displays) {
            const r = pick(d);
            if (!r) continue;
            const a = intersectionArea(rect, r);
            if (a > bestArea) { found = d; bestArea = a; }
        }
        return found && bestArea >= MIN_MONITOR_OVERLAP * rect.width * rect.height ? found : null;
    };
    const byPhysical = best(opts.monitorRect, d => d.physical);
    if (byPhysical) return { id: byPhysical.id, how: 'monitor-rect' };
    const byDip = best(opts.monitorDip, d => d.bounds);
    if (byDip) return { id: byDip.id, how: 'monitor-rect' };
    if (displays.length === 1) return { id: displays[0].id, how: 'only-display' };
    return null;
}

// ── Linux ───────────────────────────────────────────────────────────────────

/**
 * Desktops whose window manager composites by default on X11. A transparent
 * BrowserWindow needs an ARGB visual, which only exists under a compositing
 * manager; without one Chromium paints the "transparent" window OPAQUE BLACK —
 * a display-sized black window over the whole shared screen (and, since X11
 * has no capture exclusion, inside the share too). Nothing in Electron
 * reports whether a compositor is running, so the overlay is offered only on
 * desktops that composite out of the box. Matched against each
 * colon-separated entry of XDG_CURRENT_DESKTOP, case-insensitively.
 */
export const LINUX_COMPOSITING_DESKTOPS: readonly string[] = [
    'gnome', 'ubuntu', 'kde', 'cinnamon', 'x-cinnamon', 'xfce', 'unity', 'budgie', 'pantheon', 'deepin', 'dde', 'cosmic',
];

/**
 * Whether the Linux desktop overlay may be shown in this session, or why not.
 *
 *   - `CIPHERLINE_ANNOT_OVERLAY=0` → off ('platform'); `=1` → on, skipping
 *     both checks below (a user who knows their compositor is running).
 *   - Wayland → 'wayland'. Under Wayland (Electron here runs with
 *     --ozone-platform-hint=auto, so it is a native Wayland client whenever
 *     WAYLAND_DISPLAY is set or the session says wayland) a client can
 *     neither choose its window's position nor keep it above other windows —
 *     xdg-shell has no such requests — so the overlay would land wherever the
 *     compositor placed it and strokes would be drawn in the wrong place.
 *     An explicit `--ozone-platform=x11` (XWayland) is treated as X11.
 *   - X11 on a desktop not in LINUX_COMPOSITING_DESKTOPS → 'no_compositor'.
 *
 * null = show it. Pure (env injected) so it is unit tested.
 */
export function linuxOverlayVerdict(opts: {
    env: Readonly<Record<string, string | undefined>>;
    /** `app.commandLine.getSwitchValue('ozone-platform')` ('' when unset). */
    ozonePlatform: string;
}): 'platform' | 'wayland' | 'no_compositor' | null {
    const { env } = opts;
    const force = (env.CIPHERLINE_ANNOT_OVERLAY ?? '').trim();
    if (force === '0') return 'platform';
    if (force === '1') return null;
    const ozone = opts.ozonePlatform.trim().toLowerCase();
    const waylandSession = (env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || !!env.WAYLAND_DISPLAY;
    if (ozone === 'wayland' || (ozone !== 'x11' && waylandSession)) return 'wayland';
    const desktops = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':').map(s => s.trim()).filter(Boolean);
    if (!desktops.some(d => LINUX_COMPOSITING_DESKTOPS.includes(d))) return 'no_compositor';
    return null;
}

// ── Window shares ───────────────────────────────────────────────────────────

/** What window_geometry.cc / window_geometry_mac.mm getWindowInfo reports, validated. */
export interface WindowInfo {
    exists: boolean;
    visible: boolean;
    minimized: boolean;
    /** DWM-cloaked: on another virtual desktop, or a suspended UWP app (always false on macOS). */
    cloaked: boolean;
    /** Windows: physical DWMWA_EXTENDED_FRAME_BOUNDS. macOS: kCGWindowBounds,
     *  global points (= Electron DIP there — see the macOS section). */
    frame: Rect | null;
}

export function cleanWindowInfo(raw: unknown): WindowInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.exists !== true) return { exists: false, visible: false, minimized: false, cloaked: false, frame: null };
    return {
        exists: true,
        visible: r.visible === true,
        minimized: r.minimized === true,
        cloaked: r.cloaked === true,
        frame: cleanRect(r.frame),
    };
}

export type WindowPlacement =
    /** The window is gone (closed): tear the overlay down. */
    | { action: 'close' }
    /** It exists but cannot be seen right now: hide, keep tracking. */
    | { action: 'hide' }
    /** Cover exactly this physical rectangle, stacked just above it. */
    | { action: 'show'; rect: Rect };

/**
 * Where the overlay goes for a window share, from one poll of the window.
 *
 * The overlay covers the window's extended frame bounds — the visible window
 * including its title bar but not the invisible resize border — because that
 * is the frame Windows.Graphics.Capture produces for a window, and strokes
 * are normalized to the captured frame. Unreadable info (addon error) is
 * treated as "hide", not "close": the share is still running.
 */
export function windowOverlayPlacement(info: WindowInfo | null): WindowPlacement {
    if (!info) return { action: 'hide' };
    if (!info.exists) return { action: 'close' };
    if (!info.visible || info.minimized || info.cloaked || !info.frame) return { action: 'hide' };
    return { action: 'show', rect: info.frame };
}

// ── macOS ─────────────────────────────────────────────────────────────────
//
// Coordinate model (macOS), the whole reason the mac path has no conversion:
//
//   - A `window:<id>:0` source's <id> is the CGWindowID (Chromium's macOS
//     window capturer enumerates CGWindowList; BrowserWindow.getMediaSourceId
//     produces the same form for our own windows).
//   - CGWindowListCopyWindowInfo's kCGWindowBounds is in GLOBAL POINTS with
//     the origin at the top-left of the PRIMARY display (the menu-bar screen),
//     y growing DOWN. A display arranged left of / above the primary has
//     negative x / y.
//   - Electron's screen space on macOS is the same space: Display.bounds,
//     BrowserWindow.getBounds/setBounds are points, top-left of the primary
//     display, y down (Electron flips to/from Cocoa's bottom-left origin
//     internally, against the primary screen's height).
//   - Points are scale-independent: a window on a 2x Retina panel and one on
//     a 1x external report the same kind of number, and the overlay's canvas
//     backing store follows the overlay's own devicePixelRatio
//     (annotation-overlay-projection.ts backingStoreSize).
//
// So a mac window frame goes to setBounds unchanged (macOverlayBounds only
// rounds to whole points, which is what an NSWindow frame snaps to anyway),
// and NO code of ours touches the Cocoa bottom-left origin or a backing
// scale factor. A screen share's display comes from `display_id`, which on
// macOS is the CGDirectDisplayID — exactly Electron's Display.id.

/**
 * Which native window-share backend this platform + addon can drive, or null
 * (window shares are then not overlaid: 'platform' off Windows/macOS,
 * 'addon_missing' when the addon lacks the calls).
 */
export function windowOverlayBackend(
    platform: string,
    native: { getWindowInfo?: unknown; placeOverlayAbove?: unknown; orderOverlayAbove?: unknown } | null | undefined,
): 'win' | 'mac' | null {
    if (!native || typeof native.getWindowInfo !== 'function') return null;
    if (platform === 'win32') return typeof native.placeOverlayAbove === 'function' ? 'win' : null;
    if (platform === 'darwin') return typeof native.orderOverlayAbove === 'function' ? 'mac' : null;
    return null;
}

/**
 * macOS: the overlay window's bounds for a shared window's CG frame — the
 * same rectangle (see the coordinate model above), in whole points. Edges are
 * rounded independently so a frame at fractional points is never shrunk by
 * more than half a point on any side.
 */
export function macOverlayBounds(frame: Rect): Rect {
    const left = Math.round(frame.x);
    const top = Math.round(frame.y);
    const right = Math.round(frame.x + frame.width);
    const bottom = Math.round(frame.y + frame.height);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function sameRect(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Window-share tracking cadence (main-process timer, never throttled). */
export const WINDOW_TRACK_INTERVAL_MS = 16;

/**
 * Screen shares: how often, at most, the topmost overlay re-asserts the top
 * of the z-order while strokes are arriving. A fullscreen game is usually a
 * TOPMOST window itself, and activating it lifts it above every other
 * topmost window — our overlay included — so a once-at-creation
 * setAlwaysOnTop is not enough.
 */
export const TOPMOST_REASSERT_MS = 500;

/** HWND from `BrowserWindow.getNativeWindowHandle()` as a decimal string. */
export function nativeHandleToDecimal(buf: Uint8Array): string | null {
    if (buf.length !== 8 && buf.length !== 4) return null;
    let v = 0n;
    for (let i = buf.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[i]);
    return v === 0n ? null : v.toString(10);
}
