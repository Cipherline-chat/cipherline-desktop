import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    applyMotionState,
    installIdleMotionGate,
    isMotionActive,
    onMotionChange,
    MOTION_ACTIVE,
    MOTION_IDLE,
    INPUT_IDLE_MS,
} from './idleMotion';

/**
 * The window is created with `backgroundThrottling: false` (electron/main.ts),
 * so Chromium never tells the page it is hidden: minimised, `document.hidden`
 * stays false and — hidden to the tray — `hasFocus()` can stay true. Measured
 * in the real app: after `win.hide()` the page still reported
 * visible + focused and kept producing ~56 frames/s. The main process's own
 * minimise/hide pushes are the only reliable signal.
 *
 * Runs under vitest's node environment: document/window are stubs.
 */
function makeDoc(opts: { hidden?: boolean; focused?: boolean } = {}) {
    const attrs: Record<string, string> = {};
    const listeners: Record<string, Array<() => void>> = {};
    return {
        hidden: opts.hidden ?? false,
        hasFocus: () => opts.focused ?? true,
        documentElement: {
            getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
            setAttribute: (k: string, v: string) => { attrs[k] = v; },
            hasAttribute: (k: string) => k in attrs,
            removeAttribute: (k: string) => { delete attrs[k]; },
        },
        addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ||= []).push(fn); },
        removeEventListener: (ev: string, fn: () => void) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
        __attrs: attrs,
    } as unknown as Document & { __attrs: Record<string, string> };
}

function makeWin(doc: Document) {
    const listeners: Record<string, Array<() => void>> = {};
    return {
        document: doc,
        addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ||= []).push(fn); },
        removeEventListener: (ev: string, fn: () => void) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
        __listeners: listeners,
    } as unknown as Window & { __listeners: Record<string, Array<() => void>> };
}

function makeApi() {
    const subs: Record<string, Array<() => void>> = {};
    const on = (name: string) => (cb: () => void) => {
        (subs[name] ||= []).push(cb);
        return () => { subs[name] = subs[name].filter(f => f !== cb); };
    };
    return {
        api: { onWindowMinimize: on('minimize'), onWindowHide: on('hide'), onWindowFocus: on('focus') },
        fire: (name: string) => (subs[name] || []).forEach(f => f()),
        count: () => Object.values(subs).reduce((n, l) => n + l.length, 0),
    };
}

describe('installIdleMotionGate — main-process window signals', () => {
    it('idles on minimise / hide even though the page still reports visible + focused, and resumes on focus', () => {
        const doc = makeDoc({ hidden: false, focused: true });
        const win = makeWin(doc);
        const ipc = makeApi();
        (win as unknown as { electronAPI: unknown }).electronAPI = ipc.api;
        installIdleMotionGate(win);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);

        ipc.fire('minimize');
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
        // A stray blur sync while backgrounded must not revive it.
        win.__listeners.blur[0]();
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);

        ipc.fire('focus');
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);

        ipc.fire('hide');
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
        // A DOM focus while the window is still hidden (seen in the real app)
        // must not restart the loops; only the OS focus push does.
        win.__listeners.focus[0]();
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
        ipc.fire('focus');
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
    });

    it('teardown unsubscribes the main-process listeners too', () => {
        const doc = makeDoc();
        const win = makeWin(doc);
        const ipc = makeApi();
        (win as unknown as { electronAPI: unknown }).electronAPI = ipc.api;
        const stop = installIdleMotionGate(win);
        expect(ipc.count()).toBe(3);
        stop();
        expect(ipc.count()).toBe(0);
    });

    it('works unchanged without the bridge (browser / tests)', () => {
        const doc = makeDoc({ focused: false });
        const win = makeWin(doc);
        expect(() => installIdleMotionGate(win)).not.toThrow();
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
    });
});

describe('onMotionChange / isMotionActive (JS-driven decoration)', () => {
    it('fires on flips only, and stops after unsubscribe', () => {
        const doc = makeDoc();
        const seen: boolean[] = [];
        const off = onMotionChange(a => seen.push(a));
        applyMotionState(true, doc);
        applyMotionState(true, doc);
        applyMotionState(false, doc);
        expect(isMotionActive(doc)).toBe(false);
        applyMotionState(true, doc);
        expect(isMotionActive(doc)).toBe(true);
        off();
        applyMotionState(false, doc);
        expect(seen).toEqual([true, false, true]);
    });
});

describe('always-visible pulses are compositor-only', () => {
    it('status-online and update-ready keyframes animate only transform/opacity (no per-frame repaint)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const here = path.dirname(new URL(import.meta.url).pathname);
        const css = await fs.readFile(path.resolve(here, '..', 'index.css'), 'utf8');
        for (const name of ['status-online-pulse', 'update-ready-pulse']) {
            const start = css.indexOf(`@keyframes ${name}`);
            expect(start).toBeGreaterThan(-1);
            const body = css.slice(start, css.indexOf('\n}', start));
            expect(body).not.toMatch(/box-shadow|width|height|top|left|margin|filter/);
            expect(body).toMatch(/transform/);
            expect(body).toMatch(/opacity/);
        }
    });

    it('neither loops forever: a finite pulse, then no frames at rest', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const here = path.dirname(new URL(import.meta.url).pathname);
        const css = await fs.readFile(path.resolve(here, '..', 'index.css'), 'utf8');
        for (const sel of ['.status-online::after', '.update-ready-pulse::after']) {
            const start = css.indexOf(`\n${sel} {`);
            expect(start).toBeGreaterThan(-1);
            const rule = css.slice(start, css.indexOf('}', start));
            expect(rule).toMatch(/animation:\s*[\w-]+-pulse [\d.]+s ease-in-out \d+;/);
            expect(rule).not.toContain('infinite');
            // resting state is invisible once the pulses end
            expect(rule).toMatch(/opacity:\s*0;/);
        }
    });

    it('both are stopped by the idle gate', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const here = path.dirname(new URL(import.meta.url).pathname);
        const css = await fs.readFile(path.resolve(here, '..', 'index.css'), 'utf8');
        const gate = css.split('\n').filter(l => l.includes('data-cl-motion="idle"')).join('\n');
        expect(gate).toContain('.status-online::after');
        expect(gate).toContain('.update-ready-pulse::after');
    });
});

describe('installIdleMotionGate — rests after a stretch with no input', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('a focused window nobody touches stops its decoration; any input resumes it', () => {
        vi.useFakeTimers();
        const doc = makeDoc({ focused: true });
        const win = makeWin(doc);
        const stop = installIdleMotionGate(win);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);

        vi.advanceTimersByTime(INPUT_IDLE_MS - 1000);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
        win.__listeners.pointermove[0](); // input pushes the deadline out
        vi.advanceTimersByTime(INPUT_IDLE_MS - 1000);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
        vi.advanceTimersByTime(2000);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);

        // Resting costs nothing: no timer is left pending.
        expect(vi.getTimerCount()).toBe(0);

        win.__listeners.keydown[0]();
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
        stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(win.__listeners.pointermove.length).toBe(0);
    });

    it('input never overrides a minimised / blurred window', () => {
        vi.useFakeTimers();
        const doc = makeDoc({ focused: false });
        const win = makeWin(doc);
        installIdleMotionGate(win);
        win.__listeners.pointermove[0]();
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
    });
});
