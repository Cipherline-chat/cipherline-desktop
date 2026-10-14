import { describe, it, expect } from 'vitest';
import {
    ChannelMentionRecovery,
    recoverChannelMentions,
    scanReconcilePage,
    missingKeyEpochs,
    shouldAlertForReplay,
    LATE_ALERT_WINDOW_MS,
    MAX_PENDING_PER_CHANNEL,
    type PendingChannelEvent,
} from './channelMentionRecovery';
import { decideChannelMessage, type ChannelMessageDecisionInput, type NotifMode } from './notificationDecision';
import { resolveBadge, type CountMap } from './unreadBadges';
import { reconcileChannelUnread } from './channelReadSync';
import { channelPlaceholderContent } from './channelDecryptFailure';

const ME = 'user-me';
const OTHER = 'user-other';
const MY_ROLE = 'role-mine';
const NOT_MY_ROLE = 'role-theirs';
const SERVER = 'srv-1';
const CHANNEL = 'chan-general';

// ─────────────────────────────────────────────────────────────────────────────
// A faithful miniature of Dashboard's channel path, built from the REAL pure
// modules it calls: decideChannelMessage (live + replay decision),
// resolveBadge (what the channel list / rail draws), reconcileChannelUnread
// (the server-count fold), scanReconcilePage (the reconcile's mention scan)
// and ChannelMentionRecovery (the fix). The "engine" stands in for the
// main-process decrypt: it can only read an epoch it holds.
// ─────────────────────────────────────────────────────────────────────────────

interface WireEvt extends PendingChannelEvent {
    sender_user_id: string;
    mentions_everyone: boolean;
    created_at: string;
    /** What the ciphertext decrypts to (the test's stand-in for AES-GCM). */
    plaintext: { type: string; text?: string };
}

function makeClient(opts: { mode: NotifMode; heldEpochs: number[]; activeChannel?: string | null; focused?: boolean }) {
    const held = new Set(opts.heldEpochs);
    const unread: CountMap = {};
    const mentions: CountMap = {};
    const alerts: Array<{ isMention: boolean }> = [];
    const recovery = new ChannelMentionRecovery<WireEvt>();
    const decrypt = (e: { epoch: number; plaintext: WireEvt['plaintext'] }) => {
        if (!held.has(e.epoch)) throw new Error('No channel key for epoch ' + e.epoch);
        return e.plaintext;
    };
    const ctx = (): Omit<ChannelMessageDecisionInput, 'content' | 'senderUserId' | 'mentionsEveryone'> => ({
        userId: ME,
        myRoleIds: new Set([MY_ROLE]),
        keywords: [],
        mode: opts.mode,
        windowFocused: opts.focused ?? true,
        isActiveConversation: (opts.activeChannel ?? null) === CHANNEL,
        suppressWhenActiveConv: true,
        dndActive: false,
        dndLetMentionsThrough: true,
    });

    /** Dashboard.handleChannelMessage, reduced to what decides the badge. */
    const onLive = (evt: WireEvt, replay = false) => {
        let content;
        try {
            content = decrypt(evt);
        } catch {
            // key_missing: placeholder + key request in the app; with the fix,
            // also kept for recovery. (Pre-fix: nothing else happened.)
            if (evt.sender_user_id !== ME) recovery.addLive(evt, Date.now());
            return;
        }
        const d = decideChannelMessage({ ...ctx(), content, senderUserId: evt.sender_user_id, mentionsEveryone: evt.mentions_everyone });
        if (!d) return;
        if (d.countsMention) mentions[evt.channel_id] = (mentions[evt.channel_id] ?? 0) + 1;
        if (d.countsUnread) unread[evt.channel_id] = (unread[evt.channel_id] ?? 0) + 1;
        if ((d.playsSound || d.showsToast) && (!replay || shouldAlertForReplay(evt.created_at, Date.now()))) {
            alerts.push({ isMention: d.isMention });
        }
    };

    /** Dashboard.reconcileServerUnread + reconcileChannelMentions. */
    const reconcile = (serverRows: Array<{ channel_id: string; unread_count: number }>, page: WireEvt[]) => {
        // The request goes out AFTER any live event this test delivered first
        // (same-millisecond in a fast test run, hence +1).
        const requestedAt = Date.now() + 1;
        const next = reconcileChannelUnread({ unread: { ...unread }, mentions: {}, rows: serverRows, unreadAtRequest: { ...unread }, mentionsAtRequest: {} }).unread;
        for (const k of Object.keys(unread)) delete unread[k];
        Object.assign(unread, next);
        for (const r of serverRows) recovery.dropLiveReceivedBefore(r.channel_id, requestedAt);
        rescan(SERVER, CHANNEL, page);
    };
    let lastPage: WireEvt[] = [];
    const rescan = (serverId: string, channelId: string, page: WireEvt[] = lastPage) => {
        lastPage = page;
        if ((unread[channelId] ?? 0) <= 0) return;
        const decrypted = page.map(e => {
            try { return { id: e.message_id, sender_user_id: e.sender_user_id, content: decrypt(e) }; }
            catch { return { id: e.message_id, sender_user_id: e.sender_user_id, content: channelPlaceholderContent('key_missing', e.epoch) }; }
        });
        const { mentionHits, missingEpochs } = scanReconcilePage(decrypted, {
            userId: ME, myRoleIds: new Set([MY_ROLE]), keywords: [],
            mentionsEveryone: id => !!page.find(p => p.message_id === id)?.mentions_everyone,
        });
        recovery.noteReconcile(channelId, serverId, missingEpochs);
        if (mentionHits > 0) mentions[channelId] = Math.max(mentions[channelId] ?? 0, mentionHits);
    };

    /** A key envelope is installed, then pullChannelKeys runs the driver. */
    const installKey = async (epoch: number) => {
        held.add(epoch);
        await recoverChannelMentions(recovery, {
            serverId: SERVER,
            listEpochs: async () => [...held],
            replay: evt => onLive(evt, true),
            rescan: (sid, cid) => rescan(sid, cid),
        });
    };

    const badge = () => resolveBadge(unread[CHANNEL] ?? 0, mentions[CHANNEL] ?? 0, opts.mode);
    return { onLive, reconcile, installKey, badge, unread, mentions, alerts, recovery };
}

