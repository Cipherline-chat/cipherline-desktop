/**
 * Desktop annotation overlay (docs/video-annotation-design.md, Phase 5).
 *
 * While the local user shares a whole SCREEN, a transparent, click-through,
 * always-on-top window the exact size of that display renders the same
 * strokes the in-app preview tile shows — so the streamer sees what viewers
 * are pointing at over their actual work, not just inside Cipherline. While
 * they share a single WINDOW (Windows and macOS), the overlay instead covers
 * that window's frame and is stacked directly above it, following it as it
 * moves, resizes, minimizes or goes behind other windows.
 *
 * Guarantees, in order of importance:
 *  - On Windows and macOS it never captures itself into the share:
 *    `setContentProtection(true)` excludes the window from capture
 *    (WDA_EXCLUDEFROMCAPTURE / NSWindowSharingNone).
 *  - LINUX (owner decision 2026-10-08): X11 and Wayland have no per-window
 *    capture exclusion, so on Linux the overlay IS captured into the share.
 *    It is shown anyway — the streamer sees the strokes where they are — and
 *    the show result says `captured: true`; the renderer then publishes that
 *    on the participant (utils/annotationOverlayCapture.ts) so viewers stop
 *    drawing OTHER people's strokes over a video that already contains them
 *    (their own stay, as an instant local echo). Screens on X11 and Wayland;
 *    single WINDOWS on X11 only (a Wayland/portal share exposes no window
 *    position to anyone).
 *      - X11: an Electron window, shown only while a compositing manager is
 *        RUNNING (a transparent window without one paints BLACK over the whole
 *        display, into the share). That is asked of the X server at run time
 *        (an owner of `_NET_WM_CM_S<n>`, annotation-overlay-x11.ts) — not
 *        guessed from the desktop's name, which cannot tell whether XFCE's
 *        compositing is on or KDE has suspended it — and re-checked while the
 *        overlay is up: when the compositor goes away mid-share the overlay is
 *        taken down at once and the renderer is told (`annot-overlay:ended`),
 *        so it is reported like any other refusal; the next stroke shows it
 *        again once the compositor is back. The desktop-name list is only the
 *        fallback for a build / session where the probe cannot run. A window
 *        share is placed on the window's frame as the helper reports it
 *        (moves, resizes, minimize, other workspace, close).
 *      - WAYLAND: a client can neither position a window nor keep it above
 *        others, so an Electron window cannot do it — a small native helper
 *        (src-native/wayland_overlay, driven by annotation-overlay-wayland.ts)
 *        draws it instead: a wlr-layer-shell OVERLAY-layer surface on KWin,
 *        Sway, Hyprland, other wlroots desktops and COSMIC, or an XWayland
 *        override-redirect window on GNOME's Mutter (no layer-shell). Whole
 *        screens only; WHICH output is matched by the shared frame's size; with
 *        several identical screens the SHARER is asked once per share
 *        (`needs_choice`), never guessed. A build without the helper keeps the old
 *        refusal ('wayland').
 *    CIPHERLINE_ANNOT_OVERLAY=1 / 0 overrides the X11 checks either way — see
 *    linuxOverlayVerdict.
 *  - It never takes input: `setIgnoreMouseEvents(true)` + `focusable: false`.
 *    Right-click, drag, type — everything falls through to whatever is
 *    underneath.
 *  - Renderer page is inert: a bare <canvas> under `default-src 'none'`. All
 *    drawing logic lives in the sandboxed preload, which only ever receives
 *    stroke deltas from the main process.
 *  - Window shares need another app's window bounds and z-order, which
 *    Electron cannot read: they come from the audio_capture addon —
 *    src-native/window_geometry.cc on Windows (read-only queries, plus
 *    SetWindowPos on OUR overlay window only, refused for any window of
 *    another process) and src-native/window_geometry_mac.mm on macOS
 *    (CGWindowListCopyWindowInfo reads, plus orderWindow:relativeTo: on OUR
 *    overlay NSWindow only). No addon (or a build that predates it) or Linux:
 *    window shares are not overlaid; the in-app preview still shows every
 *    stroke. See windowOverlayBackend in annotation-overlay-target.ts.
 *  - WHICH display a screen share captures is resolved in
 *    annotation-overlay-target.ts — the physical monitor rectangle from the
 *    addon, never the old "index into getAllDisplays()" guess, which put
 *    strokes on the wrong monitor once DXGI enumeration was turned off.
 *  - Fullscreen games: the screen overlay is a TOPMOST window, so it draws
 *    over borderless / "fullscreen optimized" games (the common case on
 *    Windows 10/11), re-asserting the top of the z-order while strokes arrive
 *    because a fullscreen game is usually topmost itself and rises above us
 *    when activated. It cannot draw over true EXCLUSIVE fullscreen (the game
 *    owns the output; only an in-process hook could, and injecting into a
 *    game is an anti-cheat ban risk we will not take).
 *
 * Coordinates: strokes are normalized to the captured frame ([0,1]²), and a
 * screen capture's frame IS the display — taskbar included. So the canvas is
 * laid out against the DISPLAY's bounds, which the main process owns and
 * pushes over `annot-overlay:geometry`. (A window capture's frame is the
 * window's extended frame bounds, and the overlay window is placed exactly
 * there, so its canvas simply fills it.)
 *
 * It is emphatically NOT laid out against `window.innerWidth/innerHeight`.
 * That was the original bug: the overlay window's client box is a different
 * rectangle, nothing tied the two together, and when a compositor handed back
 * a work-area-sized client box (1920x1032 for a 1920x1080 display with a 48px
 * taskbar) every stroke was silently rescaled — landing 24px high at
 * mid-screen and 48px high at the bottom, correct only along the very top
 * edge. See annotation-overlay-projection.ts for the arithmetic and its
 * suite.
 */
