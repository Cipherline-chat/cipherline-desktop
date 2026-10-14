import { describe, it, expect } from 'vitest';
import { cancellationOutcome } from './cancellationOutcome';

describe('cancellationOutcome', () => {
    it('cancel that Stripe confirmed and our row reflects is settled', () => {
        expect(cancellationOutcome(true, { cancel_at_period_end: true, subscription_status: 'canceled_pending' }))
            .toEqual({ ok: true, settled: true });
    });
    it('resume that Stripe confirmed and our row reflects is settled', () => {
        expect(cancellationOutcome(false, { cancel_at_period_end: false, subscription_status: 'active' }))
            .toEqual({ ok: true, settled: true });
    });
    it('never reports success when Stripe still says it will renew (the owner-reported bug)', () => {
        expect(cancellationOutcome(true, { cancel_at_period_end: false, subscription_status: 'active' }).ok).toBe(false);
    });
    it('never reports a resume as success when Stripe still says it will end', () => {
        expect(cancellationOutcome(false, { cancel_at_period_end: true, subscription_status: 'canceled_pending' }).ok).toBe(false);
    });
    it('a missing body is a failure, not a success', () => {
        expect(cancellationOutcome(true, undefined).ok).toBe(false);
        expect(cancellationOutcome(true, {}).ok).toBe(false);
    });
    it('Stripe confirmed but our row has not caught up is ok but NOT settled', () => {
        expect(cancellationOutcome(true, { cancel_at_period_end: true, subscription_status: 'active' }))
            .toEqual({ ok: true, settled: false });
        expect(cancellationOutcome(true, { cancel_at_period_end: true, subscription_status: 'past_due' }))
            .toEqual({ ok: true, settled: false });
    });
});
