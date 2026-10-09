/**
 * Which stretches of a server channel's history this client has loaded
 * COMPLETELY — and therefore where the holes are.
 *
 * Why this exists. The channel thread is one chronological array (the local
 * cache, `channelMessages[channelId]`), and history arrives in 100-row pages.
 * As long as pages only ever extend the thread downward from the top, the
 * array is gap-free and "load older" can count back from its oldest row. That
 * stops being true the moment a row lands that is NOT adjacent to what is
 * already there:
 *
 *   - jump-to-message loads the page AROUND an old message;
 *   - a server-saved / pinned message is loaded by id, however old;
 *   - a cache restored from disk is followed, after a long absence, by a
 *     newest page that no longer reaches it (more than a page arrived
 *     meanwhile) — this one predates paging: the hole between the two was
 *     invisible and was never filled, because the old "load older" cursor
 *     was the oldest row in the whole array, i.e. BELOW the hole.
 *
 * So instead of inferring continuity from the array, each fetch records the
 * server range it PROVES complete — a {@link CoveredSegment} — and segments
 * merge when they touch. Every boundary between segments (or below the oldest
 * one) is a gap the UI can show and fill, from either side.
 *
 * Bounds are rows (id + created_at in ms). A fetch made from a cursor row
 * includes that row's timestamp in its proven range, which is what makes the
 * new segment touch the one the cursor came from.
 *
 * Precision note: the server orders by (created_at µs, id); the client only
 * knows milliseconds. Two segments whose facing bounds share a millisecond are
 * treated as touching. That can only misjudge a hole made entirely of rows
 * inside that single millisecond — accepted.
 *
 * Coverage is session state, deliberately NOT persisted: a cache loaded from
 * disk starts uncovered, the first newest-page fetch covers the top, and the
 * rows below are re-proven a page at a time as the user scrolls (cached rows
 * are reused, not re-decrypted — utils/channelRowReuse.ts). Persisting it
 * would mean trusting a "reaches the live top" claim across a restart, which
 * is exactly the claim a restart breaks.
 *
 * Pure: no argument is mutated.
 */

/** Server page size for channel history (the API caps `limit` at 100). */
export const HISTORY_PAGE_SIZE = 100;

export interface HistoryBound {
    id: string;
    /** created_at, ms since epoch */
    ts: number;
}

/** A run of server history known to be loaded completely, bound rows
 *  included. `lo: null` reaches the very first message of the channel;
 *  `hi: null` reaches the live top (nothing newer existed when it was
 *  fetched, and the socket has delivered everything since). */
export interface CoveredSegment {
    lo: HistoryBound | null;
    hi: HistoryBound | null;
}

/** Oldest first, pairwise disjoint (non-touching). */
export type ChannelCoverage = CoveredSegment[];

/** Minimal row shape — raw API rows (`created_at`) or cached rows (`timestamp`). */
interface RowLike {
    id: string;
    created_at?: string;
    timestamp?: string | number;
}

const rowTs = (r: RowLike): number => {
    const v = r.created_at ?? r.timestamp;
    return typeof v === 'number' ? v : new Date(v ?? '').getTime();
};

export const boundOf = (r: RowLike): HistoryBound => ({ id: r.id, ts: rowTs(r) });

const loTs = (s: CoveredSegment): number => (s.lo ? s.lo.ts : -Infinity);
const hiTs = (s: CoveredSegment): number => (s.hi ? s.hi.ts : Infinity);

/** How an `around` page of `limit` rows splits (mirrors the API's
 *  ChannelMessagesService.aroundSplit — keep them in step). */
export function aroundSplit(limit: number): { older: number; newer: number } {
    const older = Math.floor((limit - 1) / 2);
    return { older, newer: limit - 1 - older };
}

export type PageRequest =
    | { kind: 'newest'; limit: number }
    | { kind: 'before'; limit: number; cursor: HistoryBound }
    | { kind: 'after'; limit: number; cursor: HistoryBound }
    | { kind: 'around'; limit: number; targetId: string };

