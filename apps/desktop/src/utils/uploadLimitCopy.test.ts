import { describe, it, expect } from 'vitest';
import { FREE_TIER_MAX_UPLOAD_BYTES, MAX_ATTACHMENT_BYTES } from '../constants';
import {
    formatUploadLimit, freeTierTooLargeDetail,
    FREE_UPLOAD_LIMIT_LABEL, PRO_UPLOAD_LIMIT_LABEL,
} from './uploadLimitCopy';

describe('mirrored upload limits (must match the API: apps/api billing.service.ts)', () => {
    it('free tier is exactly 100 MB, written 100 * 1024 * 1024 like the API', () => {
        expect(FREE_TIER_MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    });

    it('paid/trial tier is still 2 GB', () => {
        expect(MAX_ATTACHMENT_BYTES).toBe(2 * 1024 * 1024 * 1024);
    });

    it('free is strictly below paid', () => {
        expect(FREE_TIER_MAX_UPLOAD_BYTES).toBeLessThan(MAX_ATTACHMENT_BYTES);
    });
});

describe('uploadLimitCopy', () => {
    it('labels the tiers "100 MB" and "2 GB"', () => {
        expect(FREE_UPLOAD_LIMIT_LABEL).toBe('100 MB');
        expect(PRO_UPLOAD_LIMIT_LABEL).toBe('2 GB');
    });

    it('formats whole units', () => {
        expect(formatUploadLimit(25 * 1024 * 1024)).toBe('25 MB');
        expect(formatUploadLimit(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('free-tier rejection copy says 100 MB, never the old 25 MB', () => {
        const one = freeTierTooLargeDetail(['movie.mkv']);
        expect(one).toBe('"movie.mkv" exceeds the 100 MB free-tier upload limit.');
        const many = freeTierTooLargeDetail(['a', 'b', 'c']);
        expect(many).toBe('3 files exceed the 100 MB free-tier upload limit.');
        expect(one + many).not.toContain('25');
    });
});