let seq = 0;
function evt(text: string, over: Partial<WireEvt> = {}): WireEvt {
    seq++;
    return {
        channel_id: CHANNEL,
        server_id: SERVER,
        message_id: `m-${seq}`,
        epoch: 1,
        sender_user_id: OTHER,
        mentions_everyone: false,
        created_at: new Date().toISOString(),
        plaintext: { type: 'text', text },
        ...over,
    };
}

const MENTION_ME = `hey <@u:${ME}:owner> look at this`;

// ─────────────────────────────────────────────────────────────────────────────

describe('REGRESSION — owner report 2026-10-11: @mention on an @mentions-only server showed a grey unread, not a red 1', () => {
    it('LIVE: a mention that arrives before its channel key ends up as a red 1 once the key lands', async () => {
        const c = makeClient({ mode: 'mentions', heldEpochs: [], activeChannel: null });
        c.onLive(evt(MENTION_ME, { epoch: 7 }));
        // Undecryptable on arrival: nothing can be known about it yet.
        expect(c.badge()).toBeNull();

        await c.installKey(7);

        expect(c.badge()).toEqual({ count: 1, tone: 'alert' });
        expect(c.mentions[CHANNEL]).toBe(1);
        expect(c.alerts).toEqual([{ isMention: true }]);
        expect(c.recovery.size()).toBe(0);
    });

    it('RECONCILE: the server count raises a grey badge; the mention is found once the key lands', async () => {
        const c = makeClient({ mode: 'mentions', heldEpochs: [], activeChannel: null });
        const m = evt(MENTION_ME, { epoch: 3 });
        // Boot / wake: the server says 1 unread, the newest page can't be read yet.
        c.reconcile([{ channel_id: CHANNEL, unread_count: 1 }], [m]);
        // This IS the reported symptom — and before the fix it stayed this way.
        expect(c.badge()).toEqual({ count: 1, tone: 'quiet' });

        await c.installKey(3);

        expect(c.badge()).toEqual({ count: 1, tone: 'alert' });
        // Counted once: the reconcile owns its unread; the rescan only adds the mention.
        expect(c.unread[CHANNEL]).toBe(1);
        expect(c.mentions[CHANNEL]).toBe(1);
    });

    it('LIVE then RECONCILE before the key: the message is counted once, not twice', async () => {
        const c = makeClient({ mode: 'mentions', heldEpochs: [], activeChannel: null });
        const m = evt(MENTION_ME, { epoch: 4 });
        c.onLive(m);
        c.reconcile([{ channel_id: CHANNEL, unread_count: 1 }], [m]);
        await c.installKey(4);
        expect(c.unread[CHANNEL]).toBe(1);
        expect(c.mentions[CHANNEL]).toBe(1);
        expect(c.badge()).toEqual({ count: 1, tone: 'alert' });
    });
});

