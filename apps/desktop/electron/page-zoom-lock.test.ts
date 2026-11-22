import { describe, it, expect, vi } from 'vitest';
import {
    isZoomShortcut, resetZoomToIntended, lockPageZoom, intendedZoomFactor, APP_ZOOM_FACTOR,
    zoomShortcutAction, setIntendedZoomFactor,
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

describe('zoomShortcutAction', () => {
    it.each([
        ['Ctrl+=', key('=', { control: true }), 'in'],
        ['Ctrl++', key('+', { control: true, shift: true }), 'in'],
        ['Cmd+=', key('=', { meta: true }), 'in'],
        ['Ctrl+NumpadAdd', key('+', { control: true, code: 'NumpadAdd' }), 'in'],
        ['Ctrl+Add', key('Add', { control: true }), 'in'],
        ['Ctrl+-', key('-', { control: true }), 'out'],
        ['Ctrl+_', key('_', { control: true, shift: true }), 'out'],
        ['Ctrl+NumpadSubtract', key('-', { control: true, code: 'NumpadSubtract' }), 'out'],
        ['Ctrl+Subtract', key('Subtract', { control: true }), 'out'],
        ['Ctrl+0', key('0', { control: true }), 'reset'],
        ['Cmd+0', key('0', { meta: true }), 'reset'],
    ])('%s -> %s', (_n, input, want) => {
        expect(zoomShortcutAction(input)).toBe(want);
    });
    it('null for everything isZoomShortcut rejects', () => {
        expect(zoomShortcutAction(key('-'))).toBeNull();
        expect(zoomShortcutAction(key('=', { control: true, alt: true }))).toBeNull();
        expect(zoomShortcutAction(key('0', { control: true, shift: true }))).toBeNull();
        expect(zoomShortcutAction({ ...key('=', { control: true }), type: 'keyUp' })).toBeNull();
    });
});

describe('intended factor', () => {
    it('defaults to 1.0', () => {
        expect(APP_ZOOM_FACTOR).toBe(1);
        expect(intendedZoomFactor()).toBe(1);
    });
    it('setIntendedZoomFactor accepts sane factors and refuses junk', () => {
        try {
            expect(setIntendedZoomFactor(1.25)).toBe(true);
            expect(intendedZoomFactor()).toBe(1.25);
            for (const bad of [0, 0.2, 5, NaN, Infinity, -1]) {
                expect(setIntendedZoomFactor(bad)).toBe(false);
                expect(intendedZoomFactor()).toBe(1.25);
            }
        } finally { setIntendedZoomFactor(1); }
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
    it('a fixed window stays at 1 even when the UI scale is set', () => {
        try {
            setIntendedZoomFactor(1.5);
            const f = fakeContents(1.5);
            lockPageZoom(f.wc);
            expect(f.wc.getZoomFactor()).toBe(1);
            f.setFactor(1.5); f.emit('did-finish-load');
            expect(f.wc.getZoomFactor()).toBe(1);
        } finally { setIntendedZoomFactor(1); }
    });
    it('a scalable window follows the intended factor on every reset path', async () => {
        try {
            setIntendedZoomFactor(1.25);
            const f = fakeContents(1);
            lockPageZoom(f.wc, { scalable: true });
            expect(f.wc.getZoomFactor()).toBe(1.25);
            f.setFactor(1); f.emit('dom-ready');
            expect(f.wc.getZoomFactor()).toBe(1.25);
            f.setFactor(2); f.emit('zoom-changed', {}, 'in');
            expect(f.wc.getZoomFactor()).toBe(1.25);
            setIntendedZoomFactor(1.5);
            f.emit('did-finish-load');
            expect(f.wc.getZoomFactor()).toBe(1.5);
        } finally { setIntendedZoomFactor(1); }
    });
    it('scalable: accelerators are still swallowed AND handed to onShortcut once per press', () => {
        const f = fakeContents(1);
        const onShortcut = vi.fn();
        lockPageZoom(f.wc, { scalable: true, onShortcut });
        const press = (input: ZoomKeyInput & { isAutoRepeat?: boolean }) => {
            const ev = { preventDefault: vi.fn() };
            f.emit('before-input-event', ev, input);
            return ev.preventDefault.mock.calls.length;
        };
        expect(press(key('=', { control: true }))).toBe(1);
        expect(press(key('-', { meta: true }))).toBe(1);
        expect(press(key('0', { control: true }))).toBe(1);
        expect(press({ ...key('=', { control: true }), isAutoRepeat: true })).toBe(1);
        expect(press(key('='))).toBe(0);
        expect(onShortcut.mock.calls.map(c => c[0])).toEqual(['in', 'out', 'reset']);
    });
    it('fixed windows never call onShortcut (positive control for the scalable case)', () => {
        const f = fakeContents(1);
        const onShortcut = vi.fn();
        lockPageZoom(f.wc, { onShortcut });
        f.emit('before-input-event', { preventDefault: vi.fn() }, key('=', { control: true }));
        expect(onShortcut).not.toHaveBeenCalled();
    });
    it('negative control: WITHOUT lockPageZoom nothing resets or blocks', () => {
        const f = fakeContents(0.6);
        expect(f.handlers.size).toBe(0);
        expect(f.wc.getZoomFactor()).toBe(0.6);
        expect(f.wc.setVisualZoomLevelLimits).not.toHaveBeenCalled();
    });
});
