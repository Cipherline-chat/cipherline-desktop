import { describe, it, expect } from 'vitest';
import { applyPruned, makeSliceYield, unchangedSince } from './sweepCommit';
import { sweepRetention } from './retentionSweeper';
import type { StoragePolicy } from '../hooks/useRetentionPolicy';

describe('sweepCommit — a sliced sweep never overwrites a thread that moved on', () => {
    const a1 = [{ id: 'a1' }, { id: 'a2' }];
    const b1 = [{ id: 'b1' }];
    const swept = { a: a1, b: b1 };
    const pruned = new Map([['a', { msgs: [{ id: 'a2' }] }], ['b', { msgs: [] as { id: string }[] }]]);

    it('applies pruned threads whose array is still the swept one', () => {
        const next = applyPruned(swept, swept, pruned, ['a', 'b']);
        expect(next).toEqual({ a: [{ id: 'a2' }], b: [] });
        expect(next).not.toBe(swept);
    });

    it('skips a thread that received a message while the sweep yielded (no lost message)', () => {
        const aNewer = [...a1, { id: 'a3-arrived-during-yield' }];
        const live = { a: aNewer, b: b1, c: [{ id: 'c1' }] };
        expect(unchangedSince(pruned.keys(), live, swept)).toEqual(['b']);
        const next = applyPruned(live, swept, pruned, ['a', 'b']);
        expect(next.a).toBe(aNewer);                 // untouched — the new message survives
        expect(next.b).toEqual([]);
        expect(next.c).toBe(live.c);                 // threads the sweep never saw are kept
    });

    it('returns prev itself when nothing applies (React bails out of the render)', () => {
        const live = { a: [...a1], b: [...b1] };
        expect(applyPruned(live, swept, pruned, ['a', 'b'])).toBe(live);
    });
});

describe('makeSliceYield', () => {
    it('yields only once the slice budget is spent', async () => {
        let t = 0;
        let yields = 0;
        const sy = makeSliceYield(8, () => t, async () => { yields++; });
        await sy(); t = 5; await sy();
        expect(yields).toBe(0);
        t = 9; await sy();
        expect(yields).toBe(1);
        t = 12; await sy();
        expect(yields).toBe(1);
        t = 17.5; await sy();
        expect(yields).toBe(2);
    });

    it('a real sweep yields on budget and never starts a thread past it (long-task regression)', async () => {
        const policy: StoragePolicy = {
            attachmentRetention: '24h', messageRetention: '1mo',
            savedAttachmentIds: [], unsavedAttachmentIds: [], savedMessageIds: [], unsavedMessageIds: [],
            unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
        };
        const now = Date.UTC(2026, 9, 12);
        const state: Record<string, Array<{ id: string; timestamp: string; content: { type: string } }>> = {};
        for (let t = 0; t < 60; t++) {
            state[`c${t}`] = Array.from({ length: 800 }, (_, i) => ({ id: `m${t}-${i}`, timestamp: new Date(now - i * 3_600_000).toISOString(), content: { type: 'text' } }));
        }
        const run = (id: string) => sweepRetention({ [id]: state[id] }, policy, now, { [id]: new Set() });
        const ids = Object.keys(state);
        const SLICE_MS = 8;

        // Size the work to THIS machine. A fixed 60 threads was ~50-75 ms on the
        // dev box but under two budgets on a fast GitHub runner once the JIT was
        // warm, so the sliced pass yielded once and failed "expected 1 to be
        // greater than 1". Warm up, take the MEDIAN per-thread cost (one GC pause
        // or preemption cannot skew it), then run enough threads for at least
        // eight budgets of work. A slower or contended machine only gets more.
        for (const id of ids) run(id);
        const costs = ids.map(id => { const t = performance.now(); run(id); return performance.now() - t; }).sort((a, b) => a - b);
        const perThread = Math.max(costs[costs.length >> 1], 0.001);
        const runs = Math.max(ids.length, Math.ceil((8 * SLICE_MS) / perThread));

        // Sliced, as Dashboard runs it: record each synchronous stretch, plus when
        // its LAST thread started.
        type Stretch = { start: number; lastRunStart: number; runs: number };
        const stretches: Stretch[] = [];
        let cur: Stretch = { start: performance.now(), lastRunStart: NaN, runs: 0 };
        const sy = makeSliceYield(SLICE_MS, () => performance.now(), async () => {
            stretches.push(cur);
            await new Promise(r => setTimeout(r, 0));
            cur = { start: performance.now(), lastRunStart: NaN, runs: 0 };
        });
        for (let i = 0; i < runs; i++) {
            await sy();
            cur.lastRunStart = performance.now();
            cur.runs++;
            run(ids[i % ids.length]);
        }
        stretches.push(cur);
        const yields = stretches.length - 1;

        // It yields. More than once: there are >= 8 budgets of work.
        expect(yields, `runs=${runs} perThread=${perThread.toFixed(3)}ms`).toBeGreaterThan(1);
        expect(Math.max(...stretches.map(s => s.runs)), 'one stretch ran the whole sweep').toBeLessThan(runs);

        // No thread STARTS past the budget. A stretch can overrun only by the
        // thread already running when the budget ran out, so the time before its
        // last thread starts must be under the budget. That leaves out the
        // threads' own wall time, where GC pauses and preemption on a shared
        // runner land, and keeps what regresses: a checkpoint that does not
        // yield, or a budget that is not enforced. The SLICE_MS slack absorbs a
        // stall in the microseconds between a checkpoint and the next thread.
        const worst = Math.max(...stretches.map(s => s.lastRunStart - s.start));
        expect(worst, `stretches=${stretches.length}`).toBeLessThan(SLICE_MS * 2);
    });
});
