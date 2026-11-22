import { describe, it, expect, vi } from 'vitest';
import {
    comboToKeyGroups, comboToVirtualKeys, comboToAccelerator, holdKeyBackend, isHoldSlot,
    GlobalHoldKeyWatcher, type KeyStateNative, type HoldBackend,
} from './global-ptt';
import { acceleratorToPortalTrigger } from './wayland-global-shortcuts';

describe('comboToKeyGroups', () => {
    it('Windows: a bare modifier is one group (Alt = VK_MENU, either Alt)', () => {
        expect(comboToKeyGroups('alt', 'win32')).toEqual([[0x12]]);
        expect(comboToVirtualKeys('ctrl')).toEqual([0x11]);
    });
    it('Windows: modifiers plus one key', () => {
        expect(comboToKeyGroups('ctrl+shift+v', 'win32')).toEqual([[0x11], [0x10], [0x56]]);
        expect(comboToKeyGroups('alt+f10', 'win32')).toEqual([[0x12], [0x79]]);
        expect(comboToKeyGroups('CTRL+Space', 'win32')).toEqual([[0x11], [0x20]]);
        expect(comboToKeyGroups('ctrl+,', 'win32')).toEqual([[0x11], [0xbc]]);
    });
    it('X11: a modifier is "left OR right" keysym, keys are keysyms', () => {
        expect(comboToKeyGroups('alt', 'x11')).toEqual([[0xffe9, 0xffea]]);
        expect(comboToKeyGroups('ctrl+shift+v', 'x11')).toEqual([[0xffe3, 0xffe4], [0xffe1, 0xffe2], [0x76]]);
        expect(comboToKeyGroups('f13', 'x11')).toEqual([[0xffbe + 12]]);
        expect(comboToKeyGroups('space', 'x11')).toEqual([[0x20]]);
        expect(comboToKeyGroups('arrowleft', 'x11')).toEqual([[0xff51]]);
    });
    it('rejects what it cannot watch', () => {
        for (const kind of ['win32', 'x11'] as const) {
            for (const bad of ['', 'ctrl+', '+', 'a+b', 'alt+alt', 'f25', 'ctrl+shift+alt+v+x', 'é', '!', null, undefined, 5, {}, 'x'.repeat(80)]) {
                expect(comboToKeyGroups(bad as unknown, kind)).toBeNull();
            }
        }
    });
});

describe('holdKeyBackend: per environment', () => {
    it('Windows: native poll with virtual keys', () => {
        expect(holdKeyBackend('win32', {}, false)).toEqual({ kind: 'native', codes: 'win32' });
    });
    it('Linux X11: native poll with keysyms', () => {
        expect(holdKeyBackend('linux', { XDG_SESSION_TYPE: 'x11' }, false)).toEqual({ kind: 'native', codes: 'x11' });
        expect(holdKeyBackend('linux', {}, false)).toEqual({ kind: 'native', codes: 'x11' });
    });
    it('Linux native Wayland (GNOME, KDE): the GlobalShortcuts portal', () => {
        expect(holdKeyBackend('linux', { XDG_SESSION_TYPE: 'wayland' }, true)).toEqual({ kind: 'portal' });
    });
    it('Linux XWayland client on a Wayland session: no system-wide path (the X11 poll cannot see other windows)', () => {
        expect(holdKeyBackend('linux', { XDG_SESSION_TYPE: 'wayland' }, false)).toEqual({ kind: 'none', reason: 'xwayland' });
    });
    it('macOS: none', () => {
        expect(holdKeyBackend('darwin', {}, false)).toEqual({ kind: 'none', reason: 'unsupported-os' });
    });
});

describe('portal triggers for hold keys', () => {
    it('a combo with a real key becomes a portal trigger', () => {
        expect(acceleratorToPortalTrigger(comboToAccelerator('ctrl+shift+v'))).toBe('CTRL+SHIFT+V');
        expect(acceleratorToPortalTrigger(comboToAccelerator('f13'))).toBe('F13');
        expect(acceleratorToPortalTrigger(comboToAccelerator('alt+arrowup'))).toBe('ALT+Up');
    });
    it('a bare modifier cannot be bound through the portal', () => {
        expect(acceleratorToPortalTrigger(comboToAccelerator('alt'))).toBeNull();
        expect(acceleratorToPortalTrigger(comboToAccelerator('ctrl+shift'))).toBeNull();
    });
    it('slot names', () => {
        expect(isHoldSlot('push-to-talk')).toBe(true);
        expect(isHoldSlot('push-to-mute')).toBe(true);
        expect(isHoldSlot('toggle-mute')).toBe(false);
    });
});