/**
 * The range of server history one response PROVES complete, or null when it
 * proves nothing (an `around` response that doesn't contain its target — an
 * older API that ignored the parameter and sent the newest page instead).
 *
 * A side is open (null) when the response came back SHORT on that side: the
 * server ran out of rows, so that side reaches the end of history.
 *
 * @param raw the response rows, in any order
 */
export function rangeForPage(req: PageRequest, raw: ReadonlyArray<RowLike>): CoveredSegment | null {
    const rows = [...raw].sort((a, b) => rowTs(a) - rowTs(b));
    const oldest = rows.length ? boundOf(rows[0]) : null;
    const newest = rows.length ? boundOf(rows[rows.length - 1]) : null;
    const short = rows.length < req.limit;
    switch (req.kind) {
        case 'newest':
            return { lo: short ? null : oldest, hi: null };
        case 'before':
            return { lo: short ? null : oldest, hi: req.cursor };
        case 'after':
            return { lo: req.cursor, hi: short ? null : newest };
        case 'around': {
            const idx = rows.findIndex(r => r.id === req.targetId);
            if (idx === -1) return null;
            const split = aroundSplit(req.limit);
            const olderCount = idx;
            const newerCount = rows.length - idx - 1;
            return {
                lo: olderCount < split.older ? null : oldest,
                hi: newerCount < split.newer ? null : newest,
            };
        }
    }
}

const touches = (a: CoveredSegment, b: CoveredSegment): boolean =>
    loTs(a) <= hiTs(b) && loTs(b) <= hiTs(a);

/** Add a proven range, merging every segment it touches. */
export function addCoveredRange(cov: ChannelCoverage, range: CoveredSegment | null): ChannelCoverage {
    if (!range) return cov;
    let merged: CoveredSegment = range;
    const rest: CoveredSegment[] = [];
    for (const s of cov) {
        if (touches(s, merged)) {
            merged = {
                lo: s.lo === null || merged.lo === null ? null : (s.lo.ts <= merged.lo.ts ? s.lo : merged.lo),
                hi: s.hi === null || merged.hi === null ? null : (s.hi.ts >= merged.hi.ts ? s.hi : merged.hi),
            };
        } else {
            rest.push(s);
        }
    }
    return [...rest, merged].sort((a, b) => loTs(a) - loTs(b));
}

/**
 * The socket dropped (or the app restarted): "reaches the live top" can no
 * longer be trusted, because anything posted while disconnected was never
 * delivered. Pin the top segment's open end to the newest row cached for the
 * channel at this moment. The next newest-page fetch either touches it (fewer
 * than a page was missed — merged, no gap) or doesn't (a real gap, shown).
 */
export function demoteLiveTop(cov: ChannelCoverage, cachedRows: ReadonlyArray<RowLike>): ChannelCoverage {
    const top = cov[cov.length - 1];
    if (!top || top.hi !== null) return cov;
    let newest: HistoryBound | null = null;
    for (const r of cachedRows) {
        const b = boundOf(r);
        if (Number.isFinite(b.ts) && (!newest || b.ts > newest.ts)) newest = b;
    }
    // Nothing cached to pin to: the segment proves nothing any more.
    if (!newest || (top.lo && newest.ts < top.lo.ts)) return cov.slice(0, -1);
    return [...cov.slice(0, -1), { lo: top.lo, hi: newest }];
}

/** Server message ids are UUIDs; the API 400s a request naming anything else
 *  (a local pending-send id, say), so callers filter with this first. */
export const isUuid = (s: unknown): s is string =>
    typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * The slice of server history a response proves COMPLETE, in the
 * `ServerWindow` shape pruneVanishedPlaceholders takes (utils/channelHistoryMerge.ts):
 * a cached placeholder inside it that the response did not return is gone
 * server-side. Both ends are exclusive at millisecond granularity — the API
 * orders by microseconds, so an un-returned row sharing a boundary row's
 * millisecond may legitimately sit just outside the page on either side, and
 * must never be judged absent. An open end reaches the start of history, or
 * the moment the request was made (sparing a live row that landed mid-flight).
 */
export function proofWindow(range: CoveredSegment | null, requestedAtMs: number): { fromTs: number; toTs: number } | null {
    if (!range) return null;
    return {
        fromTs: range.lo ? range.lo.ts + 1 : -Infinity,
        toTs: range.hi ? range.hi.ts : requestedAtMs,
    };
}

