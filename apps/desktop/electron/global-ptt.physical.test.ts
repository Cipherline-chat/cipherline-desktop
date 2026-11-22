import { describe, it, expect, vi } from 'vitest';
import {
    comboToKeyGroups, comboToAccelerator, holdKeySupport, portalHoldIssue, supportFromResult, legacyTokenOf,
    isPhysicalToken, GlobalHoldKeyWatcher, ForegroundElevationMonitor, parseForegroundElevation, foregroundBlocksKeyPoll, adminGameState,
    WIN_SCAN_CODE, X11_KEYCODE, X11_BUTTON, type KeyStateNative, type HoldBackend, type HoldKeyFocusReason,
} from './global-ptt';
import { acceleratorToPortalTrigger } from './wayland-global-shortcuts';
import { PHYSICAL_TOKENS, MOUSE_TOKENS } from '../src/utils/holdKeys';

const WIN: HoldBackend = { kind: 'native', codes: 'win32' };
const X11: HoldBackend = { kind: 'native', codes: 'x11' };

describe('physical keys (KeyboardEvent.code tokens)', () => {
    it('Windows: layout-dependent keys go as scan codes (the addon maps them with MapVirtualKeyEx)', () => {
        expect(comboToKeyGroups('keyq', 'win32')).toEqual([[WIN_SCAN_CODE | 0x10]]);
        expect(comboToKeyGroups('shift+digit1', 'win32')).toEqual([[0x10], [WIN_SCAN_CODE | 0x02]]);
        expect(comboToKeyGroups('semicolon', 'win32')).toEqual([[WIN_SCAN_CODE | 0x27]]);
        expect(comboToKeyGroups('intlbackslash', 'win32')).toEqual([[WIN_SCAN_CODE | 0x56]]);
    });
    it('Windows: fixed virtual keys for numpad (plus the NumLock-off key), Caps Lock, right-side modifiers, Win', () => {
        expect(comboToKeyGroups('numpad1', 'win32')).toEqual([[0x61, 0x23]]);   // VK_NUMPAD1 or VK_END
        expect(comboToKeyGroups('numpad5', 'win32')).toEqual([[0x65, 0x0c]]);   // VK_CLEAR
        expect(comboToKeyGroups('numpadadd', 'win32')).toEqual([[0x6b]]);
        expect(comboToKeyGroups('capslock', 'win32')).toEqual([[0x14]]);
        expect(comboToKeyGroups('altright', 'win32')).toEqual([[0xa5]]);        // VK_RMENU (AltGr)
        expect(comboToKeyGroups('controlright', 'win32')).toEqual([[0xa3]]);
        expect(comboToKeyGroups('meta', 'win32')).toEqual([[0x5b, 0x5c]]);
        expect(comboToKeyGroups('f24', 'win32')).toEqual([[0x87]]);
    });
    it('X11: raw keycodes (evdev + 8), the same keycode Chromium derived `code` from', () => {
        expect(comboToKeyGroups('keya', 'x11')).toEqual([[X11_KEYCODE | 38]]);
        expect(comboToKeyGroups('numpad1', 'x11')).toEqual([[X11_KEYCODE | 87]]);
        expect(comboToKeyGroups('capslock', 'x11')).toEqual([[X11_KEYCODE | 66]]);
        expect(comboToKeyGroups('altright', 'x11')).toEqual([[X11_KEYCODE | 108]]);
        expect(comboToKeyGroups('metaleft', 'x11')).toEqual([[X11_KEYCODE | 133]]);
        expect(comboToKeyGroups('numpadenter', 'x11')).toEqual([[X11_KEYCODE | 104]]);
        expect(comboToKeyGroups('f13', 'x11')).toEqual([[0xffbe + 12]]);   // legacy spelling keeps the keysym
    });
    it('a side-specific modifier counts as a modifier, so it combines with one key', () => {
        expect(comboToKeyGroups('altright+keyq', 'win32')).toEqual([[0xa5], [WIN_SCAN_CODE | 0x10]]);
        expect(comboToKeyGroups('keyq+keyw', 'win32')).toBeNull();
        expect(comboToKeyGroups('numpad1+mouse4', 'x11')).toBeNull();
    });
    it('legacy combos are watched exactly as before', () => {
        expect(comboToKeyGroups('ctrl+shift+v', 'win32')).toEqual([[0x11], [0x10], [0x56]]);
        expect(comboToKeyGroups('space', 'win32')).toEqual([[0x20]]);
        expect(comboToKeyGroups('ctrl+,', 'x11')).toEqual([[0xffe3, 0xffe4], [0x2c]]);
        expect(comboToKeyGroups('shift+!', 'win32')).toBeNull();   // an old recording: can't be watched (UI says re-record)
    });
    it('every physical token the renderer records is watchable on both systems', () => {
        for (const t of PHYSICAL_TOKENS) {
            expect(isPhysicalToken(t) || /^f\d+$/.test(t), t).toBe(true);
            expect(comboToKeyGroups(t, 'win32'), `${t} win32`).not.toBeNull();
            expect(comboToKeyGroups(t, 'x11'), `${t} x11`).not.toBeNull();
        }
    });
    it('no two physical tokens share an X11 keycode', () => {
        const seen = new Map<number, string>();
        for (const t of PHYSICAL_TOKENS) {
            const g = comboToKeyGroups(t, 'x11')![0];
            if (!(g[0] & X11_KEYCODE)) continue;
            expect(seen.get(g[0]), `${t} collides with ${seen.get(g[0])}`).toBeUndefined();
            seen.set(g[0], t);
        }
    });
});

