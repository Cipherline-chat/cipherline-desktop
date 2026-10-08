import { describe, expect, it } from 'vitest';
import { MAX_REFERRAL_REWARDS, capitalize, joinEarnedBonus, joinTally, splitReferralLink } from './inviteText';

describe('splitReferralLink', () => {
    it('splits the host path from the code', () => {
        expect(splitReferralLink('https://cipherline.chat/ref/7C41E9A2')).toEqual({ prefix: 'cipherline.chat/ref/', code: '7C41E9A2' });
    });
    it('tolerates http, a trailing slash and another origin', () => {
        expect(splitReferralLink('http://staging.cipherline.chat/ref/ABCDEF01/')).toEqual({ prefix: 'staging.cipherline.chat/ref/', code: 'ABCDEF01' });
    });
    it('a bare code has no prefix', () => {
        expect(splitReferralLink('7C41E9A2')).toEqual({ prefix: '', code: '7C41E9A2' });
    });
});

describe('joinTally', () => {
    it('counts down to the reward cap', () => {
        expect(joinTally(1)).toBe(' One down, four to go.');
        expect(joinTally(4)).toBe(' Four down, one to go.');
    });
    it('says nothing at or past the cap, or when unknown', () => {
        expect(joinTally(MAX_REFERRAL_REWARDS)).toBe('');
        expect(joinTally(9)).toBe('');
        expect(joinTally(0)).toBe('');
        expect(joinTally(null)).toBe('');
        expect(joinTally(1.5)).toBe('');
    });
});

describe('joinEarnedBonus', () => {
    it('is true up to and including the fifth sign-up', () => {
        expect(joinEarnedBonus(1)).toBe(true);
        expect(joinEarnedBonus(MAX_REFERRAL_REWARDS)).toBe(true);
    });
    it('is false past the cap or when the count is unknown', () => {
        expect(joinEarnedBonus(MAX_REFERRAL_REWARDS + 1)).toBe(false);
        expect(joinEarnedBonus(null)).toBe(false);
        expect(joinEarnedBonus(0)).toBe(false);
    });
});

describe('capitalize', () => {
    it('upper-cases the first letter only', () => {
        expect(capitalize('sam')).toBe('Sam');
        expect(capitalize('night_owl')).toBe('Night_owl');
        expect(capitalize('')).toBe('');
    });
});
