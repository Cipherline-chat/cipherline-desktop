import { describe, it, expect, vi } from 'vitest';
import {
    UI_SCALE_STEPS, UI_SCALE_DEFAULT, BASE_WINDOW_MIN, LAYOUT_MIN_CSS,
    isUiScaleStep, parseStoredUiScale, encodeUiScale, minWindowSizeFor, maxScaleForWorkArea,
    effectiveUiScale, stepUiScale, growBoundsToFit, createUiScaleController,
    type Rect, type ScalableWindow,
} from './ui-scale';

describe('steps and storage', () => {
    it('default is 100 and a step', () => {
        expect(UI_SCALE_DEFAULT).toBe(100);
        expect(isUiScaleStep(100)).toBe(true);
        expect([...UI_SCALE_STEPS]).toEqual([80, 90, 100, 110, 125, 150, 175, 200]);
    });
    it.each([[null, 100], ['', 100], ['125', 125], ['200', 200], ['80', 80], ['130', 100], ['1.25', 100], ['125abc', 100], ['0125', 100], [' 125', 100]])(
        'parse %j -> %d', (raw, want) => { expect(parseStoredUiScale(raw as string | null)).toBe(want); });
    it('encode round-trips every step and refuses others', () => {
        for (const s of UI_SCALE_STEPS) expect(parseStoredUiScale(encodeUiScale(s))).toBe(s);
        expect(() => encodeUiScale(130)).toThrow();
        expect(() => encodeUiScale(NaN)).toThrow();
    });
});

describe('minWindowSizeFor (rule 2)', () => {
    it('100 % and below keep the historical 1000x720 minimum', () => {
        expect(minWindowSizeFor(100)).toEqual(BASE_WINDOW_MIN);
        expect(minWindowSizeFor(80)).toEqual(BASE_WINDOW_MIN);
        expect(minWindowSizeFor(90)).toEqual(BASE_WINDOW_MIN);
    });
    it('above 100 % the minimum holds LAYOUT_MIN_CSS in CSS px', () => {
        expect(minWindowSizeFor(110)).toEqual({ width: 1100, height: 720 });
        expect(minWindowSizeFor(125)).toEqual({ width: 1250, height: 750 });
        expect(minWindowSizeFor(150)).toEqual({ width: 1500, height: 900 });
        expect(minWindowSizeFor(200)).toEqual({ width: 2000, height: 1200 });
        for (const s of UI_SCALE_STEPS) {
            const m = minWindowSizeFor(s);
            expect(m.width * 100 / s).toBeGreaterThanOrEqual(LAYOUT_MIN_CSS.width);
            expect(m.height * 100 / s).toBeGreaterThanOrEqual(LAYOUT_MIN_CSS.height);
        }
    });
});

describe('maxScaleForWorkArea (rule 3)', () => {
    it.each([
        ['1366x728 laptop', { width: 1366, height: 728 }, 110],
        ['1280x760 (1280x800 taskbar)', { width: 1280, height: 760 }, 125],
        ['1920x1040 (1080p, 100 % OS scale)', { width: 1920, height: 1040 }, 150],
        ['1920x1080 (borderless)', { width: 1920, height: 1080 }, 175],
        ['1280x680 (1920x1080 @ 150 % OS scale, DIP)', { width: 1280, height: 680 }, 110],
        ['2560x1400 (1440p)', { width: 2560, height: 1400 }, 200],
        ['3840x2120 (4K @ 100 %)', { width: 3840, height: 2120 }, 200],
        ['tiny 900x600 display', { width: 900, height: 600 }, 100],
    ])('%s -> %d', (_n, work, want) => {
        expect(maxScaleForWorkArea(work)).toBe(want);
        // the layout's CSS floor at the result always fits the display
        expect(Math.ceil(LAYOUT_MIN_CSS.width * want / 100)).toBeLessThanOrEqual(Math.max(work.width, 1000));
        expect(Math.ceil(LAYOUT_MIN_CSS.height * want / 100)).toBeLessThanOrEqual(Math.max(work.height, 600));
        // and the next step up would not
        const next = UI_SCALE_STEPS[UI_SCALE_STEPS.indexOf(want as never) + 1];
        if (next) {
            const fits = Math.ceil(LAYOUT_MIN_CSS.width * next / 100) <= work.width && Math.ceil(LAYOUT_MIN_CSS.height * next / 100) <= work.height;
            expect(fits).toBe(false);
        }
    });
});