describe('decision table: notification level × mention type × channel active/inactive × key available/late', () => {
    type Kind = 'plain' | 'user-me' | 'user-other' | 'everyone-text' | 'here-text' | 'everyone-flag' | 'role-mine' | 'role-not-mine';
    const bodies: Record<Kind, { text: string; flag?: boolean; mention: boolean }> = {
        'plain':          { text: 'just chatting', mention: false },
        'user-me':        { text: MENTION_ME, mention: true },
        'user-other':     { text: `<@u:${OTHER}:them> hi`, mention: false },
        'everyone-text':  { text: '@everyone standup', mention: true },
        'here-text':      { text: '@here standup', mention: true },
        'everyone-flag':  { text: 'standup', flag: true, mention: true },
        'role-mine':      { text: `<@r:${MY_ROLE}:mods> ping`, mention: true },
        'role-not-mine':  { text: `<@r:${NOT_MY_ROLE}:admins> ping`, mention: false },
    };
    const modes: NotifMode[] = ['all', 'mentions', 'none'];

    for (const mode of modes) {
        for (const kind of Object.keys(bodies) as Kind[]) {
            for (const active of [false, true]) {
                for (const keyLate of [false, true]) {
                    const b = bodies[kind];
                    it(`${mode} | ${kind} | ${active ? 'active' : 'inactive'} | key ${keyLate ? 'late' : 'held'}`, async () => {
                        const c = makeClient({ mode, heldEpochs: keyLate ? [] : [1], activeChannel: active ? CHANNEL : null });
                        c.onLive(evt(b.text, { epoch: 1, mentions_everyone: !!b.flag }));
                        if (keyLate) await c.installKey(1);

                        const badge = c.badge();
                        if (active) {
                            // Looking right at it (focused + open): nothing counts.
                            expect(badge).toBeNull();
                            expect(c.mentions[CHANNEL] ?? 0).toBe(0);
                        } else if (b.mention) {
                            // A mention is RED whatever the level — "@mentions only"
                            // and "Nothing" silence non-mentions, never mentions.
                            expect(badge).toEqual({ count: 1, tone: 'alert' });
                            expect(c.alerts).toEqual([{ isMention: true }]);
                        } else if (mode === 'all') {
                            expect(badge).toEqual({ count: 1, tone: 'alert' });
                            expect(c.alerts).toEqual([{ isMention: false }]);
                        } else if (mode === 'mentions') {
                            expect(badge).toEqual({ count: 1, tone: 'quiet' });
                            expect(c.alerts).toEqual([]);
                        } else {
                            expect(badge).toBeNull();
                            expect(c.alerts).toEqual([]);
                        }
                    });
                }
            }
        }
    }
});

describe('decideChannelMessage', () => {
    const base: Omit<ChannelMessageDecisionInput, 'content'> = {
        senderUserId: OTHER, userId: ME, myRoleIds: new Set(), keywords: [],
        mode: 'mentions', windowFocused: false, isActiveConversation: false,
        suppressWhenActiveConv: true, dndActive: false, dndLetMentionsThrough: true,
    };
    it('never counts our own message, even one that mentions us', () => {
        expect(decideChannelMessage({ ...base, senderUserId: ME, content: { type: 'text', text: MENTION_ME } })).toBeNull();
    });
    it('never counts an edit / delete / reaction', () => {
        for (const type of ['edit', 'delete', 'reaction']) {
            expect(decideChannelMessage({ ...base, content: { type, text: MENTION_ME } })).toBeNull();
        }
    });
    it('a user keyword counts as a mention on a channel too', () => {
        const d = decideChannelMessage({ ...base, keywords: ['deploy'], content: { type: 'text', text: 'time to deploy' } });
        expect(d?.countsMention).toBe(true);
    });
    it('a mention under DND still counts (badge), and alerts only if mentions are let through', () => {
        const on = decideChannelMessage({ ...base, dndActive: true, content: { type: 'text', text: MENTION_ME } });
        expect(on?.countsMention).toBe(true);
        expect(on?.playsSound).toBe(true);
        const off = decideChannelMessage({ ...base, dndActive: true, dndLetMentionsThrough: false, content: { type: 'text', text: MENTION_ME } });
        expect(off?.countsMention).toBe(true);
        expect(off?.playsSound).toBe(false);
    });
    it('an unfocused window does not count as "looking at it", even in the open channel', () => {
        const d = decideChannelMessage({ ...base, isActiveConversation: true, windowFocused: false, content: { type: 'text', text: MENTION_ME } });
        expect(d?.countsMention).toBe(true);
    });
});

