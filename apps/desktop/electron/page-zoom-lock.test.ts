import { describe, it, expect, vi } from 'vitest';
import {
    isZoomShortcut, resetZoomToIntended, lockPageZoom, intendedZoomFactor, APP_ZOOM_FACTOR,
    type ZoomKeyInput, type ZoomLockableContents,
} from './page-zoom-lock';

const key = (k: string, mods: Partial<ZoomKeyInput> = {}): ZoomKeyInput => ({
    type: 'keyDown', key: k, control: false, meta: false, alt: false, shift: false, ...mods,
});

describe('isZoomShortcut', () => {
    it.each([
        ['Ctrl+-', key('-', { control: true })],
        ['Ctrl+=', key('=', { control: true })],
        ['Ctrl++ (Shift+=)', key('+', { control: true, shift: true })],
        ['Ctrl+Shift+= (key reported as =)', key('=', { control: true, shift: true })],
        ['Ctrl+_ (Shift+-)', key('_', { control: true, shift: true })],
        ['Ctrl+0', key('0', { control: true })],
        ['Cmd+-', key('-', { meta: true })],
        ['Cmd+=', key('=', { meta: true })],
        ['Cmd++', key('+', { meta: true, shift: true })],
        ['Cmd+0', key('0', { meta: true })],
        ['Ctrl+NumpadAdd', key('+', { control: true, code: 'NumpadAdd' })],
        ['Ctrl+NumpadSubtract', key('-', { control: true, code: 'NumpadSubtract' })],
        ['Ctrl+Numpad0', key('0', { control: true, code: 'Numpad0' })],
        ['Ctrl+Add (legacy key name)', key('Add', { control: true })],
        ['Ctrl+Subtract (legacy key name)', key('Subtract', { control: true })],
    ])('blocks %s', (_n, input) => {
        expect(isZoomShortcut(input)).toBe(true);
    });

    it.each([
        ['plain - (typing)', key('-')],
        ['plain +', key('+', { shift: true })],
        ['plain =', key('=')],
        ['plain 0', key('0')],
        ['Shift+- without Ctrl', key('_', { shift: true })],
        ['Ctrl+Shift+I (DevTools)', key('I', { control: true, shift: true })],
        ['Ctrl+Shift+M', key('M', { control: true, shift: true })],
        ['Ctrl+Shift+0 (not a zoom shortcut)', key('0', { control: true, shift: true })],
        ['Ctrl+K', key('k', { control: true })],
        ['Ctrl+1', key('1', { control: true })],
        ['Ctrl+Enter', key('Enter', { control: true })],
        ['AltGr (Ctrl+Alt) + -', key('-', { control: true, alt: true })],
        ['AltGr (Ctrl+Alt) + =', key('=', { control: true, alt: true })],
        ['Ctrl+- keyUp', { ...key('-', { control: true }), type: 'keyUp' }],
        ['NumpadAdd without Ctrl', key('+', { code: 'NumpadAdd' })],
    ])('does not block %s', (_n, input) => {
        expect(isZoomShortcut(input)).toBe(false);
    });
});

function fakeContents(initial: number) {
    const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    let factor = initial;
    const wc = {
        destroyed: false,
        isDestroyed() { return this.destroyed; },
        getZoomFactor: () => factor,
        setZoomFactor: vi.fn((f: number) => { factor = f; }),
        setVisualZoomLevelLimits: vi.fn(async () => {}),
        on: (ev: string, fn: (...a: never[]) => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); return wc; },
    };
    return {
        wc: wc as unknown as ZoomLockableContents & typeof wc,
        emit: (ev: string, ...a: unknown[]) => (handlers.get(ev) ?? []).forEach(h => h(...a)),
        setFactor: (f: number) => { factor = f; },
        handlers,
    };
}

describe('intended factor', () => {
    it('is 1.0 (no in-app UI scale exists)', () => {
        expect(APP_ZOOM_FACTOR).toBe(1);
        expect(intendedZoomFactor()).toBe(1);
    });
});

