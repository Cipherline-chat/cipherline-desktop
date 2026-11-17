/**
 * homeCallsList — ordering and folding for the Home deck's ONE "Happening now"
 * tile (HomeCallsTile).
 *
 * The deck used to render one full card per live call, so six calls in your
 * servers were three rows of big cards that all said "HAPPENING NOW" and
 * shoved Pinned/Friends below the fold. The tile now lists each call as one
 * compact line, shows the first few and folds the rest behind "+N more". That
 * makes the ORDER load-bearing (whatever sorts first is what you see), and the
 * order has two jobs that pull against each other:
 *
 *   1. Relevance — your own call first, then calls your friends are in (more
 *      friends first), then bigger calls, then the most recently started.
 *   2. Stability — presence is a firehose (every join / leave / mute is a
 *      WS event), and a list that re-ranks on every one of them makes the row
 *      under your cursor jump away just as you reach for Join.
 *
 * So the ranking is recomputed only when the call MEMBERSHIP of the list
 * changes — a call appears, a call ends, or the call you are in changes — and
 * participant churn inside existing calls updates their counts in place
 * without moving them. `nextCallOrder` implements that; everything here is
 * pure so it can be tested without React.
 */

/** The fields of a "Happening now" call this module ranks on. */
export interface RankableCall {
    /** Stable row identity (`voice-<channel>` / `huddle-<call>`). */
    key: string;
    participantIds: readonly string[];
    /** ms epoch the call started, when known (huddle calls carry
     *  `spawned_at`; always-on voice channels have no start time). */
    startedAt?: number | null;
    /** Display name — the last, purely deterministic tie-break. */
    name: string;
}

export interface CallRankContext {
    /** Key of the call this client is connected to, if it is in the list. */
    mineKey: string | null;
    /** Accepted friends' user ids. */
    friendIds: ReadonlySet<string>;
}

/** Calls shown before the "+N more" fold, single-column layout. */
export const HOME_CALLS_COLLAPSED_LIMIT = 3;
/** Calls shown before the fold when the tile is wide enough for two columns:
 *  two FULL lines, so the folded tile is shorter than the single-column one
 *  and never ends on a half-empty line. */
export const HOME_CALLS_COLLAPSED_LIMIT_TWO_COL = 4;
/** Inline size (px) of the call list at which rows go two-across. Picked so
 *  each column is still ≥ ~600px: wide enough for name, server, count, media
 *  icons and Join without truncating an ordinary name. */
export const HOME_CALLS_TWO_COL_MIN_WIDTH = 1240;

/**
 * 1 or 2 columns. Two only when the list is wide enough AND there are more
 * calls than a single column shows folded: up to three calls already fit in
 * three short lines, and two-across would just strand one Join mid-tile (one
 * call) or leave a half-empty line (three calls).
 */
export function callColumns(listWidth: number, total: number): 1 | 2 {
    return listWidth >= HOME_CALLS_TWO_COL_MIN_WIDTH && total > HOME_CALLS_COLLAPSED_LIMIT ? 2 : 1;
}

export function friendsInCall(call: Pick<RankableCall, 'participantIds'>, friendIds: ReadonlySet<string>): number {
    let n = 0;
    for (const uid of call.participantIds) if (friendIds.has(uid)) n++;
    return n;
}

/**
 * Relevance order: mine → more friends → more people → started more recently
 * (a known start time ranks above an unknown one) → name → key. Total and
 * deterministic, so equal-looking calls never swap places between sorts.
 */
