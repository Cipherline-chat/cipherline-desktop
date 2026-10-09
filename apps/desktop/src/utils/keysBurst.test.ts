import { describe, it, expect } from 'vitest';
import {
    registerClick, isBroken, reached, lineIndex, inputTime,
    SPAM_GAP_MS, SPAM_DURATION_MS, SPAM_COUNTS_AT, MAX_INPUT_LAG_MS,
    type SpamStreak, type ClickResult,
} from './keysBurst';

/** Click at each of `times`; every click's result. */
function run(times: number[], from: SpamStreak | null = null): ClickResult[] {
    let s = from;
    return times.map(t => {
        const r = registerClick(s, t);
        s = r.streak;
        return r;
    });
}
/** Clicks every `gap` ms from t0 through t0 + span (inclusive when it lands). */
const spam = (gap: number, span: number, t0 = 10_000) =>
    Array.from({ length: Math.floor(span / gap) + 1 }, (_, i) => t0 + i * gap);
const fired = (rs: ClickResult[]) => rs.some(r => r.fired);

describe('keysBurst: the rule', () => {
    it('is 5 s of clicks with no gap over 600 ms', () => {
        expect(SPAM_DURATION_MS).toBe(5000);
        expect(SPAM_GAP_MS).toBe(600);
    });

    it('5.0 s of fast clicking opens the game, on the click that reaches 5 s', () => {
        const rs = run(spam(125, 5000)); // 41 clicks, the last at exactly +5000
        expect(rs.findIndex(r => r.fired)).toBe(rs.length - 1);
        expect(rs[rs.length - 1].progress).toBe(1);
    });

    it('4.9 s of fast clicking does not', () => {
        const rs = run(spam(100, 4900));
        expect(fired(rs)).toBe(false);
        expect(rs[rs.length - 1].progress).toBeCloseTo(0.98, 5);
    });

    it('a gap of exactly 600 ms still counts; the streak starts at the first click', () => {
        const rs = run(spam(600, 5400));
        expect(rs[0].continued).toBe(false);
        expect(rs.slice(1).every(r => r.continued)).toBe(true);
        expect(fired(rs)).toBe(true);
    });

    it('after it fires the next click starts over from zero', () => {
        const times = spam(100, 5100);
        const rs = run(times);
        expect(rs[50].fired).toBe(true);
        expect(rs[51].continued).toBe(false);
        expect(rs[51].progress).toBe(0);
    });
});

describe('keysBurst: a gap breaks the streak', () => {
    it('one gap over 600 ms, at 4.5 s in, ends it: no partial credit', () => {
        const first = spam(100, 4500);
        const t = first[first.length - 1] + SPAM_GAP_MS + 1;
        const rs = run([...first, ...spam(100, 1000, t)]);
        expect(fired(rs)).toBe(false);
        const restart = rs[first.length];
        expect(restart.continued).toBe(false);
        expect(restart.progress).toBe(0);
    });

    it('isBroken: only once more than the gap has passed since the last click', () => {
        const s: SpamStreak = { start: 0, last: 1000, clicks: 9 };
        expect(isBroken(s, 1000 + SPAM_GAP_MS)).toBe(false);
        expect(isBroken(s, 1000 + SPAM_GAP_MS + 1)).toBe(true);
        expect(isBroken(null, 99_999)).toBe(false);
    });

    it('a clock that runs backwards starts a new streak instead of counting', () => {
        const r = registerClick({ start: 5000, last: 9000, clicks: 30 }, 8000);
        expect(r.continued).toBe(false);
    });
});

describe('keysBurst: slow clicking never triggers', () => {
    it.each([601, 700, 800, 1000, 2000])('a click every %i ms, for a minute, never opens it or builds a streak', (gap) => {
        const rs = run(spam(gap, 60_000));
        expect(fired(rs)).toBe(false);
        expect(rs.every(r => !r.continued)).toBe(true);
    });

    it('double-clicks with a pause between them never get past the first moment', () => {
        const times = Array.from({ length: 30 }, (_, i) => [i * 1200, i * 1200 + 90]).flat().map(t => t + 3000);
        const rs = run(times);
        expect(fired(rs)).toBe(false);
        expect(Math.max(...rs.map(r => r.progress))).toBeLessThan(0.02);
    });
});

describe('keysBurst: lines and progress', () => {
    it('a new line each second of the streak', () => {
        expect([0, 0.19, 0.2, 0.39, 0.4, 0.6, 0.8, 0.99, 1].map(lineIndex)).toEqual([0, 0, 1, 1, 2, 3, 4, 4, 4]);
        expect(lineIndex(990 / SPAM_DURATION_MS)).toBe(0);
        expect(lineIndex(1000 / SPAM_DURATION_MS)).toBe(1);
    });

    it('reached(): how far a broken streak had got', () => {
        expect(reached(null)).toBe(0);
        expect(reached({ start: 1000, last: 3500, clicks: 20 })).toBeCloseTo(0.5, 5);
    });

    it('a streak only counts (uses up a show) from half a second', () => {
        expect(SPAM_COUNTS_AT * SPAM_DURATION_MS).toBe(500);
    });
});

describe('keysBurst: inputTime (when the click happened, not when it was handled)', () => {
    it('uses the event’s own timestamp when it is on the performance clock', () => {
        expect(inputTime(9_400, 10_000)).toBe(9_400);
        expect(inputTime(10_000, 10_000)).toBe(10_000);
        expect(inputTime(10_000 - MAX_INPUT_LAG_MS, 10_000)).toBe(10_000 - MAX_INPUT_LAG_MS);
    });

    it.each([
        ['missing', undefined],
        ['NaN', Number.NaN],
        ['in the future', 10_001],
        ['implausibly old', 10_000 - MAX_INPUT_LAG_MS - 1],
        ['on the epoch clock (a test DOM)', 1_760_000_000_000],
    ] as const)('falls back to now when the stamp is %s', (_label, ts) => {
        expect(inputTime(ts, 10_000)).toBe(10_000);
    });

    it('a click made inside the gap but handled after it still continues the streak', () => {
        // handled 650 ms after the last click (a busy main thread), made at +520
        const s = registerClick(null, 10_000).streak;
        expect(registerClick(s, inputTime(10_520, 10_650)).continued).toBe(true);
        // positive control: judged by when it was handled, the same click broke it
        expect(registerClick(s, 10_650).continued).toBe(false);
    });
});
