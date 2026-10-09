import { useCallback, useMemo, useState } from 'react';

const PAGE_SIZE = 20;

interface PagedRow {
    id?: string;
    timestamp?: string | number;
}

const tsOf = (m: PagedRow | undefined): number => {
    const v = m?.timestamp;
    return typeof v === 'number' ? v : Date.parse(v ?? '');
};

/**
 * Paginated view over a conversation's in-memory message array: the rows from
 * an ANCHOR row to the end. `loadMore()` moves the anchor PAGE_SIZE rows
 * earlier; switching conversations (`resetKey`) clears it.
 *
 * Anchored by row identity, not by a count from the end. A count-based tail
 * window broke as soon as rows could arrive in the MIDDLE of the array (server
 * history pages, the page around a jumped-to message, server-saved messages
 * loaded by id): inserting N rows inside the window silently pushed N rows off
 * its top, under the reader. Anchored, rows inserted after the anchor simply
 * appear; rows inserted before it stay out of the DOM until scrolled to, so a
 * background prefetch above the window cannot move the viewport either.
 *
 * Until the first `loadMore()` (anchor null) the window is the newest
 * PAGE_SIZE rows and follows new messages, exactly as before.
 *
 * Generic over the row shape; rows are matched by `id` and `timestamp`.
 */
export function useMessagePagination<T>(allMessages: T[], resetKey: string | null | undefined) {
    // The anchor is stored WITH the conversation it belongs to, so switching
    // conversations resets the window by derivation — no reset effect (and no
    // extra render through a stale window) needed.
    const [anchorState, setAnchorState] = useState<{ key: string | null | undefined; anchor: { id: string; ts: number } } | null>(null);
    const anchor = anchorState && anchorState.key === resetKey ? anchorState.anchor : null;
    const setAnchor = useCallback(
        (a: { id: string; ts: number }) => setAnchorState({ key: resetKey, anchor: a }),
        [resetKey],
    );

    const rows = allMessages as unknown as PagedRow[];
    const total = rows.length;

    const startIdx = useMemo(() => windowStart(rows, anchor), [rows, anchor]);

    const hasMore = startIdx > 0;

    const anchorAt = useCallback((idx: number) => {
        const r = rows[idx];
        if (r && typeof r.id === 'string') setAnchor({ id: r.id, ts: tsOf(r) });
    }, [rows, setAnchor]);

    const loadMore = useCallback(() => {
        anchorAt(Math.max(0, startIdx - PAGE_SIZE));
    }, [anchorAt, startIdx]);

    /**
     * Widens the window just enough to include the message with the given id.
     * Returns true if the id was found in allMessages, false otherwise.
     * Used by jump-to-reply so we don't have to call loadMore() in a loop.
     */
    const ensureVisible = useCallback((msgId: string) => {
        const idx = rows.findIndex(m => m?.id === msgId);
        if (idx === -1) return false;
        if (idx < startIdx) anchorAt(idx);
        return true;
    }, [rows, startIdx, anchorAt]);

    const displayed = useMemo(
        () => (startIdx === 0 ? allMessages : allMessages.slice(startIdx)),
        [allMessages, startIdx],
    );

    /** How many rows are in the window — `total - hiddenAbove`. */
    const visibleCount = total - startIdx;

    return { displayed, hasMore, loadMore, ensureVisible, visibleCount, hiddenAbove: startIdx };
}

/**
 * Index of the first displayed row. Pure (the hook's whole windowing rule).
 * No anchor → the newest PAGE_SIZE rows. A vanished anchor row → the first
 * row at/after its timestamp, never fewer than PAGE_SIZE rows shown.
 */
export function windowStart(rows: ReadonlyArray<PagedRow>, anchor: { id: string; ts: number } | null): number {
    const tail = Math.max(0, rows.length - PAGE_SIZE);
    if (!anchor) return tail;
    const exact = rows.findIndex(m => m?.id === anchor.id);
    if (exact !== -1) return exact;
    const byTime = rows.findIndex(m => tsOf(m) >= anchor.ts);
    return byTime === -1 ? tail : Math.min(byTime, tail);
}

export const MESSAGE_PAGE_SIZE = PAGE_SIZE;
