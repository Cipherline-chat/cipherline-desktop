import { describe, it, expect } from 'vitest';
import {
    TYPING_EXPIRY_MS,
    recordTypingStart,
    recordTypingStop,
    clearTypingForUser,
    pruneExpiredTyping,
    toTypingUsersView,
    typingSendDecision,
    TYPING_START_MIN_GAP_MS,
    TYPING_REFRESH_MIN_MS,
    type TypingTimestamps,
} from './typingStore';

const CONV_A = 'conv-a';
const CONV_B = 'conv-b';
const NORI = 'user-nori';
const ALICE = 'user-alice';

describe('typingStore', () => {
    describe('recordTypingStart / recordTypingStop / toTypingUsersView', () => {
        it('shows a user as typing after a start and not after a stop', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            expect(toTypingUsersView(state)).toEqual({ [CONV_A]: new Set([NORI]) });

            state = recordTypingStop(state, CONV_A, NORI);
            expect(toTypingUsersView(state)).toEqual({});
        });

        it('recordTypingStop on a user who was never typing is a no-op (same reference)', () => {
            const state: TypingTimestamps = { [CONV_A]: { [NORI]: 1000 } };
            const next = recordTypingStop(state, CONV_A, ALICE);
            expect(next).toBe(state);
        });

        it('tracks multiple users per conversation and multiple conversations independently', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            state = recordTypingStart(state, CONV_A, ALICE, 1000);
            state = recordTypingStart(state, CONV_B, NORI, 1000);

            expect(toTypingUsersView(state)).toEqual({
                [CONV_A]: new Set([NORI, ALICE]),
                [CONV_B]: new Set([NORI]),
            });

            state = recordTypingStop(state, CONV_A, NORI);
            expect(toTypingUsersView(state)).toEqual({
                [CONV_A]: new Set([ALICE]),
                [CONV_B]: new Set([NORI]),
            });
        });
    });

    describe('pruneExpiredTyping — the stale-indicator fix', () => {
        it('keeps a user typing while their last start is within the expiry window', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            // Just under the expiry.
            const pruned = pruneExpiredTyping(state, 1000 + TYPING_EXPIRY_MS - 1);
            expect(toTypingUsersView(pruned)).toEqual({ [CONV_A]: new Set([NORI]) });
        });

        it('drops a user once no fresh start has arrived within the expiry window (POSITIVE CONTROL for the shipped bug)', () => {
            // This reproduces the exact reported bug: nori's app closed after
            // its last `typing:start`, so no `typing:stop` was ever sent.
            // Before the fix, the receiver had no expiry at all and this
            // entry would never clear. Temporarily reverting the fix (making
            // this assertion fail) is the positive control called for in the
            // task's verification step.
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            const now = 1000 + TYPING_EXPIRY_MS;
            const pruned = pruneExpiredTyping(state, now);
            expect(toTypingUsersView(pruned)).toEqual({});
        });

        it('only expires the stale user, leaving a freshly-refreshed one in the same conversation', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000); // stale
            state = recordTypingStart(state, CONV_A, ALICE, 1000 + TYPING_EXPIRY_MS - 500); // fresh refresh
            const now = 1000 + TYPING_EXPIRY_MS;
            const pruned = pruneExpiredTyping(state, now);
            expect(toTypingUsersView(pruned)).toEqual({ [CONV_A]: new Set([ALICE]) });
        });

        it('is a no-op (returns the same reference) when nothing has expired', () => {
            const state: TypingTimestamps = { [CONV_A]: { [NORI]: 1000 } };
            const pruned = pruneExpiredTyping(state, 1000 + 10);
            expect(pruned).toBe(state);
        });

        it('is a no-op on an empty store', () => {
            const state: TypingTimestamps = {};
            const pruned = pruneExpiredTyping(state, 999_999);
            expect(pruned).toBe(state);
        });

        it('honors a custom expiry window', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            const pruned = pruneExpiredTyping(state, 1000 + 500, 400);
            expect(toTypingUsersView(pruned)).toEqual({});
        });
    });

    describe('clearTypingForUser — the presence-offline path', () => {
        it('drops a user from every conversation they were typing in', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            state = recordTypingStart(state, CONV_B, NORI, 1000);
            state = recordTypingStart(state, CONV_A, ALICE, 1000);

            const cleared = clearTypingForUser(state, NORI);
            expect(toTypingUsersView(cleared)).toEqual({ [CONV_A]: new Set([ALICE]) });
        });

        it('is a no-op (same reference) when the user was not typing anywhere', () => {
            const state: TypingTimestamps = { [CONV_A]: { [ALICE]: 1000 } };
            const cleared = clearTypingForUser(state, NORI);
            expect(cleared).toBe(state);
        });

        it('going offline clears the indicator immediately, even well inside the expiry window', () => {
            // This is the scenario the expiry alone does NOT cover: nori
            // disconnects right after typing, and the server's presence
            // signal arrives long before TYPING_EXPIRY_MS would have elapsed.
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000);
            const cleared = clearTypingForUser(state, NORI);
            expect(toTypingUsersView(cleared)).toEqual({});
        });
    });

    describe('typing traffic throttles (perf)', () => {
        it('puts at most one typing:start per conversation per second on the wire; stop always goes and re-arms', () => {
            const last = new Map<string, number>();
            const sent: string[] = [];
            // 10 keystrokes/s for 2.5 s in one conversation.
            for (let t = 0; t < 2500; t += 100) if (typingSendDecision(last, 'typing:start', CONV_A, t)) sent.push(`start@${t}`);
            expect(sent).toEqual(['start@0', 'start@1000', 'start@2000']);
            // Another conversation is independent.
            expect(typingSendDecision(last, 'typing:start', CONV_B, 2400)).toBe(true);
            // Stop always goes, and the next start is immediate.
            expect(typingSendDecision(last, 'typing:stop', CONV_A, 2450)).toBe(true);
            expect(typingSendDecision(last, 'typing:start', CONV_A, 2460)).toBe(true);
        });

        it('a receiver never sees a gap longer than the expiry while someone keeps typing', () => {
            // Worst case: keystrokes just under the 3 s stop timeout apart, right
            // after a start went out, plus the receiver's coalescing window.
            expect(TYPING_START_MIN_GAP_MS + 3000 + TYPING_REFRESH_MIN_MS).toBeLessThan(TYPING_EXPIRY_MS);
        });

        it('a refresh inside TYPING_REFRESH_MIN_MS keeps the same state object (no re-render)', () => {
            let state: TypingTimestamps = {};
            state = recordTypingStart(state, CONV_A, NORI, 1000, TYPING_REFRESH_MIN_MS);
            const same = recordTypingStart(state, CONV_A, NORI, 1000 + TYPING_REFRESH_MIN_MS - 1, TYPING_REFRESH_MIN_MS);
            expect(same).toBe(state);
            const later = recordTypingStart(state, CONV_A, NORI, 1000 + TYPING_REFRESH_MIN_MS, TYPING_REFRESH_MIN_MS);
            expect(later).not.toBe(state);
            expect(later[CONV_A][NORI]).toBe(1000 + TYPING_REFRESH_MIN_MS);
            // A different user is never coalesced away.
            expect(recordTypingStart(state, CONV_A, ALICE, 1001, TYPING_REFRESH_MIN_MS)).not.toBe(state);
            // Default (no window) still always records.
            expect(recordTypingStart(state, CONV_A, NORI, 1001)).not.toBe(state);
        });
    });
});
