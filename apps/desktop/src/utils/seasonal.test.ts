import { describe, it, expect } from 'vitest';
import { activeSeason, flakeCount, makeFlakes, SEASON_WINDOWS } from './seasonal';

/**
 * Date-window maths, which is the only part of a seasonal effect that can be
 * wrong in a way nobody notices until one specific day of the year. The
 * marine-snow window wraps the year end (Dec 1 → Jan 6), so the boundaries
 * are the whole test.
 *
 * `new Date(y, m, d)` is local-time by construction, which matches
 * activeSeason reading local month/day — the effect should follow the
 * calendar on the user's wall, not a server's UTC clock.
 */

const on = (year: number, month1: number, day: number) => new Date(year, month1 - 1, day);

describe('activeSeason — marine snow', () => {
    it('is on across the whole December-to-Twelfth-Night window', () => {
        expect(activeSeason(on(2026, 12, 1))).toBe('marine-snow');   // first day
        expect(activeSeason(on(2026, 12, 25))).toBe('marine-snow');
        expect(activeSeason(on(2026, 12, 31))).toBe('marine-snow');  // year end
        expect(activeSeason(on(2027, 1, 1))).toBe('marine-snow');    // year start
        expect(activeSeason(on(2027, 1, 6))).toBe('marine-snow');    // last day
    });

    it('is off immediately outside both boundaries', () => {
        expect(activeSeason(on(2026, 11, 30))).toBeNull();  // day before
        expect(activeSeason(on(2027, 1, 7))).toBeNull();    // day after
    });

    it('is off for the rest of the year', () => {
        for (const m of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
            expect(activeSeason(on(2026, m, 15))).toBeNull();
        }
    });

    it('handles Feb 29 in a leap year without throwing', () => {
        expect(activeSeason(on(2028, 2, 29))).toBeNull();
    });
});

describe('season windows', () => {
    it('every window has a valid month/day range', () => {
        for (const w of SEASON_WINDOWS) {
            expect(w.startMonth).toBeGreaterThanOrEqual(1);
            expect(w.startMonth).toBeLessThanOrEqual(12);
            expect(w.endMonth).toBeGreaterThanOrEqual(1);
            expect(w.endMonth).toBeLessThanOrEqual(12);
            expect(w.startDay).toBeGreaterThanOrEqual(1);
            expect(w.startDay).toBeLessThanOrEqual(31);
            expect(w.endDay).toBeGreaterThanOrEqual(1);
            expect(w.endDay).toBeLessThanOrEqual(31);
        }
    });

    it('no two windows overlap — a day resolves to exactly one season', () => {
        const seen = new Map<number, string>();
        for (let m = 1; m <= 12; m++) {
            for (let d = 1; d <= 28; d++) {
                const s = activeSeason(on(2026, m, d));
                if (!s) continue;
                const key = m * 100 + d;
                expect(seen.has(key)).toBe(false);
                seen.set(key, s);
            }
        }
    });
});

describe('flakeCount', () => {
    it('stays within the perf-capped range at any viewport', () => {
        for (const w of [320, 800, 1280, 1920, 3840, 8000]) {
            const n = flakeCount(w);
            expect(n).toBeGreaterThanOrEqual(10);
            expect(n).toBeLessThanOrEqual(22);
        }
    });

    it('grows with width, then caps', () => {
        expect(flakeCount(1920)).toBeGreaterThan(flakeCount(800));
        expect(flakeCount(8000)).toBe(flakeCount(3840));   // both capped
    });
});

describe('makeFlakes', () => {
    it('is deterministic — same field every time, like deepField', () => {
        expect(makeFlakes(16)).toEqual(makeFlakes(16));
    });

    it('produces exactly n flakes', () => {
        for (const n of [10, 16, 22]) expect(makeFlakes(n)).toHaveLength(n);
    });

    it('starts every flake mid-fall via a negative delay', () => {
        // A zero/positive delay means the screen starts empty and fills, which
        // reads as a loading artifact rather than weather.
        for (const f of makeFlakes(22)) {
            expect(parseFloat(f.delay)).toBeLessThanOrEqual(0);
        }
    });

    it('keeps every flake on screen and subtle', () => {
        for (const f of makeFlakes(22)) {
            const left = parseFloat(f.left);
            expect(left).toBeGreaterThanOrEqual(0);
            expect(left).toBeLessThanOrEqual(100);
            expect(f.opacity).toBeGreaterThan(0);
            expect(f.opacity).toBeLessThanOrEqual(0.62);
            expect(f.size).toBeLessThanOrEqual(5);
        }
    });

    it('handles an empty field', () => {
        expect(makeFlakes(0)).toEqual([]);
    });
});