/**
 * Retention settings changed. Rows a covered page dropped "at the door" as
 * already expired may be wanted now (a longer window), and retention only
 * ever drops the OLDEST rows — so pull each segment's lower bound up to the
 * oldest row actually cached inside it. The rows below become a fillable gap
 * again instead of being "covered" but absent. A segment with nothing cached
 * left in it proves nothing useful and is dropped.
 */
export function shrinkToCached(cov: ChannelCoverage, cachedRows: ReadonlyArray<RowLike>): ChannelCoverage {
    let changed = false;
    const out: ChannelCoverage = [];
    for (const s of cov) {
        let oldest: HistoryBound | null = null;
        for (const r of cachedRows) {
            const b = boundOf(r);
            if (b.ts >= loTs(s) && b.ts <= hiTs(s) && (!oldest || b.ts < oldest.ts)) oldest = b;
        }
        if (!oldest) { changed = true; continue; }
        if (s.lo === null || oldest.ts > s.lo.ts) {
            changed = true;
            out.push({ lo: oldest, hi: s.hi });
        } else {
            out.push(s);
        }
    }
    return changed ? out : cov;
}

/** The channel's first message is loaded (nothing older exists server-side). */
export const reachesHistoryStart = (cov: ChannelCoverage | undefined): boolean =>
    !!cov && cov.length > 0 && cov[0].lo === null;

/**
 * One hole in the loaded history, as the message list renders it.
 *
 * `beforeRowId` is the cached row the gap marker sits directly ABOVE. A gap
 * is filled from whichever side has a bound: `newer` → fetch `before_id`
 * (the user is scrolling up into it); `older` → fetch `after_id` (the user
 * jumped to an old message and is scrolling down).
 */
export interface HistoryGap {
    /** Stable for the life of the gap's two bounds. */
    key: string;
    beforeRowId: string;
    older: HistoryBound | null;
    newer: HistoryBound | null;
}

/**
 * Where the holes are, placed against the cached thread (chronological).
 *
 *  - below the oldest segment (unless it reaches the start of history);
 *  - between every pair of segments;
 *  - above the newest segment when it does not reach the live top AND newer
 *    rows are cached (otherwise there is nowhere to draw it, and the next
 *    newest-page fetch closes it anyway).
 *
 * A gap with no cached row to sit above is omitted — except the bottom one,
 * which then sits above the oldest row of the oldest segment and is how
 * "load older history" is offered at the top of the list.
 */
export function historyGaps(cov: ChannelCoverage | undefined, rows: ReadonlyArray<RowLike>): HistoryGap[] {
    if (!cov || cov.length === 0 || rows.length === 0) return [];
    const ts = rows.map(rowTs);
    // First cached row at/after a bound — the row a gap below that bound sits above.
    const firstAtOrAfter = (b: HistoryBound): string | null => {
        const exact = rows.findIndex(r => r.id === b.id);
        if (exact !== -1) return rows[exact].id;
        for (let i = 0; i < rows.length; i++) if (ts[i] >= b.ts) return rows[i].id;
        return null;
    };
    const firstAfter = (b: HistoryBound): string | null => {
        for (let i = 0; i < rows.length; i++) if (ts[i] > b.ts && rows[i].id !== b.id) return rows[i].id;
        return null;
    };
    const out: HistoryGap[] = [];
    const k = (b: HistoryBound | null) => (b ? b.id : '∅');
    for (let i = 0; i < cov.length; i++) {
        const seg = cov[i];
        if (seg.lo === null) continue; // reaches the start (only possible for i === 0)
        const older = i > 0 ? cov[i - 1].hi : null;
        const at = firstAtOrAfter(seg.lo);
        if (at) out.push({ key: `${k(older)}|${k(seg.lo)}`, beforeRowId: at, older, newer: seg.lo });
    }
    const top = cov[cov.length - 1];
    if (top.hi !== null) {
        const at = firstAfter(top.hi);
        if (at) out.push({ key: `${k(top.hi)}|∅`, beforeRowId: at, older: top.hi, newer: null });
    }
    return out;
}
