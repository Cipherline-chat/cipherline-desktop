/**
 * Which avatars are worth warming in the background, and how many.
 *
 * Pure selection — no I/O, no React. `useAvatarWarming` feeds it the same state
 * the Home deck ranks from and hands the result to the background preload lane.
 *
 * ── Why this is capped at all ────────────────────────────────────────────────
 * A cold avatar costs two REST calls on the API's `default` throttle bucket:
 * 300 requests / 60 s, per user, FIXED window, `blockDuration` = the same 60 s.
 * "Warm everything" is therefore not a slow-but-harmless choice — an account
 * with 150 friends is 300 requests, i.e. a full 60-second 429 lockout off the
 * whole API at boot. (Home's deck warm already spread `friends.accepted`
 * uncapped into `preloadAvatars`; that is exactly this bug, and it moves here.)
 *
 * The caps below bound the PLANNED set; `TokenBucket` in avatarWarmQueue bounds
 * the RATE at which the cold ones are actually fetched. Two different jobs:
 * the caps stop the warmer chasing a 5,000-member server forever, the bucket
 * stops any of it arriving as a burst.
 *
 * ── Why these numbers ────────────────────────────────────────────────────────
 * Warming is a bet on what the user opens next, so it is sized off what the UI
 * actually offers them, not off what exists:
 *   - conversations: the Home deck shows at most 6 "missed" rows and a handful
 *     of "pick back up" rows; the DM sidebar shows ~15 without scrolling. 24
 *     covers both with slack, ranked the same way the deck ranks.
 *   - friends: same order of magnitude, online-first — an offline friend's
 *     avatar is the least likely next click on the screen.
 *   - servers: 3. Each one costs a `GET /servers/:id/members` discovery request
 *     whether or not the user ever opens it, so this is the cap that has to be
 *     tight. Ranked by attention then last activity, so it is the three the
 *     rail is already badging.
 *   - members per server: 20, and preferring people who ACTUALLY POST — the
 *     locally cached channel messages name them exactly. A channel screen shows
 *     on the order of 10-20 distinct senders, so warming the member list in
 *     join order past that point is fan-out with no paint behind it.
 *
 * Planned ceiling: 24 + 24 + 3x20 = 108 distinct ids. Fully cold that is 216
 * requests — which is why the rate, not the count, is what keeps it safe.
 */

export interface AvatarWarmLimits {
    conversationAvatars: number;
    friendAvatars: number;
    servers: number;
    memberAvatarsPerServer: number;
}

export const DEFAULT_WARM_LIMITS: Readonly<AvatarWarmLimits> = Object.freeze({
    conversationAvatars: 24,
    friendAvatars: 24,
    servers: 3,
    memberAvatarsPerServer: 20,
});

export interface WarmPlanConversation {
    conversation_id: string;
    avatar_url?: string | null;
    other_user_id?: string | null;
    updated_at?: string | null;
    created_at?: string | null;
}

export interface WarmPlanFriend {
    user_id: string;
    avatar_url?: string | null;
    /** Profile banner attachment id (`GET /friends` carries it). */
    banner_url?: string | null;
}

export interface WarmPlanServer {
    server_id: string;
}

export interface WarmPlanInput {
    conversations?: WarmPlanConversation[] | null;
    friends?: WarmPlanFriend[] | null;
    servers?: WarmPlanServer[] | null;
    /** user_id -> online. Drives friend ordering only. */
    presence?: Record<string, boolean> | null;
    unreadCounts?: Record<string, number> | null;
    mentionCounts?: Record<string, number> | null;
    /** conversation_id -> ms. The persisted clock the Home deck ranks on. */
    lastActivityAt?: Record<string, number> | null;
    serverBadges?: Record<string, { unread?: number; mentions?: number }> | null;
    serverLastActivityAt?: Record<string, number> | null;
    limits?: Partial<AvatarWarmLimits>;
}

export interface AvatarWarmPlan {
    /** Attachment ids already in hand — warmable with zero discovery requests. */
    direct: string[];
    /** Servers worth one `GET /servers/:id/members` each before their avatars are known. */
    serverIds: string[];
}

/** mentions outrank unreads outrank everything — the Home deck's own rule. */
const attentionScore = (mentions: number, unread: number): number =>
    (mentions > 0 ? 2 : 0) + (unread > 0 ? 1 : 0);

const num = (v: number | undefined | null): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A conversation's avatar id. Mirrors HomePanel's convAvatarId minus the
 *  friend-map fallback, which the friend tier already covers. */
