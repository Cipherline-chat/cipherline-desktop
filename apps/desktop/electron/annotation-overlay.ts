/**
 * Desktop annotation overlay (docs/video-annotation-design.md, Phase 5).
 *
 * While the local user shares a whole SCREEN, a transparent, click-through,
 * always-on-top window the exact size of that display renders the same
 * strokes the in-app preview tile shows — so the streamer sees what viewers
 * are pointing at over their actual work, not just inside Cipherline.
 *
 * Guarantees, in order of importance:
 *  - It never captures itself into the share. `setContentProtection(true)`
 *    excludes the window from capture on Windows (WDA_EXCLUDEFROMCAPTURE) and
 *    macOS (NSWindowSharingNone). X11/Wayland have no equivalent, so on Linux
 *    the overlay is not shown at all rather than feeding strokes back into
 *    the stream (viewers would see them twice, once live and once baked in).
 *  - It never takes input: `setIgnoreMouseEvents(true)` + `focusable: false`.
 *    Right-click, drag, type — everything falls through to whatever is
 *    underneath.
 *  - Renderer page is inert: a bare <canvas> under `default-src 'none'`. All
 *    drawing logic lives in the sandboxed preload, which only ever receives
 *    stroke deltas from the main process.
 *  - Window shares are not overlaid (Electron cannot know another app's
 *    window bounds); the in-app preview still shows every stroke.
 *
 * Coordinates: strokes are normalized to the captured frame ([0,1]²), and a
 * screen capture's frame IS the display — taskbar included. So the canvas is
 * laid out against the DISPLAY's bounds, which the main process owns and
 * pushes over `annot-overlay:geometry`.
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
import { BrowserWindow, screen, type DesktopCapturerSource, type Display } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
// Wire shape shared with the renderer (src/utils/desktopAnnotationOverlay.ts)
// — kept in a dependency-free module so neither side pulls in the other's
// runtime deps (electron here, livekit-client there) just to see the type.
// No `tool` on a stroke: the laser is the only one, and the overlay's own
// renderer never read the field even when there were two.
import type { OverlayDelta } from '../src/utils/annotationOverlayTypes';
export type { OverlayPoint, OverlayStroke, OverlayDelta } from '../src/utils/annotationOverlayTypes';
import { overlayCanvasLayout, type OverlayCanvasLayout, type Rect } from './annotation-overlay-projection';

let overlay: BrowserWindow | null = null;
let overlayDisplayId: number | null = null;
/** The rectangle strokes are normalized against: the captured display's
 *  bounds, in DIP. The projection is driven by THIS, never by whatever
 *  client box the compositor ends up giving the window. */
let captureRect: Rect | null = null;
let overlayReady = false;
let queued: OverlayDelta[] = [];
let listenersBound = false;

