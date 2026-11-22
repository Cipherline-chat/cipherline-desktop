import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    createHoldKeyRecorder, HeldInputs, holdTokenLabel, holdComboAsKeybind, holdKeyKind, holdKeyReportName,
    parseHoldKeySupport, supportFromSetResult, holdKeyFocusNote, physicalTokenOfCode, __setLayoutLabels,
    HOLD_KEY_FOCUSED_ONLY_TITLE, ELEVATED_GAME_HINT,
} from './holdKeys';
import { attachFocusedHoldKey, firstTimeThisCall } from './holdKeyListeners';

type Mods = Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>;
const ev = (key: string, code?: string, mods: Mods = {}) =>
    ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const mouse = (button: number, mods: Mods = {}) => ({ button, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

const record = (steps: (r: ReturnType<typeof createHoldKeyRecorder>) => void, isMac = false) => {
    const got: string[] = [];
    steps(createHoldKeyRecorder(c => got.push(c), { isMac }));
    return got;
};

describe('recorder: physical keys', () => {
    it('stores the key by position (KeyboardEvent.code), not by the character it types', () => {
        expect(record(r => r.keydown(ev('1', 'Numpad1')))).toEqual(['numpad1']);
        expect(record(r => r.keydown(ev('End', 'Numpad1')))).toEqual(['numpad1']);       // NumLock off
        expect(record(r => r.keydown(ev('CapsLock', 'CapsLock')))).toEqual(['capslock']);
        expect(record(r => r.keydown(ev('ö', 'Semicolon')))).toEqual(['semicolon']);    // German layout
        expect(record(r => r.keydown(ev('a', 'KeyQ')))).toEqual(['keyq']);              // AZERTY
        expect(record(r => r.keydown(ev('F13', 'F13')))).toEqual(['f13']);
    });
    it('Shift+1 is shift+digit1, never "shift+!"', () => {
        expect(record(r => { r.keydown(ev('Shift', 'ShiftLeft', { shiftKey: true })); r.keydown(ev('!', 'Digit1', { shiftKey: true })); }))
            .toEqual(['shift+digit1']);
    });
    it('Ctrl+Shift+V spelled physically', () => {
        expect(record(r => {
            r.keydown(ev('Control', 'ControlLeft', { ctrlKey: true }));
            r.keydown(ev('Shift', 'ShiftLeft', { ctrlKey: true, shiftKey: true }));
            r.keydown(ev('V', 'KeyV', { ctrlKey: true, shiftKey: true }));
        })).toEqual(['ctrl+shift+keyv']);
    });
    it('a key the watcher has no table entry for still records (its key name)', () => {
        expect(record(r => r.keydown(ev('MediaPlayPause', 'MediaPlayPause')))).toEqual(['mediaplaypause']);
    });
});

describe('recorder: modifiers', () => {
    it('a lone LEFT modifier is the generic one (either side), committed on release', () => {
        expect(record(r => { r.keydown(ev('Alt', 'AltLeft', { altKey: true })); r.keyup(ev('Alt', 'AltLeft')); })).toEqual(['alt']);
        expect(record(r => { r.keydown(ev('Control', 'ControlLeft', { ctrlKey: true })); r.keyup(ev('Control', 'ControlLeft')); })).toEqual(['ctrl']);
    });
    it('a lone RIGHT modifier is itself', () => {
        expect(record(r => { r.keydown(ev('Control', 'ControlRight', { ctrlKey: true })); r.keyup(ev('Control', 'ControlRight')); })).toEqual(['controlright']);
        expect(record(r => { r.keydown(ev('Shift', 'ShiftRight', { shiftKey: true })); r.keyup(ev('Shift', 'ShiftRight')); })).toEqual(['shiftright']);
    });
    it('AltGr on Windows (fake Left Ctrl + AltGraph) records as altright', () => {
        expect(record(r => {
            r.keydown(ev('Control', 'ControlLeft', { ctrlKey: true }));
            r.keydown(ev('AltGraph', 'AltRight', { ctrlKey: true, altKey: true }));
            r.keyup(ev('AltGraph', 'AltRight'));
            r.keyup(ev('Control', 'ControlLeft'));
        })).toEqual(['altright']);
    });
    it('AltGr + a key keeps altright as the modifier', () => {
        expect(record(r => {
            r.keydown(ev('Control', 'ControlLeft', { ctrlKey: true }));
            r.keydown(ev('AltGraph', 'AltRight', { ctrlKey: true, altKey: true }));
            r.keydown(ev('@', 'KeyQ', { ctrlKey: true, altKey: true }));
        })).toEqual(['altright+keyq']);
    });
    it('the Windows / Super key is "meta" (not Ctrl, as the old recorder had it); on macOS Cmd stays "ctrl"', () => {
        expect(record(r => { r.keydown(ev('Meta', 'MetaLeft', { metaKey: true })); r.keyup(ev('Meta', 'MetaLeft')); })).toEqual(['meta']);
        expect(record(r => { r.keydown(ev('Meta', 'MetaLeft', { metaKey: true })); r.keyup(ev('Meta', 'MetaLeft')); }, true)).toEqual(['ctrl']);
    });
    it('holding Ctrl on the way to Ctrl+K binds ctrl+keyk, not ctrl', () => {
        expect(record(r => {
            r.keydown(ev('Control', 'ControlLeft', { ctrlKey: true }));
            r.keydown(ev('k', 'KeyK', { ctrlKey: true }));
            r.keyup(ev('k', 'KeyK'));
            r.keyup(ev('Control', 'ControlLeft'));
        })).toEqual(['ctrl+keyk']);
    });
    it('two modifiers held then released bind the pair', () => {
        expect(record(r => {
            r.keydown(ev('Control', 'ControlLeft', { ctrlKey: true }));
            r.keydown(ev('Alt', 'AltLeft', { ctrlKey: true, altKey: true }));
            r.keyup(ev('Alt', 'AltLeft'));
        })).toEqual(['ctrl+alt']);
    });
    it('events without a code (old cases) keep the old rules', () => {
        expect(record(r => { r.keydown(ev('Alt', undefined, { altKey: true })); r.keyup(ev('Alt')); })).toEqual(['alt']);
        expect(record(r => { r.keydown(ev('Control', undefined, { ctrlKey: true })); r.keydown(ev('k', undefined, { ctrlKey: true })); })).toEqual(['ctrl+k']);
        expect(record(r => r.keydown(ev('F13')))).toEqual(['f13']);
    });
});

describe('recorder: mouse buttons', () => {
    it('middle / back / forward bind mouse3 / mouse4 / mouse5', () => {
        expect(record(r => { expect(r.mousedown(mouse(1))).toBe(true); })).toEqual(['mouse3']);
        expect(record(r => { r.mousedown(mouse(3)); })).toEqual(['mouse4']);
        expect(record(r => { r.mousedown(mouse(4)); })).toEqual(['mouse5']);
    });
    it('left and right clicks are never taken (they close the field)', () => {
        expect(record(r => { expect(r.mousedown(mouse(0))).toBe(false); expect(r.mousedown(mouse(2))).toBe(false); })).toEqual([]);
    });
    it('with a modifier held', () => {
        expect(record(r => { r.keydown(ev('Shift', 'ShiftLeft', { shiftKey: true })); r.mousedown(mouse(3, { shiftKey: true })); })).toEqual(['shift+mouse4']);
    });
});

describe('HeldInputs: matching in the focused window', () => {
    it('physical combos, including extra keys held (WASD while talking)', () => {
        const h = new HeldInputs(false);
        h.keydown(ev('w', 'KeyW'));
        h.keydown(ev('1', 'Numpad1'));
        expect(h.isHeld('numpad1')).toBe(true);
        h.keyup(ev('1', 'Numpad1'));
        expect(h.isHeld('numpad1')).toBe(false);
    });
    it('generic modifiers match either side; side-specific only that side', () => {
        const h = new HeldInputs(false);
        h.keydown(ev('Alt', 'AltRight', { altKey: true }));
        expect(h.isHeld('alt')).toBe(true);
        expect(h.isHeld('altright')).toBe(true);
        expect(h.isHeld('altleft')).toBe(false);
    });
    it('AltGraph is altright', () => {
        const h = new HeldInputs(false);
        h.keydown(ev('AltGraph', 'AltRight'));
        expect(h.isHeld('altright')).toBe(true);
    });
    it('legacy combos (KeyboardEvent.key spelling) still match', () => {
        const h = new HeldInputs(false);
        h.keydown(ev('Control', 'ControlLeft', { ctrlKey: true }));
        h.keydown(ev('Shift', 'ShiftLeft', { ctrlKey: true, shiftKey: true }));
        h.keydown(ev('V', 'KeyV', { ctrlKey: true, shiftKey: true }));
        expect(h.isHeld('ctrl+shift+v')).toBe(true);
        expect(h.isHeld('ctrl+shift+keyv')).toBe(true);
        h.keyup(ev('Shift', 'ShiftLeft'));
        expect(h.isHeld('ctrl+shift+v')).toBe(false);
        expect(h.isHeld('ctrl')).toBe(true);
    });
    it('legacy bare modifier from an event without a code', () => {
        const h = new HeldInputs(false);
        h.keydown(ev('Alt', undefined, { altKey: true }));
        expect(h.isHeld('alt')).toBe(true);
        h.keyup(ev('Alt'));
        expect(h.isHeld('alt')).toBe(false);
    });
    it('mouse buttons', () => {
        const h = new HeldInputs(false);
        h.mousedown({ button: 3 });
        expect(h.isHeld('mouse4')).toBe(true);
        expect(h.isHeld('mouse5')).toBe(false);
        h.mouseup({ button: 3 });
        expect(h.isHeld('mouse4')).toBe(false);
    });
    it('macOS: legacy "ctrl" is held by Cmd', () => {
        const h = new HeldInputs(true);
        h.keydown(ev('Meta', 'MetaLeft', { metaKey: true }));
        expect(h.isHeld('ctrl')).toBe(true);
    });
    it('clear() drops everything (blur)', () => {
        const h = new HeldInputs(false);
        h.keydown(ev('a', 'KeyA'));
        h.clear();
        expect(h.isHeld('keya')).toBe(false);
        expect(h.isHeld('a')).toBe(false);
    });
});

describe('attachFocusedHoldKey', () => {
    const target = () => {
        const ls = new Map<string, Set<(e: unknown) => void>>();
        return {
            addEventListener: (t: string, f: (e: unknown) => void) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t)!.add(f); },
            removeEventListener: (t: string, f: (e: unknown) => void) => { ls.get(t)?.delete(f); },
            fire: (t: string, e: unknown = {}) => { for (const f of ls.get(t) ?? []) f(e); },
            count: () => [...ls.values()].reduce((n, s) => n + s.size, 0),
        };
    };
    it('press on the first held moment, release once, never preventDefault', () => {
        const t = target();
        const press = vi.fn(), release = vi.fn();
        const preventDefault = vi.fn();
        const off = attachFocusedHoldKey(t as unknown as Window, 'mouse4', { press, release, systemWide: () => false });
        t.fire('mousedown', { button: 3, preventDefault });
        t.fire('mousedown', { button: 3, preventDefault });
        t.fire('mouseup', { button: 3, preventDefault });
        expect(press).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(preventDefault).not.toHaveBeenCalled();
        off();
        expect(t.count()).toBe(0);
    });
    it('blur releases only when no system-wide watcher covers the key', () => {
        for (const sys of [false, true]) {
            const t = target();
            const press = vi.fn(), release = vi.fn();
            attachFocusedHoldKey(t as unknown as Window, 'alt', { press, release, systemWide: () => sys });
            t.fire('keydown', ev('Alt', 'AltLeft', { altKey: true }));
            t.fire('blur');
            expect(release).toHaveBeenCalledTimes(sys ? 0 : 1);
        }
    });
    it('firstTimeThisCall: once per call object', () => {
        const call = {};
        expect(firstTimeThisCall(call, 'x')).toBe(true);
        expect(firstTimeThisCall(call, 'x')).toBe(false);
        expect(firstTimeThisCall({}, 'x')).toBe(true);
        expect(firstTimeThisCall(null, 'x')).toBe(false);
    });
});

