import { describe, it, expect } from 'vitest';
import {
    MUTE_DURATIONS, channelScopeIds, effectiveMutedChannels, isMuted, isMutedInScope, mutedHint, muteFor,
    mutesStoreKey, nextExpiry, parseMuteMap, pruneExpired, serializeMuteMap, unmute, withoutMuted, type MuteMap,
} from './channelMute';
import { decideChannelMessage } from './notificationDecision';
import { resolveBadge, serverChannelBadges, trayBadgeCount } from './unreadBadges';
import { KV_RULES } from '../services/backupRegistry';

const T0 = Date.UTC(2026, 10, 20, 15, 0, 0);
const MIN = 60_000;

describe('mute state: durations, expiry, restart', () => {
    it('sets each duration relative to now; "until I turn it back on" never lapses', () => {
        for (const [id, mins] of [['15m', 15], ['1h', 60], ['8h', 480], ['24h', 1440]] as const) {
            expect(muteFor({}, 'c', id, T0).c.until).toBe(T0 + mins * MIN);
        }
        expect(muteFor({}, 'c', 'forever', T0).c.until).toBeNull();
        expect(MUTE_DURATIONS.map(d => d.label)).toEqual([
            'For 15 minutes', 'For 1 hour', 'For 8 hours', 'For 24 hours', 'Until I turn it back on',
        ]);
    });
    it('a timed mute is live until its instant, then not (boundary)', () => {
        const m = muteFor({}, 'c', '15m', T0);
        expect(isMuted(m, 'c', T0 + 15 * MIN - 1)).toBe(true);
        expect(isMuted(m, 'c', T0 + 15 * MIN)).toBe(false);
        expect(isMuted({}, 'c', T0)).toBe(false); // positive control: unmuted stays unmuted
    });
    it('forever survives any amount of time', () => {
        expect(isMuted(muteFor({}, 'c', 'forever', T0), 'c', T0 + 400 * 24 * 60 * MIN)).toBe(true);
    });
    it('pruneExpired drops lapsed records and returns the SAME object when none lapsed', () => {
        const m: MuteMap = { a: { until: T0 + 10 }, b: { until: null }, c: { until: T0 - 1 } };
        const pruned = pruneExpired(m, T0);
        expect(Object.keys(pruned).sort()).toEqual(['a', 'b']);
        expect(pruneExpired(pruned, T0)).toBe(pruned);
    });
    it('nextExpiry is the soonest future timed lapse, ignoring forever and the past', () => {
        expect(nextExpiry({ a: { until: T0 + 50 }, b: { until: T0 + 20 }, c: { until: null }, d: { until: T0 - 5 } }, T0)).toBe(T0 + 20);
        expect(nextExpiry({ c: { until: null } }, T0)).toBeNull();
    });
    it('unmute removes; a missing id returns the same object', () => {
        const m = muteFor({}, 'c', '1h', T0);
        expect(unmute(m, 'c')).toEqual({});
        expect(unmute(m, 'zzz')).toBe(m);
    });
    it('restart: serialize then parse keeps live mutes, drops lapsed ones, and survives garbage', () => {
        const stored = serializeMuteMap({ a: { until: T0 + 5 * MIN }, b: { until: null }, c: { until: T0 + MIN } });
        const later = parseMuteMap(stored, T0 + 2 * MIN); // app was closed for 2 minutes
        expect(later).toEqual({ a: { until: T0 + 5 * MIN }, b: { until: null } });
        expect(JSON.parse(stored).v).toBe(1);
        for (const bad of [null, '', 'not json', '{}', '{"mutes":[]}', '{"mutes":{"x":{"until":"soon"}}}', '{"mutes":{"x":{"until":NaN}}}', '{"mutes":{"x":5}}']) {
            expect(parseMuteMap(bad, T0)).toEqual({});
        }
    });
    it('hint: same-day clock, other-day names the day, forever, expired = none', () => {
        const clock = (ms: number) => `CLK${new Date(ms).getUTCHours()}`;
        const day = () => 'Sat';
        const hasHint = (until: number | null, now = T0) => mutedHint({ until }, now, clock, day);
        expect(hasHint(T0 + 60 * MIN)).toBe('Muted until CLK16');
        expect(hasHint(T0 + 24 * 60 * MIN)).toBe('Muted until Sat CLK15');
        expect(hasHint(null)).toBe('Muted until you turn it back on');
        expect(hasHint(T0 - 1)).toBeNull();
        expect(mutedHint(undefined, T0, clock)).toBeNull();
    });
});

