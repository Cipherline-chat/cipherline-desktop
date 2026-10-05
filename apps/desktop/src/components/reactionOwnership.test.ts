import { describe, it, expect } from 'vitest';
import { isMyReaction } from './reactionOwnership';

const DEVICES = new Set(['dev-1', 'dev-2']);

describe('isMyReaction', () => {
    it('matches a server-channel reaction keyed by user_id', () => {
        // The regression: this is the case the toggle used to miss entirely,
        // so clicking your own reaction in a server re-added it.
        expect(isMyReaction(['user-me'], 'user-me', DEVICES)).toBe(true);
    });

    it('matches a DM/group reaction keyed by device_id', () => {
        expect(isMyReaction(['dev-2'], 'user-me', DEVICES)).toBe(true);
    });

    it('matches when any of this user\'s devices reacted', () => {
        expect(isMyReaction(['someone', 'dev-1'], 'user-me', DEVICES)).toBe(true);
    });

    it('is false for other people only', () => {
        expect(isMyReaction(['user-them', 'dev-other'], 'user-me', DEVICES)).toBe(false);
    });

    it('is false on an empty reactor list', () => {
        expect(isMyReaction([], 'user-me', DEVICES)).toBe(false);
    });

    it('still works with no user id (device-only identity)', () => {
        expect(isMyReaction(['dev-1'], null, DEVICES)).toBe(true);
        expect(isMyReaction(['user-me'], null, DEVICES)).toBe(false);
    });

    it('does not treat an undefined user id as matching an undefined-ish entry', () => {
        expect(isMyReaction([''], undefined, new Set())).toBe(false);
    });
});