const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Cipherline annotations</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}canvas{position:fixed;left:0;top:0;display:block}</style>
</head><body><canvas id="c" aria-hidden="true"></canvas></body></html>`;

/** Map a `screen:` capture source to the Display it captures. */
function displayForSource(source: DesktopCapturerSource): Display | null {
    const displays = screen.getAllDisplays();
    if (source.display_id) {
        const byId = displays.find(d => String(d.id) === String(source.display_id));
        if (byId) return byId;
    }
    // Chromium ids look like `screen:<index>:0`; the index is the position in
    // the enumeration order, which matches getAllDisplays() on every platform
    // we ship.
    const m = /^screen:(\d+):/.exec(source.id);
    if (m) {
        const idx = Number(m[1]);
        if (displays[idx]) return displays[idx];
    }
    return displays.length === 1 ? displays[0] : null;
}

function bindScreenListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    screen.on('display-removed', (_e, d) => {
        if (overlay && overlayDisplayId === d.id) hideAnnotationOverlay();
    });
    screen.on('display-metrics-changed', (_e, d) => {
        if (overlay && overlayDisplayId === d.id) {
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
 * Both halves matter. `setContentBounds` re-asserts the size we asked for —
 * a frameless always-on-top window sized to a whole display is exactly the
 * shape a compositor is most tempted to "help" with (work-area clamping,
 * maximize treatment, DPI rounding), and the ask is cheap. Then the layout
 * is computed against whatever we ACTUALLY got, so if the window is still
 * not the display's size the strokes are shifted back onto the right screen
 * pixels rather than silently rescaled into the wrong box.
 *
 * `getContentBounds()` is the client area — the same rectangle the page's
 * viewport covers — which is what the canvas is positioned inside.
 */
function syncGeometry(): void {
    const win = overlay;
    const capture = captureRect;
    if (!win || win.isDestroyed() || !capture) return;
    try {
        const have = win.getContentBounds();
        if (have.x !== capture.x || have.y !== capture.y
            || have.width !== capture.width || have.height !== capture.height) {
            win.setContentBounds(capture);
        }
    } catch { /* window may be going away */ }

    let content: Rect;
    try { content = win.getContentBounds(); } catch { return; }
    const layout: OverlayCanvasLayout = overlayCanvasLayout(capture, content);
    try { win.webContents.send('annot-overlay:geometry', layout); } catch { /* closing */ }
}

/** Show (or move) the overlay over the display `source` captures. Returns
 *  false when there is nothing to overlay (window share, Linux, unknown
 *  display) — the caller then simply keeps the in-app preview. */
export function showAnnotationOverlay(source: DesktopCapturerSource): boolean {
    if (process.platform === 'linux') return false;             // cannot exclude from capture
    if (!source.id.startsWith('screen:')) return false;         // window shares: no bounds to follow
    const display = displayForSource(source);
    if (!display) return false;
    bindScreenListeners();

    if (overlay && !overlay.isDestroyed()) {
        if (overlayDisplayId !== display.id) {
            overlayDisplayId = display.id;
            captureRect = display.bounds;
        }
        // Re-sync unconditionally: the same display can have been resized or
        // rescaled since the last share.
        syncGeometry();
        return true;
    }

    const b = display.bounds;
    overlayDisplayId = display.id;
    captureRect = b;
    overlayReady = false;
    queued = [];
    const win = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
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
    win.setIgnoreMouseEvents(true);
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* level unsupported */ }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not macOS */ }
    // Load-bearing: this is what keeps the overlay OUT of the screen capture.
    try { win.setContentProtection(true); } catch { win.destroy(); overlay = null; return false; }

    const tmpPath = path.join(os.tmpdir(), `cipherline-annot-overlay-${process.pid}.html`);
    try { fs.writeFileSync(tmpPath, OVERLAY_HTML, 'utf8'); } catch (e) {
        console.warn('[annot-overlay] could not write page:', e);
        win.destroy(); overlay = null; return false;
    }
    win.webContents.on('did-finish-load', () => {
        fs.unlink(tmpPath, () => {});
        if (overlay !== win) return;
        overlayReady = true;
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
    // OS policy). Re-measuring against the capture rect keeps the canvas
    // authoritative instead of letting the new client box redefine the
    // coordinate space.
    win.on('resize', syncGeometry);
    win.on('move', syncGeometry);
    win.on('closed', () => {
        if (overlay === win) {
            overlay = null; overlayDisplayId = null; captureRect = null;
            overlayReady = false; queued = [];
        }
    });
    void win.loadFile(tmpPath);
    return true;
}

export function hideAnnotationOverlay(): void {
    const win = overlay;
    overlay = null;
    overlayDisplayId = null;
    captureRect = null;
    overlayReady = false;
    queued = [];
    if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch { /* ignore */ }
    }
}

export function pushAnnotationOverlayDelta(delta: OverlayDelta): void {
    if (!overlay) return;
    if (!overlayReady) {
        // A reset supersedes everything queued before it.
        if (delta.reset) queued = [delta]; else queued.push(delta);
        return;
    }
    send(delta);
}

export function isAnnotationOverlayShown(): boolean {
    return !!overlay && !overlay.isDestroyed();
}
