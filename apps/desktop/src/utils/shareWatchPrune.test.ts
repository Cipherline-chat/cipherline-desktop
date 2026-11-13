import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WATCH_PRUNE_GRACE_MS, pruneToActive, activeIdSet, scheduleWatchPrune } from './shareWatchPrune';

/**
 * What SidebarConference's two prune effects do, replayed with fake timers: the
 * effect re-runs whenever the joined active-sharer ids change (cleanup first,
 * which cancels the pending prune), and holds the watched set in state.
 */
function harness(initial: string[]) {
    let watched: ReadonlySet<string> = new Set(initial);
    const apply = (u: (prev: Set<string>) => Set<string>) => { watched = u(watched as Set<string>); };
    let cancel: (() => void) | null = null;
    return {
        /** The joined `activeScreenShareIds` changed to `ids`. */
        activeIs(ids: string) { cancel?.(); cancel = scheduleWatchPrune(ids, apply); },
        get watched() { return [...watched].sort(); },
    };
}

describe('shareWatchPrune', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // Report a346d7cf: BeamNG's H.264 High share was marked failed at 6 s and
    // republished FRESH (unpublish -> re-capture -> publish): share_start
    // publish_ms 1921 for that one, 1419-3927 in the other starts of the same
    // reports. The viewer had clicked Watch on the first track; the 1500 ms
    // grace expired before the new track existed and the Watch gate came back.
    it.each([1921, 2201, 3927])('a fresh republish that takes %s ms keeps the viewer watching', (gapMs) => {
        const h = harness(['sharer']);
        h.activeIs('sharer');          // watching a live share
        h.activeIs('');                // old publication unpublished
        vi.advanceTimersByTime(gapMs); // capture re-acquire + negotiate
        expect(h.watched).toEqual(['sharer']); // still in the watched set while the new track is on its way
        h.activeIs('sharer');          // new publication appears -> auto-resubscribe will take it
        vi.advanceTimersByTime(WATCH_PRUNE_GRACE_MS * 3);
        expect(h.watched).toEqual(['sharer']);
    });

    it('the old 1500 ms grace would have lost the watch for the same gap (the regression)', () => {
        let watched = new Set(['sharer']);
        const apply = (u: (p: Set<string>) => Set<string>) => { watched = u(watched); };
        const cancel1 = scheduleWatchPrune('', apply, 1500);
        vi.advanceTimersByTime(1921);
        cancel1();
        expect([...watched]).toEqual([]); // dropped before the republished track showed up
    });

    it('a genuine stop is still forgotten, after the grace', () => {
        const h = harness(['sharer']);
        h.activeIs('sharer');
        h.activeIs('');
        vi.advanceTimersByTime(WATCH_PRUNE_GRACE_MS - 1);
        expect(h.watched).toEqual(['sharer']);
        vi.advanceTimersByTime(1);
        expect(h.watched).toEqual([]);
    });

    it('only the sharer who stopped is pruned', () => {
        const h = harness(['a', 'b']);
        h.activeIs('b');
        vi.advanceTimersByTime(WATCH_PRUNE_GRACE_MS);
        expect(h.watched).toEqual(['b']);
    });

    it('the grace outlasts the slowest republish seen in the reports (3927 ms) with margin', () => {
        expect(WATCH_PRUNE_GRACE_MS).toBeGreaterThanOrEqual(3927 * 2);
    });

    it('pruneToActive returns the same set when nothing changed (no state churn)', () => {
        const prev = new Set(['a']);
        expect(pruneToActive(prev, new Set(['a', 'b']))).toBe(prev);
        expect([...pruneToActive(prev, new Set())]).toEqual([]);
    });

    it('activeIdSet parses the joined ids', () => {
        expect([...activeIdSet('')]).toEqual([]);
        expect([...activeIdSet('a,b')]).toEqual(['a', 'b']);
    });
});

describe('wiring (SidebarConference)', () => {
    const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('both prune effects use the shared grace, not a bare 1500 ms timer', () => {
        expect(src).toMatch(/scheduleWatchPrune\(activeScreenShareIds, setSubscribedScreenshares\)/);
        expect(src).toMatch(/setHiddenScreenShareIds\(prev => pruneToActive\(prev, activeSet\) as Set<string>\);\s*\}, WATCH_PRUNE_GRACE_MS\)/);
        expect(src).not.toMatch(/\}, 1500\);/);
    });
});
