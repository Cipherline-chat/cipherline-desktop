/**
 * The Friends page's activity panel: the pure half.
 *
 * Everything here is built ONLY from what this device already receives for
 * its accepted friends — the presence stream (useUserStatus), the
 * listening/watching store (utils/integrations/listening.ts), and a few WS
 * pushes (avatar / username updates, high fives, a request accepted). There
 * is deliberately no server-side activity log or feed endpoint: a server that
 * kept "who did what, when" would be holding exactly the metadata this app
 * promises not to keep. The "Recent" timeline is therefore observed on THIS
 * device while the app is running, held in memory only (never written to
 * disk, so it needs no backup classification and leaves nothing at rest), and
 * bounded: at most FEED_MAX entries, none older than FEED_TTL_MS, and at most
 * one entry per friend per kind (a newer one replaces the older).
 *
 * Privacy rules, applied in `selectFeed` at read time AND by the recorder:
 *   - only people who are accepted friends right now appear; an unfriended or
 *     blocked person disappears from the feed (and is purged from memory);
 *   - nothing is ever derived for someone whose resolved presence is offline:
 *     "appear offline" looks exactly like offline from here, so an invisible
 *     friend can never produce "came online" / "started playing";
 *   - a game, a custom status or a track is only seen when the server already
 *     sent it to us (their own sharing switches decide that), so the panel
 *     never shows more than the rest of the app does;
 *   - there is no "went offline" entry at all.
 */

export type FriendActivityKind =
    | 'online'
    | 'playing'
    | 'listening'
    | 'watching'
    | 'status'
    | 'avatar'
    | 'renamed'
    | 'high_five'
    | 'new_friend';

export interface FriendActivityEntry {
    /** Stable per (user, kind): a newer entry of the same kind replaces it. */
    id: string;
    userId: string;
    kind: FriendActivityKind;
    /** Epoch ms, local clock. */
    at: number;
    /** Game / track / video title / status text / new name. */
    title?: string | null;
    /** Artist, channel, … */
    detail?: string | null;
    /** Custom status emoji (unicode or `cl:` reference). */
    emoji?: string | null;
    /** High fives: how many in a row (merged). */
    count?: number;
}

export const FEED_MAX = 50;
export const FEED_TTL_MS = 24 * 60 * 60 * 1000;
/** After a (re)connect the presence/listening seeds land in a burst: they are
 *  a baseline, not news. Transitions inside this window only update it. */
export const SETTLE_MS = 8000;

export const entryId = (userId: string, kind: FriendActivityKind): string => `${userId}:${kind}`;

/**
 * Add one entry: replaces any older entry for the same friend and kind, drops
 * anything past the TTL, keeps the newest FEED_MAX, newest first. An entry
 * OLDER than the one it would replace is ignored (out-of-order delivery). A
 * high five within the TTL of the previous one adds to its count.
 */
export function addEntry(
    entries: readonly FriendActivityEntry[],
    entry: Omit<FriendActivityEntry, 'id'>,
    now: number,
    max = FEED_MAX,
    ttlMs = FEED_TTL_MS,
): FriendActivityEntry[] {
    const id = entryId(entry.userId, entry.kind);
    const prev = entries.find(e => e.id === id);
    if (prev && prev.at > entry.at) return pruneEntries(entries, now, ttlMs, max);
    const merged: FriendActivityEntry = { ...entry, id };
    if (entry.kind === 'high_five' && prev && now - prev.at < ttlMs) {
        merged.count = (prev.count ?? 1) + (entry.count ?? 1);
    }
    const rest = entries.filter(e => e.id !== id);
    return pruneEntries([merged, ...rest], now, ttlMs, max);
}

/** TTL + cap, newest first. Returns a new array. */
export function pruneEntries(
    entries: readonly FriendActivityEntry[],
    now: number,
    ttlMs = FEED_TTL_MS,
    max = FEED_MAX,
): FriendActivityEntry[] {
    return entries
        .filter(e => now - e.at < ttlMs && e.at <= now + 60_000)
        .sort((a, b) => b.at - a.at)
        .slice(0, max);
}

export interface FeedFilter {
    /** Accepted friends right now. */
    friendIds: ReadonlySet<string>;
    /** Anyone on the block list (belt and braces: a blocked person is never a friend). */
    blockedIds: ReadonlySet<string>;
    now: number;
    ttlMs?: number;
}

/** What the panel may show: current friends only, never blocked, within the TTL, newest first. */
export function selectFeed(entries: readonly FriendActivityEntry[], f: FeedFilter): FriendActivityEntry[] {
    return pruneEntries(
        entries.filter(e => f.friendIds.has(e.userId) && !f.blockedIds.has(e.userId)),
        f.now,
        f.ttlMs ?? FEED_TTL_MS,
    );
}

// ── Observing presence ──────────────────────────────────────────────────────

/** What we can see of one friend at one moment. */
export interface PresenceObservation {
    present: boolean;
    /** Only while present (the server already empties it otherwise). */
    game: string | null;
    customText: string | null;
    customEmoji: string | null;
}

