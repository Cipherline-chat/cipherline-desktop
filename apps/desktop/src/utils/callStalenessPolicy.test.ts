import { describe, it, expect } from 'vitest';
import { shouldTeardownForCallStatus, shouldKeepRetryingStalenessCheck } from './callStalenessPolicy';

describe('shouldTeardownForCallStatus', () => {
    it('tears down on an explicit inactive response', () => {
        expect(shouldTeardownForCallStatus({ active: false })).toBe(true);
    });

    it('keeps the call on an explicit active response', () => {
        expect(shouldTeardownForCallStatus({ active: true })).toBe(false);
    });

    it('never tears down on a failed/errored check (null) — absence of evidence is not evidence of absence', () => {
        expect(shouldTeardownForCallStatus(null)).toBe(false);
    });
});

describe('shouldKeepRetryingStalenessCheck', () => {
    it('keeps retrying while still inside the grace window', () => {
        expect(shouldKeepRetryingStalenessCheck(5_000, 30_000)).toBe(true);
    });

    it('stops retrying once the grace window has elapsed', () => {
        expect(shouldKeepRetryingStalenessCheck(30_000, 30_000)).toBe(false);
        expect(shouldKeepRetryingStalenessCheck(45_000, 30_000)).toBe(false);
    });

    it('stops immediately at zero grace window (edge case, not expected in practice)', () => {
        expect(shouldKeepRetryingStalenessCheck(0, 0)).toBe(false);
    });
});