describe('GlobalHoldKeyWatcher', () => {
    const WIN: HoldBackend = { kind: 'native', codes: 'win32' };
    const mk = (native: KeyStateNative | null, backend: HoldBackend = WIN, portal?: ConstructorParameters<typeof GlobalHoldKeyWatcher>[3]) => {
        const onState = vi.fn();
        return { onState, w: new GlobalHoldKeyWatcher(() => native, () => backend, onState, portal) };
    };

    it('starts a watch in the slot for the combo and forwards down/up with the slot', async () => {
        let cb: ((d: boolean) => void) | undefined;
        const native: KeyStateNative = { watchKeys: vi.fn((_s, _g, c) => { cb = c; return true; }), stopWatchingKeys: vi.fn() };
        const { w, onState } = mk(native);
        expect(await w.setKey('push-to-talk', 'alt')).toEqual({ ok: true, watching: true });
        expect(native.watchKeys).toHaveBeenCalledWith(0, [[0x12]], expect.any(Function));
        cb!(true); cb!(false);
        expect(onState.mock.calls).toEqual([['push-to-talk', true], ['push-to-talk', false]]);
    });

    it('the two slots are independent watches', async () => {
        const native: KeyStateNative = { watchKeys: vi.fn(() => true), stopWatchingKeys: vi.fn() };
        const { w } = mk(native);
        await w.setKey('push-to-talk', 'alt');
        await w.setKey('push-to-mute', 'f13');
        expect((native.watchKeys as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual([0, 1]);
        await w.setKey('push-to-mute', null);
        expect(native.stopWatchingKeys).toHaveBeenCalledWith(1);
        expect(native.stopWatchingKeys).not.toHaveBeenCalledWith(0);
    });

    it('null stops the watch; stopping twice calls the addon once', async () => {
        const native: KeyStateNative = { watchKeys: vi.fn(() => true), stopWatchingKeys: vi.fn() };
        const { w } = mk(native);
        await w.setKey('push-to-talk', 'alt');
        expect(await w.setKey('push-to-talk', null)).toEqual({ ok: true, watching: false });
        w.stop();
        expect(native.stopWatchingKeys).toHaveBeenCalledTimes(1);
    });

    it('Linux X11 hands keysym groups to the addon', async () => {
        const native: KeyStateNative = { watchKeys: vi.fn(() => true) };
        const { w } = mk(native, { kind: 'native', codes: 'x11' });
        await w.setKey('push-to-talk', 'alt');
        expect(native.watchKeys).toHaveBeenCalledWith(0, [[0xffe9, 0xffea]], expect.any(Function));
    });

    it('reports unsupported when the addon is old / missing, or the session has no path', async () => {
        expect(await mk(null).w.setKey('push-to-talk', 'alt')).toEqual({ ok: false, reason: 'unsupported', detail: 'no-watcher' });
        expect(await mk({}).w.setKey('push-to-talk', 'alt')).toEqual({ ok: false, reason: 'unsupported', detail: 'no-watcher' });
        const native: KeyStateNative = { watchKeys: vi.fn(() => true) };
        expect(await mk(native, { kind: 'none', reason: 'xwayland' }).w.setKey('push-to-talk', 'alt')).toEqual({ ok: false, reason: 'unsupported', detail: 'xwayland' });
        expect(native.watchKeys).not.toHaveBeenCalled();
    });

    it('a key it cannot watch stops that slot and says so', async () => {
        const native: KeyStateNative = { watchKeys: vi.fn(() => true), stopWatchingKeys: vi.fn() };
        const { w } = mk(native);
        await w.setKey('push-to-talk', 'alt');
        expect(await w.setKey('push-to-talk', 'ctrl+é')).toEqual({ ok: false, reason: 'bad-key', detail: 'unmapped-key' });
        expect(native.stopWatchingKeys).toHaveBeenCalledTimes(1);
    });

    it('a native failure (false or throw, e.g. no X display) is "failed", not a crash', async () => {
        expect(await mk({ watchKeys: () => false }).w.setKey('push-to-talk', 'alt')).toEqual({ ok: false, reason: 'failed', detail: 'failed' });
        expect(await mk({ watchKeys: () => { throw new Error('x'); } }).w.setKey('push-to-talk', 'alt')).toEqual({ ok: false, reason: 'failed', detail: 'failed' });
    });

    it('Wayland goes through the portal setter, never the addon', async () => {
        const native: KeyStateNative = { watchKeys: vi.fn(() => true) };
        const portal = vi.fn(async () => ({ ok: true as const, watching: true }));
        const { w } = mk(native, { kind: 'portal' }, portal);
        expect(await w.setKey('push-to-mute', 'ctrl+shift+m')).toEqual({ ok: true, watching: true });
        expect(portal).toHaveBeenCalledWith('push-to-mute', 'ctrl+shift+m');
        await w.setKey('push-to-mute', null);
        expect(portal).toHaveBeenLastCalledWith('push-to-mute', null);
        expect(native.watchKeys).not.toHaveBeenCalled();
    });

    it('a portal that throws is "failed"', async () => {
        const { w } = mk(null, { kind: 'portal' }, async () => { throw new Error('bus'); });
        expect(await w.setKey('push-to-talk', 'f13')).toEqual({ ok: false, reason: 'failed', detail: 'wayland-not-bound' });
    });
});
