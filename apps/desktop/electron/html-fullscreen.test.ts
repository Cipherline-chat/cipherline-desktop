import { describe, it, expect } from 'vitest';
import { attachHtmlFullscreen, OS_FULL_DECIDE_MS, SETTLE_MS, type FullscreenWindow, type Rect } from './html-fullscreen';

const DISPLAY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

/** A window with Electron's event order for a page's request (measured on Electron 43 / X11):
 *  resize(full) → enter-full-screen → enter-html-full-screen; leave: resize → leave-full-screen → leave-html-full-screen. */
class FakeWin implements FullscreenWindow {
    bounds: Rect = { x: 300, y: 200, width: 1366, height: 768 };
    full = false;
    max = false;
    destroyed = false;
    /** What the "OS" does with a fullscreen request: cover the display, or not (no WM). */
    osCovers = true;
    savedNormal: Rect | null = null;
    private ls = new Map<string, (() => void)[]>();
    setBoundsCalls: Rect[] = [];
    on(e: string, l: () => void) { this.ls.set(e, [...(this.ls.get(e) ?? []), l]); return this; }
    emit(e: string) { for (const l of this.ls.get(e) ?? []) l(); }
    isDestroyed() { return this.destroyed; }
    isFullScreen() { return this.full; }
    isMaximized() { return this.max; }
    getBounds() { return { ...this.bounds }; }
    setBounds(r: Rect) { this.setBoundsCalls.push(r); this.bounds = { ...r }; }
    maximize() { this.max = true; this.bounds = { ...DISPLAY, height: 1040 }; this.emit('maximize'); }
    unmaximize() { this.max = false; this.emit('unmaximize'); }
    // Electron's own steps
    pageEnter() {
        this.savedNormal = this.bounds;
        this.full = true;
        if (this.osCovers) this.bounds = { ...DISPLAY };
        this.emit('resize'); this.emit('enter-full-screen'); this.emit('enter-html-full-screen');
    }
    pageLeave(electronRestores: 'exact' | 'unmaximized' = 'exact') {
        this.full = false;
        this.bounds = { ...this.savedNormal! };
        if (electronRestores === 'unmaximized') { this.max = false; this.bounds = { x: 10, y: 10, width: 1000, height: 720 }; }
        this.emit('resize'); this.emit('leave-full-screen'); this.emit('leave-html-full-screen');
    }
    userOsFullscreen() { this.full = true; this.bounds = { ...DISPLAY }; this.emit('resize'); this.emit('enter-full-screen'); }
}

function setup(win: FakeWin) {
    const timers: { at: number; fn: () => void }[] = [];
    let now = 0;
    const h = attachHtmlFullscreen(win, { displayBoundsFor: () => DISPLAY, defer: (fn, ms) => { timers.push({ at: now + ms, fn }); } });
    const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            const t = timers[0];
            if (!t || t.at > end) break;
            timers.shift();
            now = t.at;
            t.fn();
        }
        now = end;
    };
    return { h, advance };
}

describe('HTML fullscreen is real OS fullscreen, and leaving restores the window exactly', () => {
    it('windowed: an OS that does not cover the display gets covered; leaving restores the bounds', () => {
        const w = new FakeWin();
        w.osCovers = false;
        const { h, advance } = setup(w);
        w.pageEnter();
        expect(h.active()).toBe(true);
        advance(SETTLE_MS);
        expect(w.bounds).toEqual(DISPLAY);
        w.pageLeave();
        advance(SETTLE_MS);
        expect(h.active()).toBe(false);
        expect(w.bounds).toEqual({ x: 300, y: 200, width: 1366, height: 768 });
        expect(w.max).toBe(false);
    });

    it('a 1 px short cover is grown once', () => {
        const w = new FakeWin();
        w.osCovers = false;
        const orig = w.setBounds.bind(w);
        let first = true;
        w.setBounds = (r) => { if (first) { first = false; orig({ ...r, width: r.width - 1, height: r.height - 1 }); } else orig(r); };
        const { advance } = setup(w);
        w.pageEnter();
        advance(SETTLE_MS + 100);
        expect(w.bounds.width).toBeGreaterThanOrEqual(1920);
        expect(w.bounds.height).toBeGreaterThanOrEqual(1080);
    });

    it('an OS that does cover the display is left alone (no setBounds)', () => {
        const w = new FakeWin();
        const { advance } = setup(w);
        w.pageEnter();
        advance(SETTLE_MS);
        expect(w.setBoundsCalls).toEqual([]);
        w.pageLeave();
        advance(SETTLE_MS);
        expect(w.setBoundsCalls).toEqual([]);
    });

    it('maximized before: maximized again after, even when the platform drops it', () => {
        const w = new FakeWin();
        const { advance } = setup(w);
        w.maximize();
        w.pageEnter();
        advance(SETTLE_MS);
        w.pageLeave('unmaximized');
        advance(SETTLE_MS);
        expect(w.max).toBe(true);
    });

    it('windowed before but the platform comes back at another size: the old bounds are put back', () => {
        const w = new FakeWin();
        const { advance } = setup(w);
        w.pageEnter();
        advance(SETTLE_MS);
        w.pageLeave('unmaximized');
        advance(SETTLE_MS);
        expect(w.max).toBe(false);
        expect(w.bounds).toEqual({ x: 300, y: 200, width: 1366, height: 768 });
    });

    it('already OS-fullscreen (F11 / green button) before the page asked: left fullscreen afterwards', () => {
        const w = new FakeWin();
        const { advance } = setup(w);
        w.userOsFullscreen();
        advance(OS_FULL_DECIDE_MS);
        // The page asks inside an OS-fullscreen window: Electron fires only the html event.
        w.emit('enter-html-full-screen');
        advance(SETTLE_MS);
        w.emit('leave-html-full-screen');
        advance(SETTLE_MS);
        expect(w.full).toBe(true);
        expect(w.setBoundsCalls).toEqual([]);
    });

    it('positive control: without the module the no-WM case stays window-sized', () => {
        const w = new FakeWin();
        w.osCovers = false;
        w.pageEnter();
        expect(w.bounds).toEqual({ x: 300, y: 200, width: 1366, height: 768 });
    });
});