import { app, BrowserWindow, screen, type DesktopCapturerSource, type Display } from 'electron';
import * as fs from 'fs';
import { spawn, execFile } from 'child_process';

/** What the overlay needs from a picker source (in-process or helper-listed). */
export type OverlaySource = Pick<DesktopCapturerSource, 'id' | 'display_id'>;
import * as path from 'path';
// Wire shape shared with the renderer (src/utils/desktopAnnotationOverlay.ts)
// — kept in a dependency-free module so neither side pulls in the other's
// runtime deps (electron here, livekit-client there) just to see the type.
// No `tool` on a stroke: the laser is the only one, and the overlay's own
// renderer never read the field even when there were two.
import type { OverlayDelta, OverlayShowResult, OverlayRefusal } from '../src/utils/annotationOverlayTypes';
export type { OverlayPoint, OverlayStroke, OverlayDelta, OverlayShowResult, OverlayRefusal } from '../src/utils/annotationOverlayTypes';
import { lockPageZoom } from './page-zoom-lock';
import { createWaylandRefreshProbe, type WaylandRefreshProbe } from './wayland-refresh';
import { createWaylandOverlay, type WaylandOverlay, type HelperProc } from './annotation-overlay-wayland';
import { cleanFrameHint, cleanDisplayChoice, cleanShowHint } from './annotation-overlay-wayland-protocol';
import { isNativeWaylandClient } from './capture-flags';
import { writePrivatePage, type PrivatePage } from './private-page-file';
import { overlayCanvasLayout, type OverlayCanvasLayout, type Rect } from './annotation-overlay-projection';
import {
    resolveCapturedDisplay, parseScreenSourceIndex, parseWindowSourceHandle, cleanRect,
    cleanWindowInfo, windowOverlayPlacement, nativeHandleToDecimal, linuxOverlayVerdict,
    windowOverlayBackend, macOverlayBounds, sameRect, shouldProbeX11Compositor, x11WindowShareAllowed,
    WINDOW_TRACK_INTERVAL_MS, TOPMOST_REASSERT_MS, type DisplayCandidate,
} from './annotation-overlay-target';
import { createX11CompositorProbe, createX11Watcher, type X11CompositorProbe, type X11Watcher, type X11WindowReport } from './annotation-overlay-x11';
import { parseX11WindowId, x11WindowInfo, x11FrameToDip } from './annotation-overlay-x11-protocol';

/** The addon functions this module uses (src-native/window_geometry.cc on
 *  Windows, src-native/window_geometry_mac.mm on macOS). */
export interface AnnotationOverlayNative {
    /** Windows only. */
    getScreenRectFromDeviceIndex?: (index: number) => unknown;
    /** Windows: HWND; macOS: CGWindowID. Both as decimal strings. */
    getWindowInfo?: (hwnd: string) => unknown;
    /** Windows only: move/size (physical px) and stack above the target. */
    placeOverlayAbove?: (overlayHwnd: string, targetHwnd: string, x: number, y: number, width: number, height: number) => unknown;
    /** macOS only: stack our overlay (NSView* handle) directly above the target CGWindowID. */
    orderOverlayAbove?: (overlayHandle: string, targetWindowId: string) => unknown;
}
let native: AnnotationOverlayNative | null = null;

/**
 * Hand over the loaded audio_capture addon (main.ts, after app ready). Only
 * functions are picked up, so an addon built before window_geometry.cc simply
 * lacks them — screen shares then resolve by `display_id` / single display
 * only, and window shares are not overlaid.
 */
export function setAnnotationOverlayNative(addon: unknown): void {
    if (!addon || typeof addon !== 'object') { native = null; return; }
    const a = addon as Record<string, unknown>;
    const fn = <T>(k: string): T | undefined => (typeof a[k] === 'function' ? (a[k] as T) : undefined);
    native = {
        getScreenRectFromDeviceIndex: fn('getScreenRectFromDeviceIndex'),
        getWindowInfo: fn('getWindowInfo'),
        placeOverlayAbove: fn('placeOverlayAbove'),
        orderOverlayAbove: fn('orderOverlayAbove'),
    };
}

/** What the overlay is laid over. `hwnd` is the platform window id: an HWND
 *  on Windows, a CGWindowID on macOS (decimal strings, from `window:<id>:0`). */
type OverlayTarget =
    | { kind: 'screen'; displayId: number }
    | { kind: 'window'; hwnd: string };

let overlay: BrowserWindow | null = null;
let target: OverlayTarget | null = null;
/** Screen shares: the rectangle strokes are normalized against — the
 *  captured display's bounds, in DIP. The projection is driven by THIS,
 *  never by whatever client box the compositor ends up giving the window.
 *  Null for window shares (the window IS the captured frame). */
let captureRect: Rect | null = null;
let overlayHwnd: string | null = null;
let overlayReady = false;
let queued: OverlayDelta[] = [];
let listenersBound = false;
let trackTimer: ReturnType<typeof setInterval> | null = null;
let lastRaiseAt = 0;
let lastLayoutKey = '';

