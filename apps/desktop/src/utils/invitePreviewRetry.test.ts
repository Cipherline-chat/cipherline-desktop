import { describe, it, expect } from 'vitest';
import { isPermanentInviteFailure, resolveRetryDelayMs, RETRY_DELAYS_MS } from './invitePreviewRetry';

/**
 * Root-cause coverage for "a valid, unexpired server invite intermittently
 * shows 'Invite unavailable' when posted in chat". The bug was: any
 * non-404/400 response (429 from the endpoint's tight anti-enumeration
 * throttle, chief among them) was treated identically to a genuinely dead
 * invite, with no retry. These two pure predicates are the classification
 * logic that fix now hinges on — get them wrong and the fix regresses
 * silently.
 */

describe('isPermanentInviteFailure', () => {
    it('treats 404 (invite not found) as permanent', () => {
        expect(isPermanentInviteFailure(404)).toBe(true);
    });

    it('treats 400 (expired/exhausted — service throws BadRequestException) as permanent', () => {
        expect(isPermanentInviteFailure(400)).toBe(true);
    });

    // The actual bug: these must NOT be permanent, or a throttle/outage
    // blip permanently declares a valid invite dead.
    it('does NOT treat 429 (throttled) as permanent — this was the core bug', () => {
        expect(isPermanentInviteFailure(429)).toBe(false);
    });

    it('does not treat 401/5xx as permanent', () => {
        expect(isPermanentInviteFailure(401)).toBe(false);
        expect(isPermanentInviteFailure(500)).toBe(false);
        expect(isPermanentInviteFailure(503)).toBe(false);
    });

    it('does not treat a network error (no status at all) as permanent', () => {
        expect(isPermanentInviteFailure(undefined)).toBe(false);
    });
});

describe('resolveRetryDelayMs', () => {
    it('honors a numeric Retry-After header over the backoff table', () => {
        expect(resolveRetryDelayMs('3', 0)).toBe(3_000);
    });

    it('falls back to the backoff table when Retry-After is absent', () => {
        expect(resolveRetryDelayMs(undefined, 0)).toBe(RETRY_DELAYS_MS[0]);
        expect(resolveRetryDelayMs(undefined, 1)).toBe(RETRY_DELAYS_MS[1]);
        expect(resolveRetryDelayMs(undefined, 2)).toBe(RETRY_DELAYS_MS[2]);
    });

    it('falls back to the backoff table on a garbage/non-numeric header', () => {
        expect(resolveRetryDelayMs('not-a-number', 0)).toBe(RETRY_DELAYS_MS[0]);
    });

    it('falls back to the backoff table on a zero or negative header (never a shorter-than-useful retry)', () => {
        expect(resolveRetryDelayMs('0', 0)).toBe(RETRY_DELAYS_MS[0]);
        expect(resolveRetryDelayMs('-5', 0)).toBe(RETRY_DELAYS_MS[0]);
    });

    it('never indexes past the end of the backoff table for a high attempt number', () => {
        expect(resolveRetryDelayMs(undefined, 99)).toBe(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    });
});
