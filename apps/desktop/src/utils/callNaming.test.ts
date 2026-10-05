import { describe, it, expect } from 'vitest';
import { DEFAULT_CALL_NAMING, CALL_NAMES_LOCKED, CALL_RENAME_MANAGERS_ONLY, type CallNamingSettings } from '@cipherline/shared';
import {
    callNamingOf, liveCallTitle, canRenameHuddleCall, isQuietRenameRefusal,
    callNamingFormError, callNamingPayload, callNamingEqual, previewCallNames,
} from './callNaming';

const s = (over: Partial<CallNamingSettings> = {}): CallNamingSettings => ({ ...DEFAULT_CALL_NAMING, ...over });

describe('callNamingOf', () => {
    it('a channel from an older API (no field) reads as the defaults', () => {
        expect(callNamingOf({})).toEqual(DEFAULT_CALL_NAMING);
        expect(callNamingOf(null)).toEqual(DEFAULT_CALL_NAMING);
        expect(callNamingOf({ call_naming: { game: 'off' } }).game).toBe('off');
    });
});

describe('liveCallTitle — the client never shows a game when the channel says no', () => {
    const games: Record<string, string | null> = { me: 'Elden Ring', a: 'Elden Ring', b: null };
    const gameOf = (u: string) => games[u] ?? null;

    it('default: the game replaces the name while half the call plays it (unchanged behaviour)', () => {
        expect(liveCallTitle("Dawson's Call", ['me', 'b'], s(), gameOf)).toBe('Elden Ring');
        expect(liveCallTitle("Dawson's Call", ['me', 'b', 'x'], s(), gameOf)).toBe("Dawson's Call");
    });

    it('off / locked: the stored name, and presence is not even consulted', () => {
        let asked = 0;
        const spy = (u: string) => { asked++; return gameOf(u); };
        expect(liveCallTitle("Dawson's Call", ['me', 'a'], s({ game: 'off' }), spy)).toBe("Dawson's Call");
        expect(liveCallTitle("Dawson's Call", ['me', 'a'], s({ locked: true }), spy)).toBe("Dawson's Call");
        expect(asked).toBe(0);
    });
});

describe('canRenameHuddleCall — mirrors the server rule', () => {
    it.each([
        ['default, starter', s(), true, false, true],
        ['default, manager', s(), false, true, true],
        ['default, neither', s(), false, false, false],
        ['starters off, starter', s({ starter_can_rename: false }), true, false, false],
        ['starters off, starter who manages', s({ starter_can_rename: false }), true, true, true],
        ['locked, manager', s({ locked: true }), true, true, false],
    ])('%s', (_l, setting, isStarter, canManageChannels, expected) => {
        expect(canRenameHuddleCall(setting, { isStarter, canManageChannels })).toBe(expected);
    });
});

describe('isQuietRenameRefusal', () => {
    it('recognises exactly the two policy codes', () => {
        expect(isQuietRenameRefusal({ response: { status: 409, data: { code: CALL_NAMES_LOCKED } } })).toBe(true);
        expect(isQuietRenameRefusal({ response: { status: 403, data: { code: CALL_RENAME_MANAGERS_ONLY } } })).toBe(true);
        expect(isQuietRenameRefusal({ response: { status: 403, data: { message: 'nope' } } })).toBe(false);
        expect(isQuietRenameRefusal(new Error('network'))).toBe(false);
    });
});

describe('settings form helpers', () => {
    it('empty boxes are "not set"; the defaults are valid', () => {
        expect(callNamingFormError(s({ fixed_name: '', template: '' }))).toBeNull();
        expect(callNamingPayload(s({ fixed_name: '  ', template: '' }))).toEqual(DEFAULT_CALL_NAMING);
    });

    it('the selected style\'s box must be valid', () => {
        expect(callNamingFormError(s({ style: 'template', template: '' }))).toMatch(/Enter a template/);
        expect(callNamingFormError(s({ style: 'template', template: '{game}' }))).toMatch(/Unknown placeholder/);
        expect(callNamingFormError(s({ style: 'fixed', fixed_name: 'Raid 🎮' }))).toMatch(/letters, numbers/);
        expect(callNamingFormError(s({ style: 'fixed', fixed_name: '' }))).toBeNull(); // = channel name
    });

    it('a half-typed value in a box that is NOT selected is dropped, not blocking', () => {
        const d = s({ style: 'host', template: 'Squad {n' });
        expect(callNamingFormError(d)).toBeNull();
        expect(callNamingPayload(d).template).toBeNull();
        expect(callNamingPayload(s({ style: 'host', template: 'Squad {n}' })).template).toBe('Squad {n}');
    });

    it('equality ignores empty-vs-null and surrounding spaces', () => {
        expect(callNamingEqual(s({ fixed_name: '' }), s())).toBe(true);
        expect(callNamingEqual(s({ template: ' A ' }), s({ template: 'A' }))).toBe(true);
        expect(callNamingEqual(s({ locked: true }), s())).toBe(false);
    });

    it('preview: the example line for each choice', () => {
        const ctx = { host: 'Alex', channel: 'General', game: 'Elden Ring' };
        expect(previewCallNames(s(), ctx)).toEqual({ start: "Alex's Call", whilePlaying: 'Elden Ring' });
        expect(previewCallNames(s({ style: 'numbered', game: 'off' }), ctx)).toEqual({ start: 'General 1', whilePlaying: null });
        expect(previewCallNames(s({ style: 'template', template: '{host} in {channel}' }), ctx))
            .toEqual({ start: 'Alex in General', whilePlaying: 'Elden Ring' });
        expect(previewCallNames(s({ locked: true }), ctx)).toEqual({ start: "Alex's Call", whilePlaying: null });
    });
});
