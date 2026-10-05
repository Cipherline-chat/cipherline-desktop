import { describe, it, expect } from 'vitest';
import {
    ACTIVE_INPUT_WINDOW_MS, DAY_MS, FIRST_WEEK_DAYS, MAX_SHOWS, NUDGE_PRIORITY, REPEAT_GAP_MS, SESSION_GRACE_MS,
    TYPING_QUIET_MS, defaultNudgeState, deriveFriendsInVoice, evaluateNudge, friendsInVoiceKey, gateReason,
    isUserActive, isUserAuthoredContentType, isWithinFirstWeek, localDayKey, nudgeCopy, nudgeStillTrue,
    parseCreatedAt, parseNudgeState, recordRetired, recordShown, OFFICIAL_SERVER_INVITE_CODE,
    type FriendsInVoice, type NudgeSnapshot, type NudgeState,
} from './firstWeekNudges';

// A fixed "now": a Tuesday afternoon, local time. Everything is relative to it.
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime();
const VOICE: FriendsInVoice = { channelId: 'ch1', channelName: 'Lounge', serverId: 's1', serverName: 'Hangout', names: ['Sam'] };

/** A snapshot where EVERYTHING is allowed and every standing condition is true
 *  except the ones a test turns on. Account is 3 days old. */
function snap(over: Partial<NudgeSnapshot> = {}): NudgeSnapshot {
    return {
        now: NOW,
        userId: 'u1',
        accountCreatedAt: NOW - 3 * DAY_MS,
        state: defaultNudgeState(),
        sessionStartedAt: NOW - 10 * 60_000,
        shownThisSession: false,
        activity: { focused: true, visible: true, lastInputAt: NOW - 5_000, lastKeyAt: 0 },
        suppress: { dnd: false, inCall: false, screensharing: false, uiBusy: false },
        friends: { loaded: true, count: 2 },
        servers: { loaded: true, count: 1 },
        friendsInVoice: null,
        pendingFriendJoined: [],
        hasOwnMessage: true,
        ...over,
    };
}
const withState = (patch: Partial<NudgeState>) => ({ ...defaultNudgeState(), ...patch });

