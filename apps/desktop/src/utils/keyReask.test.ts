import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    KeyReaskScheduler,
    ReaskBudget,
    ReaskTargets,
    planReask,
    runReaskTick,
    KEY_REASK_AT_MS,
    KEY_REASK_STEADY_MS,
    KEY_REASK_WINDOW_MS,
    KEY_REASK_REARM_AFTER_MS,
    KEY_REASK_MAX_PER_TICK,
    KEY_REASK_BUDGET_PER_MIN,
    KEY_REASK_MIN_GAP_MS,
    type ReaskTickDeps,
    type ReaskTickResult,
} from './keyReask';

/**
 * The keyless side's fast re-ask (2026-10-11 owner report: "had to wait 5 mins
 * for the keys"). Before: one lost answer cost a 75 s wait (the retry timer),
 * and a channel left holding only history (its newest epoch refused) was never
 * timer-re-asked at all. See keyDeliverySimulation.test.ts for the end-to-end
 * timings; these pin the schedule, the bounds, and the storm guards.
 */

describe('planReask', () => {
    const base = { now: 100_000, progressed: false, activeChannelId: null, lastAskedAt: () => 0, budgetAvailable: 100 };

    it('asks nobody anything while a holder is delivering (progress since the last check)', () => {
        expect(planReask({ ...base, missing: ['a', 'b'], progressed: true })).toEqual([]);
    });

    it('open channel first, then least-recently asked; capped per check', () => {
        const asked: Record<string, number> = { a: 50_000, b: 10_000, c: 30_000, d: 20_000, e: 40_000, f: 5_000, g: 1_000, h: 60_000 };
        const out = planReask({ ...base, missing: Object.keys(asked), activeChannelId: 'h', lastAskedAt: c => asked[c] });
        expect(out[0]).toBe('h');
        expect(out.slice(1)).toEqual(['g', 'f', 'b', 'd', 'c']);
        expect(out).toHaveLength(KEY_REASK_MAX_PER_TICK);
    });

    it('skips a channel asked (by any path) less than KEY_REASK_MIN_GAP_MS ago', () => {
        const out = planReask({ ...base, missing: ['fresh', 'old'], lastAskedAt: c => (c === 'fresh' ? base.now - KEY_REASK_MIN_GAP_MS + 1 : 0) });
        expect(out).toEqual(['old']);
    });

    it('never exceeds the remaining account-wide budget', () => {
        expect(planReask({ ...base, missing: ['a', 'b', 'c'], budgetAvailable: 1 })).toHaveLength(1);
        expect(planReask({ ...base, missing: ['a', 'b', 'c'], budgetAvailable: 0 })).toEqual([]);
    });
});

describe('ReaskBudget — sliding minute, account-wide', () => {
    it('grants at most KEY_REASK_BUDGET_PER_MIN in any 60 s', () => {
        const b = new ReaskBudget();
        b.consume(KEY_REASK_BUDGET_PER_MIN, 0);
        expect(b.available(59_999)).toBe(0);
        expect(b.available(60_000)).toBe(KEY_REASK_BUDGET_PER_MIN);
    });
});

describe('ReaskTargets', () => {
    it('tracks per server, keeps the highest named epoch, clears per server', () => {
        const t = new ReaskTargets();
        t.add('s1', 'c1', 3);
        t.add('s1', 'c1', 2);
        t.add('s2', 'c2', 1);
        expect(t.latestOf('c1')).toBe(3);
        expect(t.forServer('s1')).toEqual(['c1']);
        t.clearServer('s1');
        expect(t.forServer('s1')).toEqual([]);
        expect(t.forServer('s2')).toEqual(['c2']);
    });
});

function tickDeps(over: Partial<ReaskTickDeps> & { held: Map<string, number>; targets: ReaskTargets }) {
    const filed: string[] = [];
    const deps: ReaskTickDeps = {
        pull: async () => {},
        wantedChannels: s => over.targets.forServer(s),
        hasNewest: async c => (over.held.get(c) ?? 0) >= (over.targets.latestOf(c) ?? 1),
        onSatisfied: c => over.targets.delete(c),
        lastAskedAt: () => 0,
        activeChannelId: () => null,
        fileKeyRequest: async (_s, c) => { filed.push(c); },
        sleep: async () => {},
        now: () => 1_000_000,
        budget: new ReaskBudget(),
        ...over,
    };
    return { deps, filed };
}

