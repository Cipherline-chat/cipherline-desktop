/**
 * Home-screen pins — the shape a user can pin to the home deck, and the
 * identity function used to dedupe / match / key them.
 *
 * Lives outside HomePanel.tsx on purpose: exporting a non-component value from
 * a component module breaks React Fast Refresh (react-refresh/only-export-
 * components), and both Dashboard and HomePanel need these.
 */

export type PinnedHomeItem =
    | { type: 'conversation'; id: string }
    | { type: 'channel'; channelId: string; serverId: string }
    | { type: 'server'; serverId: string };

/** Stable identity for a pin — used for dedupe, React keys, and unpin matching.
 *  Prefer this over per-type field comparisons so adding a variant doesn't need
 *  a new branch at every call site. */
export function pinKey(p: PinnedHomeItem): string {
    return p.type === 'conversation' ? `c:${p.id}`
        : p.type === 'channel' ? `ch:${p.channelId}`
        : `s:${p.serverId}`;
}

// ── Reordering ────────────────────────────────────────────────────────────────
// Order IS array order: the pins array is persisted as-is (secureLocalStore →
// backups → cross-device restore), so a reorder is nothing more than a new
// array through the same setter. No separate order key.

/**
 * Moves the pin `key` to final position `toIndex` WITHIN THE VISIBLE ORDER
 * (`visibleKeys` = what the Home grid is actually showing, in order), and
 * returns the new full array — or `null` for a no-op.
 *
 * Why "visible": HomePanel drops pins it cannot resolve right now (a channel
 * whose server's channel list has not loaded yet, a conversation you have
 * left). Those still live in the persisted array, so a visual move must not
 * shuffle them: every hidden pin keeps its exact array slot, and only the
 * slots the visible pins occupy are refilled, in their new order. When it
 * resolves again it reappears exactly where it was.
 *
 * `toIndex` uses arrayMove semantics (the item's index AFTER the move), which
 * is what both dnd-kit's sortable `over` index and a keyboard nudge produce.
 */
export function moveVisiblePin(
    all: PinnedHomeItem[],
    visibleKeys: string[],
    key: string,
    toIndex: number,
): PinnedHomeItem[] | null {
    const allKeys = all.map(pinKey);
    const present = new Set(allKeys);
    // Stale keys (a pin removed between render and drop) would desync the
    // slot count, so the visible order is re-derived against the live array.
    const visible = visibleKeys.filter((k, i) => present.has(k) && visibleKeys.indexOf(k) === i);
    const from = visible.indexOf(key);
    if (from < 0 || visible.length < 2) return null;
    const to = Math.max(0, Math.min(visible.length - 1, Math.trunc(toIndex)));
    if (to === from) return null;

    const nextVisible = visible.slice();
    nextVisible.splice(from, 1);
    nextVisible.splice(to, 0, key);

    const visibleSet = new Set(visible);
    const byKey = new Map(all.map((p, i) => [allKeys[i], p] as const));
    const out = all.slice();
    let v = 0;
    for (let i = 0; i < out.length; i++) {
        if (visibleSet.has(allKeys[i])) out[i] = byKey.get(nextVisible[v++])!;
    }
    return out;
}

export type PinMoveDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Keyboard reorder chord → direction, or null when the key is not a reorder.
 * Alt+Arrow is the app's convention (the server rail and ClSelect's role
 * reorder both use it); Ctrl+Arrow is accepted too since it is what several
 * other apps use. Shift / a second modifier never counts, so Alt+Shift+Arrow
 * etc. stay free for the platform.
 */
export function pinReorderDirection(e: {
    key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
}): PinMoveDirection | null {
    if (e.shiftKey || e.metaKey || e.altKey === e.ctrlKey) return null;
    switch (e.key) {
        case 'ArrowLeft': return 'left';
        case 'ArrowRight': return 'right';
        case 'ArrowUp': return 'up';
        case 'ArrowDown': return 'down';
        default: return null;
    }
}

/**
 * Target index for a keyboard nudge in a wrapping, row-major grid of `count`
 * pins laid out `columns` wide. Left/right step one place in reading order
 * (wrapping across a row end, since that IS the next position); up/down jump
 * a whole row. Down from a row above a short last row lands on the last pin
 * (it still moves down a row); up from the first row / down from the last
 * row is a no-op. Returns null for every no-op so callers never announce a
 * move that did not happen.
 */
export function gridMoveTarget(
    index: number,
    count: number,
    columns: number,
    dir: PinMoveDirection,
): number | null {
    if (count < 2 || index < 0 || index >= count) return null;
    const cols = Math.max(1, Math.floor(columns));
    let t: number;
    switch (dir) {
        case 'left': t = index - 1; break;
        case 'right': t = index + 1; break;
        case 'up': t = index - cols; break;
        case 'down': {
            t = index + cols;
            if (t > count - 1) {
                const lastRow = Math.floor((count - 1) / cols);
                t = Math.floor(index / cols) < lastRow ? count - 1 : index;
            }
            break;
        }
    }
    if (t < 0 || t > count - 1 || t === index) return null;
    return t;
}

/** How many columns a wrapping grid is using, from its items' `offsetTop`s in
 *  order (offsetTop ignores transforms, so a hover lift can't split a row).
 *  It is the length of the first run of equal tops. */
export function countGridColumns(tops: number[]): number {
    if (!tops.length) return 1;
    let n = 1;
    while (n < tops.length && Math.abs(tops[n] - tops[0]) < 1) n++;
    return n;
}

/** Screen-reader line for a completed move (keyboard or pointer). */
export function describePinMove(name: string, toIndex: number, count: number): string {
    return `Moved ${name} to position ${toIndex + 1} of ${count}.`;
}
