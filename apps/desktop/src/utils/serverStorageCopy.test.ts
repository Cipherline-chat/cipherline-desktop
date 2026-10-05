import { describe, it, expect } from 'vitest';
import {
    FREE_OWNER_STORAGE_BYTES,
    storageLimitForServer,
    storageLimitForMembers,
    tierLabelForServer,
} from '@cipherline/shared';
import { quotaExceededMessage, nearLimitMessage, isFlatStoragePlan } from './serverStorageCopy';

const MB = 1024 * 1024;

describe('shared storage limit by owner plan (what the server enforces, mirrored for display)', () => {
    it('free-owner flat quota is 25 MB', () => {
        expect(FREE_OWNER_STORAGE_BYTES).toBe(25 * MB);
    });

    it('flat25: 25 MB at any member count', () => {
        for (const n of [1, 2, 100, 101, 5000, 100000]) {
            expect(storageLimitForServer(n, 'flat25')).toBe(25 * MB);
        }
    });

    it('ladder: unchanged 100 MB to 10 GB', () => {
        expect(storageLimitForServer(1, 'ladder')).toBe(100 * MB);
        expect(storageLimitForServer(101, 'ladder')).toBe(500 * MB);
        expect(storageLimitForServer(10001, 'ladder')).toBe(10 * 1024 * MB);
        for (const n of [1, 50, 101, 501, 1001, 5001, 10001]) {
            expect(storageLimitForServer(n, 'ladder')).toBe(storageLimitForMembers(n));
        }
    });

    it('anything that is not exactly "ladder" fails closed to the free quota', () => {
        expect(storageLimitForServer(5000, undefined as never)).toBe(25 * MB);
        expect(storageLimitForServer(5000, 'bogus' as never)).toBe(25 * MB);
    });

    it('labels: "Free plan" for flat25, the member tier for the ladder', () => {
        expect(tierLabelForServer(900, 'flat25')).toBe('Free plan');
        expect(tierLabelForServer(900, 'ladder')).toBe('501–1k members');
    });
});

describe('serverStorageCopy', () => {
    it('flags only flat25 as the flat plan; missing/unknown reads as the ladder', () => {
        expect(isFlatStoragePlan('flat25')).toBe(true);
        expect(isFlatStoragePlan('ladder')).toBe(false);
        expect(isFlatStoragePlan(undefined)).toBe(false);
        expect(isFlatStoragePlan('anything')).toBe(false);
    });

    it('free-owner toast names the 25 MB limit and the Free plan, not the member-count ladder', () => {
        const msg = quotaExceededMessage({ limit_bytes: 25 * MB, storage_plan: 'flat25' });
        expect(msg).toContain('25 MB');
        expect(msg).toContain('Free plan');
        expect(msg).not.toMatch(/member count|next tier/i);
    });

    it('paid-owner toast keeps the member-count advice', () => {
        const msg = quotaExceededMessage({ limit_bytes: 100 * MB, storage_plan: 'ladder' });
        expect(msg).toContain('100 MB');
        expect(msg).toMatch(/member count/i);
    });

    it('an older API without storage_plan gets the ladder advice', () => {
        expect(quotaExceededMessage({ limit_bytes: 100 * MB })).toMatch(/member count/i);
    });

    it('near-limit warning follows the plan', () => {
        expect(nearLimitMessage('flat25')).toMatch(/owner can upgrade to Pro/);
        expect(nearLimitMessage('ladder')).toMatch(/member count/);
    });
});
