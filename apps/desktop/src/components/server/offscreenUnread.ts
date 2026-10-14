/**
 * Off-screen unread logic for the server channel list. Pure — no DOM, no React
 * — so the rules are testable without a layout engine.
 *
 * The question this answers: "which channels with something new are scrolled
 * out of view above / below the list's visible area, and where does a click on
 * the edge pill take me?"
 *
 * Three pieces:
 *
 *   1. `channelBadgeKind` — THE definition of what unread state a channel row
 *      shows. `ServerChannelList.renderChannelRow` draws its badge from this
 *      same function, so the pill can never disagree with the badges (muted
 *      channels, "@mentions only" grey dots, the active channel).
 *   2. `buildUnreadModel` — turns the channel grouping + collapse state into a
 *      keyed list of things that can carry an unread. A channel inside a
 *      COLLAPSED category has no row on screen, so the category header stands
 *      in for it (see `ModelEntry.expandCategoryId`).
 *   3. `classifyAnchors` / `summarize` / `planJump` — geometry. The caller
 *      measures where each anchor sits (content-space centre); everything
 *      after that is arithmetic.
 */

export type NotifMode = 'all' | 'mentions' | 'none';

/** What a row shows. `mention` outranks `unread` outranks `quiet`. */
export type UnreadKind = 'mention' | 'unread' | 'quiet';

const RANK: Record<UnreadKind, number> = { quiet: 0, unread: 1, mention: 2 };

export function strongerKind(a: UnreadKind, b: UnreadKind): UnreadKind {
    return RANK[a] >= RANK[b] ? a : b;
}

// ── 1. The badge rule ────────────────────────────────────────────────────────

export interface BadgeInput {
    unread: number;
    mentions: number;
    /** Effective server-level notification mode. */
    serverNotifMode: NotifMode;
    /** This channel is individually muted. */
    channelMuted: boolean;
    /** The channel currently open. It never shows a badge. */
    active: boolean;
}

/**
 * The unread state a channel row draws, or null for none.
 *
 *   - the open channel shows nothing;
 *   - an @mention always shows (red), even in a muted channel or a muted
 *     server: being named is never silenced;
 *   - a plain unread is suppressed entirely when the channel is muted or the
 *     server is set to "none";
 *   - with the server on "@mentions only" a plain unread is still shown, but
 *     as a quiet grey dot instead of a counted lume badge.
 */
export function channelBadgeKind(i: BadgeInput): UnreadKind | null {
    if (i.active) return null;
    if (i.mentions > 0) return 'mention';
    const muted = i.serverNotifMode === 'none' || i.channelMuted;
    if (i.unread > 0 && !muted) return i.serverNotifMode === 'mentions' ? 'quiet' : 'unread';
    return null;
}

// ── 2. The model ─────────────────────────────────────────────────────────────

/** Something that can sit under the pill: a channel row, or a collapsed category's header. */
export interface ModelEntry {
    /** `ch:<channelId>` for a rendered row, `cat:<categoryId>` for a collapsed header. */
    key: string;
    kind: UnreadKind;
    /** Sum of @mention counts this entry stands for. */
    mentions: number;
    /** The channel a jump should end on (for a collapsed header: its first unread channel). */
    channelId: string;
    /** Set on a collapsed-category entry: jumping must expand this category first. */
    expandCategoryId?: string;
}

export interface ModelChannel { channel_id: string }
export interface ModelCategory { category_id: string; channels: ModelChannel[] }

export interface ModelInput {
    uncategorized: ModelChannel[];
    categories: ModelCategory[];
    collapsed: Record<string, boolean>;
    unreadCounts?: Record<string, number>;
    mentionCounts?: Record<string, number>;
    mutedChannelIds?: Set<string>;
    serverNotifMode: NotifMode;
    activeChannelId: string | null;
}

export const channelKey = (channelId: string) => `ch:${channelId}`;
export const categoryKey = (categoryId: string) => `cat:${categoryId}`;

/**
 * Collapsed categories: their channel rows are not rendered, so they have no
 * geometry to be "off-screen". The header IS rendered, so it carries the
 * rolled-up state of what it hides (strongest kind, summed mentions) and the
 * jump expands it. Ignoring them instead would leave a mention invisible to the
 * pill precisely because the user tidied the list — the opposite of the feature.
 * A header that is itself IN view produces no pill (nothing off-screen), exactly
 * like an in-view channel row.
 */
export function buildUnreadModel(i: ModelInput): Map<string, ModelEntry> {
    const out = new Map<string, ModelEntry>();
    const kindOf = (id: string): UnreadKind | null => channelBadgeKind({
        unread: i.unreadCounts?.[id] ?? 0,
        mentions: i.mentionCounts?.[id] ?? 0,
        serverNotifMode: i.serverNotifMode,
        channelMuted: i.mutedChannelIds?.has(id) ?? false,
        active: i.activeChannelId === id,
    });
    const mentionsOf = (id: string) => i.mentionCounts?.[id] ?? 0;

    for (const ch of i.uncategorized) {
        const kind = kindOf(ch.channel_id);
        if (kind) out.set(channelKey(ch.channel_id), {
            key: channelKey(ch.channel_id), kind, mentions: mentionsOf(ch.channel_id), channelId: ch.channel_id,
        });
    }
    for (const cat of i.categories) {
        if (!i.collapsed[cat.category_id]) {
            for (const ch of cat.channels) {
                const kind = kindOf(ch.channel_id);
                if (kind) out.set(channelKey(ch.channel_id), {
                    key: channelKey(ch.channel_id), kind, mentions: mentionsOf(ch.channel_id), channelId: ch.channel_id,
                });
            }
            continue;
        }
        let kind: UnreadKind | null = null;
        let mentions = 0;
        let first: string | null = null;
        for (const ch of cat.channels) {
            const k = kindOf(ch.channel_id);
            if (!k) continue;
            kind = kind ? strongerKind(kind, k) : k;
            mentions += mentionsOf(ch.channel_id);
            first ??= ch.channel_id;
        }
        if (kind && first) out.set(categoryKey(cat.category_id), {
            key: categoryKey(cat.category_id), kind, mentions, channelId: first, expandCategoryId: cat.category_id,
        });
    }
    return out;
}