export type PresenceSnapshot = Record<string, PresenceObservation>;

const norm = (s: string | null | undefined): string | null => {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    return t ? t : null;
};

/** Build one observation; an offline friend carries nothing at all. */
export function observation(
    present: boolean,
    game: string | null | undefined,
    customText: string | null | undefined,
    customEmoji: string | null | undefined,
): PresenceObservation {
    if (!present) return { present: false, game: null, customText: null, customEmoji: null };
    return { present: true, game: norm(game), customText: norm(customText), customEmoji: norm(customEmoji) };
}

/**
 * The news between two snapshots. Only friends seen in BOTH produce anything
 * (a first sighting is a baseline), and only while present in `next`:
 *   offline -> present           "came online"
 *   game changes to a new game    "started playing X"
 *   custom status set / changed   "set a status"
 * Clearing things (game stopped, status cleared, went offline) is not news.
 */
export function diffPresence(prev: PresenceSnapshot, next: PresenceSnapshot, now: number): Omit<FriendActivityEntry, 'id'>[] {
    const out: Omit<FriendActivityEntry, 'id'>[] = [];
    for (const [userId, n] of Object.entries(next)) {
        const p = prev[userId];
        if (!p || !n.present) continue;
        if (!p.present) out.push({ userId, kind: 'online', at: now });
        if (n.game && n.game !== p.game) out.push({ userId, kind: 'playing', at: now, title: n.game });
        const statusChanged = (n.customText !== p.customText || n.customEmoji !== p.customEmoji);
        // Coming back online re-reveals an unchanged status: that is not a new one.
        if (p.present && statusChanged && (n.customText || n.customEmoji)) {
            out.push({ userId, kind: 'status', at: now, title: n.customText, emoji: n.customEmoji });
        }
    }
    return out;
}

// ── Observing listening / watching ──────────────────────────────────────────

export interface ListeningObservation {
    kind: 'listening' | 'watching';
    track: string;
    artist: string;
}

export const listeningKey = (l: ListeningObservation): string => `${l.kind}\u0000${l.track}\u0000${l.artist}`;

/**
 * A new track / video for a friend (any user in `next` whose record differs
 * from `prev`). Stopping is not news. The caller passes friends only, and only
 * present ones.
 */
export function diffListening(
    prev: ReadonlyMap<string, ListeningObservation>,
    next: ReadonlyMap<string, ListeningObservation>,
    now: number,
): Omit<FriendActivityEntry, 'id'>[] {
    const out: Omit<FriendActivityEntry, 'id'>[] = [];
    for (const [userId, n] of next) {
        const p = prev.get(userId);
        if (p && listeningKey(p) === listeningKey(n)) continue;
        out.push({ userId, kind: n.kind, at: now, title: n.track, detail: n.artist });
    }
    return out;
}

// ── Presentation helpers ────────────────────────────────────────────────────

/** "now", "4m", "2h" — the feed never holds anything older than a day. */
export function shortAgo(at: number, now: number): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return 'now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

/** The accessible "4 minutes ago" for the same instant. */
export function longAgo(at: number, now: number): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(m / 60);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
}

/** The verb phrase after the name: "started playing", "came online", … (new_friend reads "You and <name> …"). */
export function entryVerb(e: FriendActivityEntry): string {
    switch (e.kind) {
        case 'online': return 'came online';
        case 'playing': return 'started playing';
        case 'listening': return 'started listening to';
        case 'watching': return 'started watching';
        case 'status': return 'set a status';
        case 'avatar': return 'got a new profile picture';
        case 'renamed': return 'changed their username';
        case 'high_five': return (e.count ?? 1) > 1 ? `high-fived you ×${e.count}` : 'high-fived you';
        case 'new_friend': return 'and you are now friends';
    }
}

// ── "Active now": what friends are doing this moment ────────────────────────

/** One call a friend is in, from the same VIEW_CHANNEL-filtered state the
 *  server list and Home deck draw (voiceParticipants / huddleCalls). */
export interface FriendCall {
    kind: 'voice' | 'huddle';
    /** Voice: the channel id. Huddle: the CALL id. */
    id: string;
    channelId: string;
    channelName: string;
    serverId: string;
    serverName: string;
    participantIds: readonly string[];
    /** This client is already connected to it. */
    mine: boolean;
}

interface ChannelLike { channel_id: string; server_id: string; name: string }
interface ServerLike { server_id: string; name: string }
interface HuddleLike { call_id: string; name?: string | null; participants: readonly string[] }

/**
 * user id -> the call they are in, for FRIENDS only. Calls in a channel or
 * server this client does not know (the server never sent it: not visible to
 * us) are skipped, exactly like the Home deck's "Happening now".
 */