describe('labels', () => {
    afterEach(() => __setLayoutLabels(null));
    it('physical and mouse tokens', () => {
        expect(holdTokenLabel('numpad1')).toBe('Num 1');
        expect(holdTokenLabel('capslock')).toBe('Caps Lock');
        expect(holdTokenLabel('altright')).toBe('Right Alt');
        expect(holdTokenLabel('mouse4')).toBe('Mouse 4');
        expect(holdTokenLabel('mouse3')).toBe('Middle mouse');
        expect(holdTokenLabel('keyq')).toBe('Q');
        expect(holdTokenLabel('unknown-token')).toBeUndefined();
    });
    it('the user layout wins for layout keys only', () => {
        __setLayoutLabels(new Map([['keyq', 'A'], ['semicolon', 'Ö'], ['numpad1', 'X']]));
        expect(holdTokenLabel('keyq')).toBe('A');
        expect(holdTokenLabel('semicolon')).toBe('Ö');
        expect(holdTokenLabel('numpad1')).toBe('Num 1');
    });
});

describe('vocabulary helpers', () => {
    it('physicalTokenOfCode knows the watcher\'s keys only', () => {
        expect(physicalTokenOfCode('Numpad1')).toBe('numpad1');
        expect(physicalTokenOfCode('MediaPlayPause')).toBeNull();
        expect(physicalTokenOfCode(undefined)).toBeNull();
    });
    it('holdComboAsKeybind compares with the keybinds\' spelling', () => {
        expect(holdComboAsKeybind('ctrl+shift+keyy')).toBe('ctrl+shift+y');
        expect(holdComboAsKeybind('ctrl+comma')).toBe('ctrl+,');
        expect(holdComboAsKeybind('numpad1')).toBe('numpad1');
    });
    it('kind and report name (diagnostics)', () => {
        expect(holdKeyKind(null)).toBe('none');
        expect(holdKeyKind('alt')).toBe('modifier');
        expect(holdKeyKind('altright')).toBe('modifier');
        expect(holdKeyKind('ctrl+shift')).toBe('combo');
        expect(holdKeyKind('numpad1')).toBe('key');
        expect(holdKeyKind('ctrl+keyv')).toBe('combo');
        expect(holdKeyKind('mouse4')).toBe('mouse');
        expect(holdKeyKind('shift+mouse5')).toBe('mouse-combo');
        expect(holdKeyReportName('ctrl+shift+keyv')).toBe('ctrl_shift_keyv');
        expect(holdKeyReportName('shift+!')).toBe('other');
        expect(holdKeyReportName(null)).toBeNull();
    });
});

