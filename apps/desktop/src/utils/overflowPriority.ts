/**
 * overflowPriority — who gets the visible slots when a call surface cannot
 * show everyone.
 *
 * ONE implementation shared by the call sidebar (video tiles + participant
 * rows) and the fullscreen/focused participant strip, so the two cannot drift.
 * Pure data in, pure data out; the React glue is hooks/useSpeakerPromotion.ts.
 *
 * ── The rules
 *  1. Nothing is reordered while everything fits ("when everything fits,
 *     preserve join order so nobody jumps around").
 *  2. Active speakers are PROMOTED: speak ≥ PROMOTE_AFTER_TICKS consecutive
 *     1 s ticks → move to the front, most recently promoted first. They are
 *     demoted DEMOTE_AFTER_MS after they stop. That delay + threshold is the
 *     anti-jitter: the order changes at most once per speaking burst, never on
 *     a blip or a short pause.
 *  3. In strip mode (`prioritizeForOverflow`) the tiers are
 *        0  screen shares and cameras that are on (they show something)
 *        1  click-to-watch gates (a share the viewer has not opted into)
 *        2  recent/active speakers with nothing to show
 *        3  everyone else
 *     and inside every tier promoted speakers go first, then original order.
 */

export const PROMOTE_AFTER_TICKS = 2;
export const DEMOTE_AFTER_MS = 5000;

/**
 * Promoted ids first (most-recently-promoted first), everyone else in their
 * original relative order. The sidebar's `applyPromotion`, lifted out.
 */
export function applyPromotion<T extends { identity: string }>(
    list: readonly T[],
    promotedIds: readonly string[],
): T[] {
    const promotedSet = new Set(promotedIds);
    const front = promotedIds
        .map(id => list.find(p => p.identity === id))
        .filter((p): p is T => p != null);
    const rest = list.filter(p => !promotedSet.has(p.identity));
    return [...front, ...rest];
}

/** Display priority of a strip entry; lower shows first. */
export type StripTier = 0 | 1 | 2 | 3;

export interface TierInput {
    identity: string;
    /** A live screen share or camera picture. */
    hasVideo: boolean;
    /** A published share the viewer has not subscribed to (click to watch). */
    gated?: boolean;
}

export function stripTier(item: TierInput, promotedIds: ReadonlySet<string>): StripTier {
    if (item.gated) return 1;
    if (item.hasVideo) return 0;
    return promotedIds.has(item.identity) ? 2 : 3;
}

/**
 * Order `items` for a surface that may not fit them all.
 *
 * `overflowing` false -> returned untouched (rule 1). Stable: items of equal
 * tier and equal promotion status keep their input order.
 */
export function prioritizeForOverflow<T>(
    items: readonly T[],
    opts: {
        overflowing: boolean;
        promotedIds: readonly string[];
        describe: (item: T) => TierInput;
    },
): T[] {
    if (!opts.overflowing) return [...items];
    const promoted = new Map<string, number>();
    opts.promotedIds.forEach((id, i) => promoted.set(id, i));
    const promotedSet = new Set(opts.promotedIds);
    const keyed = items.map((item, index) => {
        const d = opts.describe(item);
        return {
            item,
            index,
            tier: stripTier(d, promotedSet),
            // Promoted first (by recency), then the rest: Infinity sorts last.
            rank: promoted.get(d.identity) ?? Infinity,
        };
    });
    keyed.sort((a, b) =>
        a.tier - b.tier
        || (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1)
        || a.index - b.index);
    return keyed.map(k => k.item);
}

// ── Speaker-tick hysteresis (the pure half of the 1 s interval) ──────────────

export interface SpeakerSample { identity: string; isSpeaking: boolean }

export interface SpeakerTickResult {
    /** Crossed the active threshold this tick: promote to the front. */
    promote: string[];
    /** Fell below the threshold this tick: schedule a demotion. */
    demote: string[];
}

/**
 * Advance the per-participant speaking counters by one 1 s tick. MUTATES
 * `ticks` (a long-lived ref-held record) and reports the edges only, so a
 * caller reacts to threshold crossings, not to every tick.
 */
export function advanceSpeakerTicks(
    ticks: Record<string, number>,
    samples: readonly SpeakerSample[],
): SpeakerTickResult {
    const promote: string[] = [];
    const demote: string[] = [];
    for (const { identity: id, isSpeaking } of samples) {
        const old = ticks[id] || 0;
        if (isSpeaking) {
            ticks[id] = old + 1;
            if (old < PROMOTE_AFTER_TICKS && ticks[id] >= PROMOTE_AFTER_TICKS) promote.push(id);
        } else if (old > 0) {
            ticks[id] = Math.max(0, old - 1);
            if (old >= PROMOTE_AFTER_TICKS && ticks[id] < PROMOTE_AFTER_TICKS) demote.push(id);
        }
    }
    return { promote, demote };
}
