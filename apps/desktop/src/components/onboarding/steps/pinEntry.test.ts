import { describe, expect, it } from 'vitest';
import {
    MISMATCH_NOTE, SAVE_FAILED_NOTE, initialPinState, isEntering, pinHeadline, pinLockedHere, pinReducer, pinToggleOn,
    type PinAction, type PinEntryState,
} from './pinEntry';

const run = (s: PinEntryState, ...actions: PinAction[]) => actions.reduce(pinReducer, s);
const OFF = initialPinState({ enabled: false, pinLength: 6 });

describe('pinEntry: initial state comes from useScreenLock', () => {
    it('lock off: off, 6 digits by default (as ScreenLockSettings setup)', () => {
        expect(OFF).toMatchObject({ stage: 'off', len: 6, first: '', val: '' });
        expect(pinToggleOn(OFF)).toBe(false);
        // a stale 4-digit length from an earlier lock does not leak into a fresh setup
        expect(initialPinState({ enabled: false, pinLength: 4 }).len).toBe(6);
    });
    it('lock already on (Back / resume): set, PIN not in memory, no off switch here', () => {
        const s = initialPinState({ enabled: true, pinLength: 4 });
        expect(s).toMatchObject({ stage: 'done', len: 4, first: '' });
        expect(pinToggleOn(s)).toBe(true);
        expect(pinLockedHere(s)).toBe(true);
    });
});

describe('pinEntry: the happy path', () => {
    it('6 digits: pick, confirm, saving carries the PIN, saved keeps it for turning off', () => {
        let s = run(OFF, { type: 'turnOn' });
        expect(s.stage).toBe('first');
        expect(pinHeadline(s)).toBe('Pick a 6-digit PIN');
        s = run(s, { type: 'type', raw: '12345' }, { type: 'commitFirst' });
        expect(s.stage).toBe('first'); // incomplete: commit is a no-op
        s = run(s, { type: 'type', raw: '123456' }, { type: 'commitFirst' });
        expect(s).toMatchObject({ stage: 'again', first: '123456', val: '' });
        expect(pinHeadline(s)).toBe('Once more to confirm');
        s = run(s, { type: 'type', raw: '123456' }, { type: 'confirm' });
        expect(s).toMatchObject({ stage: 'saving', first: '123456', len: 6 });
        expect(isEntering(s)).toBe(true);
        s = run(s, { type: 'saved' });
        expect(s).toMatchObject({ stage: 'done', first: '123456', val: '' });
        expect(pinLockedHere(s)).toBe(false);
        s = run(s, { type: 'turnedOff' });
        expect(s).toMatchObject({ stage: 'off', first: '', val: '' });
    });
    it('4 digits: the length choice resets the entry and drives the headline', () => {
        let s = run(OFF, { type: 'turnOn' }, { type: 'type', raw: '99' }, { type: 'setLength', len: 4 });
        expect(s).toMatchObject({ stage: 'first', len: 4, val: '' });
        expect(pinHeadline(s)).toBe('Pick a 4-digit PIN');
        s = run(s, { type: 'type', raw: '4821' }, { type: 'commitFirst' }, { type: 'type', raw: '4821' }, { type: 'confirm' }, { type: 'saved' });
        expect(s).toMatchObject({ stage: 'done', len: 4, first: '4821' });
    });
    it('the length cannot change once confirming', () => {
        const s = run(OFF, { type: 'turnOn' }, { type: 'type', raw: '123456' }, { type: 'commitFirst' }, { type: 'setLength', len: 4 });
        expect(s).toMatchObject({ stage: 'again', len: 6 });
    });
});

describe('pinEntry: input boundaries', () => {
    it('keeps digits only and clips to the length', () => {
        const s = run(OFF, { type: 'turnOn' }, { type: 'type', raw: '1a2 3-4567890' });
        expect(s.val).toBe('123456');
    });
    it('typing is ignored while off, saving or set', () => {
        expect(run(OFF, { type: 'type', raw: '1' }).val).toBe('');
        const set = initialPinState({ enabled: true, pinLength: 6 });
        expect(run(set, { type: 'type', raw: '1' })).toBe(set);
    });
});

describe('pinEntry: mismatch', () => {
    it('flags, then resets to the first entry with the note, keeping the length', () => {
        let s = run(OFF, { type: 'turnOn' }, { type: 'setLength', len: 4 }, { type: 'type', raw: '1111' }, { type: 'commitFirst' }, { type: 'type', raw: '2222' }, { type: 'confirm' });
        expect(s).toMatchObject({ stage: 'again', mismatch: true });
        expect(run(s, { type: 'type', raw: '3' })).toBe(s); // frozen while red
        s = run(s, { type: 'mismatchReset' });
        expect(s).toMatchObject({ stage: 'first', len: 4, first: '', val: '', mismatch: false });
        expect(pinHeadline(s)).toBe(MISMATCH_NOTE);
        s = run(s, { type: 'type', raw: '5' });
        expect(pinHeadline(s)).toBe(MISMATCH_NOTE);
        s = run(s, { type: 'type', raw: '5555' }, { type: 'commitFirst' });
        expect(pinHeadline(s)).toBe('Once more to confirm');
    });
});

describe('pinEntry: leaving and cancelling never save', () => {
    it.each(['cancel', 'leave'] as const)('%s mid-entry turns it back off and drops what was typed', (type) => {
        const mid = run(OFF, { type: 'turnOn' }, { type: 'type', raw: '123456' }, { type: 'commitFirst' }, { type: 'type', raw: '12' });
        const s = run(mid, { type });
        expect(s).toMatchObject({ stage: 'off', first: '', val: '' });
        expect(pinToggleOn(s)).toBe(false);
    });
    it('leave does not undo a set PIN', () => {
        const set = initialPinState({ enabled: true, pinLength: 6 });
        expect(run(set, { type: 'leave' })).toBe(set);
    });
    it('a failed save goes back to picking, with a note, and forgets the PIN', () => {
        const s = run(OFF, { type: 'turnOn' }, { type: 'type', raw: '123456' }, { type: 'commitFirst' }, { type: 'type', raw: '123456' }, { type: 'confirm' }, { type: 'saveFailed' });
        expect(s).toMatchObject({ stage: 'first', first: '', val: '' });
        expect(pinHeadline(s)).toBe(SAVE_FAILED_NOTE);
    });
});
