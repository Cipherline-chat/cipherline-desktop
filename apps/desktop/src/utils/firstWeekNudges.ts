/**
 * firstWeekNudges — the pure rules behind the first-week, in-app-only nudges.
 *
 * The idea (owner, 2026-10-04): for the first 7 days of a new account, while
 * the person is actually using the app, offer ONE gentle, dismissible hint now
 * and then — about something that is really true of their account right now.
 * Never an email, never an OS notification, never a streak, never a made-up
 * count. A "Don't show these" switch (also in Settings → Notifications) ends
 * it for good.
 *
 * Everything that DECIDES lives here as pure functions of a snapshot so the
 * rules (priority, once-per-day, active-only, DND / in-call suppression, the
 * 7-day window, the off switch) are unit-testable without React, a DOM, or a
 * clock. The runtime that feeds the snapshot is hooks/useFirstWeekNudges.ts;
 * the card is components/FirstWeekNudges.tsx.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * Client-side only. The only thing persisted is a small counter blob per
 * account in secureLocalStore (encrypted at rest). Nothing here calls the
 * server, and nothing about what was shown leaves the device.
 *
 * ── Window ──────────────────────────────────────────────────────────────────
 * The 7 days run from the ACCOUNT's `created_at` (GET /auth/me already returns
 * it). That is what makes this safe by construction: an old account that
 * upgrades, or signs in on a new machine, is long past day 7 and sees nothing,
 * and nobody needs a migration or a "first seen" stamp. An account whose
 * created_at is missing or unparseable gets NO nudges (fail quiet).
 *
 * ── Hook for other features ─────────────────────────────────────────────────
 * Other code reports real events through `nudges.notify(...)` in
 * utils/nudgeBus.ts. This file only defines the event vocabulary.
 */

export const DAY_MS = 86_400_000;

/** How long after account creation nudges may appear. */
export const FIRST_WEEK_DAYS = 7;
/** "Recent input" — a keypress / click / scroll within this long counts as active. */
export const ACTIVE_INPUT_WINDOW_MS = 45_000;
/** Don't pop anything while the person is mid-sentence in the composer. */
export const TYPING_QUIET_MS = 4_000;
/** After the app starts (or a sign-in), leave people alone for this long. */
export const SESSION_GRACE_MS = 120_000;
/** A nudge nobody touched goes away on its own after this long. */
export const NUDGE_AUTO_HIDE_MS = 20_000;
/** The same nudge is not repeated sooner than this. */
export const REPEAT_GAP_MS = 2 * DAY_MS;
/** "Message yourself" only starts once an account is at least this old. */
export const SELF_MESSAGE_AFTER_DAYS = 2;
/** A pending notification ask expires if the moment passes. */
export const ASK_MAX_AGE_MS = 10 * 60_000;

/** The Official Cipherline server's public invite. */
export const OFFICIAL_SERVER_INVITE_CODE = 'zKKaUldlWXo';
export const OFFICIAL_SERVER_INVITE_URL = `https://cipherline.chat/invite/${OFFICIAL_SERVER_INVITE_CODE}`;

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type NudgeKind =
    | 'friend_joined'
    | 'friends_in_voice'
    | 'no_friends'
    | 'no_server'
    | 'self_message';

/**
 * Highest priority first. Event-driven and live-presence nudges beat the
 * "you haven't done X yet" ones: a friend who just arrived is more relevant
 * than a generic suggestion.
 */
export const NUDGE_PRIORITY: readonly NudgeKind[] = [
    'friend_joined',
    'friends_in_voice',
    'no_friends',
    'no_server',
    'self_message',
];

/** Kinds that are about a one-off occurrence rather than a standing condition. */
const EVENT_KINDS: ReadonlySet<NudgeKind> = new Set<NudgeKind>(['friend_joined', 'friends_in_voice']);

/** How many times each kind may ever be shown. */
export const MAX_SHOWS: Record<NudgeKind, number> = {
    friend_joined: 5,
    friends_in_voice: 3,
    no_friends: 2,
    no_server: 2,
    self_message: 2,
};