export function compareCalls(a: RankableCall, b: RankableCall, ctx: CallRankContext): number {
    const am = a.key === ctx.mineKey ? 1 : 0;
    const bm = b.key === ctx.mineKey ? 1 : 0;
    if (am !== bm) return bm - am;
    const af = friendsInCall(a, ctx.friendIds);
    const bf = friendsInCall(b, ctx.friendIds);
    if (af !== bf) return bf - af;
    if (a.participantIds.length !== b.participantIds.length) return b.participantIds.length - a.participantIds.length;
    const as = a.startedAt ?? Number.NEGATIVE_INFINITY;
    const bs = b.startedAt ?? Number.NEGATIVE_INFINITY;
    if (as !== bs) return as > bs ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function sortCalls<T extends RankableCall>(calls: readonly T[], ctx: CallRankContext): T[] {
    return [...calls].sort((a, b) => compareCalls(a, b, ctx));
}

/** What a re-rank is keyed on: the SET of calls plus which one is yours. */
export function membershipSignature(calls: readonly Pick<RankableCall, 'key'>[], mineKey: string | null): string {
    return `${calls.map(c => c.key).sort().join('\n')}\u0000${mineKey ?? ''}`;
}

export interface CallOrder {
    sig: string;
    keys: readonly string[];
}

/**
 * The display order, re-ranked only on a membership change. Returns `prev`
 * itself (same identity) while the signature is unchanged, so a caller can
 * memo on it.
 */
export function nextCallOrder(
    prev: CallOrder | null,
    calls: readonly RankableCall[],
    ctx: CallRankContext,
): CallOrder {
    const sig = membershipSignature(calls, ctx.mineKey);
    if (prev && prev.sig === sig) return prev;
    return { sig, keys: sortCalls(calls, ctx).map(c => c.key) };
}

/**
 * The CURRENT call objects (live counts) laid out in `order`. Defensive about
 * a key mismatch it should never see — a key the order lacks is appended, a
 * stale one dropped — so a row can never silently vanish.
 */
export function applyCallOrder<T extends Pick<RankableCall, 'key'>>(calls: readonly T[], order: CallOrder): T[] {
    const byKey = new Map(calls.map(c => [c.key, c] as const));
    const out: T[] = [];
    for (const k of order.keys) {
        const c = byKey.get(k);
        if (c) { out.push(c); byKey.delete(k); }
    }
    for (const c of byKey.values()) out.push(c);
    return out;
}

/** Fold: the rows to render and how many sit behind "+N more". */
export function foldCalls<T>(ordered: readonly T[], expanded: boolean, limit: number): { shown: T[]; hidden: number } {
    if (expanded || ordered.length <= limit) return { shown: [...ordered], hidden: 0 };
    return { shown: ordered.slice(0, limit), hidden: ordered.length - limit };
}

/** Whether the fold toggle exists at all (also drives "Show less"). */
export function needsFold(total: number, limit: number): boolean {
    return total > limit;
}

/** Participant ids for the avatar stack: friends first, then everyone else,
 *  each group in roster order, capped at `max`. */
export function stackParticipants(participantIds: readonly string[], friendIds: ReadonlySet<string>, max = 3): string[] {
    const friends: string[] = [];
    const others: string[] = [];
    for (const uid of participantIds) (friendIds.has(uid) ? friends : others).push(uid);
    return [...friends, ...others].slice(0, max);
}

/** Avatar geometry of a multi-call row's stack (must match home-deck.css
 *  `.hd-call-stack > *`: 20px discs overlapping by 6px). */
export const CALL_ROW_AVATAR_PX = 20;
export const CALL_ROW_AVATAR_OVERLAP_PX = 6;

/** Rendered width (px) of an overlapping avatar stack of `count` discs. */
export function stackWidth(count: number, size = CALL_ROW_AVATAR_PX, overlap = CALL_ROW_AVATAR_OVERLAP_PX): number {
    if (count <= 0) return 0;
    return size + (count - 1) * (size - overlap);
}

/**
 * Avatar-slot width (px) for a multi-call list: the widest stack actually
 * SHOWN, so names line up down the list without reserving room for three
 * avatars that no row has. A row with a smaller stack pads on the right (its
 * avatars stay flush-left); when every row's stack is the same size there is
 * no pad at all. The single-call layout never sets a slot width.
 */
export function stackSlotWidth(stackCounts: readonly number[]): number {
    let max = 0;
    for (const n of stackCounts) if (n > max) max = n;
    return stackWidth(max);
}

/** Max discs (avatars + the "+N" chip) in the single-call layout's stack. */
export const SOLO_STACK_MAX_DISCS = 4;

/**
 * The single-call layout's larger stack: every participant when they fit in
 * `maxDiscs`, otherwise `maxDiscs - 1` avatars (friends first) and a "+N"
 * chip for the rest — so the stack is never wider than `maxDiscs` discs.
 */
export function soloStack(
    participantIds: readonly string[],
    friendIds: ReadonlySet<string>,
    maxDiscs = SOLO_STACK_MAX_DISCS,
): { ids: string[]; extra: number } {
    const n = participantIds.length;
    if (n <= maxDiscs) return { ids: stackParticipants(participantIds, friendIds, n), extra: 0 };
    const shown = Math.max(1, maxDiscs - 1);
    return { ids: stackParticipants(participantIds, friendIds, shown), extra: n - shown };
}

// ── Session-only "expanded" memory ────────────────────────────────────────────
// Remembered for the life of this renderer (survives leaving and coming back
// to Home), never persisted: it is a view preference, not something worth a
// key in the encrypted store or a backup-registry entry.
let sessionExpanded = false;
export function getHomeCallsExpanded(): boolean { return sessionExpanded; }
export function setHomeCallsExpanded(v: boolean): void { sessionExpanded = v; }
/** Test hook. */
export function resetHomeCallsExpandedForTests(): void { sessionExpanded = false; }
