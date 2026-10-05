import { describe, it, expect, vi } from 'vitest';
import { parseReferralRedeemed, referralRedeemedBus } from './referralEvents';

const GOOD = { username: 'frodo', discriminator: 1111, redeemed_at: '2026-10-04T00:00:00.000Z' };

describe('parseReferralRedeemed', () => {
    it('accepts the server payload', () => {
        expect(parseReferralRedeemed(GOOD)).toEqual(GOOD);
        expect(parseReferralRedeemed({ ...GOOD, discriminator: null })).toEqual({ ...GOOD, discriminator: null });
    });

    it('passes through ONLY the three public fields (extra keys are dropped)', () => {
        const ev = parseReferralRedeemed({ ...GOOD, user_id: 'secret-id', email: 'x@y.z' });
        expect(Object.keys(ev!).sort()).toEqual(['discriminator', 'redeemed_at', 'username']);
    });

    it.each([
        ['null', null], ['a string', 'x'], ['empty object', {}],
        ['no username', { ...GOOD, username: '' }],
        ['non-string username', { ...GOOD, username: 7 }],
        ['huge username', { ...GOOD, username: 'a'.repeat(65) }],
        ['discriminator out of range', { ...GOOD, discriminator: 10000 }],
        ['discriminator not an integer', { ...GOOD, discriminator: 1.5 }],
        ['discriminator a string', { ...GOOD, discriminator: '1111' }],
        ['bad timestamp', { ...GOOD, redeemed_at: 'not a date' }],
        ['missing timestamp', { username: 'frodo', discriminator: 1 }],
    ])('drops a malformed frame: %s', (_l, data) => {
        expect(parseReferralRedeemed(data)).toBeNull();
    });
});

describe('referralRedeemedBus', () => {
    it('delivers to subscribers until they unsubscribe', () => {
        const a = vi.fn(); const b = vi.fn();
        const offA = referralRedeemedBus.subscribe(a);
        const offB = referralRedeemedBus.subscribe(b);
        referralRedeemedBus.emit(GOOD);
        offA();
        referralRedeemedBus.emit(GOOD);
        offB();
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(2);
    });

    it('a throwing listener does not starve the others', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const good = vi.fn();
        const offBad = referralRedeemedBus.subscribe(() => { throw new Error('boom'); });
        const offGood = referralRedeemedBus.subscribe(good);
        referralRedeemedBus.emit(GOOD);
        offBad(); offGood(); err.mockRestore();
        expect(good).toHaveBeenCalledWith(GOOD);
    });
});