describe('runReaskTick', () => {
    it('done once every target holds the newest epoch the API named', async () => {
        const targets = new ReaskTargets();
        targets.add('s', 'c', 3);
        const { deps, filed } = tickDeps({ targets, held: new Map([['c', 3]]) });
        expect(await runReaskTick(deps, 's')).toBe('done');
        expect(filed).toEqual([]);
    });

    it('a channel that got only HISTORY (newest refused) is still re-asked — the 75 s timer never covered it', async () => {
        const targets = new ReaskTargets();
        targets.add('s', 'c', 3);
        const { deps, filed } = tickDeps({ targets, held: new Map([['c', 2]]) });
        expect(await runReaskTick(deps, 's')).toBe('reasked');
        expect(filed).toEqual(['c']);
    });

    it('pulls BEFORE judging, so envelopes already waiting count and nothing is re-asked for them', async () => {
        const targets = new ReaskTargets();
        targets.add('s', 'c', 2);
        const held = new Map<string, number>();
        const { deps, filed } = tickDeps({ targets, held, pull: async () => { held.set('c', 2); } });
        expect(await runReaskTick(deps, 's')).toBe('done');
        expect(filed).toEqual([]);
    });

    it('progress = a target satisfied in this check: the others wait one more check', async () => {
        const targets = new ReaskTargets();
        targets.add('s', 'a', 1);
        targets.add('s', 'b', 1);
        const { deps, filed } = tickDeps({ targets, held: new Map([['a', 1]]) });
        expect(await runReaskTick(deps, 's')).toBe('waiting');
        expect(filed).toEqual([]);
        // Next check, no progress: b is re-asked.
        expect(await runReaskTick(deps, 's')).toBe('reasked');
        expect(filed).toEqual(['b']);
    });
});

describe('KeyReaskScheduler', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function make(result: () => ReaskTickResult) {
        const at: number[] = [];
        const t0 = Date.now();
        const exhausted: string[] = [];
        const s = new KeyReaskScheduler({
            tick: async () => { at.push(Date.now() - t0); return result(); },
            onExhausted: sid => exhausted.push(sid),
        });
        return { s, at, exhausted };
    }

    it('checks at 2.5 s, 6 s, 12 s, 30 s, then every 30 s, and stops at the 5-minute window', async () => {
        const { s, at, exhausted } = make(() => 'waiting');
        s.arm('srv');
        await vi.advanceTimersByTimeAsync(KEY_REASK_WINDOW_MS + 60_000);
        const steady: number[] = [];
        for (let t = KEY_REASK_AT_MS[KEY_REASK_AT_MS.length - 1] + KEY_REASK_STEADY_MS; t <= KEY_REASK_WINDOW_MS; t += KEY_REASK_STEADY_MS) steady.push(t);
        expect(at).toEqual([...KEY_REASK_AT_MS, ...steady]);
        expect(s.isArmed('srv')).toBe(false);
        expect(exhausted).toEqual(['srv']);
    });

    it('arming while armed is a no-op (one schedule per server)', async () => {
        const { s, at } = make(() => 'waiting');
        s.arm('srv');
        await vi.advanceTimersByTimeAsync(2_000);
        s.arm('srv');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(at).toEqual([KEY_REASK_AT_MS[0]]);
    });

    it('ends on "done", and can be armed again at once after a success', async () => {
        const { s, at } = make(() => 'done');
        s.arm('srv');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(at).toEqual([KEY_REASK_AT_MS[0]]);
        expect(s.isArmed('srv')).toBe(false);
        s.arm('srv');
        expect(s.isArmed('srv')).toBe(true);
    });

    it('storm guard: a window that ran out unsatisfied is not re-opened for KEY_REASK_REARM_AFTER_MS (the 75 s timer cannot keep restarting it)', async () => {
        const { s } = make(() => 'waiting');
        s.arm('srv');
        await vi.advanceTimersByTimeAsync(KEY_REASK_WINDOW_MS + 1_000);
        s.arm('srv');
        expect(s.isArmed('srv')).toBe(false);
        await vi.advanceTimersByTimeAsync(KEY_REASK_REARM_AFTER_MS);
        s.arm('srv');
        expect(s.isArmed('srv')).toBe(true);
        s.disarmAll();
    });

    it('a throwing check keeps the schedule', async () => {
        let n = 0;
        const s = new KeyReaskScheduler({ tick: async () => { n += 1; throw new Error('x'); } });
        s.arm('srv');
        await vi.advanceTimersByTimeAsync(KEY_REASK_AT_MS[1] + 10);
        expect(n).toBe(2);
        s.disarmAll();
    });

    it('bound: at most (number of checks) × KEY_REASK_MAX_PER_TICK re-asks per window, and never over the per-minute budget', () => {
        let checks = 0;
        while (KeyReaskScheduler.offsetOf(checks) <= KEY_REASK_WINDOW_MS) checks += 1;
        expect(checks).toBe(13);
        expect(checks * KEY_REASK_MAX_PER_TICK).toBeLessThanOrEqual(78);
    });
});