describe('mouse buttons', () => {
    it('Windows: VK_MBUTTON / VK_XBUTTON1 / VK_XBUTTON2 (GetAsyncKeyState reads them)', () => {
        expect(comboToKeyGroups('mouse3', 'win32')).toEqual([[0x04]]);
        expect(comboToKeyGroups('mouse4', 'win32')).toEqual([[0x05]]);
        expect(comboToKeyGroups('mouse5', 'win32')).toEqual([[0x06]]);
        expect(comboToKeyGroups('ctrl+mouse4', 'win32')).toEqual([[0x11], [0x05]]);
    });
    it('X11: pointer buttons 2 / 8 / 9', () => {
        expect(comboToKeyGroups('mouse3', 'x11')).toEqual([[X11_BUTTON | 2]]);
        expect(comboToKeyGroups('mouse4', 'x11')).toEqual([[X11_BUTTON | 8]]);
        expect(comboToKeyGroups('mouse5', 'x11')).toEqual([[X11_BUTTON | 9]]);
    });
    it('every mouse token the renderer records is watchable', () => {
        for (const t of Object.keys(MOUSE_TOKENS)) expect(comboToKeyGroups(t, 'win32')).not.toBeNull();
    });
});

describe('portal (native Wayland)', () => {
    it('says why a combo cannot be a portal trigger, agreeing with the trigger converter', () => {
        const cases: [string, HoldKeyFocusReason | null][] = [
            ['alt', 'wayland-modifier'], ['altright', 'wayland-modifier'], ['ctrl+shift', 'wayland-modifier'],
            ['mouse4', 'wayland-mouse'], ['shift+mouse5', 'wayland-mouse'],
            ['numpad1', 'wayland-key'], ['capslock', 'wayland-key'], ['meta+keyv', 'wayland-key'], ['altright+keyq', 'wayland-key'],
            ['ctrl+shift+keyv', null], ['keyv', null], ['digit1', null], ['f13', null], ['ctrl+space', null], ['alt+arrowup', null],
            ['ctrl+shift+v', null], ['ctrl+comma', null],
        ];
        for (const [combo, want] of cases) {
            expect(portalHoldIssue(combo), combo).toBe(want);
            if (want === null) expect(acceleratorToPortalTrigger(comboToAccelerator(combo)), combo).not.toBeNull();
        }
    });
    it('physical tokens become the accelerator the portal converter knows', () => {
        expect(acceleratorToPortalTrigger(comboToAccelerator('ctrl+shift+keyv'))).toBe('CTRL+SHIFT+V');
        expect(acceleratorToPortalTrigger(comboToAccelerator('digit1'))).toBe('1');
        expect(legacyTokenOf('keyv')).toBe('v');
        expect(legacyTokenOf('comma')).toBe(',');
        expect(legacyTokenOf('numpad1')).toBe('numpad1');
    });
    it('a combo the portal cannot take is refused with the reason, and clears that slot', async () => {
        const portal = vi.fn(async () => ({ ok: true as const, watching: true }));
        const w = new GlobalHoldKeyWatcher(() => null, () => ({ kind: 'portal' }), () => undefined, portal);
        expect(await w.setKey('push-to-talk', 'mouse4')).toEqual({ ok: false, reason: 'bad-key', detail: 'wayland-mouse' });
        expect(portal).toHaveBeenCalledWith('push-to-talk', null);
        expect(await w.setKey('push-to-talk', 'alt')).toEqual({ ok: false, reason: 'bad-key', detail: 'wayland-modifier' });
    });
    it('a portal that answers "not bound" carries wayland-not-bound', async () => {
        const w = new GlobalHoldKeyWatcher(() => null, () => ({ kind: 'portal' }), () => undefined, async () => ({ ok: false, reason: 'unsupported' }));
        expect(await w.setKey('push-to-talk', 'f13')).toEqual({ ok: false, reason: 'unsupported', detail: 'wayland-not-bound' });
    });
});