describe('what the watcher said, for the user', () => {
    it('parses main\'s dry run and rejects junk', () => {
        expect(parseHoldKeySupport({ status: 'ok', backend: 'win32' })).toEqual({ status: 'ok', backend: 'win32' });
        expect(parseHoldKeySupport({ status: 'focused-only', backend: 'portal', reason: 'wayland-mouse' }))
            .toEqual({ status: 'focused-only', backend: 'portal', reason: 'wayland-mouse' });
        expect(parseHoldKeySupport({ status: 'focused-only', reason: 'made-up' })).toBeNull();
        expect(parseHoldKeySupport(null)).toBeNull();
        expect(parseHoldKeySupport('ok')).toBeNull();
    });
    it('a live set result becomes the same shape', () => {
        expect(supportFromSetResult({ ok: true, watching: true })?.status).toBe('ok');
        expect(supportFromSetResult({ ok: false, reason: 'bad-key', detail: 'wayland-modifier' })).toMatchObject({ reason: 'wayland-modifier' });
        expect(supportFromSetResult({ ok: false, reason: 'bad-key' })).toMatchObject({ reason: 'unmapped-key' });
        expect(supportFromSetResult({ ok: false, reason: 'unsupported' })).toMatchObject({ reason: 'no-watcher' });
        expect(supportFromSetResult(null)).toBeNull();
    });
    it('a note only when the key works only while focused, with the reason', () => {
        expect(holdKeyFocusNote({ status: 'ok', backend: 'win32' })).toBeNull();
        expect(holdKeyFocusNote(null)).toBeNull();
        const n = holdKeyFocusNote({ status: 'focused-only', backend: 'none', reason: 'unsupported-os' })!;
        expect(n.startsWith(HOLD_KEY_FOCUSED_ONLY_TITLE)).toBe(true);
        expect(n).toMatch(/macOS/);
        expect(holdKeyFocusNote({ status: 'focused-only', backend: 'portal', reason: 'wayland-modifier' })).toMatch(/modifier on its own/);
        expect(holdKeyFocusNote({ status: 'focused-only', backend: 'win32', reason: 'unmapped-key' })).toMatch(/press it again/);
    });
    it('the elevated-game hint names the fix', () => {
        expect(ELEVATED_GAME_HINT).toMatch(/administrator/);
        expect(ELEVATED_GAME_HINT).toMatch(/start Cipherline as administrator/);
    });
});
