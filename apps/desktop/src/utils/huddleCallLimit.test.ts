import { describe, it, expect } from 'vitest';
import { isHuddleAtCallLimit } from './huddleCallLimit';

describe('isHuddleAtCallLimit', () => {
    it('is never at the limit when max_calls is null (unlimited)', () => {
        expect(isHuddleAtCallLimit(0, null)).toBe(false);
        expect(isHuddleAtCallLimit(50, null)).toBe(false);
    });

    it('is never at the limit when max_calls is undefined', () => {
        expect(isHuddleAtCallLimit(5, undefined)).toBe(false);
    });

    it('is not at the limit while below max_calls', () => {
        expect(isHuddleAtCallLimit(2, 5)).toBe(false);
    });

    it('is at the limit exactly at max_calls', () => {
        expect(isHuddleAtCallLimit(5, 5)).toBe(true);
    });

    it('is at the limit above max_calls (stale/racy count)', () => {
        expect(isHuddleAtCallLimit(6, 5)).toBe(true);
    });

    it('is at the limit when max_calls is 1 and one call is already live', () => {
        expect(isHuddleAtCallLimit(1, 1)).toBe(true);
    });

    it('is not at the limit with zero live calls, whatever the cap', () => {
        expect(isHuddleAtCallLimit(0, 3)).toBe(false);
    });
});