const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Cipherline annotations</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}canvas{position:fixed;left:0;top:0;display:block}</style>
</head><body><canvas id="c" aria-hidden="true"></canvas></body></html>`;

/** Electron's displays with their PHYSICAL rectangles (Windows). */
function displayCandidates(displays: Display[]): DisplayCandidate[] {
    return displays.map(d => {
        let physical: Rect | null = null;
        if (process.platform === 'win32') {
            try { physical = cleanRect(screen.dipToScreenRect(null, d.bounds)); } catch { physical = null; }
        }
        return { id: d.id, bounds: d.bounds, physical };
    });
}

/** Map a `screen:` capture source to the Display it captures (see
 *  annotation-overlay-target.ts for why this is not an index lookup). */
function displayForSource(source: OverlaySource): { display: Display; how: string } | { refused: OverlayShowResult } {
    const displays = screen.getAllDisplays();
    let monitorRect: Rect | null = null;
    let monitorDip: Rect | null = null;
    const index = parseScreenSourceIndex(source.id);
    if (process.platform === 'win32' && index != null && native?.getScreenRectFromDeviceIndex) {
        try { monitorRect = cleanRect(native.getScreenRectFromDeviceIndex(index)); } catch { monitorRect = null; }
        // Second, independent signal: Chromium's own physical->DIP mapping of
        // that rectangle, compared with each display's DIP bounds. Agrees with
        // the physical match whenever both are available; covers the case
        // where dipToScreenRect is unavailable or throws.
        if (monitorRect) {
            try { monitorDip = cleanRect(screen.screenToDipRect(null, monitorRect)); } catch { monitorDip = null; }
        }
    }
    const r = resolveCapturedDisplay({ displayId: source.display_id, displays: displayCandidates(displays), monitorRect, monitorDip });
    if (!r) {
        const addon = !!native?.getScreenRectFromDeviceIndex;
        const hint = addon ? '' : ' (audio_capture addon predates window_geometry: run "npm run rebuild-native")';
        console.warn(`[annot-overlay] cannot tell which of ${displays.length} displays ${source.id} captures${hint}; monitorRect=${JSON.stringify(monitorRect)}; desktop overlay off for this share, in-app preview unaffected`);
        return { refused: { ok: false, reason: 'no_display_match', displays: displays.length, addon: process.platform === 'win32' ? addon : undefined } };
    }
    console.log(`[annot-overlay] ${source.id} -> display ${r.id} (${r.how})`);
    const display = displays.find(d => d.id === r.id);
    if (!display) return { refused: { ok: false, reason: 'no_display_match', displays: displays.length } };
    return { display, how: r.how };
}

function bindScreenListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    screen.on('display-removed', (_e, d) => {
        if (overlay && target?.kind === 'screen' && target.displayId === d.id) hideAnnotationOverlay();
    });
    screen.on('display-metrics-changed', (_e, d) => {
        if (overlay && target?.kind === 'screen' && target.displayId === d.id) {
            // The display resized / changed scale factor, so the captured
            // frame did too. Re-point the capture rect FIRST, then let
            // syncGeometry move the window and re-lay the canvas; sending the
            // new layout is what the old code missed (it moved the window and
            // relied on a `resize` event reaching the page).
            captureRect = d.bounds;
            syncGeometry();
        }
    });
}

function send(delta: OverlayDelta): void {
    if (!overlay || overlay.isDestroyed()) return;
    try { overlay.webContents.send('annot-overlay:delta', delta); } catch { /* closing */ }
}

/**
 * Pin the window to the capture rect and tell the preload where to lay its
 * canvas.
 *
 * Screen shares — both halves matter. `setContentBounds` re-asserts the size
 * we asked for — a frameless always-on-top window sized to a whole display is
 * exactly the shape a compositor is most tempted to "help" with (work-area
 * clamping, maximize treatment, DPI rounding), and the ask is cheap. Then the
 * layout is computed against whatever we ACTUALLY got, so if the window is
 * still not the display's size the strokes are shifted back onto the right
 * screen pixels rather than silently rescaled into the wrong box.
 *
 * Window shares — the addon placed the window on the captured frame in
 * physical pixels, so the canvas fills the client area exactly. Never
 * setContentBounds here: that would fight the native placement with a DIP
 * rectangle that is ambiguous across monitors of different scale.
 *
 * `getContentBounds()` is the client area — the same rectangle the page's
 * viewport covers — which is what the canvas is positioned inside. The
 * layout is only re-sent when it changed (window tracking calls this at
 * WINDOW_TRACK_INTERVAL_MS).
 */
function syncGeometry(): void {
    const win = overlay;
    if (!win || win.isDestroyed() || !target) return;
    let layout: OverlayCanvasLayout;
    if (target.kind === 'window') {
        let content: Rect;
        try { content = win.getContentBounds(); } catch { return; }
        layout = overlayCanvasLayout(content, content);
    } else {
        const capture = captureRect;
        if (!capture) return;
        try {
            const have = win.getContentBounds();
            if (have.x !== capture.x || have.y !== capture.y
                || have.width !== capture.width || have.height !== capture.height) {
                win.setContentBounds(capture);
            }
        } catch { /* window may be going away */ }
        let content: Rect;
        try { content = win.getContentBounds(); } catch { return; }
        layout = overlayCanvasLayout(capture, content);
    }
    const key = `${layout.cssLeft},${layout.cssTop},${layout.cssWidth},${layout.cssHeight}`;
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    try { win.webContents.send('annot-overlay:geometry', layout); } catch { /* closing */ }
}

/**
 * Window shares: one poll of the shared window, on a main-process timer —
 * never throttled, whatever state Cipherline's own window is in. Follows
 * moves and resizes, hides while the window is minimized / hidden / on
 * another virtual desktop, closes when it is gone, and keeps the overlay
 * stacked directly above it so a window covering the shared one also covers
 * the strokes.
 */
function trackWindow(): void {
    if (process.platform === 'linux') { trackX11Window(); return; }
    const win = overlay;
    const t = target;
    const n = native;
    const backend = windowOverlayBackend(process.platform, n);
    if (!win || win.isDestroyed() || t?.kind !== 'window' || !n?.getWindowInfo || !backend) return;
    let raw: unknown = null;
    try { raw = n.getWindowInfo(t.hwnd); } catch { raw = null; }
    const p = windowOverlayPlacement(cleanWindowInfo(raw));
    if (p.action === 'close') { hideAnnotationOverlay(); return; }
    if (p.action === 'hide') {
        try { if (win.isVisible()) win.hide(); } catch { /* closing */ }
        return;
    }
    if (!overlayReady || !overlayHwnd) return;
    if (backend === 'mac') {
        // macOS: the frame is already in Electron's coordinate space (global
        // points, top-left origin — see window_geometry_mac.mm), so Electron
        // positions the window and owns the Cocoa bottom-left flip; the addon
        // only stacks it. Bounds BEFORE the show, so it never appears at the
        // previous spot for a frame.
        const want = macOverlayBounds(p.rect);
        try { if (!sameRect(win.getBounds(), want)) win.setBounds(want); } catch { return; }
        try { if (!win.isVisible()) win.showInactive(); } catch { return; }
        try { n.orderOverlayAbove!(overlayHwnd, t.hwnd); } catch { /* ignore */ }
        syncGeometry();
        return;
    }
    try { if (!win.isVisible()) win.showInactive(); } catch { return; }
    // Same tick as the show, so it is never composited out of place.
    try { n.placeOverlayAbove!(overlayHwnd, t.hwnd, p.rect.x, p.rect.y, p.rect.width, p.rect.height); } catch { /* ignore */ }
    syncGeometry();
}

function startTracking(): void {
    stopTracking();
    trackTimer = setInterval(trackWindow, WINDOW_TRACK_INTERVAL_MS);
}

function stopTracking(): void {
    if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
}

/**
 * Show (or move) the overlay over what `source` captures. Resolves to a
 * refusal (with a reason enum for the call event log) when there is nothing
 * to overlay: unknown display, a window share without the addon / off
 * Windows, Wayland, an X11 desktop not known to composite. The caller then
 * keeps the in-app preview only.
 */
export function showAnnotationOverlay(source: OverlaySource, frameHint?: unknown, chosenDisplay?: unknown, showHint?: unknown): OverlayShowResult | Promise<OverlayShowResult> {
    const kind = source.id.startsWith('screen:') ? 'screen' : source.id.startsWith('window:') ? 'window' : null;
    if (!kind) return refuse('bad_source');
    const proceed = (): OverlayShowResult | Promise<OverlayShowResult> => {
        // Wayland: the helper draws it (see waylandOverlay()); a window share was refused above.
        if (kind === 'screen' && shouldUseWaylandHelper()) return waylandOverlay().show(source, cleanFrameHint(frameHint), cleanDisplayChoice(chosenDisplay), cleanShowHint(showHint));
        if (kind === 'window') return process.platform === 'linux' ? showForX11Window(source) : showForWindow(source);
        return showForScreen(source);
    };
    const pre = annotationOverlayPrecheck(kind);
    // Synchronous everywhere except a Linux X11 session with no fresh compositor answer yet (a Promise then).
    if (pre instanceof Promise) return pre.then(r => r ?? proceed());
    if (pre) return pre;
    return proceed();
}

// ── Linux / X11: run-time compositor check + window shares ──────────────────
//
// Both come from the native helper's plain-X11 modes (annotation-overlay-x11.ts). The helper
// binary is the Wayland overlay's (waylandOverlayHelperPath below); these modes never touch Wayland.

/** Called when the overlay was taken down by something other than the renderer asking (see setAnnotationOverlayEndedListener). */
let endedListener: ((reason: 'no_compositor') => void) | null = null;

/**
 * main.ts hands over a callback that tells the renderer the overlay is gone and why, so the
 * share's status reads "off: no compositor" (the same refusal, and the same viewer notice, as
 * when the overlay is refused at the start) and its next stroke tries again.
 */
export function setAnnotationOverlayEndedListener(cb: ((reason: 'no_compositor') => void) | null): void {
    endedListener = cb;
}

let x11Watcher: X11Watcher | null = null;
let x11Win: X11WindowReport | null = null;

let x11ProbeInstance: X11CompositorProbe | null = null;
/**
 * true / false = a compositing manager is / is not running on this X server; null = could not ask.
 * One-shot `--x11-probe`, run ASYNCHRONOUSLY (execFile with a deadline: a synchronous child process on the
 * main thread is banned in electron/); peek() answers without a Promise whenever a fresh answer is cached.
 */
function x11Probe(): X11CompositorProbe {
    return (x11ProbeInstance ??= createX11CompositorProbe({
        available: () => waylandOverlayHelperPath() !== null,
        run: () => new Promise<string | null>(resolve => {
            const bin = waylandOverlayHelperPath();
            if (!bin) { resolve(null); return; }
            try {
                // A non-zero exit still carries the helper's own `ERR <code>` line on stdout, which is what gets logged.
                execFile(bin, ['--x11-probe'], { env: waylandHelperEnv(), timeout: 1500, encoding: 'utf8', maxBuffer: 4096 },
                    (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : null));
            } catch { resolve(null); }
        }),
        now: () => Date.now(),
        log: (m) => console.warn(m),
    }));
}

/** Chromium on X11 has one device scale factor for the whole desktop (see x11FrameToDip). */
function x11ScaleFactor(): number {
    try { return screen.getPrimaryDisplay().scaleFactor || 1; } catch { return 1; }
}

function makeX11Watcher(watchCompositor: boolean): X11Watcher {
    const self: X11Watcher = createX11Watcher({
        spawnHelper: () => {
            const bin = waylandOverlayHelperPath();
            if (!bin) return null;
            try {
                return spawn(bin, ['--x11-watch'], { stdio: ['pipe', 'pipe', 'ignore'], env: waylandHelperEnv() }) as unknown as HelperProc;
            } catch { return null; }
        },
        log: (m) => console.log(m),
    }, {
        onCompositor: (compositor) => {
            if (x11Watcher !== self || !watchCompositor || compositor) return;
            // The compositor went away mid-share: from this moment a transparent window paints black
            // over the shared screen (and into it). Take the overlay down NOW and say so.
            console.warn('[annot-overlay] the X11 compositing manager stopped; desktop overlay taken down (a transparent window would paint black over the share)');
            hideAnnotationOverlay();
            endedListener?.('no_compositor');
        },
        onWindow: (report) => {
            if (x11Watcher !== self) return;
            x11Win = report;
            if (target?.kind === 'window') trackX11Window();
        },
        onLost: () => { if (x11Watcher === self) x11Watcher = null; },
    });
    return self;
}

function stopX11Watcher(): void {
    const w = x11Watcher;
    x11Watcher = null;
    x11Win = null;
    w?.stop();
}

/**
 * Screen share on X11: watch the compositor for as long as the overlay is up. (A window share
 * starts its watcher in showForX11Window, which needs the same helper for the window's rectangle.)
 */
function watchCompositorForScreen(): void {
    if (process.platform !== 'linux' || !shouldProbeX11Compositor(process.env)) return;
    if (isNativeWaylandClient(process.env, safeSwitch('ozone-platform'))) return;
    stopX11Watcher();
    const w = makeX11Watcher(true);
    x11Watcher = w;
    void w.start().then(compositor => {
        if (x11Watcher !== w) return;
        if (compositor === null) { x11Watcher = null; return; }       // helper unavailable: the launch-time answer stands
        if (compositor === false) {
            console.warn('[annot-overlay] the X11 compositing manager is gone; desktop overlay taken down');
            hideAnnotationOverlay();
            endedListener?.('no_compositor');
        }
    });
}

/**
 * X11 window share (`window:<XID>:0`, the picker's own grid; Wayland/portal shares never get here).
 * Same shape as the Windows / macOS backends: the helper reports the window's frame and whether it
 * can be seen, `windowOverlayPlacement` decides close / hide / show, and the overlay covers the
 * frame exactly. X11 has no way to stack OUR window directly above ANOTHER client's, so the overlay
 * is a normal always-on-top window: a window covering the shared one would not cover the strokes.
 * `captured: false`: a compositing X11 capture reads the window's own pixmap, which does not
 * contain a separate window drawn over it. (If a capturer did include it, viewers would draw
 * the same stroke on the same spot twice — harmless; the opposite mistake would lose strokes.)
 */
async function showForX11Window(source: OverlaySource): Promise<OverlayShowResult> {
    const xid = parseX11WindowId(source.id);
    if (!xid) return refuse('bad_source');
    if (overlay && !overlay.isDestroyed() && target?.kind === 'window' && target.hwnd === xid && x11Watcher?.isRunning()) {
        trackX11Window();
        return { ok: true, how: 'x11-window', captured: false };
    }
    if (!waylandOverlayHelperPath()) {
        console.warn('[annot-overlay] X11 window share not overlaid: the native helper (cl-wayland-overlay) is not built into this install');
        return refuse('helper_failed');
    }
    if (overlay) hideAnnotationOverlay();
    stopX11Watcher();
    const w = makeX11Watcher((process.env.CIPHERLINE_ANNOT_OVERLAY ?? '').trim() !== '1');
    x11Watcher = w;
    const compositor = await w.start();
    if (x11Watcher !== w) return refuse('create_failed');            // released while it was starting
    const fail = (r: OverlayShowResult): OverlayShowResult => { if (x11Watcher === w) stopX11Watcher(); return r; };
    if (compositor === null) return fail(refuse('helper_failed'));
    if (compositor === false && (process.env.CIPHERLINE_ANNOT_OVERLAY ?? '').trim() !== '1') return fail(refuse('no_compositor'));
    const report = await w.track(xid);
    if (x11Watcher !== w) return refuse('create_failed');
    if (!report) return fail(refuse('helper_failed'));
    if (report.state === 'gone') return fail(refuse('window_gone'));
    x11Win = report;
    target = { kind: 'window', hwnd: xid };
    captureRect = null;
    const initial = report.frame ? x11FrameToDip(report.frame, x11ScaleFactor()) : { x: 0, y: 0, width: 320, height: 240 };
    if (!createOverlay(initial, true)) { stopX11Watcher(); return refuse('create_failed'); }
    console.log(`[annot-overlay] ${source.id} -> X11 window ${xid} (${report.state})`);
    return { ok: true, how: 'x11-window', captured: false };
}

/** One placement step for an X11 window share, driven by the helper's reports (no timer). */
function trackX11Window(): void {
    const win = overlay;
    const t = target;
    if (!win || win.isDestroyed() || t?.kind !== 'window') return;
    const p = windowOverlayPlacement(x11WindowInfo(x11Win?.state ?? null, x11Win?.frame ?? null));
    if (p.action === 'close') { hideAnnotationOverlay(); return; }
    if (p.action === 'hide') {
        try { if (win.isVisible()) win.hide(); } catch { /* closing */ }
        return;
    }
    if (!overlayReady) return;
    // Bounds BEFORE the show, so it never appears at the previous spot for a frame.
    const want = x11FrameToDip(p.rect, x11ScaleFactor());
    try { if (!sameRect(win.getBounds(), want)) win.setBounds(want); } catch { return; }
    try { if (!win.isVisible()) win.showInactive(); } catch { return; }
    syncGeometry();
}

// ── Linux / Wayland: the native helper ──────────────────────────────────────

const WAYLAND_HELPER_NAME = 'cl-wayland-overlay';

/**
 * Where the helper binary is, or null when this install has none (an unbuilt dev tree, a
 * non-Linux package). node-gyp builds it next to audio_capture.node (binding.gyp target
 * `cl_wayland_overlay`); electron-builder unpacks it from the asar (it has to be executed).
 * A dev build may point CIPHERLINE_WAYLAND_OVERLAY_HELPER at one, honoured only unpackaged.
 */
export function waylandOverlayHelperPath(): string | null {
    if (process.platform !== 'linux') return null;
    const candidates: string[] = [];
    if (!app.isPackaged && process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER) candidates.push(process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER);
    candidates.push(path.join(__dirname, '..', 'build', 'Release', WAYLAND_HELPER_NAME).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile()) { fs.accessSync(c, fs.constants.X_OK); return c; }
        } catch { /* not there / not executable */ }
    }
    return null;
}

/** A native Wayland session on a build that has the helper (and the user has not switched the overlay off). */
function shouldUseWaylandHelper(): boolean {
    if (process.platform !== 'linux') return false;
    if ((process.env.CIPHERLINE_ANNOT_OVERLAY ?? '').trim() === '0') return false;
    if (!isNativeWaylandClient(process.env, safeSwitch('ozone-platform'))) return false;
    return waylandOverlayHelperPath() !== null;
}

/** Only what the helper needs to find the compositor — nothing else of ours leaks into it. */
function waylandHelperEnv(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const k of ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'HOME']) {
        if (process.env[k]) out[k] = process.env[k];
    }
    return out;
}

let wayland: WaylandOverlay | null = null;
function waylandOverlay(): WaylandOverlay {
    return (wayland ??= createWaylandOverlay({
        spawnHelper: () => {
            const bin = waylandOverlayHelperPath();
            if (!bin) return null;
            try {
                // stderr is not read (the helper logs counts and states on stdout's protocol only).
                return spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'], env: waylandHelperEnv() }) as unknown as HelperProc;
            } catch { return null; }
        },
        getDisplays: () => {
            let primary = -1;
            try { primary = screen.getPrimaryDisplay().id; } catch { /* no primary */ }
            return screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === primary }));
        },
        now: () => Date.now(),
        log: (m) => console.log(m),
        onEnded: () => console.warn('[annot-overlay] the Wayland overlay ended (compositor closed it or the helper stopped); the next stroke starts it again'),
    }));
}

let refreshProbe: WaylandRefreshProbe | null = null;
/**
 * Display id -> real refresh (Hz) on a native Wayland session, read from wl_output.mode by a one-shot
 * `cl-wayland-overlay --outputs` (cached ~30 s, no resident process). Electron reports 0 there. Empty on
 * anything else, without the helper, or on any failure: callers keep today's "unknown". Never rejects.
 */
export function getWaylandDisplayRefresh(): Promise<Map<number, number>> {
    if (process.platform !== 'linux' || !isNativeWaylandClient(process.env, safeSwitch('ozone-platform'))) return Promise.resolve(new Map());
    refreshProbe ??= createWaylandRefreshProbe({
        run: () => new Promise<string | null>(resolve => {
            const bin = waylandOverlayHelperPath();
            if (!bin) { resolve(null); return; }
            try {
                execFile(bin, ['--outputs'], { env: waylandHelperEnv(), timeout: 1500, encoding: 'utf8', maxBuffer: 16384 },
                    (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : null));
            } catch { resolve(null); }
        }),
        getDisplays: () => {
            let primary = -1;
            try { primary = screen.getPrimaryDisplay().id; } catch { /* none */ }
            return screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === primary }));
        },
        now: () => Date.now(),
    });
    return refreshProbe.get();
}

/**
 * The refusals that depend only on the platform and the share KIND, not on
 * the source — checked by main's IPC handler before it looks the source up
 * (a fresh lookup of screens opens the portal chooser under Wayland).
 */
export function annotationOverlayPrecheck(kind: 'screen' | 'window'): OverlayShowResult | null | Promise<OverlayShowResult | null> {
    // Linux window shares: only on a real X11 session (the position of a window is a query away
    // there; Wayland / portal shares expose none to anyone, so they stay refused).
    if (kind === 'window' && process.platform !== 'win32' && process.platform !== 'darwin'
        && !(process.platform === 'linux' && x11WindowShareAllowed(process.env, safeSwitch('ozone-platform')))) return refuse('platform');
    if (process.platform !== 'linux') return null;
    const ozonePlatform = safeSwitch('ozone-platform');
    const decide = (compositor: boolean | null): OverlayShowResult | null => {
        const verdict = linuxOverlayVerdict({
            env: process.env,
            ozonePlatform,
            waylandHelper: waylandOverlayHelperPath() !== null,
            compositor,
        });
        if (!verdict) return null;
        console.warn(`[annot-overlay] desktop overlay off on this Linux session (${verdict}); in-app preview unaffected`);
        return refuse(verdict);
    };
    // The REAL compositor signal (an owner of _NET_WM_CM_S<n>) where it applies; null = could not ask, and the
    // desktop-name list decides as before. Answered synchronously whenever a fresh answer is cached (or there is
    // no helper to ask), otherwise through one asynchronous spawn.
    if (!shouldProbeX11Compositor(process.env) || isNativeWaylandClient(process.env, ozonePlatform)) return decide(null);
    const probe = x11Probe();
    const known = probe.peek();
    if (known !== undefined) return decide(known);
    return probe.get().then(decide);
}

function safeSwitch(name: string): string {
    try { return app.commandLine.getSwitchValue(name); } catch { return ''; }
}

/** The overlay is part of the captured stream (no capture exclusion on this OS). */
const overlayInCapture = (): boolean => process.platform === 'linux';

function refuse(reason: OverlayRefusal): OverlayShowResult { return { ok: false, reason }; }

function showForScreen(source: OverlaySource): OverlayShowResult {
    const found = displayForSource(source);
    if ('refused' in found) return found.refused;
    const { display, how } = found;
    bindScreenListeners();

    if (overlay && !overlay.isDestroyed() && target?.kind === 'screen') {
        if (target.displayId !== display.id) {
            target = { kind: 'screen', displayId: display.id };
            captureRect = display.bounds;
        }
        // Re-sync unconditionally: the same display can have been resized or
        // rescaled since the last share.
        lastLayoutKey = '';
        syncGeometry();
        return { ok: true, how, captured: overlayInCapture() };
    }
    if (overlay) hideAnnotationOverlay();                        // was over a window
    target = { kind: 'screen', displayId: display.id };
    captureRect = display.bounds;
    if (!createOverlay(display.bounds, true)) return refuse('create_failed');
    watchCompositorForScreen();       // Linux X11: take it down if the compositor goes away mid-share
    return { ok: true, how, captured: overlayInCapture() };
}

function showForWindow(source: OverlaySource): OverlayShowResult {
    // Electron cannot read another app's window bounds or z-order: that comes
    // from the geometry half of the audio_capture addon, which exists on
    // Windows and macOS only.
    if (process.platform !== 'win32' && process.platform !== 'darwin') return refuse('platform');
    const n = native;
    const backend = windowOverlayBackend(process.platform, n);
    if (!n?.getWindowInfo || !backend) {
        const rebuild = process.platform === 'darwin' ? 'npm run rebuild-native:mac' : 'npm run rebuild-native';
        console.warn(`[annot-overlay] window share not overlaid: audio_capture addon lacks window geometry (run "${rebuild}")`);
        return { ok: false, reason: 'addon_missing', addon: false };
    }
    const hwnd = parseWindowSourceHandle(source.id);
    if (!hwnd) return refuse('bad_source');
    let raw: unknown = null;
    try { raw = n.getWindowInfo(hwnd); } catch { raw = null; }
    const placement = windowOverlayPlacement(cleanWindowInfo(raw));
    if (placement.action === 'close') return refuse('window_gone');

    if (overlay && !overlay.isDestroyed() && target?.kind === 'window' && target.hwnd === hwnd) {
        trackWindow();
        return { ok: true, how: 'window', captured: false };
    }
    if (overlay) hideAnnotationOverlay();
    target = { kind: 'window', hwnd };
    captureRect = null;
    // Windows: a first guess in DIP; the addon then places it exactly, in
    // physical px. macOS: the frame IS in Electron's coordinates already.
    let initial: Rect = { x: 0, y: 0, width: 320, height: 240 };
    if (placement.action === 'show') {
        if (backend === 'mac') initial = macOverlayBounds(placement.rect);
        else {
            try { initial = screen.screenToDipRect(null, placement.rect); } catch { /* keep the guess */ }
        }
    }
    const ok = createOverlay(initial, false);
    if (ok) startTracking();
    return ok ? { ok: true, how: 'window', captured: false } : refuse('create_failed');
}

/** Each overlay window loads its OWN page file. One per-process name was
 *  shared by consecutive windows, so a closing window's did-finish-load
 *  unlink could delete the file the next window was about to load. */
let pageSeq = 0;

function createOverlay(b: Rect, topmost: boolean): boolean {
    overlayReady = false;
    queued = [];
    lastLayoutKey = '';
    lastRaiseAt = 0;
    const win = new BrowserWindow({
        x: Math.round(b.x), y: Math.round(b.y),
        width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)),
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        // Screen shares float over everything (borderless fullscreen games
        // included); a window share's overlay lives in the shared window's
        // own z-order band, stacked by the addon.
        alwaysOnTop: topmost,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        enableLargerThanScreen: true,
        title: 'Cipherline annotations',
        webPreferences: {
            preload: path.join(__dirname, 'annotation-overlay-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    overlay = win;
    win.setMenu(null);
    lockPageZoom(win.webContents);
    win.setIgnoreMouseEvents(true);
    if (topmost) {
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* level unsupported */ }
        try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not macOS */ }
    } else if (process.platform === 'darwin') {
        // macOS window share: on every Space (and allowed over a fullscreen
        // app's Space), so wherever the shared window is visible the overlay
        // can be ordered right above it. It is HIDDEN whenever the shared
        // window is not on screen (minimized, another Space, app hidden), so
        // being on all Spaces never shows strokes anywhere else.
        try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
    }
    // Load-bearing on Windows/macOS: this is what keeps the overlay OUT of the
    // screen capture. (A no-op on Linux, where the overlay IS captured — see
    // the header; the show result says so.)
    try { win.setContentProtection(true); } catch { win.destroy(); overlay = null; target = null; return false; }
    try { overlayHwnd = nativeHandleToDecimal(win.getNativeWindowHandle()); } catch { overlayHwnd = null; }

    // A private mkdtemp directory (0700, exclusive 0600 file), never a
    // predictable name in the shared temp dir — see private-page-file.ts.
    let page: PrivatePage;
    try { page = writePrivatePage(`cl-annot-${++pageSeq}`, OVERLAY_HTML); } catch (e) {
        console.warn('[annot-overlay] could not write page:', e);
        win.destroy(); overlay = null; target = null; return false;
    }
    win.webContents.on('did-finish-load', () => {
        page.cleanup();
        if (overlay !== win) return;
        overlayReady = true;
        // Geometry sent before this document existed (a resize/move while it
        // was still loading) went to the document being replaced. The layout
        // de-duplication in syncGeometry must not take that for "already
        // sent", or the page never learns where to draw: force a send.
        lastLayoutKey = '';
        if (target?.kind === 'window') {
            // Place it on the window FIRST (that sizes the client area the
            // layout is read from), then geometry, then the held strokes.
            trackWindow();
            syncGeometry();
            for (const d of queued) send(d);
            queued = [];
            return;
        }
        // Geometry BEFORE any stroke: the preload holds deltas it cannot yet
        // place, and a stroke drawn against a stale box is the whole bug.
        syncGeometry();
        for (const d of queued) send(d);
        queued = [];
        try { win.showInactive(); } catch { /* ignore */ }
        // ...and again after showing. A window's client area is not final
        // until it is mapped: this is the moment a work-area clamp or a
        // maximize-treatment actually takes effect, and until now nothing
        // re-measured afterwards.
        syncGeometry();
    });
    // The compositor can resize us at any time (display change, DPI change,
    // OS policy). Re-measuring keeps the canvas authoritative instead of
    // letting the new client box redefine the coordinate space.
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
        if (!isMainFrame || overlay !== win) return;
        page.cleanup();
        console.warn(`[annot-overlay] overlay page failed to load (${code} ${desc}); desktop overlay off`);
        hideAnnotationOverlay();
    });
    win.on('resize', syncGeometry);
    win.on('move', syncGeometry);
    win.on('closed', () => {
        page.cleanup();
        if (overlay === win) {
            stopTracking();
            stopX11Watcher();
            overlay = null; target = null; captureRect = null; overlayHwnd = null;
            overlayReady = false; queued = [];
        }
    });
    // A failed load is already handled by the did-fail-load listener above;
    // the promise's rejection is the same failure and must not go unhandled.
    win.loadFile(page.filePath).catch(() => { /* handled by did-fail-load */ });
    return true;
}

export function hideAnnotationOverlay(): void {
    wayland?.hide();
    const win = overlay;
    stopTracking();
    stopX11Watcher();
    overlay = null;
    target = null;
    captureRect = null;
    overlayHwnd = null;
    overlayReady = false;
    queued = [];
    if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch { /* ignore */ }
    }
}

/**
 * Screen shares on Windows: put the overlay back on top of the topmost band,
 * at most every TOPMOST_REASSERT_MS and only while strokes are arriving. A
 * fullscreen game is typically a topmost window that rises above ours when
 * it is activated; without this the strokes are drawn — underneath it.
 * `moveTop` is SetWindowPos(HWND_TOP, SWP_NOACTIVATE | SWP_NOMOVE |
 * SWP_NOSIZE) (Electron native_window_views.cc): no focus change, so the
 * game never loses the foreground.
 */
function reassertTopmost(win: BrowserWindow): void {
    if (process.platform !== 'win32' || target?.kind !== 'screen') return;
    const now = Date.now();
    if (now - lastRaiseAt < TOPMOST_REASSERT_MS) return;
    lastRaiseAt = now;
    try { if (win.isVisible()) win.moveTop(); } catch { /* closing */ }
}

export function pushAnnotationOverlayDelta(delta: OverlayDelta): void {
    if (wayland?.isActive()) { wayland.push(delta); return; }
    if (!overlay) return;
    if (!overlayReady) {
        // A reset supersedes everything queued before it.
        if (delta.reset) queued = [delta]; else queued.push(delta);
        return;
    }
    send(delta);
    if (!overlay.isDestroyed()) reassertTopmost(overlay);
}

export function isAnnotationOverlayShown(): boolean {
    if (wayland?.isShown()) return true;
    return !!overlay && !overlay.isDestroyed();
}
