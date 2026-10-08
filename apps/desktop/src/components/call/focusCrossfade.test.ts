/**
 * "When focusing a call the focused stream seems to flash in and out for the
 * first second after focusing" — FocusedStreamBanner crossfaded EVERY focus
 * change, including a fresh focus with no old stream on screen, so the stream
 * being focused was faded out (1 -> 0 over 0.14 s) and snapped back at 160 ms
 * while the banner's own entrance was fading it in. These tests pin that only
 * a switch crossfades, and that no path leaves the fade stuck on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { focusSwap, FOCUS_CROSSFADE_MS, type FocusKey, type FocusSwap } from './focusCrossfade';

const A: FocusKey = { identity: 'alice', source: 'camera' };
const A_SHARE: FocusKey = { identity: 'alice', source: 'screen_share' };
const B: FocusKey = { identity: 'bob', source: 'camera' };
const C: FocusKey = { identity: 'carol', source: 'camera' };

describe('focusSwap — decision table', () => {
    it.each<[string, FocusKey | null, FocusKey | null, FocusSwap]>([
        ['unfocus', A, null, 'clear'],
        ['nothing focused, nothing shown', null, null, 'clear'],
        ['fresh focus (nothing on screen)', null, A, 'show-now'],
        ['same stream (new object)', A, { ...A }, 'keep'],
        ['other participant', A, B, 'crossfade'],
        ['same participant, other source', A, A_SHARE, 'crossfade'],
    ])('%s', (_name, shown, next, want) => {
        expect(focusSwap(shown, next)).toBe(want);
    });
});

/**
 * The banner's effect, replayed against a fake clock. `rule` is the body that
 * runs when `focusedStream` changes; it returns a cleanup like the effect does.
 * Records `crossfading` at every focus change and timer firing.
 */
type State = { shown: FocusKey | null; crossfading: boolean };
type Rule = (s: State, next: FocusKey | null, schedule: (fn: () => void) => () => void) => (() => void) | void;

function replay(rule: Rule, changes: Array<[number, FocusKey | null]>, until = 2000) {
    const s: State = { shown: null, crossfading: false };
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    const log: Array<{ t: number; crossfading: boolean; shown: string | null }> = [];
    let now = 0;
    let cleanup: (() => void) | void = undefined;
    const schedule = (fn: () => void) => {
        const tm = { at: now + FOCUS_CROSSFADE_MS, fn, live: true };
        timers.push(tm);
        return () => { tm.live = false; };
    };
    const record = () => log.push({ t: now, crossfading: s.crossfading, shown: s.shown?.identity ?? null });
    const events = changes.map(([t, f]) => ({ t, f }));
    while (now <= until) {
        for (const tm of timers) if (tm.live && tm.at === now) { tm.live = false; tm.fn(); record(); }
        for (const e of events) if (e.t === now) { cleanup?.(); cleanup = rule(s, e.f, schedule); record(); }
        now++;
    }
    return { final: s, log };
}

// FocusedStreamBanner's effect body, as shipped by this fix.
const fixedRule: Rule = (s, next, schedule) => {
    if (focusSwap(s.shown, next) !== 'crossfade') { s.shown = next; s.crossfading = false; return; }
    s.crossfading = true;
    return schedule(() => { s.shown = next; s.crossfading = false; });
};
// The body it replaced — kept only as the positive control for the oracle.
const legacyRule: Rule = (s, next, schedule) => {
    if (!next) { s.shown = null; return; }
    if (s.shown?.identity === next.identity && s.shown?.source === next.source) return;
    s.crossfading = true;
    return schedule(() => { s.shown = next; s.crossfading = false; });
};

const fadesOnFreshFocus = (rule: Rule) =>
    replay(rule, [[0, A]]).log.some(e => e.crossfading)
    || replay(rule, [[0, A], [500, null], [900, A]]).log.some(e => e.t >= 900 && e.crossfading);

describe('fresh focus shows at once (the flash)', () => {
    it('positive control: the old rule faded a fresh focus — the oracle catches it', () => {
        expect(fadesOnFreshFocus(legacyRule)).toBe(true);
    });
    it('a fresh focus never fades, first time or after an unfocus', () => {
        expect(fadesOnFreshFocus(fixedRule)).toBe(false);
        const r = replay(fixedRule, [[0, A], [500, null], [900, A]]);
        expect(r.log.filter(e => e.t === 0 || e.t === 900).map(e => e.shown)).toEqual(['alice', 'alice']);
    });
    it('a switch still crossfades, then lands on the new stream', () => {
        const r = replay(fixedRule, [[0, A], [500, B]]);
        expect(r.log.find(e => e.t === 500)).toEqual({ t: 500, crossfading: true, shown: 'alice' });
        expect(r.final).toEqual({ shown: B, crossfading: false });
    });
});

describe('the fade can never be left on', () => {
    it.each<[string, Array<[number, FocusKey | null]>, FocusKey | null]>([
        ['switch, then unfocus mid-fade, then a fresh focus', [[0, A], [500, B], [550, null], [600, C]], C],
        ['switch undone inside the fade window', [[0, A], [500, B], [550, A]], A],
        ['switch, then unfocus mid-fade', [[0, A], [500, B], [550, null]], null],
    ])('%s', (_name, changes, want) => {
        const r = replay(fixedRule, changes);
        expect(r.final).toEqual({ shown: want, crossfading: false });
    });
    it('positive control: the old rule left a switch-undo stuck at opacity 0', () => {
        expect(replay(legacyRule, [[0, A], [500, B], [550, A]]).final.crossfading).toBe(true);
    });
});

describe('FocusedStreamBanner is wired to it', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const banner = readFileSync(join(here, 'FocusedStreamBanner.tsx'), 'utf8');
    const body = banner.slice(banner.indexOf('const step = focusSwap('), banner.indexOf('}, FOCUS_CROSSFADE_MS);'));
    it('decides through focusSwap and resets the fade on every non-crossfade step', () => {
        expect(body.length).toBeGreaterThan(0);
        expect(body).toMatch(/const step = focusSwap\(shownFocus, focusedStream\);\s*if \(step !== 'crossfade'\) \{\s*setShownFocus\(focusedStream\);\s*setCrossfading\(false\);\s*return;\s*\}\s*setCrossfading\(true\);/);
    });
    it('keeps the stable key, so the swap after a crossfade never remounts the same stream', () => {
        expect(banner).toMatch(/const displayFocus = shownFocus \?\? focusedStream;/);
        expect(banner).toMatch(/key=\{`focused-\$\{displayFocus\.identity\}-\$\{displayFocus\.source\}`\}/);
    });
});
