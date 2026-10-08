import { describe, it, expect } from 'vitest';
import {
    FREE_OWNER_STORAGE_BYTES,
    storageLimitForServer,
    storageLimitForMembers,
    tierLabelForServer,
} from '@cipherline/shared';
import {
    quotaExceededMessage, nearLimitMessage, isFlatStoragePlan, emojiQuotaExceededMessage, isStorageQuotaError,
    emojiCountLimitMessage, emojiCountNearMessage, isEmojiCountLimitError, EMOJI_COUNT_NOTE_AT,
} from './serverStorageCopy';

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

describe('custom emojis share the server storage quota', () => {
    it('emoji over-quota toast says storage, not a count cap, and shows usage', () => {
        const msg = emojiQuotaExceededMessage({ used_bytes: 25 * MB, limit_bytes: 25 * MB, storage_plan: 'flat25' });
        expect(msg).toContain("doesn't fit in the server's storage");
        expect(msg).toContain('25 MB of 25 MB used');
        expect(msg).toMatch(/Pro/);
        expect(msg).not.toMatch(/\b50\b|maximum/);
    });

    it('paid-owner emoji toast has no upgrade pitch', () => {
        const msg = emojiQuotaExceededMessage({ used_bytes: 100 * MB, limit_bytes: 100 * MB, storage_plan: 'ladder' });
        expect(msg).not.toMatch(/Pro/);
    });

    it('recognises only the STORAGE_QUOTA_EXCEEDED body', () => {
        expect(isStorageQuotaError({ code: 'STORAGE_QUOTA_EXCEEDED', kind: 'emoji' })).toBe(true);
        expect(isStorageQuotaError({ code: 'EMOJI_TOO_LARGE' })).toBe(false);
        expect(isStorageQuotaError(undefined)).toBe(false);
        expect(isStorageQuotaError('STORAGE_QUOTA_EXCEEDED')).toBe(false);
    });

    it('the save toasts and near-limit warning mention emojis as something to remove', () => {
        expect(quotaExceededMessage({ limit_bytes: 25 * MB, storage_plan: 'flat25' })).toMatch(/custom emojis/);
        expect(nearLimitMessage('ladder')).toMatch(/custom emojis/);
    });
});

describe('the 1,000-emoji backstop copy', () => {
    it('names the limit from the API payload, with a way out', () => {
        expect(emojiCountLimitMessage({ limit: 1000 })).toBe(
            'This server has reached its maximum of 1,000 custom emojis. Remove one you no longer use to add another.',
        );
        expect(emojiCountLimitMessage({ limit: 1500 })).toMatch(/1,500/);
        expect(emojiCountLimitMessage()).toMatch(/1,000/);
    });

    it('the near-limit note starts at 950 and is not an x/1000 counter', () => {
        expect(EMOJI_COUNT_NOTE_AT).toBe(950);
        const note = emojiCountNearMessage(962);
        expect(note).toMatch(/962/);
        expect(note).not.toMatch(/\d+\s*\/\s*1,?000/);
    });

    it('recognises only the EMOJI_COUNT_LIMIT body', () => {
        expect(isEmojiCountLimitError({ code: 'EMOJI_COUNT_LIMIT', limit: 1000 })).toBe(true);
        expect(isEmojiCountLimitError({ code: 'STORAGE_QUOTA_EXCEEDED' })).toBe(false);
        expect(isEmojiCountLimitError(null)).toBe(false);
    });
});