describe('holdKeySupport: the dry run behind the settings hint', () => {
    const native = true;
    it('decision table', () => {
        expect(holdKeySupport('numpad1', WIN, native)).toEqual({ status: 'ok', backend: 'win32' });
        expect(holdKeySupport('mouse4', X11, native)).toEqual({ status: 'ok', backend: 'x11' });
        expect(holdKeySupport('alt', WIN, false)).toEqual({ status: 'focused-only', backend: 'win32', reason: 'no-watcher' });
        expect(holdKeySupport('shift+!', WIN, native)).toEqual({ status: 'focused-only', backend: 'win32', reason: 'unmapped-key' });
        expect(holdKeySupport('alt', { kind: 'none', reason: 'unsupported-os' }, native)).toEqual({ status: 'focused-only', backend: 'none', reason: 'unsupported-os' });
        expect(holdKeySupport('alt', { kind: 'none', reason: 'xwayland' }, native)).toEqual({ status: 'focused-only', backend: 'none', reason: 'xwayland' });
        expect(holdKeySupport('alt', { kind: 'portal' }, native)).toEqual({ status: 'focused-only', backend: 'portal', reason: 'wayland-modifier' });
        expect(holdKeySupport('ctrl+keyv', { kind: 'portal' }, native)).toEqual({ status: 'ok', backend: 'portal' });
        expect(holdKeySupport('', WIN, native)).toBeNull();
        expect(holdKeySupport(null, WIN, native)).toBeNull();
    });
    it('a live result maps onto the same shape', () => {
        expect(supportFromResult({ ok: true, watching: true }, WIN)).toEqual({ status: 'ok', backend: 'win32' });
        expect(supportFromResult({ ok: false, reason: 'failed', detail: 'failed' }, X11)).toEqual({ status: 'focused-only', backend: 'x11', reason: 'failed' });
        expect(supportFromResult({ ok: false, reason: 'unsupported' }, { kind: 'none', reason: 'xwayland' })).toEqual({ status: 'focused-only', backend: 'none', reason: 'xwayland' });
        expect(supportFromResult({ ok: false, reason: 'bad-key' }, WIN)).toEqual({ status: 'focused-only', backend: 'win32', reason: 'unmapped-key' });
    });
    it('the watcher remembers each slot\'s last result for the report, and forgets a cleared slot', async () => {
        const n: KeyStateNative = { watchKeys: () => true, stopWatchingKeys: () => undefined };
        const w = new GlobalHoldKeyWatcher(() => n, () => WIN, () => undefined);
        await w.setKey('push-to-talk', 'mouse4');
        await w.setKey('push-to-mute', 'shift+!');
        expect(w.results()).toEqual({
            'push-to-talk': { ok: true, watching: true },
            'push-to-mute': { ok: false, reason: 'bad-key', detail: 'unmapped-key' },
        });
        expect(w.watchingNatively).toBe(true);
        await w.setKey('push-to-talk', null);
        expect(w.results()['push-to-talk']).toBeUndefined();
        expect(w.watchingNatively).toBe(false);
    });
});

