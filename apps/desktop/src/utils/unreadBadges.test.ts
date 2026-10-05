import { describe, it, expect } from 'vitest';
import { sumCounts, splitCountsByOwner, dmGroupRailBadges, serverChannelBadges, clearCountsForIds, formatRailBadgeCount, resolveBadge, trayBadgeCount, effectiveChannelMode, type TrayBadgeInput } from './unreadBadges';

describe('sumCounts', () => {
    it('sums every value in the map', () => {
        expect(sumCounts({ a: 1, b: 2, c: 3 })).toBe(6);
    });

    it('returns 0 for an empty map', () => {
        expect(sumCounts({})).toBe(0);
    });

    it('treats falsy values as 0', () => {
        expect(sumCounts({ a: 0, b: 5 })).toBe(5);
    });

    // The tray/dock badge and every in-app rail badge must use this exact
    // function — this test exists to catch a future regression where one
    // surface reimplements its own summation and silently drifts from
    // another (that divergence was the original bug).
    it('is the single source of truth both tray and rail badges rely on', () => {
        const unread = { conv1: 2, conv2: 3 };
        const mentions = { conv1: 1 };
        const trayTotal = sumCounts(unread) + sumCounts(mentions);
        expect(trayTotal).toBe(6);
    });
});

describe('splitCountsByOwner', () => {
    it('assigns each id to its classified owner', () => {
        const result = splitCountsByOwner(
            { a: 1, b: 2, c: 3 },
            id => (id === 'a' ? 'x' : id === 'b' ? 'y' : undefined),
        );
        expect(result.byOwner).toEqual({ x: 1, y: 2 });
        expect(result.orphan).toBe(3);
    });

    it('never drops an unclassifiable id — it lands in orphan, not nowhere', () => {
        const result = splitCountsByOwner({ unknown: 5 }, () => undefined);
        expect(result.orphan).toBe(5);
        expect(Object.keys(result.byOwner)).toHaveLength(0);
    });

    it('skips zero/falsy counts entirely', () => {
        const result = splitCountsByOwner({ a: 0 }, () => 'x');
        expect(result.byOwner.x).toBeUndefined();
        expect(result.orphan).toBe(0);
    });

    it('accumulates multiple ids under the same owner', () => {
        const result = splitCountsByOwner(
            { a: 1, b: 2, c: 3 },
            () => 'same',
        );
        expect(result.byOwner.same).toBe(6);
        expect(result.orphan).toBe(0);
    });
});

describe('dmGroupRailBadges', () => {
    const classify = (id: string): 'dm' | 'group' | undefined => {
        if (id === 'dm1' || id === 'dm2') return 'dm';
        if (id === 'grp1') return 'group';
        return undefined;
    };

    it('a mention REPLACES the unread count rather than adding to it', () => {
        // THE REGRESSION. This used to assert dm === 3 and group === 2, i.e.
        // unread + mentions. That is double counting: an @mention increments
        // both counters, and outside a mute the mention counter is a SUBSET of
        // the unread counter — so a single @mention drew a badge reading 2.
        const result = dmGroupRailBadges(
            { dm1: 2, grp1: 1 },
            { dm2: 1, grp1: 1 },
            classify,
        );
        expect(result.dm).toEqual({ count: 1, tone: 'alert' });
        expect(result.group).toEqual({ count: 1, tone: 'alert' });
    });

    it('shows the plain unread count when there is no mention', () => {
        const result = dmGroupRailBadges({ dm1: 2, grp1: 5 }, {}, classify);
        expect(result.dm).toEqual({ count: 2, tone: 'alert' });
        expect(result.group).toEqual({ count: 5, tone: 'alert' });
    });

    it('draws an @mentions-only conversation quietly, not loudly', () => {
        const result = dmGroupRailBadges(
            { dm1: 4 }, {}, classify, () => 'mentions',
        );
        expect(result.dm).toEqual({ count: 4, tone: 'quiet' });
    });

    it('goes loud as soon as ANY contributing conversation still pings', () => {
        const result = dmGroupRailBadges(
            { dm1: 4, dm2: 1 }, {}, classify,
            id => (id === 'dm1' ? 'mentions' : 'all'),
        );
        // The whole unread total is shown; the tone reflects the loudest
        // conversation contributing to it.
        expect(result.dm).toEqual({ count: 5, tone: 'alert' });
    });

    it('drops a muted conversation from the count entirely', () => {
        const result = dmGroupRailBadges(
            { dm1: 9 }, {}, classify, () => 'none',
        );
        expect(result.dm).toBeNull();
    });

    it('still surfaces an @mention from a MUTED conversation', () => {
        // The entire difference between "Muted" and "off".
        const result = dmGroupRailBadges(
            { dm1: 9 }, { dm1: 2 }, classify, () => 'none',
        );
        expect(result.dm).toEqual({ count: 2, tone: 'alert' });
    });

    it('the decisive regression case: an unread for a conversation not yet in the loaded list is NOT zero', () => {
        // A message just arrived for a brand-new conversation the client
        // hasn't fetched yet — classify can't place it. Before this fix, the
        // rail badge derived from conversations.filter(...) and would render
        // this as literally invisible: sound plays, badge shows nothing.
        const result = dmGroupRailBadges(
            { 'brand-new-conv': 1 },
            {},
            () => undefined,
        );
        expect(result.dm).toEqual({ count: 1, tone: 'alert' });
    });

    it('returns null for both when there is nothing unread', () => {
        const result = dmGroupRailBadges({}, {}, classify);
        expect(result.dm).toBeNull();
        expect(result.group).toBeNull();
    });
});