export function deriveFriendCalls(
    friendIds: ReadonlySet<string>,
    voiceParticipants: Record<string, readonly string[]>,
    huddleCalls: Record<string, readonly HuddleLike[]>,
    channels: readonly ChannelLike[],
    servers: readonly ServerLike[],
    session: { voiceChannelId: string | null; huddleCallId: string | null } | null,
): Map<string, FriendCall> {
    const byChannel = new Map(channels.map(c => [c.channel_id, c]));
    const byServer = new Map(servers.map(s => [s.server_id, s]));
    const out = new Map<string, FriendCall>();
    const place = (call: FriendCall) => {
        for (const uid of call.participantIds) if (friendIds.has(uid) && !out.has(uid)) out.set(uid, call);
    };
    for (const [channelId, ids] of Object.entries(voiceParticipants)) {
        if (!ids || ids.length === 0) continue;
        const ch = byChannel.get(channelId);
        const srv = ch ? byServer.get(ch.server_id) : undefined;
        if (!ch || !srv) continue;
        place({
            kind: 'voice', id: channelId, channelId, channelName: ch.name, serverId: srv.server_id, serverName: srv.name,
            participantIds: ids, mine: !!session?.voiceChannelId && session.voiceChannelId === channelId,
        });
    }
    for (const [huddleId, calls] of Object.entries(huddleCalls)) {
        const ch = byChannel.get(huddleId);
        const srv = ch ? byServer.get(ch.server_id) : undefined;
        if (!ch || !srv) continue;
        for (const c of calls) {
            if (c.participants.length === 0) continue;
            place({
                kind: 'huddle', id: c.call_id, channelId: huddleId, channelName: c.name || ch.name, serverId: srv.server_id, serverName: srv.name,
                participantIds: c.participants, mine: !!session?.huddleCallId && session.huddleCallId === c.call_id,
            });
        }
    }
    return out;
}

export interface ActiveNowMedia {
    kind: 'listening' | 'watching';
    track: string;
    artist: string;
    source: string;
    artRef?: string | null;
    startedAt: number;
    durationMs: number | null;
}

export interface ActiveNowCard {
    userId: string;
    call: FriendCall | null;
    game: string | null;
    media: ActiveNowMedia | null;
}

/**
 * Friends doing something right now: in a call you can see, playing, or
 * listening / watching. Present friends only — someone offline (or appearing
 * offline) never gets a card even if a stale record is still around. Order:
 * calls first (the most joinable), then games, then music / video, then name.
 */
export function selectActiveNow<F extends { user_id: string; username?: string }>(
    friends: readonly F[],
    opts: {
        isPresent: (userId: string) => boolean;
        gameOf: (userId: string) => string | null;
        mediaOf: (userId: string) => ActiveNowMedia | null;
        calls: ReadonlyMap<string, FriendCall>;
        blockedIds: ReadonlySet<string>;
    },
): ActiveNowCard[] {
    const cards: (ActiveNowCard & { name: string })[] = [];
    for (const f of friends) {
        if (opts.blockedIds.has(f.user_id) || !opts.isPresent(f.user_id)) continue;
        const call = opts.calls.get(f.user_id) ?? null;
        const game = norm(opts.gameOf(f.user_id));
        const media = opts.mediaOf(f.user_id);
        if (!call && !game && !media) continue;
        cards.push({ userId: f.user_id, call, game, media, name: (f.username ?? '').toLowerCase() });
    }
    const rank = (c: ActiveNowCard) => (c.call ? 0 : c.game ? 1 : 2);
    cards.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return cards.map(c => ({ userId: c.userId, call: c.call, game: c.game, media: c.media }));
}

export interface ActiveNowGroups {
    /** One entry per call, with the friends in it (in card order). */
    calls: { call: FriendCall; userIds: string[] }[];
    /** Friends not in a call: playing / listening / watching. */
    solo: ActiveNowCard[];
}

/** Friends in the same call share one card; everyone else gets their own. */
export function groupActiveNow(cards: readonly ActiveNowCard[]): ActiveNowGroups {
    const calls: ActiveNowGroups['calls'] = [];
    const byCall = new Map<string, ActiveNowGroups['calls'][number]>();
    const solo: ActiveNowCard[] = [];
    for (const c of cards) {
        if (!c.call) { solo.push(c); continue; }
        const key = `${c.call.kind}:${c.call.id}`;
        let g = byCall.get(key);
        if (!g) { g = { call: c.call, userIds: [] }; byCall.set(key, g); calls.push(g); }
        g.userIds.push(c.userId);
    }
    return { calls, solo };
}

/** Friends whose friendship anniversary is today (local), for the "Today" row. */
export function todaysAnniversaries<F extends { user_id: string; friends_since?: string | null }>(
    friends: readonly F[],
    blockedIds: ReadonlySet<string>,
    years: (since: string | null | undefined) => number,
): { userId: string; years: number }[] {
    const out: { userId: string; years: number }[] = [];
    for (const f of friends) {
        if (blockedIds.has(f.user_id)) continue;
        const y = years(f.friends_since);
        if (y > 0) out.push({ userId: f.user_id, years: y });
    }
    return out;
}
