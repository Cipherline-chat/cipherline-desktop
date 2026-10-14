import { describe, it, expect } from 'vitest';
import {
    proTierOf, isActivePaid, shouldCelebratePro, observeProStatus, recordProPurchase, proSeenKey, parseProTier,
    type ProStatusLike, type ProTier,
} from './proCelebration';

const st = (subscription_status: string, has_subscription = true): ProStatusLike => ({ subscription_status, has_subscription });
const memStore = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
};

describe('proTierOf', () => {
    it('counts every paid-for Stripe state as pro, so leaving one is not a "purchase"', () => {
        expect(proTierOf(st('active'))).toBe('pro');
        expect(proTierOf(st('canceled_pending'))).toBe('pro');
        expect(proTierOf(st('past_due'))).toBe('pro');
    });
    it('trial, expired and a comp (no Stripe subscription) are free', () => {
        expect(proTierOf(st('trial'))).toBe('free');
        expect(proTierOf(st('expired'))).toBe('free');
        expect(proTierOf(st('active', false))).toBe('free'); // admin comp
        // subscription-intent creates an incomplete subscription before payment
        expect(proTierOf(st('trial', true))).toBe('free');
    });
    it('isActivePaid needs both the subscription and active', () => {
        expect(isActivePaid(st('active'))).toBe(true);
        expect(isActivePaid(st('active', false))).toBe(false);
        expect(isActivePaid(st('canceled_pending'))).toBe(false);
    });
});

describe('shouldCelebratePro — decision table', () => {
    const rows: Array<[ProTier | null, ProStatusLike, boolean, boolean, string]> = [
        ['free', st('active'), false, true, 'free → paid observed (website / hosted checkout / trial → paid)'],
        ['free', st('active'), true, true, 'free → paid while a hosted checkout is pending'],
        [null, st('active'), false, false, 'first look on a NEW device at an existing subscriber'],
        [null, st('active'), true, true, 'first look, but this session opened the hosted checkout'],
        ['pro', st('active'), false, false, 'already pro (reload / HMR / poll)'],
        ['pro', st('active'), true, false, 'already pro even with a stale pending flag'],
        ['free', st('trial'), false, false, 'still on trial'],
        ['free', st('expired'), true, false, 'checkout opened but not paid'],
        ['free', st('active', false), false, false, 'comp grant is not a purchase'],
        ['free', st('canceled_pending'), false, false, 'not active'],
    ];
    for (const [prev, status, pending, want, why] of rows) {
        it(`${why} → ${want}`, () => { expect(shouldCelebratePro(prev, status, pending)).toBe(want); });
    }
});

describe('observeProStatus — once per purchase', () => {
    it('records the first observation without celebrating, then fires once on the free → paid edge', () => {
        const s = memStore();
        expect(observeProStatus(s, 'u1', st('trial'), false)).toBe(false);
        expect(s.m.get(proSeenKey('u1'))).toBe('free');
        expect(observeProStatus(s, 'u1', st('active'), false)).toBe(true);
        expect(s.m.get(proSeenKey('u1'))).toBe('pro');
        // reload / HMR / the next 5-minute poll: never again
        expect(observeProStatus(s, 'u1', st('active'), false)).toBe(false);
        expect(observeProStatus(s, 'u1', st('active'), true)).toBe(false);
    });
    it('cancel → resume and past_due → fixed do not replay it; lapse → resubscribe does', () => {
        const s = memStore({ [proSeenKey('u1')]: 'pro' });
        expect(observeProStatus(s, 'u1', st('canceled_pending'), false)).toBe(false);
        expect(observeProStatus(s, 'u1', st('active'), false)).toBe(false);
        expect(observeProStatus(s, 'u1', st('past_due'), false)).toBe(false);
        expect(observeProStatus(s, 'u1', st('active'), false)).toBe(false);
        expect(observeProStatus(s, 'u1', st('expired'), false)).toBe(false);
        expect(observeProStatus(s, 'u1', st('active'), false)).toBe(true); // a new purchase
    });
    it('is per account', () => {
        const s = memStore({ [proSeenKey('a')]: 'free' });
        expect(observeProStatus(s, 'b', st('active'), false)).toBe(false);
        expect(observeProStatus(s, 'a', st('active'), false)).toBe(true);
    });
    it('recordProPurchase pre-empts the status observer (in-app checkout path)', () => {
        const s = memStore({ [proSeenKey('u1')]: 'free' });
        recordProPurchase(s, 'u1');
        expect(observeProStatus(s, 'u1', st('active'), false)).toBe(false);
    });
    it('treats an unreadable or garbage record as "no record" and survives a throwing store', () => {
        expect(parseProTier('1')).toBeNull(); // the old pro_welcomed flag value
        const throwing = { getItem: () => { throw new Error('locked'); }, setItem: () => { throw new Error('locked'); } };
        expect(observeProStatus(throwing, 'u1', st('active'), false)).toBe(false);
        expect(observeProStatus(throwing, 'u1', st('active'), true)).toBe(true);
    });
});
