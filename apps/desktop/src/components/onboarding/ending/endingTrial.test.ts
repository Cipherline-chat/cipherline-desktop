import { describe, expect, it } from 'vitest';
import { decideTrialBeat, hasLiveTrial, linkOwner } from './endingTrial';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const inDays = (d: number) => new Date(NOW + d * 24 * 3600_000).toISOString();

describe('decideTrialBeat', () => {
    it('granted, no referral: the 7-day trial, no card needed', () => {
        const b = decideTrialBeat({ trialGranted: true, referralApplied: false, bonusDays: 0, now: NOW });
        expect(b).toMatchObject({ kind: 'started', days: 7, voucher: false, bonus: false });
        expect(b?.title).toBe('Your 7-day Pro trial has started.');
        expect(b?.sub).toBe('No card needed. When it ends, everything free stays free.');
    });

    it('granted with a referral bonus: 14 days, "7 days, plus 7 from Sam’s link"', () => {
        const b = decideTrialBeat({
            trialGranted: true, referralApplied: true, bonusDays: 7, referrerName: 'Sam',
            subscription: { status: 'trial', trialEndsAt: inDays(14) }, now: NOW,
        });
        expect(b).toMatchObject({ kind: 'started', days: 14, bonus: true, voucher: false });
        expect(b?.title).toBe('Your 14-day Pro trial has started.');
        expect(b?.sub).toBe('7 days, plus 7 from Sam’s link. When it ends, everything free stays free.');
    });

    it('granted with a referral but no live end date still says 14 days', () => {
        const b = decideTrialBeat({ trialGranted: true, referralApplied: true, bonusDays: 7, referrerName: 'Sam', now: NOW });
        expect(b?.title).toBe('Your 14-day Pro trial has started.');
    });

    it('withheld copy ONLY on an explicit false', () => {
        const b = decideTrialBeat({ trialGranted: false, referralApplied: false, now: NOW });
        expect(b?.kind).toBe('withheld');
        expect(b?.title).toBe('Your free trial didn’t start this time.');
        expect(b?.sub).toMatch(/^Only a few trials can start from one network each day/);
        // every other input never produces the withheld claim
        for (const trialGranted of [true, undefined]) {
            for (const status of ['trial', 'expired', 'active', null]) {
                const o = decideTrialBeat({ trialGranted, subscription: { status, trialEndsAt: null }, now: NOW });
                expect(o?.kind).not.toBe('withheld');
            }
        }
    });

    it('a referral overrides a withheld trial: 7 days, started by the link', () => {
        const b = decideTrialBeat({ trialGranted: false, referralApplied: true, bonusDays: 7, referrerName: 'Sam', now: NOW });
        expect(b).toMatchObject({ kind: 'started', days: 7, voucher: true });
        expect(b?.title).toBe('Your 7-day Pro trial has started.');
        expect(b?.sub).toBe('Started by Sam’s link. When it ends, everything free stays free.');
    });

    it('the voucher as finalize() really reports it (granted + referral, ~7 days left) is not called 14 days', () => {
        const b = decideTrialBeat({
            trialGranted: true, referralApplied: true, bonusDays: 7, referrerName: 'Sam',
            subscription: { status: 'trial', trialEndsAt: inDays(7) }, now: NOW,
        });
        expect(b).toMatchObject({ kind: 'started', days: 7, voucher: true });
        expect(b?.sub).toMatch(/^Started by Sam’s link\./);
    });

    it('a referral that gave no bonus days is not a voucher', () => {
        const b = decideTrialBeat({ trialGranted: false, referralApplied: true, bonusDays: 0, now: NOW });
        expect(b?.kind).toBe('withheld');
        const g = decideTrialBeat({ trialGranted: true, referralApplied: true, bonusDays: 0, now: NOW });
        expect(g?.title).toBe('Your 7-day Pro trial has started.');
    });

    it('unknown + live trial with an end date: days from trialEndsAt', () => {
        const b = decideTrialBeat({ subscription: { status: 'trial', trialEndsAt: inDays(6.9) }, now: NOW });
        expect(b).toMatchObject({ kind: 'started', days: 7 });
        expect(b?.title).toBe('Your 7-day Pro trial has started.');
    });

    it('unknown + live trial without an end date: "Your Pro trial has started."', () => {
        const b = decideTrialBeat({ subscription: { status: 'trial', trialEndsAt: null }, now: NOW });
        expect(b).toMatchObject({ kind: 'started', days: null });
        expect(b?.title).toBe('Your Pro trial has started.');
    });

    it('unknown + not a trial: no trial beat at all (no withheld claim)', () => {
        expect(decideTrialBeat({ subscription: { status: 'expired', trialEndsAt: null }, now: NOW })).toBeNull();
        expect(decideTrialBeat({ subscription: null, now: NOW })).toBeNull();
        expect(decideTrialBeat({ now: NOW })).toBeNull();
    });
});

describe('linkOwner', () => {
    it('capitalises the name, falls back to a neutral phrase', () => {
        expect(linkOwner('sam')).toBe('sam’s link'); // usernames are never re-cased
        expect(linkOwner('obA_x')).toBe('obA_x’s link');
        expect(linkOwner('')).toBe('your friend’s link');
        expect(linkOwner(null)).toBe('your friend’s link');
    });
});

describe('hasLiveTrial (onboarding profile card: Pro pill)', () => {
    it('shows the pill when the trial was granted', () => {
        expect(hasLiveTrial({ trialGranted: true, now: NOW })).toBe(true);
        expect(hasLiveTrial({ trialGranted: true, referralApplied: true, bonusDays: 7, now: NOW })).toBe(true);
    });

    it('does not when the trial was withheld and no referral voucher applied', () => {
        expect(hasLiveTrial({ trialGranted: false, referralApplied: false, now: NOW })).toBe(false);
        expect(hasLiveTrial({ trialGranted: false, subscription: { status: 'expired', trialEndsAt: null }, now: NOW })).toBe(false);
    });

    it('does when a referral voucher started a trial the quota withheld', () => {
        expect(hasLiveTrial({ trialGranted: false, referralApplied: true, bonusDays: 7, now: NOW })).toBe(true);
    });

    it('on a resume that lost the marker, follows the live subscription', () => {
        expect(hasLiveTrial({ subscription: { status: 'trial', trialEndsAt: inDays(5) }, now: NOW })).toBe(true);
        expect(hasLiveTrial({ subscription: { status: 'expired', trialEndsAt: null }, now: NOW })).toBe(false);
        expect(hasLiveTrial({ subscription: null, now: NOW })).toBe(false);
        expect(hasLiveTrial({ now: NOW })).toBe(false);
    });
});
