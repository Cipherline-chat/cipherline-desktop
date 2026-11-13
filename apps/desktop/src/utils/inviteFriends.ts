/**
 * Invite People — which friends to offer, and in what order.
 *
 * The "recent friends" list in the Invite People dialog. Recency is worked out
 * ENTIRELY on this device from state the client already holds; there is no
 * server-side "recent contacts" log and nothing here sends or stores anything:
 *
 *   - a message signal — `lastActivityAt[dmConversationId]`, the device-local
 *     "when did I last see a message in this DM" map Dashboard keeps
 *     (encrypted at rest). It moves when you send AND when you receive.
 *   - an "added" signal — `friends_since`, the accepted instant `GET /friends`
 *     already carries for every accepted friend.
 *
 * A friend's recency is the LATER of the two, so someone you accepted an hour
 * ago outranks the friend you last messaged last week, and a friend you are
 * chatting with right now outranks one you added yesterday.
 *
 * Pure and React-free so the ordering and search rules are unit-testable.
 */
import { padDiscriminator } from '@cipherline/shared';
import { matchRank } from './peoplePicker';

/** The `accepted` row fields this list reads (the `/friends` payload is untyped upstream). */
export interface InviteFriendSource {
    user_id: string;
    username?: string | null;
    discriminator?: number | null;
    avatar_url?: string | null;
    /** ISO instant the friendship was accepted. */
    friends_since?: string | null;
}

interface ConversationLike {
    conversation_id?: string | null;
    id?: string | null;
    type?: string | null;
    other_user_id?: string | null;
    is_self?: boolean | null;
}

export type InviteRecentReason = 'message' | 'new-friend';

export interface InviteFriend {
    userId: string;
    username: string;
    discriminator: number | null;
    avatarUrl: string | null;
    /** Epoch ms of the friend's most recent signal; 0 = none known. */
    recentAt: number;
    /** Which signal won; null when `recentAt` is 0. */
    recentReason: InviteRecentReason | null;
}

/** How many friends the unfiltered list leads with. */
export const RECENT_INVITE_LIMIT = 5;

const toMs = (iso: string | null | undefined, now: number): number => {
    if (!iso) return 0;
    const t = Date.parse(iso);
    // An unparseable or far-future stamp is bad data, not "most recent ever".
    if (!Number.isFinite(t) || t <= 0 || t > now + 24 * 3_600_000) return 0;
    return t;
};

const byName = (a: InviteFriend, b: InviteFriend) =>
    a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }) || a.userId.localeCompare(b.userId);

/**
 * Every offerable friend with their recency, most recent first; friends with no
 * signal at all follow A-Z. Blocked people and yourself are never offered.
 */
export function buildInviteFriends(p: {
    friends: readonly InviteFriendSource[];
    conversations: readonly ConversationLike[];
    lastActivityAt?: Record<string, number> | null;
    blockedIds?: ReadonlySet<string> | null;
    myUserId?: string | null;
    now?: number;
}): InviteFriend[] {
    const now = p.now ?? Date.now();
    const dmByUser = new Map<string, string>();
    for (const c of p.conversations) {
        if (c?.type !== 'dm') continue;
        const cid = c.conversation_id ?? c.id ?? null;
        if (!cid || c.is_self === true || !c.other_user_id) continue;
        if (!dmByUser.has(c.other_user_id)) dmByUser.set(c.other_user_id, cid);
    }
    const seen = new Set<string>();
    const out: InviteFriend[] = [];
    for (const f of p.friends) {
        if (!f?.user_id || seen.has(f.user_id)) continue;
        if (f.user_id === p.myUserId || p.blockedIds?.has(f.user_id)) continue;
        seen.add(f.user_id);
        const cid = dmByUser.get(f.user_id);
        const rawMsg = cid ? p.lastActivityAt?.[cid] : undefined;
        const msgAt = typeof rawMsg === 'number' && Number.isFinite(rawMsg) && rawMsg > 0 && rawMsg <= now + 24 * 3_600_000 ? rawMsg : 0;
        const sinceAt = toMs(f.friends_since, now);
        const recentAt = Math.max(msgAt, sinceAt);
        out.push({
            userId: f.user_id,
            username: f.username?.trim() || 'Unknown',
            discriminator: typeof f.discriminator === 'number' ? f.discriminator : null,
            avatarUrl: f.avatar_url ?? null,
            recentAt,
            recentReason: recentAt === 0 ? null : msgAt >= sinceAt ? 'message' : 'new-friend',
        });
    }
    return out.sort((a, b) => (b.recentAt - a.recentAt) || byName(a, b));
}

/** The unfiltered list's lead: the `limit` most recent friends that have any signal. */
export function recentInviteFriends(list: readonly InviteFriend[], limit = RECENT_INVITE_LIMIT): InviteFriend[] {
    return list.filter(f => f.recentAt > 0).slice(0, Math.max(0, limit));
}

/**
 * Search every friend by name. `name` matches exact → prefix → word start →
 * anywhere (the same ranking the New Message picker uses); `name#12` also
 * requires the tag to start with `12` (padded or not), and `#12` alone searches by tag.
 * Ties break on recency, then A-Z.
 */
export function searchInviteFriends(list: readonly InviteFriend[], query: string): InviteFriend[] {
    const q = query.trim();
    if (!q) return [];
    const hash = q.indexOf('#');
    const namePart = (hash >= 0 ? q.slice(0, hash) : q).trim();
    const tagPart = hash >= 0 ? q.slice(hash + 1).trim() : '';
    const ranked: { f: InviteFriend; rank: number }[] = [];
    for (const f of list) {
        const rank = namePart ? matchRank(f.username, namePart) : 0;
        if (rank < 0) continue;
        if (tagPart) {
            if (f.discriminator === null) continue;
            // "12" finds #0012 (as typed, unpadded) and #1234 (prefix of the padded tag).
            if (!padDiscriminator(f.discriminator).startsWith(tagPart) && !String(f.discriminator).startsWith(tagPart)) continue;
        }
        ranked.push({ f, rank });
    }
    return ranked
        .sort((a, b) => (a.rank - b.rank) || (b.f.recentAt - a.f.recentAt) || byName(a.f, b.f))
        .map(r => r.f);
}
