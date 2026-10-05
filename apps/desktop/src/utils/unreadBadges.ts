/**
 * Shared unread-count math for every badge surface: the OS tray/dock badge,
 * the DM rail tile, the Group rail tile, and each per-server rail tile.
 *
 * Extracted so the tray badge and the in-app badges can never diverge again.
 * That divergence WAS the bug: the tray badge summed unreadCounts/
 * mentionCounts directly and was always correct, while every in-app rail
 * badge derived its count by filtering a LIST (conversations, or
 * serverChannels[serverId]) and looking counts up by id — so a real, correct
 * count sat in state with no surface willing to render it whenever that list
 * was empty or hadn't loaded yet (cold start, a brand-new conversation, an
 * unvisited server). The user heard a notification sound and saw nothing.
 *
 * Pure functions over plain data — no DOM, no React — so they're testable
 * under vitest's node environment (see unreadBadges.test.ts), the same
 * approach already used for utils/inviteLimits.ts.
 */

export type CountMap = Record<string, number>;

/** Sum every value in a count map. This is the ONE totalling function every
 * badge surface must use — the tray badge and every rail badge call this
 * (directly or via splitCountsByOwner below) rather than each keeping its own
 * copy that can quietly drift out of sync with the others. */
export function sumCounts(map: CountMap): number {
    let total = 0;
    for (const v of Object.values(map)) total += v || 0;
    return total;
}

export interface OwnerSplit<TOwner extends string> {
    /** Sum per owner, for every id the classifier could resolve. */
    byOwner: Record<TOwner, number>;
    /**
     * Sum of ids the classifier could NOT resolve to any owner. This is not
     * "no unread" — it means the count arrived before the list that would
     * classify it (e.g. a message for a conversation not yet in
     * `conversations`, a moment before its GET /conversations round trip
     * lands). Never drop it silently: a caller either folds it into a
     * best-effort bucket (see dmGroupRailBadges below) or uses a nonzero
     * orphan total as a signal that something needs a refetch.
     */
    orphan: number;
}

/** Split a count map by owner using a classifier that may not (yet) know
 * every id. See OwnerSplit for why orphaned ids are kept, not dropped. */
export function splitCountsByOwner<TOwner extends string>(
    counts: CountMap,
    ownerOf: (id: string) => TOwner | undefined,
): OwnerSplit<TOwner> {
    const byOwner = {} as Record<TOwner, number>;
    let orphan = 0;
    for (const [id, n] of Object.entries(counts)) {
        if (!n) continue;
        const owner = ownerOf(id);
        if (owner === undefined) { orphan += n; continue; }
        byOwner[owner] = (byOwner[owner] ?? 0) + n;
    }
    return { byOwner, orphan };
}

export type NotifMode = 'all' | 'mentions' | 'none';

/** What a badge surface should draw: how many, and how loudly. `null` = draw
 *  nothing at all. */
export interface BadgeState {
    count: number;
    /** 'alert' is the red pill this app has always drawn. 'quiet' is the grey
     *  one, for a conversation the user has turned pings off on. */
    tone: 'alert' | 'quiet';
}

/**
 * The ONE rule every badge surface resolves through. Three things live here,
 * and each was a separate bug before it did.
 *
 * 1. MENTIONS ARE NOT ADDED TO UNREAD. An @mention sets both counters —
 *    correctly: they answer different questions — and every rail surface then
 *    rendered `unread + mentions`, so one @mention drew a badge reading **2**.
 *    Outside a mute the mention counter is a SUBSET of the unread counter, not
 *    a disjoint set, so summing them was never right. A mention badge shows
 *    the mention count and stands in for the unread badge, exactly as the
 *    channel list has always done it.
 * 2. A mention always shows, even muted. That is the entire difference
 *    between "Muted" and "off".
 * 3. Muted suppresses the plain-unread badge; @mentions-only makes it QUIET
 *    rather than absent. See notificationDecision's countsUnread.
 */
