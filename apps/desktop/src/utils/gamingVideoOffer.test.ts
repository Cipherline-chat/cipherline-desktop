import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    },
}));

import {
    canOffer, answerOffer, parseOfferState, readOfferState, writeOfferState, offerCopy,
    DEFAULT_OFFER_STATE, SNOOZE_MS, GAMING_VIDEO_OFFER_KEY,
} from './gamingVideoOffer';

const NOW = 1_800_000_000_000;
const gate = (over: Partial<Parameters<typeof canOffer>[0]> = {}) =>
    canOffer({ state: { ...DEFAULT_OFFER_STATE }, now: NOW, modeOn: false, shownThisCall: false, ...over });

beforeEach(() => store.clear());

describe('canOffer', () => {
    it('offers by default', () => {
        expect(gate()).toBe(true);
    });

    it('never while the mode is already on', () => {
        expect(gate({ modeOn: true })).toBe(false);
    });

    it('at most once per call', () => {
        expect(gate({ shownThisCall: true })).toBe(false);
    });

    it('"Don\'t ask again" is permanent', () => {
        expect(gate({ state: { snoozedUntil: 0, never: true }, now: NOW + 365 * SNOOZE_MS })).toBe(false);
    });

    it('"Not now" snoozes for a day, then offers again', () => {
        const state = answerOffer(DEFAULT_OFFER_STATE, 'not-now', NOW);
        expect(state.snoozedUntil).toBe(NOW + SNOOZE_MS);
        expect(gate({ state, now: NOW })).toBe(false);
        expect(gate({ state, now: NOW + SNOOZE_MS - 1 })).toBe(false);
        expect(gate({ state, now: NOW + SNOOZE_MS })).toBe(true);
    });

    it('a snooze further out than one day (clock moved back / tampered) is not honoured forever', () => {
        expect(gate({ state: { snoozedUntil: NOW + 30 * SNOOZE_MS, never: false } })).toBe(true);
    });
});

describe('answerOffer', () => {
    it('"never" keeps any snooze and sets never', () => {
        expect(answerOffer({ snoozedUntil: 5, never: false }, 'never', NOW)).toEqual({ snoozedUntil: 5, never: true });
    });
    it('"turn-on" clears the snooze (the mode itself stops further offers)', () => {
        expect(answerOffer({ snoozedUntil: NOW + 10, never: false }, 'turn-on', NOW)).toEqual({ snoozedUntil: 0, never: false });
    });
});

describe('persistence (secureLocalStore)', () => {
    it('round-trips through the store under the classified key', () => {
        writeOfferState({ snoozedUntil: NOW + 1, never: true });
        expect(JSON.parse(store.get(GAMING_VIDEO_OFFER_KEY)!)).toEqual({ snoozedUntil: NOW + 1, never: true });
        expect(readOfferState()).toEqual({ snoozedUntil: NOW + 1, never: true });
    });

    it.each([
        ['missing', null],
        ['garbage', '{nope'],
        ['an array', '[1,2]'],
        ['wrong types', '{"snoozedUntil":"tomorrow","never":"yes"}'],
        ['negative / NaN', '{"snoozedUntil":-5}'],
        ['oversized', JSON.stringify({ snoozedUntil: 1, pad: 'x'.repeat(400) })],
    ])('%s → defaults (ask again)', (_l, raw) => {
        expect(parseOfferState(raw)).toEqual(DEFAULT_OFFER_STATE);
    });
});

describe('offerCopy', () => {
    it('is honest about the FPS cost and names the setting', () => {
        const c = offerCopy(true);
        expect(c.title).toBe('Video froze while you were gaming');
        expect(c.body).toMatch(/may lower your game’s FPS/);
        expect(c.body).toContain('Prioritize call video while gaming');
        expect([c.accept, c.decline, c.never]).toEqual(['Turn on', 'Not now', 'Don’t ask again']);
    });
    it('does not claim gaming when no game is known', () => {
        expect(offerCopy(false).title).toBe('Video froze while Cipherline was in the background');
    });
});
