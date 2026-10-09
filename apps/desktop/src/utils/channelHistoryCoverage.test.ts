import { describe, it, expect } from 'vitest';
import {
    HISTORY_PAGE_SIZE, aroundSplit, rangeForPage, addCoveredRange, demoteLiveTop, shrinkToCached,
    reachesHistoryStart, historyGaps, proofWindow, isUuid, boundOf,
    type ChannelCoverage, type HistoryBound,
} from './channelHistoryCoverage';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
/** Row n of a channel, one second apart (n = 0 is the oldest). */
const row = (n: number) => ({ id: `m${String(n).padStart(5, '0')}`, created_at: new Date(T0 + n * 1000).toISOString() });
const cached = (n: number) => ({ id: row(n).id, timestamp: row(n).created_at });
const b = (n: number): HistoryBound => boundOf(row(n));
/** Rows a..z inclusive, newest-first like the API. */
const rows = (a: number, z: number) => Array.from({ length: z - a + 1 }, (_, i) => row(z - i));

describe('rangeForPage — what one response proves complete', () => {
    it('newest page, full: [oldest returned, live top]', () => {
        expect(rangeForPage({ kind: 'newest', limit: 100 }, rows(4900, 4999))).toEqual({ lo: b(4900), hi: null });
    });

    it('newest page, short: the whole channel (lo = start of history)', () => {
        expect(rangeForPage({ kind: 'newest', limit: 100 }, rows(0, 41))).toEqual({ lo: null, hi: null });
        expect(rangeForPage({ kind: 'newest', limit: 100 }, [])).toEqual({ lo: null, hi: null });
    });

    it('before page: [oldest returned, cursor]; short → reaches the start', () => {
        expect(rangeForPage({ kind: 'before', limit: 100, cursor: b(4900) }, rows(4800, 4899))).toEqual({ lo: b(4800), hi: b(4900) });
        expect(rangeForPage({ kind: 'before', limit: 100, cursor: b(30) }, rows(0, 29))).toEqual({ lo: null, hi: b(30) });
        // boundary: exactly `limit` rows is NOT proof of the start
        expect(rangeForPage({ kind: 'before', limit: 100, cursor: b(100) }, rows(0, 99))!.lo).toEqual(b(0));
    });

    it('after page: [cursor, newest returned]; short → reaches the live top', () => {
        expect(rangeForPage({ kind: 'after', limit: 100, cursor: b(10) }, rows(11, 110))).toEqual({ lo: b(10), hi: b(110) });
        expect(rangeForPage({ kind: 'after', limit: 100, cursor: b(4950) }, rows(4951, 4999))).toEqual({ lo: b(4950), hi: null });
    });

    it('around page: each side open only if it came back short', () => {
        expect(aroundSplit(HISTORY_PAGE_SIZE)).toEqual({ older: 49, newer: 50 });
        // 49 older + target + 50 newer: both sides cut by the limit
        expect(rangeForPage({ kind: 'around', limit: 100, targetId: row(2000).id }, rows(1951, 2050)))
            .toEqual({ lo: b(1951), hi: b(2050) });
        // target near the start: only 3 older exist
        expect(rangeForPage({ kind: 'around', limit: 100, targetId: row(3).id }, rows(0, 53)))
            .toEqual({ lo: null, hi: b(53) });
        // target near the top: only 10 newer exist
        expect(rangeForPage({ kind: 'around', limit: 100, targetId: row(4989).id }, rows(4940, 4999)))
            .toEqual({ lo: b(4940), hi: null });
    });

    it('around page WITHOUT its target (an API that ignored `around`) proves nothing', () => {
        expect(rangeForPage({ kind: 'around', limit: 100, targetId: row(5).id }, rows(4900, 4999))).toBeNull();
    });
});

describe('addCoveredRange — segments merge only when they touch', () => {
    it('a page fetched from a segment\'s own cursor extends that segment', () => {
        let cov: ChannelCoverage = addCoveredRange([], { lo: b(4900), hi: null });
        cov = addCoveredRange(cov, { lo: b(4800), hi: b(4900) });
        expect(cov).toEqual([{ lo: b(4800), hi: null }]);
    });

    it('a disjoint jump window becomes its own segment, and the fill between joins all three', () => {
        let cov: ChannelCoverage = addCoveredRange([], { lo: b(4900), hi: null });
        cov = addCoveredRange(cov, { lo: b(1951), hi: b(2050) });
        expect(cov).toEqual([{ lo: b(1951), hi: b(2050) }, { lo: b(4900), hi: null }]);
        // a range touching both
        cov = addCoveredRange(cov, { lo: b(2050), hi: b(4900) });
        expect(cov).toEqual([{ lo: b(1951), hi: null }]);
    });

    it('null bounds dominate (start / live top)', () => {
        const cov = addCoveredRange([{ lo: b(100), hi: b(200) }], { lo: null, hi: b(150) });
        expect(cov).toEqual([{ lo: null, hi: b(200) }]);
        expect(reachesHistoryStart(cov)).toBe(true);
        expect(reachesHistoryStart([{ lo: b(1), hi: null }])).toBe(false);
        expect(reachesHistoryStart(undefined)).toBe(false);
    });

    it('null range is a no-op (same array back)', () => {
        const cov: ChannelCoverage = [{ lo: b(1), hi: null }];
        expect(addCoveredRange(cov, null)).toBe(cov);
    });
});