export function resolveBadge(
    unread: number,
    mentions: number,
    mode: NotifMode = 'all',
): BadgeState | null {
    if (mentions > 0) return { count: mentions, tone: 'alert' };
    if (mode === 'none') return null;
    if (unread > 0) return { count: unread, tone: mode === 'mentions' ? 'quiet' : 'alert' };
    return null;
}

/** A channel's effective notification mode: its own override, else its
 *  server's, else that server's default, else 'all'. The same precedence the
 *  live notification path resolves (Dashboard's channel:message handler). */
export function effectiveChannelMode(
    channelId: string,
    channelPrefs: Record<string, NotifMode>,
    serverOf: (channelId: string) => string | undefined,
    serverMode: (serverId: string) => NotifMode | undefined,
): NotifMode {
    const own = channelPrefs[channelId];
    if (own) return own;
    const serverId = serverOf(channelId);
    return (serverId && serverMode(serverId)) || 'all';
}

export interface TrayBadgeInput {
    unreadCounts: CountMap;
    mentionCounts: CountMap;
    channelUnreadCounts: CountMap;
    channelMentionCounts: CountMap;
    conversationMode: (conversationId: string) => NotifMode;
    channelMode: (channelId: string) => NotifMode;
    showBadgeCount: boolean;
    onlyMentions: boolean;
    includesMuted: boolean;
}

/**
 * The OS badge (taskbar overlay / dock / tray tooltip) total.
 *
 * Only what is allowed to PING counts. An @mentions-only conversation or
 * channel draws a quiet grey dot in the app, which means "there's something
 * here, but you asked not to be pinged for it". Putting its plain unread
 * into the taskbar count would ping from outside the app instead, so it
 * contributes only its mentions. A muted one ('none') contributes its
 * mentions only when the user has opted in to "include muted".
 *
 * Mentions are never ADDED to unread for a loud ('all') source. The mention
 * counter is a subset of the unread counter there (see resolveBadge), so
 * adding would double-count.
 */
export function trayBadgeCount(o: TrayBadgeInput): number {
    if (!o.showBadgeCount) return 0;
    if (o.onlyMentions) return sumCounts(o.mentionCounts) + sumCounts(o.channelMentionCounts);
    const total = (unread: CountMap, mentions: CountMap, modeOf: (id: string) => NotifMode): number => {
        let n = 0;
        for (const id of new Set([...Object.keys(unread), ...Object.keys(mentions)])) {
            const mode = modeOf(id);
            if (mode === 'all') n += unread[id] || 0;
            else if (mode === 'mentions' || o.includesMuted) n += mentions[id] || 0;
        }
        return n;
    };
    return total(o.unreadCounts, o.mentionCounts, o.conversationMode)
        + total(o.channelUnreadCounts, o.channelMentionCounts, o.channelMode);
}

/**
 * DM + Group rail badges, count-driven rather than list-driven.
 *
 * `classify` maps a conversation_id to 'dm' | 'group' — normally built from
 * the loaded `conversations` list. Ids it can't classify yet (orphans from
 * both maps) are folded into the DM bucket: a first-ever DM from a brand-new
 * friend is by far the common "conversation the client doesn't know about
 * yet" case (a brand-new group is created by explicit user action the client
 * already knows about), and Dashboard.tsx's pullMessages already triggers a
 * conversations refetch the moment it sees an unknown id — so this is a
 * best-effort placement for one render, not a permanent misclassification.
 */