describe('serverChannelBadges', () => {
    const classify = (id: string): string | undefined => {
        if (id === 'ch1' || id === 'ch2') return 'server-a';
        if (id === 'ch3') return 'server-b';
        return undefined;
    };

    it('groups channel unread/mentions by owning server', () => {
        const result = serverChannelBadges(
            { ch1: 2, ch3: 5 },
            { ch2: 1 },
            classify,
        );
        expect(result.byServer['server-a']).toEqual({ unread: 2, mentions: 1 });
        expect(result.byServer['server-b']).toEqual({ unread: 5, mentions: 0 });
        expect(result.orphan).toBe(0);
    });

    it('the decisive regression case: a channel not yet in serverChannels is not silently dropped', () => {
        // A message for a channel whose server's channel list hasn't loaded
        // yet (or was never eagerly loaded) — before Phase 1's eager-load
        // fix, this server's rail badge would sum over an empty channel-id
        // list and always read 0 no matter how large channelUnreadCounts got.
        const result = serverChannelBadges(
            { 'unclassified-channel': 3 },
            {},
            () => undefined,
        );
        expect(result.orphan).toBe(3);
        expect(Object.keys(result.byServer)).toHaveLength(0);
    });

    it('a server with zero unread channels is simply absent from byServer, not present-as-zero', () => {
        const result = serverChannelBadges({}, {}, classify);
        expect(result.byServer).toEqual({});
    });
});

describe('clearCountsForIds (server rail "Mark as Read")', () => {
    const classify = (id: string): string | undefined => {
        if (id === 'ch1' || id === 'ch2') return 'server-a';
        if (id === 'ch3') return 'server-b';
        return undefined;
    };

    it('clears exactly what the badge counted, and nothing else', () => {
        // The round trip the context-menu item performs: read the badge for
        // server-a, mark it read, read it again.
        const unread = { ch1: 2, ch2: 4, ch3: 5 };
        const mentions = { ch2: 1, ch3: 3 };
        expect(serverChannelBadges(unread, mentions, classify).byServer['server-a'])
            .toEqual({ unread: 6, mentions: 1 });

        const serverAChannels = ['ch1', 'ch2'];
        const after = serverChannelBadges(
            clearCountsForIds(unread, serverAChannels),
            clearCountsForIds(mentions, serverAChannels),
            classify,
        );
        expect(after.byServer['server-a']).toBeUndefined();
        // server-b untouched — marking one server read must not touch another.
        expect(after.byServer['server-b']).toEqual({ unread: 5, mentions: 3 });
    });

    it('deletes keys instead of zeroing them (the maps are persisted verbatim)', () => {
        const cleared = clearCountsForIds({ ch1: 2, ch3: 5 }, ['ch1']);
        expect(Object.prototype.hasOwnProperty.call(cleared, 'ch1')).toBe(false);
        expect(cleared).toEqual({ ch3: 5 });
    });

    it('does not mutate the input map', () => {
        const unread = { ch1: 2 };
        clearCountsForIds(unread, ['ch1']);
        expect(unread).toEqual({ ch1: 2 });
    });

    it('returns the same object reference when nothing matched (React setter bail-out)', () => {
        const unread = { ch3: 5 };
        expect(clearCountsForIds(unread, ['ch1', 'ch2'])).toBe(unread);
        expect(clearCountsForIds(unread, [])).toBe(unread);
    });

    it('leaves orphaned counts alone — they belong to no known server', () => {
        // A count for a channel whose server's channel list has not loaded is
        // not attributable to this server, so "Mark as Read" here must not
        // eat it. It stays visible as orphan until the list lands.
        const unread = { 'unclassified-channel': 3, ch1: 1 };
        const after = clearCountsForIds(unread, ['ch1', 'ch2']);
        expect(after).toEqual({ 'unclassified-channel': 3 });
        expect(serverChannelBadges(after, {}, classify).orphan).toBe(3);
    });
});

