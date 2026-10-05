import { describe, it, expect } from 'vitest';
import { bumpStreak, firesAt, type Streak } from './eggStreak';

const WINDOW = 3000;

describe('bumpStreak', () => {
    it('starts at 1 with no prior streak', () => {
        expect(bumpStreak(undefined, 1000, WINDOW)).toEqual({ count: 1, lastAt: 1000 });
    });

    it('increments while presses stay inside the window', () => {
        let s = bumpStreak(undefined, 0, WINDOW);
        s = bumpStreak(s, 500, WINDOW);
        s = bumpStreak(s, 1000, WINDOW);
        expect(s.count).toBe(3);
    });

    it('restarts at 1 once the gap exceeds the window', () => {
        const first = bumpStreak(undefined, 0, WINDOW);
        const later = bumpStreak(first, WINDOW + 1, WINDOW);
        expect(later.count).toBe(1);
    });

    it('measures the gap from the LAST press, not the first', () => {
        // Six slow-but-steady presses inside the gap must keep the streak
        // alive; the window is a per-press timeout, not a total duration.
        let s = bumpStreak(undefined, 0, WINDOW);
        for (let i = 1; i <= 5; i++) s = bumpStreak(s, i * (WINDOW - 500), WINDOW);
        expect(s.count).toBe(6);
    });

    it('treats a gap exactly equal to the window as expired', () => {
        const first = bumpStreak(undefined, 0, WINDOW);
        expect(bumpStreak(first, WINDOW, WINDOW).count).toBe(1);
    });
});

describe('firesAt', () => {
    it('is true only on the exact threshold press', () => {
        // Rule 6/10: the egg fires once when you cross the line, and does not
        // re-fire (or chain-restart its animation) on every press after.
        const at = (count: number): Streak => ({ count, lastAt: 0 });
        expect(firesAt(at(5), 6)).toBe(false);
        expect(firesAt(at(6), 6)).toBe(true);
        expect(firesAt(at(7), 6)).toBe(false);
        expect(firesAt(at(60), 6)).toBe(false);
    });

    it('fires again only after the streak resets and climbs back', () => {
        let s = bumpStreak(undefined, 0, WINDOW);
        for (let i = 1; i < 6; i++) s = bumpStreak(s, i * 100, WINDOW);
        expect(firesAt(s, 6)).toBe(true);

        s = bumpStreak(s, 100_000, WINDOW);   // long pause — streak resets
        expect(s.count).toBe(1);
        for (let i = 1; i < 6; i++) s = bumpStreak(s, 100_000 + i * 100, WINDOW);
        expect(firesAt(s, 6)).toBe(true);
    });
});