describe('scope: channel, category, parent category, server', () => {
    const data = {
        categoryOfChannel: (id: string) => ({ a: 'sub', b: 'top', c: null } as Record<string, string | null>)[id],
        parentOfCategory: (id: string) => (id === 'sub' ? 'top' : null),
        serverOfChannel: () => 's1',
    };
    it('chain is channel, category, parent, server', () => {
        expect(channelScopeIds('a', data)).toEqual(['a', 'sub', 'top', 's1']);
        expect(channelScopeIds('c', data)).toEqual(['c', 's1']);
    });
    it('a category mute covers its channels and sub-category channels only', () => {
        const m = muteFor({}, 'top', 'forever', T0);
        expect([...effectiveMutedChannels(m, ['a', 'b', 'c'], data, T0)].sort()).toEqual(['a', 'b']);
    });
    it('a server mute covers every channel; expired mute covers none', () => {
        expect(effectiveMutedChannels(muteFor({}, 's1', '1h', T0), ['a', 'b', 'c'], data, T0).size).toBe(3);
        expect(effectiveMutedChannels(muteFor({}, 's1', '15m', T0), ['a'], data, T0 + 16 * MIN).size).toBe(0);
        expect(isMutedInScope({}, ['a', 's1'], T0)).toBe(false);
    });
});

describe('notification gating while muted', () => {
    const base = {
        senderUserId: 'other', userId: 'me', myRoleIds: new Set(['role1']),
        keywords: ['deploy'], mode: 'all' as const, windowFocused: false, isActiveConversation: false,
        suppressWhenActiveConv: false, dndActive: false, dndLetMentionsThrough: false,
    };
    const text = (t: string, extra: Record<string, unknown> = {}) =>
        decideChannelMessage({ ...base, content: { type: 'text', text: t }, ...extra });

    it('positive control: unmuted plain message badges, sounds and toasts', () => {
        const d = text('hello')!;
        expect(d).toMatchObject({ countsUnread: true, playsSound: true, showsToast: true, countsMention: false });
    });
    it('muted plain message: no badge, no sound, no OS toast', () => {
        const d = text('hello', { muted: true })!;
        expect(d).toMatchObject({ countsUnread: false, playsSound: false, showsToast: false, countsMention: false });
    });
    it('muted: a DIRECT @mention of me still counts and notifies', () => {
        const d = text('hey <@u:me:Me>', { muted: true })!;
        expect(d.isMention).toBe(true);
        expect(d).toMatchObject({ countsMention: true, playsSound: true, showsToast: true });
        // positive control for the fixture: the mention syntax is what the unmuted path also reads
        expect(text('hey <@u:me:Me>')!.isMention).toBe(true);
    });
    it('muted: @everyone/@here, role pings and keyword hits are suppressed', () => {
        const everyone = text('@everyone hi', { muted: true, mentionsEveryone: true })!;
        expect(everyone).toMatchObject({ isMention: false, countsMention: false, playsSound: false, showsToast: false });
        const keyword = text('time to deploy', { muted: true })!;
        expect(keyword).toMatchObject({ isMention: false, playsSound: false });
        // controls: unmuted, the same inputs DO ping
        expect(text('@everyone hi', { mentionsEveryone: true })!.isMention).toBe(true);
        expect(text('time to deploy')!.isMention).toBe(true);
    });
    it('muted never turns an own message or an edit into something countable', () => {
        expect(text('x', { muted: true, senderUserId: 'me' })).toBeNull();
        expect(decideChannelMessage({ ...base, muted: true, content: { type: 'edit' } })).toBeNull();
    });
});

describe('badge aggregation excludes muted channels', () => {
    const unread = { a: 4, b: 9, c: 2 };
    const mentions = { c: 1 };
    const serverOf = () => 's1';
    it('rail total drops muted unread but keeps their direct mentions', () => {
        const muted = new Set(['a', 'c']);
        expect(withoutMuted(unread, muted)).toEqual({ b: 9 });
        const t = serverChannelBadges(withoutMuted(unread, muted), mentions, serverOf).byServer.s1;
        expect(t).toEqual({ unread: 9, mentions: 1 });
        // control: nothing muted = original totals, same object
        expect(withoutMuted(unread, new Set())).toBe(unread);
        expect(serverChannelBadges(unread, mentions, serverOf).byServer.s1).toEqual({ unread: 15, mentions: 1 });
    });
    it('a fully muted server resolves to no badge, a mention still shows', () => {
        expect(resolveBadge(15, 0, 'none')).toBeNull();
        expect(resolveBadge(15, 1, 'none')).toEqual({ count: 1, tone: 'alert' });
    });
    it('tray count: muted channel (mode none) contributes nothing unless include-muted', () => {
        const input = {
            unreadCounts: {}, mentionCounts: {}, channelUnreadCounts: { a: 4, b: 9 }, channelMentionCounts: { a: 1 },
            conversationMode: () => 'all' as const, channelMode: (id: string) => (id === 'a' ? 'none' as const : 'all' as const),
            showBadgeCount: true, onlyMentions: false, includesMuted: false,
        };
        expect(trayBadgeCount(input)).toBe(9);
        expect(trayBadgeCount({ ...input, includesMuted: true })).toBe(10);
    });
});

describe('persistence', () => {
    it('is keyed per account and included in encrypted backups', () => {
        expect(mutesStoreKey('u1')).toBe('cipherline_mutes_u1');
        const rule = KV_RULES.find(r => r.pattern === 'cipherline_mutes_{uid}');
        expect(rule).toBeDefined();
        expect(rule!.include).toBe(true);
        expect(KV_RULES.find(r => r.pattern === 'cipherline_nonexistent_{uid}')).toBeUndefined(); // control
    });
});
