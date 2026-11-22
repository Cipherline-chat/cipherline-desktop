import { describe, it, expect, beforeEach } from 'vitest';
import {
    PTT_NO_KEY_HINT,
    pttMicDisplay, selfMicShownMuted, getPttUiState, setPttUiState, resetPttUiState,
    type PttUiState,
} from './pushToTalk';

// Key recording and matching moved to utils/holdKeys.ts (holdKeys.test.ts carries the old cases too).
describe('push-to-talk no-key hint', () => {
    it('says nothing transmits until a key is set', () => {
        expect(PTT_NO_KEY_HINT).toMatch(/Choose a key/);
        expect(PTT_NO_KEY_HINT).toMatch(/Nothing transmits/);
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
