import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    AloneGuard, ALONE_COUNTDOWN_SECONDS, aloneLeaveMinutes, countsDisagree, parseAloneLeave, someoneElseHere,
    type AloneAction, type AloneCounts,
} from './aloneLeave';

/** Deterministic timers: advance(ms) runs everything due, in order. */
function makeHarness(opts: { minutes?: () => number | null; counts: () => AloneCounts }) {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const log: Array<{ c: AloneCounts; a: AloneAction }> = [];
    const countdowns: Array<number | null> = [];
    let leaves = 0;
    const g = new AloneGuard({
        minutes: opts.minutes ?? (() => 15),
        probe: opts.counts,
        schedule: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
        cancel: (h) => { timers.delete(h as number); },
        onCountdown: (s) => { countdowns.push(s); },
        onLeave: () => { leaves++; },
        log: (c, a) => { log.push({ c, a }); },
    });
    const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].fn();
        }
        now = end;
    };
    return { g, advance, log, countdowns, leaves: () => leaves, pending: () => timers.size };
}
const MIN = 60_000;
const alone: AloneCounts = { hook: 0, live: 0, presence: 0 };

describe('parse / minutes', () => {
    it('defaults to 15 and accepts only the four values', () => {
        expect(parseAloneLeave(undefined)).toBe('15');
        expect(parseAloneLeave('7')).toBe('15');
        expect(parseAloneLeave(30)).toBe('15');
        expect(['15', '30', '60', 'never'].map(parseAloneLeave)).toEqual(['15', '30', '60', 'never']);
        // One fixed limit since 2026-11-21: 24 hours alone, whatever an older build stored.
        expect(['15', '30', '60', 'never'].map(v => aloneLeaveMinutes(parseAloneLeave(v)))).toEqual([1440, 1440, 1440, 1440]);
    });
});

describe('source decision', () => {
    it('anyone seen by ANY source means someone is here; unavailable sources (null) do not count as people', () => {
        expect(someoneElseHere({ hook: 0, live: 0, presence: 0 })).toBe(false);
        expect(someoneElseHere({ hook: 0, live: null, presence: null })).toBe(false);
        expect(someoneElseHere({ hook: 0, live: 1, presence: 0 })).toBe(true);
        expect(someoneElseHere({ hook: 0, live: 0, presence: 2 })).toBe(true);
        expect(someoneElseHere({ hook: 1, live: 0, presence: null })).toBe(true);
    });
    it('disagreement = at least one source with people and one without', () => {
        expect(countsDisagree({ hook: 0, live: 1, presence: null })).toBe(true);
        expect(countsDisagree({ hook: 1, live: 1, presence: 1 })).toBe(false);
        expect(countsDisagree({ hook: 0, live: 0, presence: 0 })).toBe(false);
        expect(countsDisagree({ hook: 0, live: null, presence: null })).toBe(false);
    });
});