export function conversationAvatarId(conv: WarmPlanConversation | null | undefined): string | null {
    const id = conv?.avatar_url;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

export function buildAvatarWarmPlan(input: WarmPlanInput): AvatarWarmPlan {
    const limits: AvatarWarmLimits = { ...DEFAULT_WARM_LIMITS, ...(input.limits ?? {}) };

    const unread = input.unreadCounts ?? {};
    const mention = input.mentionCounts ?? {};
    const activity = input.lastActivityAt ?? {};

    // ── Conversations ───────────────────────────────────────────────────────
    const convRanked = (input.conversations ?? [])
        .filter((c): c is WarmPlanConversation => !!c && !!c.conversation_id)
        .map((c, index) => ({
            index,
            id: conversationAvatarId(c),
            attention: attentionScore(num(mention[c.conversation_id]), num(unread[c.conversation_id])),
            activity: num(activity[c.conversation_id])
                || Date.parse(c.updated_at ?? c.created_at ?? '') || 0,
        }))
        .filter(c => !!c.id)
        // Stable: ties fall back to the list's own order rather than to sort
        // implementation detail, so the plan is deterministic across runs.
        .sort((a, b) => (b.attention - a.attention) || (b.activity - a.activity) || (a.index - b.index));

    // ── Friends ─────────────────────────────────────────────────────────────
    const presence = input.presence ?? {};
    const friendRanked = (input.friends ?? [])
        .filter((f): f is WarmPlanFriend => !!f && typeof f.avatar_url === 'string' && f.avatar_url.length > 0)
        .map((f, index) => ({ index, id: f.avatar_url as string, online: presence[f.user_id] === true }))
        .sort((a, b) => (Number(b.online) - Number(a.online)) || (a.index - b.index));

    // Dedup ACROSS tiers, and take each tier's cap from what it contributed
    // rather than from the merged list — otherwise a DM partner who is also a
    // friend would silently eat one of the friend slots.
    const direct: string[] = [];
    const seen = new Set<string>();
    const push = (ids: string[], cap: number) => {
        let taken = 0;
        for (const id of ids) {
            if (taken >= cap) break;
            if (seen.has(id)) continue;
            seen.add(id);
            direct.push(id);
            taken++;
        }
    };
    push(convRanked.map(c => c.id as string), limits.conversationAvatars);
    push(friendRanked.map(f => f.id), limits.friendAvatars);

    // ── Servers ─────────────────────────────────────────────────────────────
    const badges = input.serverBadges ?? {};
    const serverActivity = input.serverLastActivityAt ?? {};
    const serverIds = (input.servers ?? [])
        .filter((s): s is WarmPlanServer => !!s && !!s.server_id)
        .map((s, index) => ({
            index,
            id: s.server_id,
            attention: attentionScore(num(badges[s.server_id]?.mentions), num(badges[s.server_id]?.unread)),
            activity: num(serverActivity[s.server_id]),
        }))
        .sort((a, b) => (b.attention - a.attention) || (b.activity - a.activity) || (a.index - b.index))
        .slice(0, Math.max(0, limits.servers))
        .map(s => s.id);

    return { direct, serverIds };
}

/**
 * Once a server's member list is in hand, which of those avatars to warm.
 *
 * `recentSenderUserIds` is most-recent-first and comes from the locally cached
 * channel messages — the people whose bubbles will actually paint. They go
 * first; the remaining budget is filled from the member list so a server with
 * no cached history still gets something.
 */
export function selectServerMemberAvatars(
    members: Array<{ user_id?: string | null; avatar_url?: string | null }> | null | undefined,
    recentSenderUserIds: string[] = [],
    limit: number = DEFAULT_WARM_LIMITS.memberAvatarsPerServer,
): string[] {
    const avatarByUser = new Map<string, string>();
    const inListOrder: string[] = [];
    for (const m of members ?? []) {
        const uid = m?.user_id;
        const avatar = m?.avatar_url;
        if (!uid || typeof avatar !== 'string' || avatar.length === 0) continue;
        if (!avatarByUser.has(uid)) { avatarByUser.set(uid, avatar); inListOrder.push(uid); }
    }

    const out: string[] = [];
    const seen = new Set<string>();
    const take = (uid: string) => {
        if (out.length >= limit) return;
        const avatar = avatarByUser.get(uid);
        if (!avatar || seen.has(avatar)) return;
        seen.add(avatar);
        out.push(avatar);
    };

    for (const uid of recentSenderUserIds) take(uid);
    for (const uid of inListOrder) take(uid);
    return out;
}

/**
 * Distinct sender user ids across a server's locally cached channel messages,
 * most recent first. Callers pass this straight to `selectServerMemberAvatars`.
 *
 * Messages are assumed newest-last within a channel (the order ChatPane
 * renders), so each channel is walked backwards and the channels are
 * interleaved by nothing more clever than "most recently active channel first"
 * — the caller supplies that order.
 */
export function collectRecentSenderIds(
    messageListsNewestLast: Array<Array<{ sender_user_id?: string | null }> | null | undefined>,
    limit = 64,
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const list of messageListsNewestLast) {
        if (!Array.isArray(list)) continue;
        for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
            const uid = list[i]?.sender_user_id;
            if (!uid || seen.has(uid)) continue;
            seen.add(uid);
            out.push(uid);
        }
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Friends' profile BANNERS worth warming, online-first, capped.
 *
 * A banner is only ever seen on a profile card, one at a time, so this is a
 * much smaller bet than avatars: FRIEND_BANNER_WARM_LIMIT, not 24. It exists
 * because the card is where the "slow profile" complaint lives — a friend's
 * banner id is in the friends list from boot, so warming it means the card
 * paints it on the first frame instead of after a cold download (two API
 * round trips + the media GET). Fully cold that is 2 requests per banner on
 * the same paced background lane as the avatars (queued behind them), once
 * per device: the decrypted result lands in the encrypted disk cache under its
 * own 'banner' prune budget and later boots cost nothing.
 */
export const FRIEND_BANNER_WARM_LIMIT = 12;

export function selectFriendBanners(
    friends: WarmPlanFriend[] | null | undefined,
    presence: Record<string, boolean> | null | undefined,
    limit: number = FRIEND_BANNER_WARM_LIMIT,
): string[] {
    const online = presence ?? {};
    const ranked = (friends ?? [])
        .filter((f): f is WarmPlanFriend => !!f && typeof f.banner_url === 'string' && f.banner_url.length > 0)
        .map((f, index) => ({ index, id: f.banner_url as string, online: online[f.user_id] === true }))
        .sort((a, b) => (Number(b.online) - Number(a.online)) || (a.index - b.index));
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of ranked) {
        if (out.length >= Math.max(0, limit)) break;
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        out.push(f.id);
    }
    return out;
}
