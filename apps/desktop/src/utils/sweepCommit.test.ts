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

    it('bounds the longest synchronous stretch of a real sweep (long-task regression)', async () => {
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

        // Unsliced: the whole sweep is one task.
        const t0 = performance.now();
        for (const id of Object.keys(state)) run(id);
        const whole = performance.now() - t0;

        // Sliced, as Dashboard runs it: measure every synchronous stretch.
        let stretchStart = performance.now();
        let longest = 0;
        let yields = 0;
        const sy = makeSliceYield(8, () => performance.now(), async () => {
            longest = Math.max(longest, performance.now() - stretchStart);
            yields++;
            await new Promise(r => setTimeout(r, 0));
            stretchStart = performance.now();
        });
        for (const id of Object.keys(state)) { await sy(); run(id); }
        longest = Math.max(longest, performance.now() - stretchStart);

        expect(yields).toBeGreaterThan(1);
        // One thread's sweep past the 8 ms budget is the most a stretch can be.
        expect(longest).toBeLessThan(Math.max(whole / 2, 30));
    });
});