describe('effectiveUiScale (rule 4)', () => {
    it('clamps to the display, never rewrites the preference', () => {
        expect(effectiveUiScale(200, 150)).toBe(150);
        expect(effectiveUiScale(125, 150)).toBe(125);
        expect(effectiveUiScale(80, 100)).toBe(80);
        expect(effectiveUiScale(137, 200)).toBe(100);
    });
});

describe('stepUiScale (Ctrl/Cmd + = / - / 0)', () => {
    it('steps through the list', () => {
        expect(stepUiScale(100, 'in', 200)).toBe(110);
        expect(stepUiScale(110, 'in', 200)).toBe(125);
        expect(stepUiScale(100, 'out', 200)).toBe(90);
        expect(stepUiScale(90, 'out', 200)).toBe(80);
    });
    it('stops at both ends', () => {
        expect(stepUiScale(200, 'in', 200)).toBe(200);
        expect(stepUiScale(80, 'out', 200)).toBe(80);
    });
    it('stepping in stops at the display limit', () => {
        expect(stepUiScale(150, 'in', 150)).toBe(150);
        expect(stepUiScale(125, 'in', 150)).toBe(150);
    });
    it('stepping out from a clamped preference moves below what is shown', () => {
        expect(stepUiScale(200, 'out', 125)).toBe(110);
    });
    it('reset is 100 from anywhere', () => {
        for (const s of UI_SCALE_STEPS) expect(stepUiScale(s, 'reset', 150)).toBe(100);
    });
});

describe('growBoundsToFit (rule 5)', () => {
    const work: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
    it('null when already big enough', () => {
        expect(growBoundsToFit({ x: 10, y: 10, width: 1600, height: 1000 }, { width: 1500, height: 900 }, work)).toBeNull();
    });
    it('grows and shifts back inside the work area', () => {
        expect(growBoundsToFit({ x: 800, y: 300, width: 1280, height: 720 }, { width: 1500, height: 900 }, work))
            .toEqual({ x: 420, y: 140, width: 1500, height: 900 });
    });
    it('never exceeds the work area, honours a non-zero origin (second monitor)', () => {
        const right: Rect = { x: 1920, y: 0, width: 1366, height: 728 };
        expect(growBoundsToFit({ x: 2000, y: 50, width: 1000, height: 720 }, { width: 2000, height: 1200 }, right))
            .toEqual({ x: 1920, y: 0, width: 1366, height: 728 });
    });
});

function fakeWin(bounds: Rect, opts: { maximized?: boolean } = {}) {
    let b = { ...bounds };
    const w = {
        destroyed: false,
        min: null as null | [number, number],
        isDestroyed() { return this.destroyed; },
        isMaximized: () => !!opts.maximized,
        isFullScreen: () => false,
        getBounds: () => ({ ...b }),
        setBounds: vi.fn((r: Rect) => { b = { ...r }; }),
        setMinimumSize(wd: number, h: number) { this.min = [wd, h]; },
    };
    return w as typeof w & ScalableWindow;
}

function deps(stored: string | null, work: Rect) {
    const store = { v: stored };
    return {
        store,
        readStored: () => store.v,
        writeStored: vi.fn((v: string) => { store.v = v; }),
        workAreaFor: () => work,
        applyZoomFactor: vi.fn(),
        notify: vi.fn(),
    };
}