describe('ChannelMentionRecovery', () => {
    it('releases only events whose own epoch is now held', () => {
        const r = new ChannelMentionRecovery<WireEvt>();
        const a = evt('a', { epoch: 1 });
        const b = evt('b', { epoch: 2 });
        r.addLive(a, 1);
        r.addLive(b, 2);
        expect(r.takeReady(CHANNEL, new Set([2])).replay).toEqual([b]);
        expect(r.takeReady(CHANNEL, new Set([2])).replay).toEqual([]);
        expect(r.takeReady(CHANNEL, new Set([1, 2])).replay).toEqual([a]);
        expect(r.size()).toBe(0);
    });

    it('ignores a duplicate message id and bounds each channel', () => {
        const r = new ChannelMentionRecovery<WireEvt>();
        const a = evt('a');
        r.addLive(a, 1);
        r.addLive(a, 2);
        expect(r.size()).toBe(1);
        for (let i = 0; i < MAX_PENDING_PER_CHANNEL + 5; i++) r.addLive(evt('x'), 10 + i);
        expect(r.size()).toBe(MAX_PENDING_PER_CHANNEL);
        // The oldest was evicted first.
        expect(r.takeReady(CHANNEL, new Set([1])).replay.some(e => e.message_id === a.message_id)).toBe(false);
    });

    it('a complete reconcile settles a pending rescan; an incomplete one records its epochs', () => {
        const r = new ChannelMentionRecovery<WireEvt>();
        r.noteReconcile(CHANNEL, SERVER, [5]);
        expect(r.takeReady(CHANNEL, new Set([4])).rescan).toBeNull();
        r.noteReconcile(CHANNEL, SERVER, []);
        expect(r.takeReady(CHANNEL, new Set([5])).rescan).toBeNull();
        r.noteReconcile(CHANNEL, SERVER, [5, 6]);
        expect(r.takeReady(CHANNEL, new Set([6])).rescan).toEqual({ serverId: SERVER });
    });

    it('dropLiveReceivedBefore keeps events that arrived after the request went out', () => {
        const r = new ChannelMentionRecovery<WireEvt>();
        const early = evt('early');
        const late = evt('late');
        r.addLive(early, 100);
        r.addLive(late, 300);
        r.dropLiveReceivedBefore(CHANNEL, 200);
        expect(r.takeReady(CHANNEL, new Set([1])).replay).toEqual([late]);
    });

    it('channels() scopes by server', () => {
        const r = new ChannelMentionRecovery<WireEvt>();
        r.addLive(evt('a', { channel_id: 'c1', server_id: 's1' }), 1);
        r.noteReconcile('c2', 's2', [1]);
        expect(r.channels('s1')).toEqual(['c1']);
        expect(r.channels('s2')).toEqual(['c2']);
        expect(r.channels().sort()).toEqual(['c1', 'c2']);
    });

    it('recoverChannelMentions skips a channel whose epoch list cannot be read, and leaves its work pending', async () => {
        const r = new ChannelMentionRecovery<WireEvt>();
        r.addLive(evt('a'), 1);
        const replayed: WireEvt[] = [];
        await recoverChannelMentions(r, {
            listEpochs: async () => { throw new Error('ipc down'); },
            replay: e => { replayed.push(e); },
            rescan: () => {},
        });
        expect(replayed).toEqual([]);
        expect(r.size()).toBe(1);
    });
});

describe('missingKeyEpochs / scanReconcilePage', () => {
    it('collects key_missing epochs from other people\'s rows only', () => {
        const rows = [
            { id: '1', sender_user_id: OTHER, content: channelPlaceholderContent('key_missing', 4) },
            { id: '2', sender_user_id: ME, content: channelPlaceholderContent('key_missing', 5) },
            { id: '3', sender_user_id: OTHER, content: channelPlaceholderContent('unverified', 6) },
            { id: '4', sender_user_id: OTHER, content: { type: 'text', text: 'hi' } },
        ];
        expect(missingKeyEpochs(rows, ME)).toEqual([4]);
    });
    it('counts an @everyone-flagged row as a mention even before it can be decrypted', () => {
        const rows = [{ id: '1', sender_user_id: OTHER, content: channelPlaceholderContent('key_missing', 4) }];
        const r = scanReconcilePage(rows, { userId: ME, myRoleIds: new Set(), keywords: [], mentionsEveryone: () => true });
        expect(r).toEqual({ mentionHits: 1, missingEpochs: [4] });
    });
});

describe('shouldAlertForReplay', () => {
    it('alerts for a recent message, stays silent for an old or unparseable one', () => {
        const now = Date.parse('2026-10-11T12:00:00Z');
        expect(shouldAlertForReplay('2026-10-11T11:59:00Z', now)).toBe(true);
        expect(shouldAlertForReplay(new Date(now - LATE_ALERT_WINDOW_MS - 1).toISOString(), now)).toBe(false);
        expect(shouldAlertForReplay('garbage', now)).toBe(false);
        expect(shouldAlertForReplay(undefined, now)).toBe(false);
    });
});
