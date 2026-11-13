import { describe, it, expect } from 'vitest';
import { friendRequestTiming, expiryLabel, FRIEND_REQUEST_TTL_DAYS } from './friendRequestTiming';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

describe('friendRequestTiming', () => {
    it('unusable dates say nothing (never "NaN days ago")', () => {
        for (const v of [null, undefined, '', 'not a date']) {
            expect(friendRequestTiming(v, NOW)).toEqual({ age: null, expiresInDays: null });
        }
    });

    it('ages: today / yesterday / N days ago', () => {
        expect(friendRequestTiming(at(0), NOW).age).toBe('today');
        expect(friendRequestTiming(at(0.99), NOW).age).toBe('today');
        expect(friendRequestTiming(at(1), NOW).age).toBe('yesterday');
        expect(friendRequestTiming(at(1.99), NOW).age).toBe('yesterday');
        expect(friendRequestTiming(at(2), NOW).age).toBe('2 days ago');
        expect(friendRequestTiming(at(29), NOW).age).toBe('29 days ago');
    });

    it('a request from the future (clock skew) reads as today, not negative', () => {
        expect(friendRequestTiming(at(-0.5), NOW).age).toBe('today');
    });

    it('the countdown only appears in the last week of the 30 days', () => {
        expect(FRIEND_REQUEST_TTL_DAYS).toBe(30);
        expect(friendRequestTiming(at(0), NOW).expiresInDays).toBeNull();
        expect(friendRequestTiming(at(22.5), NOW).expiresInDays).toBeNull(); // 7.5 left -> rounds up to 8
        expect(friendRequestTiming(at(23), NOW).expiresInDays).toBe(7);
        expect(friendRequestTiming(at(26), NOW).expiresInDays).toBe(4);
        expect(friendRequestTiming(at(28.5), NOW).expiresInDays).toBe(2);
        expect(friendRequestTiming(at(29.5), NOW).expiresInDays).toBe(1);
    });

    it('past the 30 days (the sweep runs once a day) it says "soon", never a negative count', () => {
        expect(friendRequestTiming(at(30), NOW).expiresInDays).toBe(0);
        expect(friendRequestTiming(at(30.7), NOW).expiresInDays).toBe(0);
    });
});

describe('expiryLabel', () => {
    it('reads naturally at each end', () => {
        expect(expiryLabel(0)).toBe('Expires soon');
        expect(expiryLabel(1)).toBe('Expires tomorrow');
        expect(expiryLabel(5)).toBe('Expires in 5 days');
    });
});
