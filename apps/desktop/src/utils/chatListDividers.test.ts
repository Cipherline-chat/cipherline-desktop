import { describe, it, expect } from 'vitest';
import { chatBucket, chatBucketLabel, type ChatBucketKey } from './chatListDividers';
import { ANCIENT_CHATS_POOL } from './eggPools';

const DAY = 86_400_000;

/** A fixed "now": a Wednesday at 15:00 local time. */
const NOW = new Date(2026, 8, 2, 15, 0, 0).getTime(); // Sep 2 2026, 15:00 local
const MIDNIGHT = new Date(2026, 8, 2, 0, 0, 0).getTime();

describe('chatBucket', () => {
    it('anything since local midnight is today — and future timestamps too', () => {
        expect(chatBucket(NOW, NOW)).toBe('today');
        expect(chatBucket(MIDNIGHT, NOW)).toBe('today');
        expect(chatBucket(NOW + DAY, NOW)).toBe('today'); // clock skew tolerated
    });

    it('calendar-day boundary, not a rolling 24h: 11:59pm yesterday is yesterday', () => {
        expect(chatBucket(MIDNIGHT - 1, NOW)).toBe('yesterday');
        expect(chatBucket(MIDNIGHT - DAY, NOW)).toBe('yesterday');
        // 20 hours ago but past midnight → still today under calendar bucketing
        expect(chatBucket(NOW - 14 * 3_600_000, NOW)).toBe('today');
    });

    it('week / month / older windows nest correctly', () => {
        expect(chatBucket(MIDNIGHT - DAY - 1, NOW)).toBe('week');
        expect(chatBucket(MIDNIGHT - 6 * DAY, NOW)).toBe('week');
        expect(chatBucket(MIDNIGHT - 6 * DAY - 1, NOW)).toBe('month');
        expect(chatBucket(MIDNIGHT - 29 * DAY, NOW)).toBe('month');
        expect(chatBucket(MIDNIGHT - 29 * DAY - 1, NOW)).toBe('older');
        expect(chatBucket(MIDNIGHT - 364 * DAY, NOW)).toBe('older');
    });

    it('a year of silence lands in the ancient bucket', () => {
        expect(chatBucket(MIDNIGHT - 364 * DAY - 1, NOW)).toBe('ancient');
        expect(chatBucket(0, NOW)).toBe('ancient');
    });

    it('buckets are monotonic: older timestamp never yields a newer bucket', () => {
        const order: ChatBucketKey[] = ['today', 'yesterday', 'week', 'month', 'older', 'ancient'];
        let prevRank = -1;
        // Walk backwards a day at a time for two years.
        for (let d = 0; d < 730; d++) {
            const rank = order.indexOf(chatBucket(NOW - d * DAY, NOW));
            expect(rank).toBeGreaterThanOrEqual(prevRank);
            prevRank = rank;
        }
    });
});

describe('chatBucketLabel', () => {
    it('plain labels for the young buckets', () => {
        expect(chatBucketLabel('today', NOW)).toBe('Today');
        expect(chatBucketLabel('yesterday', NOW)).toBe('Yesterday');
        expect(chatBucketLabel('week', NOW)).toBe('This week');
        expect(chatBucketLabel('month', NOW)).toBe('This month');
        expect(chatBucketLabel('older', NOW)).toBe('Months ago');
    });

    it('ancient label comes from the personality pool', () => {
        expect(ANCIENT_CHATS_POOL).toContain(chatBucketLabel('ancient', NOW));
    });

    it('ancient label is stable within a day but rotates across days (rule 3)', () => {
        const a = chatBucketLabel('ancient', NOW);
        expect(chatBucketLabel('ancient', NOW + 3_600_000)).toBe(a); // +1h, same day
        expect(chatBucketLabel('ancient', NOW + DAY)).not.toBe(a);   // next day rotates
    });
});
