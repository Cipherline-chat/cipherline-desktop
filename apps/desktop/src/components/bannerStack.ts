/**
 * Banner stacking policy: pure, so it is testable without a DOM.
 *
 * Several banners can be live at once (an admin announcement, a failing card,
 * a ghost-device alarm, ...). Unbounded chrome at the top of the app is
 * unwelcome, so the stack shows the top MAX_VISIBLE_BANNERS by priority and
 * folds the rest behind a "+N more" toggle. Ties keep registration order, so
 * the order is stable from one render to the next.
 */

export type ClBannerTone = 'info' | 'warning' | 'danger' | 'success' | 'neutral';

/** At most this many banners are shown before the rest collapse to "+N more". */
export const MAX_VISIBLE_BANNERS = 2;

/** Default priority per tone when a banner does not set its own. */
export const TONE_PRIORITY: Record<ClBannerTone, number> = {
    danger: 80,
    warning: 60,
    info: 40,
    success: 30,
    neutral: 20,
};

export interface BannerEntry {
    id: string;
    priority: number;
    /** Registration order; the tie-break among equal priorities. */
    seq: number;
}

/** Highest priority first; equal priorities keep the order they appeared in. */
export function rankBanners(entries: readonly BannerEntry[]): BannerEntry[] {
    return [...entries].sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
}

export interface BannerSplit {
    /** Entry ids in display order. */
    order: string[];
    /** How many are shown (the rest are folded away unless expanded). */
    visibleCount: number;
    /** How many are folded behind the "+N more" toggle. */
    hiddenCount: number;
}

export function splitBanners(
    entries: readonly BannerEntry[],
    expanded: boolean,
    max: number = MAX_VISIBLE_BANNERS,
): BannerSplit {
    const order = rankBanners(entries).map(e => e.id);
    const cap = Math.max(0, Math.floor(max));
    const visibleCount = expanded ? order.length : Math.min(order.length, cap);
    return { order, visibleCount, hiddenCount: order.length - Math.min(order.length, cap) };
}

/** aria-live per tone: assertive only for danger; every other tone is polite. */
export function liveRegionFor(tone: ClBannerTone): 'polite' | 'assertive' {
    return tone === 'danger' ? 'assertive' : 'polite';
}