describe('AloneGuard', () => {
    it('alone for the full wait: countdown starts at 15 min, leaves 60 s later', () => {
        const h = makeHarness({ counts: () => alone });
        h.g.arm();
        h.advance(15 * MIN - 1);
        expect(h.countdowns).toEqual([]);
        h.advance(1);
        expect(h.countdowns).toEqual([ALONE_COUNTDOWN_SECONDS]);
        h.advance(59_000);
        expect(h.leaves()).toBe(0);
        h.advance(1000);
        expect(h.leaves()).toBe(1);
        expect(h.log.at(-1)?.a).toBe('left');
    });

    it('POSITIVE CONTROL (the prod bug): the hook is FROZEN at 0 but the live room has someone - no countdown, and the disagreement is logged', () => {
        const h = makeHarness({ counts: () => ({ hook: 0, live: 1, presence: null }) });
        h.g.arm();
        h.advance(15 * MIN);
        expect(h.countdowns).toEqual([]);
        expect(h.leaves()).toBe(0);
        expect(h.log).toEqual([{ c: { hook: 0, live: 1, presence: null }, a: 'kept' }]);
        h.advance(60 * MIN);   // and it stays safe for as long as the live room says so
        expect(h.leaves()).toBe(0);
    });

    it('server presence alone is enough to cancel (channel call, room view stale)', () => {
        const h = makeHarness({ counts: () => ({ hook: 0, live: 0, presence: 1 }) });
        h.g.arm();
        h.advance(15 * MIN);
        expect(h.countdowns).toEqual([]);
        expect(h.log[0]?.a).toBe('kept');
    });

    it('someone joins DURING the countdown: the final re-check cancels the leave', () => {
        let counts: AloneCounts = alone;
        const h = makeHarness({ counts: () => counts });
        h.g.arm();
        h.advance(15 * MIN);
        counts = { hook: 0, live: 1, presence: 0 };   // hook still frozen
        h.advance(60_000);
        expect(h.leaves()).toBe(0);
        expect(h.countdowns.at(-1)).toBeNull();
        expect(h.log.at(-1)?.a).toBe('countdown_cancelled');
    });

    it('setting Never: no timer at all', () => {
        const h = makeHarness({ minutes: () => null, counts: () => alone });
        h.g.arm();
        expect(h.pending()).toBe(0);
        h.advance(24 * 60 * MIN);
        expect(h.leaves()).toBe(0);
    });

    it.each([[30], [60]])('setting %i minutes: waits that long', (m) => {
        const h = makeHarness({ minutes: () => m, counts: () => alone });
        h.g.arm();
        h.advance(m * MIN - 1);
        expect(h.countdowns).toEqual([]);
        h.advance(1);
        expect(h.countdowns).toEqual([ALONE_COUNTDOWN_SECONDS]);
    });

    it('"Stay in call" dismisses the countdown and restarts the full wait', () => {
        const h = makeHarness({ counts: () => alone });
        h.g.arm();
        h.advance(15 * MIN + 20_000);
        expect(h.g.countdown).toBe(ALONE_COUNTDOWN_SECONDS - 20);
        h.g.stay();
        expect(h.g.countdown).toBeNull();
        expect(h.countdowns.at(-1)).toBeNull();
        h.advance(14 * MIN);
        expect(h.leaves()).toBe(0);
        h.advance(MIN);   // a full 15 min after Stay
        expect(h.countdowns.at(-1)).toBe(ALONE_COUNTDOWN_SECONDS);
        h.advance(60_000);
        expect(h.leaves()).toBe(1);
    });

    it('someone arriving (disarm) drops a running countdown and everything pending', () => {
        const h = makeHarness({ counts: () => alone });
        h.g.arm();
        h.advance(15 * MIN + 5000);
        h.g.disarm();
        expect(h.countdowns.at(-1)).toBeNull();
        expect(h.pending()).toBe(0);
        h.advance(2 * 60 * MIN);
        expect(h.leaves()).toBe(0);
    });

    it('re-arming never stacks timers', () => {
        const h = makeHarness({ counts: () => alone });
        h.g.arm(); h.g.arm(); h.g.arm();
        expect(h.pending()).toBe(1);
    });

    it('changing the setting to Never mid-wait (re-arm) cancels the pending leave', () => {
        let m: number | null = 15;
        const h = makeHarness({ minutes: () => m, counts: () => alone });
        h.g.arm();
        h.advance(10 * MIN);
        m = null;
        h.g.arm();
        h.advance(2 * 60 * MIN);
        expect(h.countdowns).toEqual([]);
        expect(h.leaves()).toBe(0);
    });
});

describe('wiring', () => {
    const sc = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('the call reads the LIVE room, not just the hook, and the old misleading copy is gone', () => {
        expect(sc).toMatch(/realRemoteCount\(room\.remoteParticipants\)/); // the Room's own roster, minus a phone's share-audio helper connection
        expect(sc).toMatch(/readAlonePresence\(\)/);
        expect(sc).not.toMatch(/Removed due to inactivity/);
        expect(sc).toMatch(/<AloneLeaveDialog/);
        const dlg = readFileSync(join(__dirname, '../components/call/AloneLeaveDialog.tsx'), 'utf8');
        expect(dlg).toMatch(/Stay in call/);
        expect(dlg).toMatch(/Leave now/);
        // Esc = stay, through the shared Escape stack (escapeOwnership.test.ts forbids raw Escape handling here).
        expect(dlg).toMatch(/useEscape\(\(\) => \{ onStay\(\); \}\)/);
        expect(dlg).not.toMatch(/'Escape'/);
    });
    it('the setting is gone from Voice & Video (one fixed 24-hour limit) and nothing writes it on mount', () => {
        expect(readFileSync(join(__dirname, '../components/VoiceVideoSettings.tsx'), 'utf8')).not.toMatch(/AloneLeaveRow|alone for/);
        const lib = readFileSync(join(__dirname, 'aloneLeave.ts'), 'utf8');
        expect(lib.match(/secureLocalStore\.setItem/g)).toHaveLength(1);
        expect(lib).toMatch(/export const ALONE_LEAVE_MINUTES = 24 \* 60;/);
        expect(lib).toMatch(/export function aloneLeaveMinutes[\s\S]{0,800}return ALONE_LEAVE_MINUTES;/);
        expect(readFileSync(join(__dirname, '../components/call/AloneLeaveDialog.tsx'), 'utf8')).toMatch(/minutes \/ 60\} hours/);
    });
});
