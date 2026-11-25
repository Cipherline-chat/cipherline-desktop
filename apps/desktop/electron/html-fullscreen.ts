/**
 * HTML fullscreen (a video's fullscreen button, YouTube's own button inside
 * its iframe, the call overlay's root request) must be REAL OS fullscreen,
 * the whole display, and leaving it (Esc, the player's exit button) must
 * put the window back exactly as it was: maximized stays maximized, a
 * windowed window gets its bounds back. Owner, 2026-11-23: a video's
 * fullscreen only filled the window.
 *
 * Electron already asks the OS for fullscreen on `requestFullscreen()`
 * (setFullScreen under the hood). Where that does not end up covering the
 * display (measured on Linux X11 without a window manager: the window jumps to
 * the display size and is then put back at its own size while
 * isFullScreen() still says true), this covers the display itself. On the way
 * out it restores the last NORMAL state it saw (bounds + maximized), unless
 * the window was already OS-fullscreen before the page asked (F11, macOS
 * green button), which Electron leaves alone and so do we.
 *
 * No `electron` import: the window and the display lookup are injected, so the
 * policy is unit-tested with a fake window (html-fullscreen.test.ts).
 */

export interface Rect { x: number; y: number; width: number; height: number }

export interface FullscreenWindow {
    on(event: string, listener: () => void): unknown;
    isDestroyed(): boolean;
    isFullScreen(): boolean;
    isMaximized(): boolean;
    getBounds(): Rect;
    setBounds(r: Rect): void;
    maximize(): void;
    unmaximize(): void;
}

export interface HtmlFullscreenDeps {
    displayBoundsFor(r: Rect): Rect;
    /** setTimeout (injectable). */
    defer(fn: () => void, ms: number): void;
    log?(line: string): void;
}

/** A page's request fires enter-full-screen just before enter-html-full-screen;
 *  an enter-full-screen with no html one this long after it was the user's own. */
export const OS_FULL_DECIDE_MS = 150;

/** How long Electron/the OS gets to finish its own transition before we check. */
export const SETTLE_MS = 350;

const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const covers = (w: Rect, d: Rect) => w.x <= d.x && w.y <= d.y && w.x + w.width >= d.x + d.width && w.y + w.height >= d.y + d.height;

export interface HtmlFullscreenHandle {
    /** True between enter-html-full-screen and the restore after leaving it. */
    active(): boolean;
}

export function attachHtmlFullscreen(win: FullscreenWindow, deps: HtmlFullscreenDeps): HtmlFullscreenHandle {
    // The last state seen while the window was NOT fullscreen: what "exactly as
    // it was" means. Updated on every move / resize / (un)maximize outside fullscreen.
    let normal = { bounds: win.getBounds(), maximized: win.isMaximized() };
    // Was the window OS-fullscreen on its own (not because of a page)?
    let osFull = win.isFullScreen();
    let html = false;
    let pre: { bounds: Rect; maximized: boolean; osFull: boolean } | null = null;
    let covered = false;

    const track = () => {
        if (win.isDestroyed() || html) return;
        if (win.isFullScreen()) return;
        normal = { bounds: win.getBounds(), maximized: win.isMaximized() };
        osFull = false;
    };
    for (const ev of ['move', 'resize', 'maximize', 'unmaximize']) win.on(ev, track);
    // An OS fullscreen the user asked for (no page involved): F11 / green button.
    win.on('enter-full-screen', () => { if (!html) deps.defer(() => { if (!html && win.isFullScreen()) osFull = true; }, OS_FULL_DECIDE_MS); });
    win.on('leave-full-screen', () => { if (!html) osFull = false; });

    win.on('enter-html-full-screen', () => {
        if (html) return;
        html = true;
        covered = false;
        // Electron fires enter-full-screen just before this one for a page's
        // request; `osFull` was decided on the next tick, so read it as it was.
        pre = { ...normal, osFull };
        deps.defer(() => {
            if (win.isDestroyed() || !html) return;
            const display = deps.displayBoundsFor(pre!.bounds);
            const b = win.getBounds();
            if (!covers(b, display)) {
                deps.log?.(`[html-fullscreen] OS fullscreen did not cover the display (${b.width}x${b.height} of ${display.width}x${display.height}); covering it`);
                win.setBounds(display);
                covered = true;
                // Some window systems take a frameless window 1 px short of what
                // was asked (X11: 2599x1699 for 2600x1700). Grow by the shortfall once.
                deps.defer(() => {
                    if (win.isDestroyed() || !html) return;
                    const got = win.getBounds();
                    if (!covers(got, display)) {
                        win.setBounds({ ...display, width: display.width + (display.x + display.width - (got.x + got.width)), height: display.height + (display.y + display.height - (got.y + got.height)) });
                    }
                }, 100);
            }
        }, SETTLE_MS);
    });

    win.on('leave-html-full-screen', () => {
        if (!html) return;
        const p = pre;
        deps.defer(() => {
            html = false;
            pre = null;
            if (win.isDestroyed() || !p) return;
            // The window was fullscreen before the page asked: Electron keeps it so.
            if (p.osFull || win.isFullScreen()) return;
            if (p.maximized) {
                if (!win.isMaximized()) win.maximize();
            } else {
                if (win.isMaximized()) win.unmaximize();
                if (covered || !same(win.getBounds(), p.bounds)) win.setBounds(p.bounds);
            }
            normal = { bounds: p.bounds, maximized: p.maximized };
            covered = false;
        }, SETTLE_MS);
    });

    return { active: () => html };
}