// ── 3. Geometry ──────────────────────────────────────────────────────────────

/**
 * Height of the strip the edge pills cover (pill height + its inset from the
 * edge). A row inside that strip is physically hidden behind the pill, so it
 * counts as off-screen even though it is technically within the scrollport.
 */
export const PILL_ZONE = 40;

/** A model entry plus where it was measured: `center` is in scroll-content coordinates (px from the top of the scrollable content). */
export interface MeasuredAnchor extends ModelEntry { center: number }

export interface ScrollView { scrollTop: number; clientHeight: number; scrollHeight: number }

/**
 * Where "in view" starts and ends, in content coordinates.
 *
 * The zone shrinks to the distance still left to scroll in that direction
 * (`min(PILL_ZONE, scrollTop)` at the top; the room below at the bottom). Two
 * consequences, both wanted: at the very top / very bottom the zone is 0, so
 * the list's own first/last row is never "covered" by a pill that has nothing
 * to point at; and the boundary moves continuously with the scroll offset, so
 * a row never flips state because the scroll position changed by one pixel.
 */
export function visibleBand(v: ScrollView): { top: number; bottom: number } {
    const maxScroll = Math.max(0, v.scrollHeight - v.clientHeight);
    const scrollTop = Math.min(Math.max(0, v.scrollTop), maxScroll);
    const topZone = Math.min(PILL_ZONE, scrollTop);
    const bottomZone = Math.min(PILL_ZONE, maxScroll - scrollTop);
    return { top: scrollTop + topZone, bottom: scrollTop + v.clientHeight - bottomZone };
}

export interface Classified {
    /** Off-screen above, nearest to the viewport first. */
    above: MeasuredAnchor[];
    /** Off-screen below, nearest to the viewport first. */
    below: MeasuredAnchor[];
}

/** An anchor is in view when its centre is inside the band. */
export function classifyAnchors(anchors: MeasuredAnchor[], v: ScrollView): Classified {
    const band = visibleBand(v);
    const above = anchors.filter(a => a.center < band.top).sort((a, b) => b.center - a.center);
    const below = anchors.filter(a => a.center > band.bottom).sort((a, b) => a.center - b.center);
    return { above, below };
}

export interface PillSummary {
    kind: UnreadKind;
    /** Entries off-screen in this direction. */
    count: number;
    /** Sum of @mention counts across them (0 unless kind === 'mention'). */
    mentions: number;
}

/** The pill's content, or null when there is nothing off-screen that way. */
export function summarize(list: MeasuredAnchor[]): PillSummary | null {
    if (list.length === 0) return null;
    let kind: UnreadKind = 'quiet';
    let mentions = 0;
    for (const a of list) {
        kind = strongerKind(kind, a.kind);
        mentions += a.kind === 'mention' ? a.mentions : 0;
    }
    return { kind, count: list.length, mentions };
}

export function pillLabel(s: PillSummary): string {
    if (s.kind !== 'mention') return 'New unreads';
    const n = s.mentions > 99 ? '99+' : String(s.mentions);
    return `${n} ${s.mentions === 1 ? 'mention' : 'mentions'}`;
}

export function pillAriaLabel(direction: 'above' | 'below', s: PillSummary): string {
    const base = `Jump to next unread channel ${direction}`;
    return s.kind === 'mention' ? `${base}, ${pillLabel(s)}` : base;
}

export function summaryKey(s: PillSummary | null): string {
    return s ? `${s.kind}:${s.count}:${s.mentions}` : '-';
}

export interface JumpPlan {
    anchor: MeasuredAnchor;
    /** Target `scrollTop`, clamped to the scrollable range. */
    scrollTop: number;
    behavior: 'smooth' | 'instant';
}

/** Scroll offset that centres `center`, clamped to [0, maxScroll]. */
export function centeredScrollTop(center: number, v: ScrollView): number {
    const maxScroll = Math.max(0, v.scrollHeight - v.clientHeight);
    return Math.min(maxScroll, Math.max(0, Math.round(center - v.clientHeight / 2)));
}

/**
 * The jump for a click on the `direction` pill: the NEAREST off-screen anchor
 * in that direction — not the strongest. Repeated clicks therefore walk the
 * list in order, each landing the next one in view. Reduced motion swaps the
 * smooth scroll for an instant one.
 */
export function planJump(
    anchors: MeasuredAnchor[],
    v: ScrollView,
    direction: 'above' | 'below',
    reducedMotion: boolean,
): JumpPlan | null {
    const target = classifyAnchors(anchors, v)[direction][0];
    if (!target) return null;
    return {
        anchor: target,
        scrollTop: centeredScrollTop(target.center, v),
        behavior: reducedMotion ? 'instant' : 'smooth',
    };
}