describe('createUiScaleController', () => {
    const work1080: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

    it('init: applies the stored scale, sets the min size, grows the window, zooms; no notify', () => {
        const d = deps('125', work1080);
        const c = createUiScaleController(d);
        const win = fakeWin({ x: 100, y: 100, width: 1000, height: 720 });
        const s = c.apply(win, 'init');
        expect(s).toEqual({ percent: 125, effective: 125, max: 150, source: 'init' });
        expect(win.min).toEqual([1250, 750]);
        expect(win.setBounds).toHaveBeenCalledWith({ x: 100, y: 100, width: 1250, height: 750 });
        expect(d.applyZoomFactor).toHaveBeenLastCalledWith(1.25);
        expect(d.notify).not.toHaveBeenCalled();
    });

    it('clamps a too-big stored scale to the display without rewriting it', () => {
        const d = deps('200', work1080);
        const c = createUiScaleController(d);
        const s = c.apply(fakeWin({ x: 0, y: 0, width: 1280, height: 720 }), 'display');
        expect(s.percent).toBe(200);
        expect(s.effective).toBe(150);
        expect(d.applyZoomFactor).toHaveBeenLastCalledWith(1.5);
        expect(d.writeStored).not.toHaveBeenCalled();
        expect(d.notify).toHaveBeenCalledWith(s);
    });

    it('a maximised window is not resized, only constrained + zoomed', () => {
        const d = deps(null, work1080);
        const c = createUiScaleController(d);
        const win = fakeWin({ x: 0, y: 0, width: 1920, height: 1040 }, { maximized: true });
        c.set(win, 150);
        expect(win.setBounds).not.toHaveBeenCalled();
        expect(win.min).toEqual([1500, 900]);
        expect(d.store.v).toBe('150');
    });

    it('set refuses a non-step', () => {
        const c = createUiScaleController(deps(null, work1080));
        expect(() => c.set(fakeWin({ x: 0, y: 0, width: 1280, height: 720 }), 133)).toThrow();
    });

    it('step persists, applies and notifies with source shortcut', () => {
        const d = deps(null, work1080);
        const c = createUiScaleController(d);
        const win = fakeWin({ x: 0, y: 0, width: 1280, height: 720 });
        c.apply(win, 'init');
        expect(c.step(win, 'in')).toMatchObject({ percent: 110, effective: 110, source: 'shortcut' });
        expect(d.store.v).toBe('110');
        c.step(win, 'reset');
        expect(d.store.v).toBe('100');
        expect(d.applyZoomFactor).toHaveBeenLastCalledWith(1);
        expect(win.min).toEqual([1000, 720]);
    });

    it('a locked store still applies for the session', () => {
        const d = deps(null, work1080);
        d.writeStored.mockImplementation(() => { throw new Error('locked'); });
        const c = createUiScaleController(d);
        expect(c.set(fakeWin({ x: 0, y: 0, width: 1600, height: 1000 }), 125).effective).toBe(125);
    });

    it('display re-applies notify only when the limit actually changes', () => {
        const d = deps('200', work1080);
        let work = work1080;
        d.workAreaFor = () => work;
        const c = createUiScaleController(d);
        const win = fakeWin({ x: 0, y: 0, width: 1600, height: 1000 });
        c.apply(win, 'init');
        c.apply(win, 'display');
        expect(d.notify).not.toHaveBeenCalled();
        work = { x: 1920, y: 0, width: 1366, height: 728 };
        c.apply(win, 'display');
        expect(d.notify).toHaveBeenCalledTimes(1);
        expect(d.notify.mock.calls[0][0]).toMatchObject({ percent: 200, effective: 110, max: 110 });
    });

    it('factorFor gives the clamped first-paint factor for a window opening at given bounds', () => {
        const c = createUiScaleController(deps('200', work1080));
        expect(c.factorFor({ x: 0, y: 0, width: 1280, height: 720 })).toBe(1.5);
        const c2 = createUiScaleController(deps('110', work1080));
        expect(c2.factorFor({ x: 0, y: 0, width: 1280, height: 720 })).toBe(1.1);
        const c3 = createUiScaleController(deps(null, work1080));
        expect(c3.factorFor({ x: 0, y: 0, width: 1280, height: 720 })).toBe(1);
    });

    it('a destroyed window is skipped without throwing', () => {
        const d = deps('125', work1080);
        const c = createUiScaleController(d);
        const win = fakeWin({ x: 0, y: 0, width: 1280, height: 720 });
        win.destroyed = true;
        expect(() => c.apply(win, 'display')).not.toThrow();
        expect(d.applyZoomFactor).not.toHaveBeenCalled();
    });
});
