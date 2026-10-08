import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allocateRows, ROW_BATCH, ROW_PX_ESTIMATE } from './incrementalRows';

describe('allocateRows', () => {
    it('fills sections in display order and stops where the budget runs out', () => {
        expect(allocateRows([10, 20, 100], 48)).toEqual([10, 20, 18]);
        expect(allocateRows([10, 20, 100], 5)).toEqual([5, 0, 0]);
    });

    it('a list that fits the budget is rendered whole (identical to no budgeting)', () => {
        const counts = [3, 7, 20];
        expect(allocateRows(counts, ROW_BATCH)).toEqual(counts);
        expect(allocateRows(counts, 30)).toEqual(counts);          // exactly full
        expect(allocateRows(counts, 29)).toEqual([3, 7, 19]);      // control: one short drops the last row
    });

    it('never allocates more than the budget in total, nor more than a section holds', () => {
        for (const budget of [0, 1, 47, 48, 49, 500]) {
            const counts = [0, 12, 0, 60, 5];
            const a = allocateRows(counts, budget);
            expect(a.reduce((x, y) => x + y, 0)).toBe(Math.min(budget, 77));
            a.forEach((n, i) => { expect(n).toBeLessThanOrEqual(counts[i]); expect(n).toBeGreaterThanOrEqual(0); });
        }
    });

    it('tolerates empty sections and a negative budget', () => {
        expect(allocateRows([], 10)).toEqual([]);
        expect(allocateRows([0, 0], 10)).toEqual([0, 0]);
        expect(allocateRows([5], -3)).toEqual([0]);
    });

    it('the spacer estimate is a sane row height (avatar 32 + py-1.5 12 + 2 gap)', () => {
        expect(ROW_PX_ESTIMATE).toBe(46);
    });
});

describe('wiring (source)', () => {
    const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

    it('the member list mounts a budget of rows and sizes a sentinel for the rest', () => {
        const panel = read('components/server/ServerContextPanel.tsx');
        // `listMembers` = the list actually shown (filtered to the open channel's
        // viewers, see channelViewerCache) — the budget sizes THAT, not the roster.
        expect(panel).toMatch(/useIncrementalRows\(server\.server_id, listMembers\.length\)/);
        expect(panel).toMatch(/\.slice\(0, rowAlloc\[gi\]\)/);
        expect(panel).toMatch(/onlineNoRole\.slice\(0, onlineAlloc\)/);
        expect(panel).toMatch(/allOffline\.slice\(0, offlineAlloc\)/);
        expect(panel).toMatch(/ref=\{rowSentinelRef\}/);
        // The section headers still count the FULL list.
        expect(panel).toMatch(/Offline — \{allOffline\.length\}/);
        expect(panel).toMatch(/Online — \{onlineNoRole\.length\}/);
    });

    it('the observer is re-created after each batch (an observer only reports changes) and is rooted at the scroll parent', () => {
        const hook = read('hooks/useIncrementalRows.ts');
        expect(hook).toMatch(/\[node, hidden, budget, resetKey, batch, marginPx\]/);
        expect(hook).toMatch(/root: scrollParentOf\(node\)/);
        expect(hook).toMatch(/state\.key === resetKey \? state\.budget : batch/);   // reset computed in render, no stale-budget frame
    });
});