export function dmGroupRailBadges(
    unreadCounts: CountMap,
    mentionCounts: CountMap,
    classify: (conversationId: string) => 'dm' | 'group' | undefined,
    modeOf: (conversationId: string) => NotifMode = () => 'all',
): { dm: BadgeState | null; group: BadgeState | null } {
    const mentions = splitCountsByOwner(mentionCounts, classify);
    // Unread is split a second way as well: a conversation the user has set to
    // @mentions-only contributes to the count but must not make the pill red
    // on its own. An orphan (a count that arrived before the conversation did)
    // has no mode to read, so it is treated as 'all' — the loud, visible
    // default. Under-reporting a brand-new DM is the worse failure.
    const loud: Record<string, number> = { dm: 0, group: 0 };
    const quiet: Record<string, number> = { dm: 0, group: 0 };
    for (const [id, n] of Object.entries(unreadCounts)) {
        if (!n) continue;
        const mode = modeOf(id);
        // Muted contributes nothing, the same as resolveBadge. A count can
        // outlive the mute that should hide it (it was accrued before, and
        // these maps persist), so this is checked here rather than assumed
        // from notificationDecision having stopped incrementing.
        if (mode === 'none') continue;
        const owner = classify(id) ?? 'dm';
        (mode === 'mentions' ? quiet : loud)[owner] += n;
    }

    const bucket = (owner: 'dm' | 'group'): BadgeState | null => {
        const m = (mentions.byOwner[owner] ?? 0) + (owner === 'dm' ? mentions.orphan : 0);
        if (m > 0) return { count: m, tone: 'alert' };
        const total = loud[owner] + quiet[owner];
        if (total <= 0) return null;
        // Red as soon as ANY of it came from a conversation still set to ping.
        return { count: total, tone: loud[owner] > 0 ? 'alert' : 'quiet' };
    };
    return { dm: bucket('dm'), group: bucket('group') };
}

/**
 * Per-server rail badge totals, count-driven rather than list-driven.
 *
 * `classify` maps a channel_id to its owning server_id — normally built from
 * the loaded `serverChannels` map. Unlike the DM/group split, orphaned ids
 * are NOT folded into any one server's badge (there's no reasonable default
 * server to blame them on) — they're returned separately so the caller can
 * decide whether to react (Dashboard.tsx eagerly loads every joined server's
 * channel list on boot, and refreshes on `server:channels_changed`, so a
 * nonzero orphan total here should be rare/transient rather than routine).
 */
export function serverChannelBadges(
    channelUnreadCounts: CountMap,
    channelMentionCounts: CountMap,
    classify: (channelId: string) => string | undefined,
): { byServer: Record<string, { unread: number; mentions: number }>; orphan: number } {
    const unread = splitCountsByOwner(channelUnreadCounts, classify);
    const mentions = splitCountsByOwner(channelMentionCounts, classify);
    const byServer: Record<string, { unread: number; mentions: number }> = {};
    for (const serverId of new Set([...Object.keys(unread.byOwner), ...Object.keys(mentions.byOwner)])) {
        byServer[serverId] = { unread: unread.byOwner[serverId] ?? 0, mentions: mentions.byOwner[serverId] ?? 0 };
    }
    return { byServer, orphan: unread.orphan + mentions.orphan };
}

/**
 * Clear every count belonging to a set of ids — the "Mark as Read" half of
 * the badge math, kept here next to the counting half so the two can't
 * disagree about what a server's badge is made of.
 *
 * Deletes rather than writing 0: these maps are persisted verbatim (see
 * Dashboard.tsx's write-through effects), and a zero entry per channel would
 * grow the stored blob forever without ever changing a total. Returns the
 * ORIGINAL map object when nothing matched, so a caller passing this to a
 * React setter gets a bail-out re-render instead of a fresh object every
 * time.
 */
export function clearCountsForIds(counts: CountMap, ids: readonly string[]): CountMap {
    let changed = false;
    const next = { ...counts };
    for (const id of ids) {
        if (next[id] !== undefined) { delete next[id]; changed = true; }
    }
    return changed ? next : counts;
}

/**
 * Formats a badge count for display, exactly as the DM/Group rail pill
 * always has: nothing below 1, the raw number up to 99, '99+' beyond it.
 *
 * Pulled out so `components/RailBadge.tsx` — the single presentation every
 * rail tile (DM, Group, and now server) renders through — and any future
 * badge surface share one place that decides the cap, rather than each
 * copying the `> 99 ? '99+' : n` ternary and risking the two badge families
 * drifting apart again (see this file's header for why that already
 * happened once with the totals themselves).
 */
export function formatRailBadgeCount(count: number): string | null {
    if (!count || count <= 0) return null;
    return count > 99 ? '99+' : String(count);
}