describe('elevated foreground window (Windows UIPI)', () => {
    it('parses the addon reply', () => {
        expect(parseForegroundElevation({ foreground: 'higher', selfElevated: false, selfIntegrity: 0x2000 })).toEqual({ foreground: 'higher', selfElevated: false });
        expect(parseForegroundElevation({ foreground: 'weird' })).toBeNull();
        expect(parseForegroundElevation(null)).toBeNull();
    });
    it('blocked ONLY when elevation is positively confirmed; a hidden token (anti-cheat) is never "admin"', () => {
        const f = (foreground: string, selfElevated = false) => foregroundBlocksKeyPoll(parseForegroundElevation({ foreground, selfElevated }));
        expect(f('higher')).toBe(true);
        expect(f('denied')).toBe(false);
        expect(f('unknown')).toBe(false);
        expect(f('higher', true)).toBe(false);
        for (const k of ['same', 'self', 'none']) expect(f(k)).toBe(false);
        expect(foregroundBlocksKeyPoll(null)).toBe(false);
    });
    it('adminGameState: yes / no / unknown, null for our own window or none', () => {
        const s = (foreground: string, selfElevated = false) => adminGameState(parseForegroundElevation({ foreground, selfElevated }));
        expect(s('higher')).toBe('yes');
        expect(s('same')).toBe('no');
        expect(s('higher', true)).toBe('no');
        expect(s('denied')).toBe('unknown');
        expect(s('unknown')).toBe('unknown');
        expect(s('self')).toBeNull();
        expect(s('none')).toBeNull();
        expect(adminGameState(null)).toBeNull();
    });
    it('the monitor keeps the last game answer (unknown included) for the report, without a hint for unknown', () => {
        let reply: unknown = { foreground: 'denied', selfElevated: false };
        const onChange = vi.fn();
        const m = new ForegroundElevationMonitor(() => reply, onChange);
        m.tick();
        expect(m.lastGame).toBe('unknown');
        expect(onChange).not.toHaveBeenCalled();
        reply = { foreground: 'self', selfElevated: false };   // back in Cipherline: the game answer is kept
        m.tick();
        expect(m.lastGame).toBe('unknown');
    });
    it('the monitor reports changes only, and "not blocked" when stopped', () => {
        let reply: unknown = { foreground: 'same', selfElevated: false };
        let tick: (() => void) | undefined;
        const onChange = vi.fn();
        const m = new ForegroundElevationMonitor(() => reply, onChange, 1000, {
            set: ((fn: () => void) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval,
            clear: (() => { tick = undefined; }) as unknown as typeof clearInterval,
        });
        m.setRunning(true);
        expect(onChange).not.toHaveBeenCalled();
        reply = { foreground: 'higher', selfElevated: false };
        tick!(); tick!();
        expect(onChange.mock.calls).toEqual([[true]]);
        expect(m.isBlocked).toBe(true);
        m.setRunning(false);
        expect(onChange.mock.calls).toEqual([[true], [false]]);
        expect(m.running).toBe(false);
    });
    it('a throwing addon is "not blocked", never a crash', () => {
        const onChange = vi.fn();
        const m = new ForegroundElevationMonitor(() => { throw new Error('x'); }, onChange);
        m.tick();
        expect(onChange).not.toHaveBeenCalled();
    });
});
