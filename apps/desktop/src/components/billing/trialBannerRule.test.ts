import { describe, it, expect } from 'vitest';
import { isTrialBannerEligible } from './trialBannerRule';

const base = { subscription_status: 'trial', effective_status: 'active', is_comp: false };

describe('isTrialBannerEligible', () => {
    it('shows for a genuine live trial', () => {
        expect(isTrialBannerEligible(base)).toBe(true);
    });
    it('hides for a comped account even if its raw status was left at trial', () => {
        expect(isTrialBannerEligible({ ...base, is_comp: true })).toBe(false);
    });
    it('hides once the trial has lapsed (effective expired)', () => {
        expect(isTrialBannerEligible({ ...base, effective_status: 'expired' })).toBe(false);
    });
    it('hides for non-trial statuses', () => {
        for (const st of ['active', 'canceled_pending', 'past_due', 'expired']) {
            expect(isTrialBannerEligible({ ...base, subscription_status: st })).toBe(false);
        }
    });
    it('tolerates a server that omits is_comp (older API)', () => {
        expect(isTrialBannerEligible({ subscription_status: 'trial', effective_status: 'active' })).toBe(true);
    });
});