describe('selection and priority', () => {
    it('shows nothing when every standing condition is already satisfied', () => {
        expect(evaluateNudge(snap())).toEqual({ nudge: null, blocked: null });
    });

    it('no friends -> invite a friend', () => {
        expect(evaluateNudge(snap({ friends: { loaded: true, count: 0 } })).nudge).toEqual({ kind: 'no_friends' });
    });

    it('does NOT claim "no friends" before the friends list has loaded', () => {
        expect(evaluateNudge(snap({ friends: { loaded: false, count: 0 } })).nudge).toBeNull();
    });

    it('no servers -> Official Cipherline server (only once servers have loaded)', () => {
        expect(evaluateNudge(snap({ servers: { loaded: true, count: 0 } })).nudge).toEqual({ kind: 'no_server' });
        expect(evaluateNudge(snap({ servers: { loaded: false, count: 0 } })).nudge).toBeNull();
    });

    it('a friend who just arrived -> "<name> is here"', () => {
        const ev = evaluateNudge(snap({ pendingFriendJoined: [{ username: 'sam', userId: 'u2' }] }));
        expect(ev.nudge).toEqual({ kind: 'friend_joined', username: 'sam', userId: 'u2' });
        expect(nudgeCopy(ev.nudge!).title).toBe('sam is here');
    });

    it('friends in a voice channel -> names the real channel and count', () => {
        const two: FriendsInVoice = { ...VOICE, names: ['Sam', 'Ana'] };
        const ev = evaluateNudge(snap({ friendsInVoice: two }));
        expect(ev.nudge).toEqual({ kind: 'friends_in_voice', voice: two });
        expect(nudgeCopy(ev.nudge!).title).toBe('2 friends are in Lounge');
        expect(nudgeCopy({ kind: 'friends_in_voice', voice: VOICE }).title).toBe('Sam is in Lounge');
    });

    it('never-messaged: only from day 2, only when nothing was ever sent', () => {
        const day = (n: number, over: Partial<NudgeSnapshot> = {}) =>
            evaluateNudge(snap({ accountCreatedAt: NOW - n * DAY_MS - 1000, hasOwnMessage: false, ...over })).nudge;
        expect(day(1)).toBeNull();
        expect(day(2)).toEqual({ kind: 'self_message' });
        expect(day(2, { state: withState({ sentMessage: true }) })).toBeNull();
        expect(day(2, { hasOwnMessage: true })).toBeNull();
    });

    it('priority: friend_joined > friends_in_voice > no_friends > no_server > self_message', () => {
        const everything = snap({
            pendingFriendJoined: [{ username: 'sam' }],
            friendsInVoice: VOICE,
            friends: { loaded: true, count: 0 },
            servers: { loaded: true, count: 0 },
            hasOwnMessage: false,
        });
        expect([...NUDGE_PRIORITY]).toEqual(['friend_joined', 'friends_in_voice', 'no_friends', 'no_server', 'self_message']);
        const order: string[] = [];
        let s = everything;
        for (let i = 0; i < 5; i++) {
            const n = evaluateNudge(s).nudge;
            if (!n) break;
            order.push(n.kind);
            // Drop the winner so the next one surfaces.
            s = { ...s,
                pendingFriendJoined: n.kind === 'friend_joined' ? [] : s.pendingFriendJoined,
                friendsInVoice: n.kind === 'friends_in_voice' ? null : s.friendsInVoice,
                friends: n.kind === 'no_friends' ? { loaded: true, count: 1 } : s.friends,
                servers: n.kind === 'no_server' ? { loaded: true, count: 1 } : s.servers,
            };
        }
        expect(order).toEqual(['friend_joined', 'friends_in_voice', 'no_friends', 'no_server', 'self_message']);
    });

    it('copy never invents anything: the invite-server nudge points at the official invite code', () => {
        expect(OFFICIAL_SERVER_INVITE_CODE).toBe('zKKaUldlWXo');
        for (const n of [{ kind: 'no_friends' }, { kind: 'no_server' }, { kind: 'self_message' }] as const) {
            const c = nudgeCopy(n);
            expect(c.title + c.body).not.toMatch(/\d/); // no counts, no streak numbers
            expect(c.title + c.body + c.action).not.toMatch(/streak|don't break|miss out|hurry/i);
        }
    });
});

describe('7-day window', () => {
    const none = (over: Partial<NudgeSnapshot>) => evaluateNudge(snap({ friends: { loaded: true, count: 0 }, ...over }));

    it('shows inside the first week', () => {
        expect(none({ accountCreatedAt: NOW - (FIRST_WEEK_DAYS * DAY_MS - 60_000) }).nudge).toEqual({ kind: 'no_friends' });
    });
    it('shows nothing from day 7 on', () => {
        const r = none({ accountCreatedAt: NOW - FIRST_WEEK_DAYS * DAY_MS });
        expect(r).toEqual({ nudge: null, blocked: 'outside-first-week' });
        expect(none({ accountCreatedAt: NOW - 400 * DAY_MS }).blocked).toBe('outside-first-week');
    });
    it('fails quiet when the creation time is unknown or garbage', () => {
        expect(none({ accountCreatedAt: null }).blocked).toBe('outside-first-week');
        expect(parseCreatedAt('not a date')).toBeNull();
        expect(parseCreatedAt('')).toBeNull();
        expect(parseCreatedAt(undefined)).toBeNull();
        expect(isWithinFirstWeek(null, NOW)).toBe(false);
    });
    it('tolerates a little clock skew on the early side only', () => {
        expect(isWithinFirstWeek(NOW + 60_000, NOW)).toBe(true);
        expect(isWithinFirstWeek(NOW + 3_600_000, NOW)).toBe(false);
    });
    it('parses the server ISO timestamp', () => {
        expect(parseCreatedAt('2026-10-01T12:00:00.000Z')).toBe(Date.parse('2026-10-01T12:00:00.000Z'));
    });
});

describe('active-only gating', () => {
    const A = (over: Partial<NudgeSnapshot['activity']>) => snap({ friends: { loaded: true, count: 0 }, activity: { focused: true, visible: true, lastInputAt: NOW - 1000, lastKeyAt: 0, ...over } });

    it('window not focused -> nothing', () => {
        expect(evaluateNudge(A({ focused: false })).blocked).toBe('not-active');
    });
    it('window hidden / minimised -> nothing', () => {
        expect(evaluateNudge(A({ visible: false })).blocked).toBe('not-active');
    });
    it('focused but no recent input -> nothing', () => {
        expect(evaluateNudge(A({ lastInputAt: NOW - ACTIVE_INPUT_WINDOW_MS - 1 })).blocked).toBe('not-active');
        expect(evaluateNudge(A({ lastInputAt: 0 })).blocked).toBe('not-active');
    });
    it('focused with input just inside the window -> active', () => {
        expect(isUserActive({ focused: true, visible: true, lastInputAt: NOW - ACTIVE_INPUT_WINDOW_MS, lastKeyAt: 0 }, NOW)).toBe(true);
        expect(evaluateNudge(A({ lastInputAt: NOW - ACTIVE_INPUT_WINDOW_MS })).nudge).toEqual({ kind: 'no_friends' });
    });
    it('waits while the person is mid-sentence', () => {
        expect(evaluateNudge(A({ lastKeyAt: NOW - (TYPING_QUIET_MS - 1) })).blocked).toBe('typing');
        expect(evaluateNudge(A({ lastKeyAt: NOW - TYPING_QUIET_MS })).nudge).toEqual({ kind: 'no_friends' });
    });
});

describe('suppression: DND, calls, screen share, busy UI', () => {
    const quiet = (suppress: Partial<NudgeSnapshot['suppress']>) =>
        evaluateNudge(snap({ friends: { loaded: true, count: 0 }, suppress: { dnd: false, inCall: false, screensharing: false, uiBusy: false, ...suppress } }));

    it.each([
        ['dnd', { dnd: true }, 'dnd'],
        ['in a call', { inCall: true }, 'in-call'],
        ['screen sharing', { screensharing: true }, 'screensharing'],
        ['a modal / first-run prompt is up', { uiBusy: true }, 'ui-busy'],
    ] as const)('%s -> nothing', (_n, s, reason) => {
        expect(quiet(s)).toEqual({ nudge: null, blocked: reason });
    });

    it('a call beats DND in the reported reason, and both beat everything else', () => {
        expect(quiet({ inCall: true, dnd: true }).blocked).toBe('in-call');
    });

    it('friends-in-voice is never offered while you are in a call', () => {
        expect(evaluateNudge(snap({ friendsInVoice: VOICE, suppress: { dnd: false, inCall: true, screensharing: false, uiBusy: false } })).nudge).toBeNull();
        expect(nudgeStillTrue(snap({ friendsInVoice: VOICE, suppress: { dnd: false, inCall: true, screensharing: false, uiBusy: false } }), { kind: 'friends_in_voice', voice: VOICE })).toBe(false);
    });
});

describe('the off switch', () => {
    it('"Don\'t show these" silences everything, whatever is true', () => {
        const s = snap({
            state: withState({ off: true }),
            friends: { loaded: true, count: 0 }, servers: { loaded: true, count: 0 },
            pendingFriendJoined: [{ username: 'sam' }], friendsInVoice: VOICE, hasOwnMessage: false,
        });
        expect(evaluateNudge(s)).toEqual({ nudge: null, blocked: 'off' });
    });
    it('and not being signed in shows nothing', () => {
        expect(evaluateNudge(snap({ userId: null, friends: { loaded: true, count: 0 } })).blocked).toBe('no-account');
    });
});

describe('at most one per session and one per day', () => {
    const noFriends = (over: Partial<NudgeSnapshot>) => evaluateNudge(snap({ friends: { loaded: true, count: 0 }, ...over }));

    it('after one nudge in this app session, no more this session', () => {
        expect(noFriends({ shownThisSession: true })).toEqual({ nudge: null, blocked: 'already-this-session' });
    });

    it('recordShown stamps today; the same local day is blocked, the next day is open again', () => {
        const state = recordShown(defaultNudgeState(), 'no_server', NOW);
        expect(state.lastShownDay).toBe(localDayKey(NOW));
        expect(noFriends({ state })).toEqual({ nudge: null, blocked: 'already-today' });
        // Same day, much later in the evening: still blocked.
        expect(noFriends({ state, now: NOW + 5 * 3_600_000, activity: { focused: true, visible: true, lastInputAt: NOW + 5 * 3_600_000 - 1000, lastKeyAt: 0 } }).blocked).toBe('already-today');
        // Tomorrow: open (a different kind than the one shown yesterday).
        const tomorrow = NOW + DAY_MS;
        const r = noFriends({ state, now: tomorrow, activity: { focused: true, visible: true, lastInputAt: tomorrow - 1000, lastKeyAt: 0 } });
        expect(r.blocked).toBeNull();
        expect(r.nudge).toEqual({ kind: 'no_friends' });
    });

    it('a new app session starts with a grace period', () => {
        expect(noFriends({ sessionStartedAt: NOW - (SESSION_GRACE_MS - 1) }).blocked).toBe('session-grace');
        expect(noFriends({ sessionStartedAt: NOW - SESSION_GRACE_MS }).nudge).toEqual({ kind: 'no_friends' });
    });

    it('localDayKey is the user\'s own calendar day (not UTC)', () => {
        expect(localDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
        expect(localDayKey(new Date(2026, 0, 6, 0, 1).getTime())).toBe('2026-01-06');
    });
});

describe('not nagging: caps, retirement, repeat gap', () => {
    const noFriends = (state: NudgeState, now = NOW) => evaluateNudge(snap({
        now, state, friends: { loaded: true, count: 0 },
        activity: { focused: true, visible: true, lastInputAt: now - 1000, lastKeyAt: 0 },
    }));

    it('acting on / dismissing a standing nudge retires it for good', () => {
        const s = recordRetired(defaultNudgeState(), 'no_friends');
        expect(noFriends(s).nudge).toBeNull();
        expect(noFriends(s, NOW + 3 * DAY_MS).nudge).toBeNull();
    });

    it('event nudges are per-occurrence: dismissing one does not retire the kind', () => {
        const s = recordRetired(defaultNudgeState(), 'friend_joined');
        expect(s.kinds.friend_joined).toBeUndefined();
        const again = evaluateNudge(snap({ state: s, pendingFriendJoined: [{ username: 'ana' }] }));
        expect(again.nudge?.kind).toBe('friend_joined');
    });

    it('an ignored nudge returns no sooner than the repeat gap, and at most MAX_SHOWS times', () => {
        let s = recordShown(defaultNudgeState(), 'no_friends', NOW);
        // Next day: only 1 day later -> still too soon.
        expect(noFriends(s, NOW + DAY_MS).nudge).toBeNull();
        // After the gap: allowed.
        expect(noFriends(s, NOW + REPEAT_GAP_MS).nudge).toEqual({ kind: 'no_friends' });
        // Second show reaches the cap (2): never again.
        s = recordShown(s, 'no_friends', NOW + REPEAT_GAP_MS);
        expect(MAX_SHOWS.no_friends).toBe(2);
        expect(noFriends(s, NOW + 5 * REPEAT_GAP_MS).nudge).toBeNull();
    });
});

describe('withdrawing a card whose reason went away', () => {
    it('no_friends is no longer true once a friend exists', () => {
        expect(nudgeStillTrue(snap({ friends: { loaded: true, count: 1 } }), { kind: 'no_friends' })).toBe(false);
        expect(nudgeStillTrue(snap({ friends: { loaded: true, count: 0 } }), { kind: 'no_friends' })).toBe(true);
    });
    it('no_server / self_message likewise', () => {
        expect(nudgeStillTrue(snap({ servers: { loaded: true, count: 2 } }), { kind: 'no_server' })).toBe(false);
        expect(nudgeStillTrue(snap({ hasOwnMessage: true }), { kind: 'self_message' })).toBe(false);
        expect(nudgeStillTrue(snap({ hasOwnMessage: false }), { kind: 'self_message' })).toBe(true);
    });
    it('friends_in_voice only while they are still in THAT channel', () => {
        expect(nudgeStillTrue(snap({ friendsInVoice: VOICE }), { kind: 'friends_in_voice', voice: VOICE })).toBe(true);
        expect(nudgeStillTrue(snap({ friendsInVoice: null }), { kind: 'friends_in_voice', voice: VOICE })).toBe(false);
        expect(nudgeStillTrue(snap({ friendsInVoice: { ...VOICE, channelId: 'other' } }), { kind: 'friends_in_voice', voice: VOICE })).toBe(false);
    });
});

describe('gateReason is shared by the permission ask (limits are the only difference)', () => {
    it('limits off: week/session/day do not apply, but active / DND / call / busy still do', () => {
        const old = snap({ accountCreatedAt: NOW - 400 * DAY_MS, shownThisSession: true, state: recordShown(defaultNudgeState(), 'no_server', NOW) });
        expect(gateReason(old, { enforceLimits: false })).toBeNull();
        expect(gateReason(old, { enforceLimits: true })).toBe('outside-first-week');
        expect(gateReason({ ...old, suppress: { dnd: true, inCall: false, screensharing: false, uiBusy: false } }, { enforceLimits: false })).toBe('dnd');
        expect(gateReason({ ...old, state: withState({ off: true }) }, { enforceLimits: false })).toBe('off');
    });
});

describe('persisted state', () => {
    it('round-trips', () => {
        const s = recordRetired(recordShown(withState({ sentMessage: true, coachSaveDone: true }), 'no_server', NOW), 'no_server');
        expect(parseNudgeState(JSON.stringify(s))).toEqual(s);
    });
    it('garbage or missing -> a fresh default (nothing shown yet, switch on)', () => {
        for (const raw of [null, undefined, '', '{nope', '[]', '7', 'null']) {
            expect(parseNudgeState(raw as string)).toEqual(defaultNudgeState());
        }
    });
    it('keeps valid fields, drops invalid ones, ignores unknown kinds', () => {
        const p = parseNudgeState(JSON.stringify({
            off: 'yes', sentMessage: true, lastShownDay: 'yesterday',
            kinds: { no_friends: { shown: 1.9, lastShownAt: 5, retired: true }, bogus: { shown: 9 }, no_server: 'x' },
        }));
        expect(p.off).toBe(false);                 // only a real `true` turns it off
        expect(p.sentMessage).toBe(true);
        expect(p.lastShownDay).toBeNull();
        expect(p.kinds).toEqual({ no_friends: { shown: 1, lastShownAt: 5, retired: true } });
    });
});

describe('friends in voice: real presence only', () => {
    const base = {
        voiceParticipants: { c1: ['me', 'friendA', 'stranger'], c2: ['friendB'] } as Record<string, string[]>,
        huddleCalls: {} as Record<string, { participants: string[] }[]>,
        serverChannels: { s1: [{ channel_id: 'c1', name: 'Lounge' }, { channel_id: 'c2', name: 'Games' }] },
        servers: [{ server_id: 's1', name: 'Hangout' }],
        friendNames: new Map([['friendA', 'Sam'], ['friendB', 'Ana']]),
        myUserId: 'me',
        activeVoiceChannelId: null as string | null,
    };

    it('counts only friends, never yourself or strangers', () => {
        const v = deriveFriendsInVoice(base)!;
        expect(v).toMatchObject({ channelId: 'c1', channelName: 'Lounge', serverName: 'Hangout' });
        expect(v.names).toEqual(['Sam']);
    });
    it('prefers the channel with the most friends', () => {
        const v = deriveFriendsInVoice({ ...base, voiceParticipants: { c1: ['friendA'], c2: ['friendB', 'friendA'] } })!;
        expect(v.channelId).toBe('c2');
        expect(v.names.sort()).toEqual(['Ana', 'Sam']);
    });
    it('skips the channel you are already in', () => {
        const v = deriveFriendsInVoice({ ...base, activeVoiceChannelId: 'c1' })!;
        expect(v.channelId).toBe('c2');
        expect(deriveFriendsInVoice({ ...base, activeVoiceChannelId: 'c1', voiceParticipants: { c1: ['friendA'] } })).toBeNull();
    });
    it('includes Calls (huddle) channels', () => {
        const v = deriveFriendsInVoice({ ...base, voiceParticipants: {}, huddleCalls: { c2: [{ participants: ['friendB'] }] } })!;
        expect(v).toMatchObject({ channelId: 'c2', names: ['Ana'] });
    });
    it('fails closed on a channel it cannot name or attribute to a server', () => {
        expect(deriveFriendsInVoice({ ...base, voiceParticipants: { ghost: ['friendA'] } })).toBeNull();
        expect(deriveFriendsInVoice({ ...base, servers: [] })).toBeNull();
    });
    it('nobody there -> null, and the change key is stable', () => {
        expect(deriveFriendsInVoice({ ...base, voiceParticipants: { c1: ['me', 'stranger'] } })).toBeNull();
        expect(friendsInVoiceKey(null)).toBe('');
        expect(friendsInVoiceKey(VOICE)).toBe('ch1:1');
    });
});

describe('what counts as the user sending a message', () => {
    it('text, attachments and GIFs only', () => {
        for (const t of ['text', 'attachment', 'klipy_gif']) expect(isUserAuthoredContentType(t)).toBe(true);
        for (const t of ['edit', 'delete', 'reaction', 'call_key', 'system', 'read_receipt', undefined, null, '']) {
            expect(isUserAuthoredContentType(t as string)).toBe(false);
        }
    });
});