describe('demoteLiveTop — a reconnect stops trusting "reaches the live top"', () => {
    it('pins the open end to the newest cached row', () => {
        const cov: ChannelCoverage = [{ lo: b(4900), hi: null }];
        expect(demoteLiveTop(cov, [cached(4900), cached(4999), cached(4950)])).toEqual([{ lo: b(4900), hi: b(4999) }]);
    });

    it('then a newest page that no longer reaches it leaves a visible gap (>1 page missed) …', () => {
        let cov = demoteLiveTop([{ lo: b(4900), hi: null }], [cached(4999)]);
        cov = addCoveredRange(cov, rangeForPage({ kind: 'newest', limit: 100 }, rows(5200, 5299)));
        expect(cov).toEqual([{ lo: b(4900), hi: b(4999) }, { lo: b(5200), hi: null }]);
    });

    it('… while one that does reach it merges (fewer than a page missed) — control', () => {
        let cov = demoteLiveTop([{ lo: b(4900), hi: null }], [cached(4999)]);
        cov = addCoveredRange(cov, rangeForPage({ kind: 'newest', limit: 100 }, rows(4950, 5049)));
        expect(cov).toEqual([{ lo: b(4900), hi: null }]);
    });

    it('leaves already-closed coverage alone (same array)', () => {
        const cov: ChannelCoverage = [{ lo: b(1), hi: b(2) }];
        expect(demoteLiveTop(cov, [cached(2)])).toBe(cov);
    });
});

describe('historyGaps — where the holes render', () => {
    const thread = (...ns: number[]) => ns.map(cached);

    it('no coverage yet → no gaps (a cache shown as-is, like before)', () => {
        expect(historyGaps([], thread(1, 2, 3))).toEqual([]);
        expect(historyGaps(undefined, thread(1))).toEqual([]);
    });

    it('newest page only: the "older history" gap sits above its oldest row', () => {
        const gaps = historyGaps([{ lo: b(4900), hi: null }], thread(4900, 4901, 4999));
        expect(gaps).toEqual([{ key: `∅|${row(4900).id}`, beforeRowId: row(4900).id, older: null, newer: b(4900) }]);
    });

    it('start of history reached → no gap at all', () => {
        expect(historyGaps([{ lo: null, hi: null }], thread(0, 1, 2))).toEqual([]);
    });

    it('stale cache below the newest page: the gap sits BETWEEN them (the old invisible hole)', () => {
        const gaps = historyGaps([{ lo: b(5200), hi: null }], thread(10, 11, 4999, 5200, 5299));
        expect(gaps).toHaveLength(1);
        expect(gaps[0].beforeRowId).toBe(row(5200).id);
        expect(gaps[0].older).toBeNull();
    });

    it('after a jump: a gap below the jump window and one between it and the newest page', () => {
        const cov: ChannelCoverage = [{ lo: b(1951), hi: b(2050) }, { lo: b(4900), hi: null }];
        const gaps = historyGaps(cov, thread(1951, 2000, 2050, 4900, 4999));
        expect(gaps.map(g => [g.beforeRowId, g.older?.id ?? null, g.newer?.id ?? null])).toEqual([
            [row(1951).id, null, row(1951).id],
            [row(4900).id, row(2050).id, row(4900).id],
        ]);
    });

    it('top segment not live with newer rows cached → a gap above them (fill with after_id)', () => {
        const gaps = historyGaps([{ lo: null, hi: b(4999) }], thread(4998, 4999, 5300));
        expect(gaps).toEqual([{ key: `${row(4999).id}|∅`, beforeRowId: row(5300).id, older: b(4999), newer: null }]);
    });

    it('a server-saved row loaded by id far above the pages sits ABOVE the older-history gap', () => {
        // ids-mode adds no coverage, so the saved row is just an uncovered cached row
        const gaps = historyGaps([{ lo: b(4900), hi: null }], thread(12, 4900, 4999));
        expect(gaps[0].beforeRowId).toBe(row(4900).id);
    });
});

describe('shrinkToCached — retention changed', () => {
    it('pulls a segment\'s floor up to the oldest cached row in it (rows dropped as expired become a gap)', () => {
        const cov: ChannelCoverage = [{ lo: b(4800), hi: null }];
        expect(shrinkToCached(cov, [cached(4850), cached(4999)])).toEqual([{ lo: b(4850), hi: null }]);
    });
    it('unchanged when the floor row is cached (same array)', () => {
        const cov: ChannelCoverage = [{ lo: b(4800), hi: null }];
        expect(shrinkToCached(cov, [cached(4800), cached(4999)])).toBe(cov);
    });
    it('drops a segment with nothing cached in it', () => {
        expect(shrinkToCached([{ lo: b(10), hi: b(20) }, { lo: b(4800), hi: null }], [cached(4800)]))
            .toEqual([{ lo: b(4800), hi: null }]);
    });
});

describe('proofWindow / isUuid', () => {
    it('both ends exclusive at ms granularity; open ends reach start / request time', () => {
        expect(proofWindow({ lo: b(10), hi: b(20) }, 999)).toEqual({ fromTs: b(10).ts + 1, toTs: b(20).ts });
        expect(proofWindow({ lo: null, hi: null }, 999)).toEqual({ fromTs: -Infinity, toTs: 999 });
        expect(proofWindow(null, 1)).toBeNull();
    });
    it('isUuid', () => {
        expect(isUuid('33333333-3333-4333-8333-333333333331')).toBe(true);
        expect(isUuid('local-123')).toBe(false);
        expect(isUuid(undefined)).toBe(false);
    });
});
