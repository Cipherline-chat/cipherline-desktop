import { describe, it, expect } from 'vitest';
import {
    buildAvatarWarmPlan,
    conversationAvatarId,
    selectServerMemberAvatars,
    collectRecentSenderIds,
    DEFAULT_WARM_LIMITS,
} from './avatarWarmPlan';

describe('conversationAvatarId', () => {
    it('returns the attachment id when there is one', () => {
        expect(conversationAvatarId({ conversation_id: 'c', avatar_url: 'att-1' })).toBe('att-1');
    });

    it('normalises every "no avatar" shape to null — including the empty string', () => {
        // An empty string is falsy, so a caller filtering on truthiness gets the
        // same answer either way; this pins the RETURN VALUE so the helper stays
        // usable by a caller that checks `=== null`.
        expect(conversationAvatarId({ conversation_id: 'c', avatar_url: '' })).toBeNull();
        expect(conversationAvatarId({ conversation_id: 'c', avatar_url: null })).toBeNull();
        expect(conversationAvatarId({ conversation_id: 'c' })).toBeNull();
        expect(conversationAvatarId(null)).toBeNull();
        expect(conversationAvatarId(undefined)).toBeNull();
    });
});

const conv = (id: string, avatar: string | null, updated?: string) => ({
    conversation_id: id,
    avatar_url: avatar,
    updated_at: updated ?? null,
});

describe('buildAvatarWarmPlan — conversations', () => {
    it('ranks a mentioned conversation above an unread one above a quiet one', () => {
        const plan = buildAvatarWarmPlan({
            conversations: [conv('quiet', 'a-quiet'), conv('unread', 'a-unread'), conv('mention', 'a-mention')],
            unreadCounts: { unread: 3, mention: 1 },
            mentionCounts: { mention: 1 },
        });
        expect(plan.direct).toEqual(['a-mention', 'a-unread', 'a-quiet']);
    });

    it('orders equal-attention conversations by the persisted activity clock, newest first', () => {
        const plan = buildAvatarWarmPlan({
            conversations: [conv('old', 'a-old'), conv('new', 'a-new'), conv('mid', 'a-mid')],
            lastActivityAt: { old: 100, mid: 500, new: 900 },
        });
        expect(plan.direct).toEqual(['a-new', 'a-mid', 'a-old']);
    });

    it('falls back to updated_at when the persisted clock has no entry', () => {
        const plan = buildAvatarWarmPlan({
            conversations: [
                conv('older', 'a-older', '2026-01-01T00:00:00.000Z'),
                conv('newer', 'a-newer', '2026-06-01T00:00:00.000Z'),
            ],
        });
        expect(plan.direct).toEqual(['a-newer', 'a-older']);
    });

    it('caps the conversation tier and drops the lowest-ranked overflow', () => {
        const conversations = Array.from({ length: 40 }, (_, i) =>
            conv(`c${i}`, `a${i}`),
        );
        // Descending activity, so c0 is the freshest and c39 the stalest.
        const lastActivityAt = Object.fromEntries(conversations.map((c, i) => [c.conversation_id, 1000 - i]));
        const plan = buildAvatarWarmPlan({ conversations, lastActivityAt, limits: { conversationAvatars: 5 } });
        expect(plan.direct).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
        expect(plan.direct).not.toContain('a5');
    });

    it('skips conversations with no avatar rather than spending a slot on null', () => {
        const plan = buildAvatarWarmPlan({
            conversations: [conv('none', null), conv('has', 'a-has')],
            limits: { conversationAvatars: 2 },
        });
        expect(plan.direct).toEqual(['a-has']);
    });
});

describe('buildAvatarWarmPlan — friends', () => {
    it('warms online friends before offline ones', () => {
        const plan = buildAvatarWarmPlan({
            friends: [
                { user_id: 'off1', avatar_url: 'a-off1' },
                { user_id: 'on1', avatar_url: 'a-on1' },
                { user_id: 'off2', avatar_url: 'a-off2' },
                { user_id: 'on2', avatar_url: 'a-on2' },
            ],
            presence: { on1: true, on2: true, off1: false },
        });
        expect(plan.direct.slice(0, 2)).toEqual(['a-on1', 'a-on2']);
    });

    it('caps the friend tier — a 200-friend account does not plan 200 avatars', () => {
        const friends = Array.from({ length: 200 }, (_, i) => ({ user_id: `f${i}`, avatar_url: `a${i}` }));
        const plan = buildAvatarWarmPlan({ friends });
        expect(plan.direct).toHaveLength(DEFAULT_WARM_LIMITS.friendAvatars);
    });

    it('a friend with no avatar is skipped and does not consume a capped slot', () => {
        const plan = buildAvatarWarmPlan({
            friends: [
                { user_id: 'none', avatar_url: null },
                { user_id: 'blank', avatar_url: '' },
                { user_id: 'nofield' },
                { user_id: 'has', avatar_url: 'a-has' },
            ],
            limits: { friendAvatars: 2 },
        });
        expect(plan.direct).toEqual(['a-has']);
    });

    it('a friend who is also a DM partner does not consume a slot in BOTH tiers', () => {
        // shared-1 is ranked into the conversation tier; the friend tier must
        // then still contribute its own full quota rather than re-offering it.
        const plan = buildAvatarWarmPlan({
            conversations: [conv('c1', 'shared-1')],
            friends: [
                { user_id: 'u1', avatar_url: 'shared-1' },
                { user_id: 'u2', avatar_url: 'friend-2' },
            ],
            limits: { conversationAvatars: 1, friendAvatars: 1 },
        });
        expect(plan.direct).toEqual(['shared-1', 'friend-2']);
    });
});