/** What the rest of the app can report (see nudgeBus.ts). */
export type NudgeEvent =
    /** Someone is now your friend / signed up through you. */
    | { kind: 'friend_joined'; username: string; userId?: string }
    /** The user just sent a friend request. */
    | { kind: 'friend_request_sent' }
    /** The user just shared an invite (referral link, server invite). */
    | { kind: 'invite_sent' }
    /** The user sent a real message of their own. */
    | { kind: 'message_sent' };

export interface FriendJoinedEvent { username: string; userId?: string }

/** Content types that count as "the user wrote something" — not edits, deletes,
 *  reactions, call keys or system rows. */
export function isUserAuthoredContentType(type: string | null | undefined): boolean {
    return type === 'text' || type === 'attachment' || type === 'klipy_gif';
}

export interface FriendsInVoice {
    channelId: string;
    channelName: string;
    serverId: string;
    serverName: string;
    /** Distinct friends in that channel (never includes you). */
    names: string[];
}

export type Nudge =
    | { kind: 'friend_joined'; username: string; userId?: string }
    | { kind: 'friends_in_voice'; voice: FriendsInVoice }
    | { kind: 'no_friends' }
    | { kind: 'no_server' }
    | { kind: 'self_message' };

// ── Persisted state ──────────────────────────────────────────────────────────

export interface KindRecord {
    shown: number;
    lastShownAt: number;
    /** Acted on or dismissed — never shown again. */
    retired: boolean;
}

export interface NudgeState {
    v: 1;
    /** "Don't show these". */
    off: boolean;
    /** Local calendar day (YYYY-MM-DD) a nudge was last shown. */
    lastShownDay: string | null;
    kinds: Partial<Record<NudgeKind, KindRecord>>;
    /** The user has sent at least one message from this account on this device. */
    sentMessage: boolean;
    /** The "save a message" coach mark has been shown (one time per account). */
    coachSaveDone: boolean;
}

export function defaultNudgeState(): NudgeState {
    return { v: 1, off: false, lastShownDay: null, kinds: {}, sentMessage: false, coachSaveDone: false };
}

const KIND_SET: ReadonlySet<string> = new Set<string>(NUDGE_PRIORITY);

/** Tolerant parse: anything unreadable becomes the default (nothing shown yet),
 *  anything half-valid keeps the fields that are valid. */
export function parseNudgeState(raw: string | null | undefined): NudgeState {
    const out = defaultNudgeState();
    if (!raw) return out;
    let p: unknown;
    try { p = JSON.parse(raw); } catch { return out; }
    if (!p || typeof p !== 'object') return out;
    const o = p as Record<string, unknown>;
    out.off = o.off === true;
    out.sentMessage = o.sentMessage === true;
    out.coachSaveDone = o.coachSaveDone === true;
    if (typeof o.lastShownDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.lastShownDay)) out.lastShownDay = o.lastShownDay;
    if (o.kinds && typeof o.kinds === 'object') {
        for (const [k, v] of Object.entries(o.kinds as Record<string, unknown>)) {
            if (!KIND_SET.has(k) || !v || typeof v !== 'object') continue;
            const r = v as Record<string, unknown>;
            out.kinds[k as NudgeKind] = {
                shown: typeof r.shown === 'number' && r.shown >= 0 ? Math.floor(r.shown) : 0,
                lastShownAt: typeof r.lastShownAt === 'number' ? r.lastShownAt : 0,
                retired: r.retired === true,
            };
        }
    }
    return out;
}

/** Local-calendar day key. Once-per-day is per the user's own clock, so
 *  "tomorrow" means tomorrow where they are. */