describe('resetZoomToIntended', () => {
    it('restores a drifted factor', () => {
        const { wc } = fakeContents(0.7);
        expect(resetZoomToIntended(wc)).toBe(true);
        expect(wc.setZoomFactor).toHaveBeenCalledWith(1);
        expect(wc.getZoomFactor()).toBe(1);
    });
    it('restores a custom intended factor, not a hard-coded 1', () => {
        const { wc } = fakeContents(1);
        expect(resetZoomToIntended(wc, 1.25)).toBe(true);
        expect(wc.setZoomFactor).toHaveBeenCalledWith(1.25);
    });
    it('does nothing when already at the factor (incl. float noise)', () => {
        const { wc } = fakeContents(1.0004);
        expect(resetZoomToIntended(wc)).toBe(false);
        expect(wc.setZoomFactor).not.toHaveBeenCalled();
    });
    it('is a no-op on destroyed contents and never throws', () => {
        const { wc } = fakeContents(0.5);
        wc.destroyed = true;
        expect(resetZoomToIntended(wc)).toBe(false);
        expect(wc.setZoomFactor).not.toHaveBeenCalled();
        const throwing = {
            isDestroyed: () => false,
            getZoomFactor: () => { throw new Error('gone'); },
        } as unknown as ZoomLockableContents;
        expect(() => resetZoomToIntended(throwing)).not.toThrow();
    });
});

describe('lockPageZoom', () => {
    it('resets a persisted stray zoom immediately and on dom-ready / did-finish-load', () => {
        const f = fakeContents(0.8);
        lockPageZoom(f.wc);
        expect(f.wc.getZoomFactor()).toBe(1);
        f.setFactor(0.8); f.emit('dom-ready');
        expect(f.wc.getZoomFactor()).toBe(1);
        f.setFactor(1.4); f.emit('did-finish-load');
        expect(f.wc.getZoomFactor()).toBe(1);
    });
    it('pins visual (pinch) zoom limits to 1..1', () => {
        const f = fakeContents(1);
        lockPageZoom(f.wc);
        expect(f.wc.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
    });
    it('survives setVisualZoomLevelLimits rejecting', async () => {
        const f = fakeContents(1);
        f.wc.setVisualZoomLevelLimits = vi.fn(async () => { throw new Error('closing'); });
        expect(() => lockPageZoom(f.wc)).not.toThrow();
        await new Promise(r => setImmediate(r));
    });
    it('snaps Ctrl+wheel zoom (zoom-changed) back, now and on the next tick', async () => {
        const f = fakeContents(1);
        lockPageZoom(f.wc);
        f.setFactor(1.2); f.emit('zoom-changed', {}, 'in');
        expect(f.wc.getZoomFactor()).toBe(1);
        f.setFactor(1.2); // level applied after the event was delivered
        await new Promise(r => setImmediate(r));
        expect(f.wc.getZoomFactor()).toBe(1);
    });
    it('preventDefaults zoom accelerators and leaves other keys alone', () => {
        const f = fakeContents(1);
        lockPageZoom(f.wc);
        const run = (input: ZoomKeyInput) => {
            const ev = { preventDefault: vi.fn() };
            f.emit('before-input-event', ev, input);
            return ev.preventDefault.mock.calls.length;
        };
        expect(run(key('-', { control: true }))).toBe(1);
        expect(run(key('0', { meta: true }))).toBe(1);
        expect(run(key('-'))).toBe(0);
        expect(run(key('I', { control: true, shift: true }))).toBe(0);
    });
    it('negative control: WITHOUT lockPageZoom nothing resets or blocks', () => {
        const f = fakeContents(0.6);
        expect(f.handlers.size).toBe(0);
        expect(f.wc.getZoomFactor()).toBe(0.6);
        expect(f.wc.setVisualZoomLevelLimits).not.toHaveBeenCalled();
    });
});
