// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
    RAIL_GAME_CLICKS, RAIL_GAME_GAP_MS, RAIL_GAME_REFUSAL, railGameClick, railGameRefusal, type RailGameResult,
} from './railKeysGame';
import { SPAM_GAP_MS, inputTime, MAX_INPUT_LAG_MS } from './keysBurst';
import type { SpamStreak } from './keysBurst';
import { BURST_LINES } from '../components/mascot/HomeKeys';

/** Feed clicks at the given times; returns every result. */
function run(times: number[]): RailGameResult[] {
    const out: RailGameResult[] = [];
    let s: SpamStreak | null = null;
    for (const t of times) { const r = railGameClick(s, t); out.push(r); s = r.streak; }
    return out;
}
const evenly = (n: number, gap: number, t0 = 1000) => Array.from({ length: n }, (_, i) => t0 + i * gap);

describe('railKeysGame: the rule', () => {
    it('is 6 right-clicks, gap 600 ms (keysBurst\'s own gap, not a new number)', () => {
        expect(RAIL_GAME_CLICKS).toBe(6);
        expect(RAIL_GAME_GAP_MS).toBe(600);
        expect(RAIL_GAME_GAP_MS).toBe(SPAM_GAP_MS);
    });

    it('5 clicks never fire; the 6th does', () => {
        const five = run(evenly(5, 100));
        expect(five.some(r => r.fired)).toBe(false);
        expect(five.map(r => r.clicks)).toEqual([1, 2, 3, 4, 5]);
        const six = run(evenly(6, 100));
        expect(six.slice(0, 5).some(r => r.fired)).toBe(false);
        expect(six[5].fired).toBe(true);
        expect(six[5].streak).toBeNull();
    });

    it('a gap of exactly 600 ms continues the streak; 601 ms breaks it', () => {
        const ok = run(evenly(6, 600));
        expect(ok[5].fired).toBe(true);
        const times = [1000, 1100, 1200, 1300, 1400, 1400 + 601];
        const broken = run(times);
        expect(broken[5].fired).toBe(false);
        expect(broken[5].clicks).toBe(1); // the late click starts a fresh streak
        expect(broken[5].streak).toEqual({ start: 2001, last: 2001, clicks: 1 });
        // ... and the fresh streak needs a full 6 of its own
        const after = run([...times, ...evenly(5, 100, 2101)]);
        expect(after[after.length - 1].fired).toBe(true);
        expect(after.slice(0, -1).some(r => r.fired)).toBe(false);
    });

    it('a gap at 600 vs 601 anywhere in the run (not just the last)', () => {
        const mk = (g: number) => run([1000, 1100, 1100 + g, 1200 + g, 1300 + g, 1400 + g]);
        expect(mk(600)[5].fired).toBe(true);
        expect(mk(601)[5].fired).toBe(false);
    });

    it('fires once per streak: a 7th click starts a new streak at 1', () => {
        const r = run(evenly(7, 100));
        expect(r[5].fired).toBe(true);
        expect(r[6].fired).toBe(false);
        expect(r[6].clicks).toBe(1);
    });

    it('a single click is inert: streak of 1, nothing fired', () => {
        const [r] = run([5000]);
        expect(r).toEqual({ streak: { start: 5000, last: 5000, clicks: 1 }, clicks: 1, fired: false });
    });

    it('a timestamp going backwards does not continue the streak', () => {
        const r = railGameClick({ start: 1000, last: 1500, clicks: 3 }, 1400);
        expect(r.clicks).toBe(1);
        expect(r.fired).toBe(false);
    });

    it('the input-lag fallback (keysBurst inputTime) is what feeds it: stale or future stamps use the handler clock', () => {
        const now = 100_000;
        expect(inputTime(now - 50, now)).toBe(now - 50);
        expect(inputTime(now - MAX_INPUT_LAG_MS, now)).toBe(now - MAX_INPUT_LAG_MS);
        expect(inputTime(now - MAX_INPUT_LAG_MS - 1, now)).toBe(now); // too old: epoch-clock synthetic event
        expect(inputTime(now + 1, now)).toBe(now);
        expect(inputTime(undefined, now)).toBe(now);
        expect(inputTime(Number.NaN, now)).toBe(now);
        // A burst delivered late by a busy thread: handler times bunch up, stamps keep the true 500 ms gaps.
        const stamps = evenly(6, 500, 99_000);
        expect(run(stamps.map(t => inputTime(t, now)))[5].fired).toBe(true);
    });
});

describe('railKeysGame: refusal wording', () => {
    it('ok has no message; call and unavailable do, and unavailable is Home Keys\' line verbatim', () => {
        expect(railGameRefusal('ok')).toBeNull();
        expect(railGameRefusal('call')).toBe(RAIL_GAME_REFUSAL.call);
        expect(railGameRefusal('unavailable')).toBe(BURST_LINES.unavailable);
    });
});