describe('buildAvatarWarmPlan — servers', () => {
    it('picks the servers the rail is badging, then the most recently active', () => {
        const plan = buildAvatarWarmPlan({
            servers: [{ server_id: 'quiet' }, { server_id: 'stale' }, { server_id: 'mention' }, { server_id: 'fresh' }],
            serverBadges: { mention: { mentions: 2 } },
            serverLastActivityAt: { fresh: 900, stale: 100, quiet: 0 },
            limits: { servers: 3 },
        });
        expect(plan.serverIds).toEqual(['mention', 'fresh', 'stale']);
    });

    it('caps server discovery — each one costs a members request whether or not it is opened', () => {
        const servers = Array.from({ length: 30 }, (_, i) => ({ server_id: `s${i}` }));
        const plan = buildAvatarWarmPlan({ servers });
        expect(plan.serverIds).toHaveLength(DEFAULT_WARM_LIMITS.servers);
    });

    it('plans nothing at all for an empty account', () => {
        expect(buildAvatarWarmPlan({})).toEqual({ direct: [], serverIds: [] });
    });
});

describe('selectServerMemberAvatars', () => {
    const members = [
        { user_id: 'm1', avatar_url: 'av1' },
        { user_id: 'm2', avatar_url: 'av2' },
        { user_id: 'm3', avatar_url: 'av3' },
        { user_id: 'm4', avatar_url: null },
        { user_id: 'm5', avatar_url: 'av5' },
    ];

    it('warms the people who actually post before the rest of the member list', () => {
        expect(selectServerMemberAvatars(members, ['m5', 'm3'], 10))
            .toEqual(['av5', 'av3', 'av1', 'av2']);
    });

    it('fills from the member list when the server has no cached history', () => {
        expect(selectServerMemberAvatars(members, [], 10)).toEqual(['av1', 'av2', 'av3', 'av5']);
    });

    it('honours the per-server cap, keeping the recent senders', () => {
        expect(selectServerMemberAvatars(members, ['m5', 'm3'], 2)).toEqual(['av5', 'av3']);
    });

    it('ignores a recent sender who is no longer a member', () => {
        expect(selectServerMemberAvatars(members, ['ghost', 'm2'], 2)).toEqual(['av2', 'av1']);
    });

    it('never returns the same avatar twice when two members share one', () => {
        const shared = [
            { user_id: 'a', avatar_url: 'same' },
            { user_id: 'b', avatar_url: 'same' },
            { user_id: 'c', avatar_url: 'other' },
        ];
        expect(selectServerMemberAvatars(shared, ['b', 'a'], 10)).toEqual(['same', 'other']);
    });

    it('survives a member list that is null', () => {
        expect(selectServerMemberAvatars(null, ['x'], 5)).toEqual([]);
    });
});

describe('collectRecentSenderIds', () => {
    it('reads each channel newest-last, so the most recent sender comes out first', () => {
        const channel = [
            { sender_user_id: 'oldest' },
            { sender_user_id: 'middle' },
            { sender_user_id: 'newest' },
        ];
        expect(collectRecentSenderIds([channel])).toEqual(['newest', 'middle', 'oldest']);
    });

    it('deduplicates a sender who posted repeatedly, keeping their newest position', () => {
        const channel = [
            { sender_user_id: 'chatty' },
            { sender_user_id: 'other' },
            { sender_user_id: 'chatty' },
        ];
        expect(collectRecentSenderIds([channel])).toEqual(['chatty', 'other']);
    });

    it('stops at the limit instead of walking an entire server history', () => {
        const channel = Array.from({ length: 500 }, (_, i) => ({ sender_user_id: `u${i}` }));
        expect(collectRecentSenderIds([channel], 4)).toEqual(['u499', 'u498', 'u497', 'u496']);
    });

    it('skips channels with no cached messages without losing the later ones', () => {
        expect(collectRecentSenderIds([undefined, null, [{ sender_user_id: 'a' }]])).toEqual(['a']);
    });
});