export function localDayKey(now: number): string {
    const d = new Date(now);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Record that `kind` was just shown. Pure — returns a new state. */
export function recordShown(state: NudgeState, kind: NudgeKind, now: number): NudgeState {
    const prev = state.kinds[kind] ?? { shown: 0, lastShownAt: 0, retired: false };
    return {
        ...state,
        lastShownDay: localDayKey(now),
        kinds: { ...state.kinds, [kind]: { ...prev, shown: prev.shown + 1, lastShownAt: now } },
    };
}

/** The user acted on or dismissed `kind`: stop offering it. Event kinds are
 *  per-occurrence (the next event is a new thing), so they are not retired. */
export function recordRetired(state: NudgeState, kind: NudgeKind): NudgeState {
    if (EVENT_KINDS.has(kind)) return state;
    const prev = state.kinds[kind] ?? { shown: 0, lastShownAt: 0, retired: false };
    return { ...state, kinds: { ...state.kinds, [kind]: { ...prev, retired: true } } };
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** Parse the server's created_at into ms, or null when unusable. */
export function parseCreatedAt(createdAt: string | number | null | undefined): number | null {
    if (createdAt == null || createdAt === '') return null;
    const ms = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
    return Number.isFinite(ms) ? ms : null;
}

/** In the first week of the account? Unknown creation time → no. A little
 *  clock-skew tolerance on the early side. */
export function isWithinFirstWeek(createdAtMs: number | null, now: number): boolean {
    if (createdAtMs == null) return false;
    const age = now - createdAtMs;
    return age >= -5 * 60_000 && age < FIRST_WEEK_DAYS * DAY_MS;
}

export function accountAgeDays(createdAtMs: number | null, now: number): number {
    if (createdAtMs == null) return 0;
    return Math.max(0, Math.floor((now - createdAtMs) / DAY_MS));
}

export interface ActivityInput {
    /** Window has OS focus. */
    focused: boolean;
    /** Document is visible (not minimised / on another desktop). */
    visible: boolean;
    /** ms timestamp of the last click / key / scroll, or 0. */
    lastInputAt: number;
    /** ms timestamp of the last KEY press, or 0 (typing). */
    lastKeyAt: number;
}

/** "Actively using the app": focused, visible, and touched recently. */
export function isUserActive(a: ActivityInput, now: number): boolean {
    return a.focused && a.visible && a.lastInputAt > 0 && now - a.lastInputAt <= ACTIVE_INPUT_WINDOW_MS;
}

export function isTyping(a: ActivityInput, now: number): boolean {
    return a.lastKeyAt > 0 && now - a.lastKeyAt < TYPING_QUIET_MS;
}

export interface SuppressInput {
    /** Manual / scheduled / auto Do Not Disturb, or status set to DND. */
    dnd: boolean;
    inCall: boolean;
    screensharing: boolean;
    /** A modal, first-run prompt, celebration or settings is up. */
    uiBusy: boolean;
}

export type BlockReason =
    | 'no-account'
    | 'off'
    | 'outside-first-week'
    | 'not-active'
    | 'typing'
    | 'dnd'
    | 'in-call'
    | 'screensharing'
    | 'ui-busy'
    | 'session-grace'
    | 'already-this-session'
    | 'already-today';

export interface NudgeSnapshot {
    now: number;
    userId: string | null;
    /** The account's server created_at, in ms (null when unknown). */
    accountCreatedAt: number | null;
    state: NudgeState;
    /** When this app session (Dashboard mount) started. */
    sessionStartedAt: number;
    /** A nudge has already been shown in this app session. */
    shownThisSession: boolean;
    activity: ActivityInput;
    suppress: SuppressInput;
    friends: { loaded: boolean; count: number };
    servers: { loaded: boolean; count: number };
    /** Best "friends are in a voice channel right now", or null. Real presence only. */
    friendsInVoice: FriendsInVoice | null;
    /** Friends who just arrived, oldest first (in-memory only). */
    pendingFriendJoined: readonly FriendJoinedEvent[];
    /** Any message of the user's own is known locally (this device or restored). */
    hasOwnMessage: boolean;
}

/**
 * The gates that apply to EVERYTHING (nudges and the permission asks differ
 * only in which of the last two — session/day limits — they honour).
 */
export function gateReason(s: NudgeSnapshot, opts: { enforceLimits: boolean }): BlockReason | null {
    if (!s.userId) return 'no-account';
    if (s.state.off) return 'off';
    if (!isUserActive(s.activity, s.now)) return 'not-active';
    if (isTyping(s.activity, s.now)) return 'typing';
    if (s.suppress.inCall) return 'in-call';
    if (s.suppress.screensharing) return 'screensharing';
    if (s.suppress.dnd) return 'dnd';
    if (s.suppress.uiBusy) return 'ui-busy';
    if (opts.enforceLimits) {
        if (!isWithinFirstWeek(s.accountCreatedAt, s.now)) return 'outside-first-week';
        if (s.now - s.sessionStartedAt < SESSION_GRACE_MS) return 'session-grace';
        if (s.shownThisSession) return 'already-this-session';
        if (s.state.lastShownDay === localDayKey(s.now)) return 'already-today';
    }
    return null;
}

/** May this kind still be offered (not retired, under its cap, not too soon)? */
function kindAvailable(s: NudgeSnapshot, kind: NudgeKind): boolean {
    const r = s.state.kinds[kind];
    if (!r) return true;
    if (r.retired) return false;
    if (r.shown >= MAX_SHOWS[kind]) return false;
    if (!EVENT_KINDS.has(kind) && r.lastShownAt > 0 && s.now - r.lastShownAt < REPEAT_GAP_MS) return false;
    return true;
}

/** Is `nudge` still true of the account right now? Used to withdraw a card
 *  whose reason went away while it was on screen ("invite a friend" after the
 *  friend request was just accepted). Gates are NOT re-checked here. */
export function nudgeStillTrue(s: NudgeSnapshot, nudge: Nudge): boolean {
    switch (nudge.kind) {
        case 'friend_joined': return true; // it already happened
        case 'friends_in_voice': return !!s.friendsInVoice && s.friendsInVoice.channelId === nudge.voice.channelId && !s.suppress.inCall;
        case 'no_friends': return s.friends.loaded && s.friends.count === 0;
        case 'no_server': return s.servers.loaded && s.servers.count === 0;
        case 'self_message': return !s.state.sentMessage && !s.hasOwnMessage;
    }
}

export interface Evaluation {
    nudge: Nudge | null;
    blocked: BlockReason | null;
}

/**
 * The one decision: what (if anything) to show right now. Pure.
 *
 * Order: gates first (so a blocked moment reports WHY), then the priority list.
 * Every candidate is built only from real state in the snapshot — there is no
 * branch that invents a number or a name.
 */
export function evaluateNudge(s: NudgeSnapshot): Evaluation {
    const blocked = gateReason(s, { enforceLimits: true });
    if (blocked) return { nudge: null, blocked };

    for (const kind of NUDGE_PRIORITY) {
        if (!kindAvailable(s, kind)) continue;
        switch (kind) {
            case 'friend_joined': {
                const ev = s.pendingFriendJoined[0];
                if (ev && ev.username) return { nudge: { kind, username: ev.username, userId: ev.userId }, blocked: null };
                break;
            }
            case 'friends_in_voice': {
                if (s.friendsInVoice && s.friendsInVoice.names.length > 0 && !s.suppress.inCall) {
                    return { nudge: { kind, voice: s.friendsInVoice }, blocked: null };
                }
                break;
            }
            case 'no_friends':
                if (s.friends.loaded && s.friends.count === 0) return { nudge: { kind }, blocked: null };
                break;
            case 'no_server':
                if (s.servers.loaded && s.servers.count === 0) return { nudge: { kind }, blocked: null };
                break;
            case 'self_message':
                if (accountAgeDays(s.accountCreatedAt, s.now) >= SELF_MESSAGE_AFTER_DAYS
                    && !s.state.sentMessage && !s.hasOwnMessage) {
                    return { nudge: { kind }, blocked: null };
                }
                break;
        }
    }
    return { nudge: null, blocked: null };
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export interface NudgeCopy {
    title: string;
    body: string;
    /** The primary button. */
    action: string;
}

/** Short, friendly, in the app's voice. */
export function nudgeCopy(n: Nudge): NudgeCopy {
    switch (n.kind) {
        case 'friend_joined':
            return {
                title: `${n.username} is here`,
                body: 'Say hi. It’s encrypted from the first message.',
                action: 'Say hi',
            };
        case 'friends_in_voice': {
            const { names, channelName } = n.voice;
            const title = names.length === 1
                ? `${names[0]} is in ${channelName}`
                : `${names.length} friends are in ${channelName}`;
            return { title, body: 'Hop in?', action: 'Take a look' };
        }
        case 'no_friends':
            return {
                title: 'Cipherline’s better with your people',
                body: 'Invite a friend. One link is all it takes.',
                action: 'Copy invite link',
            };
        case 'no_server':
            return {
                title: 'Peek at the Cipherline server',
                body: 'Updates, questions and good company. Join if you like, or not.',
                action: 'Take a look',
            };
        case 'self_message':
            return {
                title: 'Try it out',
                body: 'Message yourself to see how it feels. Nobody else needed.',
                action: 'Message yourself',
            };
    }
}

// ── Friends in voice (real presence only) ────────────────────────────────────

export interface FriendsInVoiceInput {
    /** channel_id → user ids in that voice channel (already permission-filtered by the server). */
    voiceParticipants: Readonly<Record<string, readonly string[]>>;
    /** Calls channel id → live calls under it. */
    huddleCalls: Readonly<Record<string, ReadonlyArray<{ participants: readonly string[] }>>>;
    /** server_id → its channels (to name them). */
    serverChannels: Readonly<Record<string, ReadonlyArray<{ channel_id: string; name: string }>>>;
    servers: ReadonlyArray<{ server_id: string; name: string }>;
    /** Accepted friends: user_id → display name. */
    friendNames: ReadonlyMap<string, string>;
    myUserId: string | null;
    /** The voice channel you are already in, if any. */
    activeVoiceChannelId: string | null;
}

/**
 * The channel with the most of YOUR FRIENDS in it right now, or null.
 *
 * Everything it reads is already filtered server-side to channels the caller
 * can see (see serverCallPresence.ts); this adds no permission logic and fails
 * closed on a channel it cannot name or attribute to a server. A channel you
 * are in yourself is skipped — nobody needs "hop in?" for where they already
 * are. Ties go to the first channel seen, which is stable for a given input.
 */
export function deriveFriendsInVoice(i: FriendsInVoiceInput): FriendsInVoice | null {
    const nameOfChannel = new Map<string, { channelName: string; serverId: string }>();
    for (const [serverId, chans] of Object.entries(i.serverChannels)) {
        for (const c of chans ?? []) nameOfChannel.set(c.channel_id, { channelName: c.name, serverId });
    }
    const serverName = new Map(i.servers.map(s => [s.server_id, s.name] as const));

    const occupancy = new Map<string, Set<string>>();
    const add = (channelId: string, uid: string) => {
        if (!uid || uid === i.myUserId) return;
        if (!i.friendNames.has(uid)) return;
        let set = occupancy.get(channelId);
        if (!set) { set = new Set(); occupancy.set(channelId, set); }
        set.add(uid);
    };
    for (const [channelId, uids] of Object.entries(i.voiceParticipants)) {
        for (const uid of uids ?? []) add(channelId, uid);
    }
    for (const [channelId, calls] of Object.entries(i.huddleCalls)) {
        for (const call of calls ?? []) for (const uid of call?.participants ?? []) add(channelId, uid);
    }

    let best: FriendsInVoice | null = null;
    for (const [channelId, uids] of occupancy) {
        if (channelId === i.activeVoiceChannelId) continue;
        const meta = nameOfChannel.get(channelId);
        if (!meta) continue;                       // unattributable → fail closed
        const sName = serverName.get(meta.serverId);
        if (!sName) continue;
        if (best && uids.size <= best.names.length) continue;
        best = {
            channelId,
            channelName: meta.channelName,
            serverId: meta.serverId,
            serverName: sName,
            names: [...uids].map(u => i.friendNames.get(u) as string),
        };
    }
    return best;
}

/** A stable string for "is this the same friends-in-voice situation", so the
 *  engine can re-evaluate on a CHANGE without re-rendering on every poll. */
export function friendsInVoiceKey(v: FriendsInVoice | null): string {
    return v ? `${v.channelId}:${v.names.length}` : '';
}