describe('formatRailBadgeCount', () => {
    it('returns null for zero and negative counts (nothing to render)', () => {
        expect(formatRailBadgeCount(0)).toBeNull();
        expect(formatRailBadgeCount(-1)).toBeNull();
    });

    it('returns the plain number as a string up to 99', () => {
        expect(formatRailBadgeCount(1)).toBe('1');
        expect(formatRailBadgeCount(99)).toBe('99');
    });

    it('caps at "99+" past 99, same threshold the rail pill has always used', () => {
        expect(formatRailBadgeCount(100)).toBe('99+');
        expect(formatRailBadgeCount(1000)).toBe('99+');
    });
});

describe('resolveBadge', () => {
    it('a mention wins outright and shows the MENTION count', () => {
        // Not unread + mentions: see dmGroupRailBadges' regression test above.
        expect(resolveBadge(7, 2, 'all')).toEqual({ count: 2, tone: 'alert' });
    });

    it('a mention shows even when the conversation is muted', () => {
        expect(resolveBadge(7, 2, 'none')).toEqual({ count: 2, tone: 'alert' });
    });

    it('a mute hides the plain unread badge completely', () => {
        expect(resolveBadge(7, 0, 'none')).toBeNull();
    });

    it('@mentions-only is quiet, not silent — the point of the grey badge', () => {
        expect(resolveBadge(7, 0, 'mentions')).toEqual({ count: 7, tone: 'quiet' });
    });

    it('ordinary unread is loud', () => {
        expect(resolveBadge(7, 0, 'all')).toEqual({ count: 7, tone: 'alert' });
    });

    it('nothing unread draws nothing, in every mode', () => {
        for (const mode of ['all', 'mentions', 'none'] as const) {
            expect(resolveBadge(0, 0, mode)).toBeNull();
        }
    });
});

describe('trayBadgeCount', () => {
    const base = (over: Partial<TrayBadgeInput> = {}): TrayBadgeInput => ({
        unreadCounts: {}, mentionCounts: {}, channelUnreadCounts: {}, channelMentionCounts: {},
        conversationMode: () => 'all', channelMode: () => 'all',
        showBadgeCount: true, onlyMentions: false, includesMuted: false, ...over,
    });

    it('counts plain unread from sources that ping', () => {
        expect(trayBadgeCount(base({ unreadCounts: { a: 2 }, channelUnreadCounts: { c: 3 } }))).toBe(5);
    });

    it('does not count plain unread from an @mentions-only conversation or channel', () => {
        const input = base({
            unreadCounts: { quiet: 4, loud: 1 },
            channelUnreadCounts: { qc: 7 },
            conversationMode: id => (id === 'quiet' ? 'mentions' : 'all'),
            channelMode: () => 'mentions',
        });
        expect(trayBadgeCount(input)).toBe(1);
    });

    it('still counts @mentions from an @mentions-only source', () => {
        const input = base({
            unreadCounts: { quiet: 4 }, mentionCounts: { quiet: 1 },
            channelUnreadCounts: { qc: 6 }, channelMentionCounts: { qc: 2 },
            conversationMode: () => 'mentions', channelMode: () => 'mentions',
        });
        expect(trayBadgeCount(input)).toBe(3);
    });

    it('never adds mentions on top of unread for a loud source (a mention is part of unread)', () => {
        expect(trayBadgeCount(base({ unreadCounts: { a: 1 }, mentionCounts: { a: 1 } }))).toBe(1);
    });

    it('ignores muted sources unless the user opted in, and then counts only their mentions', () => {
        const muted = base({
            unreadCounts: { m: 5 }, mentionCounts: { m: 1 },
            channelUnreadCounts: { mc: 5 }, channelMentionCounts: { mc: 2 },
            conversationMode: () => 'none', channelMode: () => 'none',
        });
        expect(trayBadgeCount(muted)).toBe(0);
        expect(trayBadgeCount({ ...muted, includesMuted: true })).toBe(3);
    });

    it('honours the badge preferences', () => {
        const input = base({ unreadCounts: { a: 2 }, mentionCounts: { b: 1 }, channelMentionCounts: { c: 1 } });
        expect(trayBadgeCount({ ...input, showBadgeCount: false })).toBe(0);
        expect(trayBadgeCount({ ...input, onlyMentions: true })).toBe(2);
    });
});

describe('effectiveChannelMode', () => {
    const serverOf = (id: string) => (id === 'orphan' ? undefined : 's1');
    it('prefers the channel override, then the server, then all', () => {
        expect(effectiveChannelMode('c', { c: 'none' }, serverOf, () => 'mentions')).toBe('none');
        expect(effectiveChannelMode('c', {}, serverOf, () => 'mentions')).toBe('mentions');
        expect(effectiveChannelMode('c', {}, serverOf, () => undefined)).toBe('all');
        expect(effectiveChannelMode('orphan', {}, serverOf, () => 'mentions')).toBe('all');
    });
});
