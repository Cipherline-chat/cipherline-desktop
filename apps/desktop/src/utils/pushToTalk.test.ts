import { describe, it, expect, beforeEach } from 'vitest';
import {
    PTT_NO_KEY_HINT, eventCombo, pttPressed, pttReleased, createComboRecorder,
    pttMicDisplay, selfMicShownMuted, getPttUiState, setPttUiState, resetPttUiState,
    type PttUiState,
} from './pushToTalk';

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('push-to-talk key matching', () => {
    it('the no-key hint says nothing transmits until a key is set', () => {
        expect(PTT_NO_KEY_HINT).toMatch(/Choose a key/);
        expect(PTT_NO_KEY_HINT).toMatch(/Nothing transmits/);
    });

    it('a bare modifier press spells the modifier combo', () => {
        expect(eventCombo(ev('Alt', { altKey: true }))).toBe('alt');
        expect(pttPressed(ev('Alt', { altKey: true }), 'alt')).toBe(true);
        expect(pttPressed(ev('Control', { ctrlKey: true }), 'alt')).toBe(false);
    });

    it('a normal combo needs its modifiers and its key', () => {
        expect(pttPressed(ev('v', { ctrlKey: true, shiftKey: true }), 'ctrl+shift+v')).toBe(true);
        expect(pttPressed(ev('v', { ctrlKey: true }), 'ctrl+shift+v')).toBe(false);
        expect(pttPressed(ev(' '), 'space')).toBe(true);
    });

    it('release: letting go of ANY key of the combo ends it (the modifier flag is already false then)', () => {
        expect(pttReleased(ev('Alt'), 'alt')).toBe(true);
        expect(pttReleased(ev('Shift'), 'ctrl+shift+v')).toBe(true);
        expect(pttReleased(ev('V'), 'ctrl+shift+v')).toBe(true);
        expect(pttReleased(ev('Meta'), 'ctrl')).toBe(true);
        expect(pttReleased(ev('x'), 'ctrl+shift+v')).toBe(false);
        expect(pttReleased(ev('Alt'), 'v')).toBe(false);
    });
});

describe('combo recorder (bare modifiers can be bound)', () => {
    it('Alt pressed and released alone binds "alt"', () => {
        const got: string[] = [];
        const r = createComboRecorder(c => got.push(c));
        r.keydown(ev('Alt', { altKey: true }));
        expect(got).toEqual([]);
        r.keyup(ev('Alt'));
        expect(got).toEqual(['alt']);
    });

    it('holding Ctrl on the way to Ctrl+K binds ctrl+k, not ctrl', () => {
        const got: string[] = [];
        const r = createComboRecorder(c => got.push(c));
        r.keydown(ev('Control', { ctrlKey: true }));
        r.keydown(ev('k', { ctrlKey: true }));
        r.keyup(ev('k', { ctrlKey: true }));
        r.keyup(ev('Control'));
        expect(got).toEqual(['ctrl+k']);
    });

    it('two modifiers held then released bind the pair', () => {
        const got: string[] = [];
        const r = createComboRecorder(c => got.push(c));
        r.keydown(ev('Control', { ctrlKey: true }));
        r.keydown(ev('Alt', { ctrlKey: true, altKey: true }));
        r.keyup(ev('Alt', { ctrlKey: true }));
        r.keyup(ev('Control'));
        expect(got).toEqual(['ctrl+alt']);
    });

    it('a plain key binds immediately', () => {
        const got: string[] = [];
        createComboRecorder(c => got.push(c)).keydown(ev('F13'));
        expect(got).toEqual(['f13']);
    });
});

describe('what the self mic indicator shows', () => {
    const s = (p: Partial<PttUiState>): PttUiState => ({ active: false, keyDown: false, manualMuted: false, recording: false, ...p });

    it('outside push-to-talk the real mute state is shown', () => {
        expect(pttMicDisplay(s({}), true)).toBe('normal');
        expect(selfMicShownMuted(s({}), false)).toBe(true);
        expect(selfMicShownMuted(s({}), true)).toBe(false);
    });

    it('push-to-talk waiting for the key is idle (grey), never muted, though the mic track is off', () => {
        expect(pttMicDisplay(s({ active: true }), false)).toBe('idle');
        expect(selfMicShownMuted(s({ active: true }), false)).toBe(false);
    });

    it('holding the key with the mic live is held (green)', () => {
        expect(pttMicDisplay(s({ active: true, keyDown: true }), true)).toBe('held');
        expect(selfMicShownMuted(s({ active: true, keyDown: true }), true)).toBe(false);
    });

    it('key down but the mic is not live yet is still idle (do not claim to transmit early)', () => {
        expect(pttMicDisplay(s({ active: true, keyDown: true }), false)).toBe('idle');
    });

    it('a deliberate Mute in push-to-talk is muted (red) even while the key is down', () => {
        expect(pttMicDisplay(s({ active: true, manualMuted: true }), false)).toBe('muted');
        expect(pttMicDisplay(s({ active: true, manualMuted: true, keyDown: true }), true)).toBe('muted');
        expect(selfMicShownMuted(s({ active: true, manualMuted: true }), false)).toBe(true);
    });
});

describe('ptt ui store', () => {
    beforeEach(() => { setPttUiState({ recording: false }); resetPttUiState(); });
    it('updates, and reset clears everything but an open recorder', () => {
        setPttUiState({ active: true, keyDown: true, manualMuted: true, recording: true });
        expect(getPttUiState()).toEqual({ active: true, keyDown: true, manualMuted: true, recording: true });
        resetPttUiState();
        expect(getPttUiState()).toEqual({ active: false, keyDown: false, manualMuted: false, recording: true });
        setPttUiState({ recording: false });
        expect(getPttUiState().recording).toBe(false);
    });
});
