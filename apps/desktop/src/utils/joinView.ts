/**
 * Instant join, part 2 — WHERE the joining user is shown (owner feedback on
 * the first version, which put a separate "you" row at the top of the panel):
 *
 *   "put me in the call with everyone else if there's people already in it,
 *    then just do the connecting animation at the bottom call controls. And if
 *    it's a new call, create the call for me client side and then once it
 *    connects of course everyone will see me in the call."
 *
 * So the joining user is rendered inside the call view itself:
 *   - a Calls-channel (huddle) call's view is its card in the huddle list —
 *     `displayHuddleCalls` puts you into that call's participant list (or, for
 *     a call you are starting, a client-side call card with just you in it);
 *   - a DM / group / legacy voice call's view is SidebarConference, mirrored
 *     before the room exists by call/JoiningCallView.tsx from a JoinView.
 *
 * All of it is LOCAL display. Nothing is sent anywhere earlier than before:
 * other people see you when the server join lands, exactly as before.
 */
import type { HuddleCallInfo } from '../hooks/useServers';

/** Someone already in the call, as the joining view shows them. */
export interface JoinPeer {
    userId: string;
    /** The name the call will show (LiveKit participant name: nickname ?? username for server calls, username for DMs). */
    name: string;
    avatarId: string | null;
    roleColor?: string;
}

export type JoinView =
    /** Calls channel. callId null = starting a new call (spawn). */
    | {
        kind: 'huddle';
        huddleId: string;
        callId: string | null;
        /** Stable React key for the card, kept for the call's life so a
         *  client-side card becoming the real one never remounts. */
        renderKey: string;
        /** Spawn: filled in when the spawn request returns. */
        realCallId?: string;
        realName?: string;
        /** Spawn: the client's best guess at the name until the server's lands. */
        predictedName?: string;
        spawnedAt: string;
    }
    /** Legacy voice channel — peers come from live voice presence at render time. */
    | { kind: 'voice'; channelId: string; serverId: string | null }
    /** DM / group call. */
    | {
        kind: 'dm';
        peers: JoinPeer[];
        ringing: { title: string; avatarId: string | null; userId: string | null; isGroup: boolean } | null;
    };

export const PENDING_CALL_KEY_PREFIX = 'joining:';

/** A huddle call row with an optional stable render key (see JoinView.renderKey). */
export type DisplayHuddleCall = HuddleCallInfo & { render_key?: string };

function withMe(participants: string[], me: string): string[] {
    return participants.includes(me) ? participants : [...participants, me];
}

/**
 * The huddle call lists as this client should DRAW them: the server's lists,
 * plus you, in the call you are joining or in.
 *
 * - Joining an existing call: you are appended to its participant list — the
 *   position the server's own join event will put you in (it appends), so
 *   nothing moves when that event lands.
 * - Starting a call: until the server's call shows up, a client-side card for
 *   it (just you, newest — where a spawned call sorts). It keeps one React
 *   key (`render_key`) from the click to the end of the call, so the
 *   client-side card BECOMES the real one rather than being swapped for it.
 * - In a call: you stay listed in it even if a server event lags (your own
 *   state is authoritative for "am I in this call" on this device).
 *
 * `mineCallId` is the call to draw as yours (isMine styling, Leave on the card).
 */
export function displayHuddleCalls(
    calls: Record<string, HuddleCallInfo[]>,
    view: JoinView | null,
    me: string | null,
    activeHuddleCallId: string | null,
): { calls: Record<string, DisplayHuddleCall[]>; mineCallId: string | null } {
    const r = withJoiningUser(calls, view, me, activeHuddleCallId);
    return { calls: dropEmptyCalls(r.calls), mineCallId: r.mineCallId };
}

/**
 * A call nobody is in is not drawn — anywhere. Owner rule (2026-10-08): "If
 * there is not a call / it has nobody in it, it should never show that there
 * is one." The server stopped returning empty calls and destroys them, but the
 * client can still hold one briefly (the last participant's leave event lands
 * before the destroy event, or a call row arrives from an older API). The call
 * you are in or joining always has you in it (withJoiningUser), so it is never
 * dropped. Returns the same object when nothing is dropped.
 */
export function dropEmptyCalls<T extends { participants: string[] }>(
    calls: Record<string, T[]>,
): Record<string, T[]> {
    let changed = false;
    const out: Record<string, T[]> = {};
    for (const [hid, list] of Object.entries(calls)) {
        const kept = list.filter(c => c.participants.length > 0);
        if (kept.length !== list.length) changed = true;
        out[hid] = kept.length === list.length ? list : kept;
    }
    return changed ? out : calls;
}

/**
 * Take `userId` out of one call's participant list (a local leave). Same
 * object back when they were not in it, so a setState updater is a no-op.
 */
export function removeParticipantFromCall<T extends { call_id: string; participants: string[] }>(
    calls: Record<string, T[]>,
    callId: string,
    userId: string,
): Record<string, T[]> {
    for (const [hid, list] of Object.entries(calls)) {
        const idx = list.findIndex(c => c.call_id === callId);
        if (idx === -1) continue;
        const call = list[idx];
        if (!call.participants.includes(userId)) return calls;
        const next = list.slice();
        next[idx] = { ...call, participants: call.participants.filter(u => u !== userId) };
        return { ...calls, [hid]: next };
    }
    return calls;
}

function withJoiningUser(
    calls: Record<string, HuddleCallInfo[]>,
    view: JoinView | null,
    me: string | null,
    activeHuddleCallId: string | null,
): { calls: Record<string, DisplayHuddleCall[]>; mineCallId: string | null } {
    if (!me) return { calls, mineCallId: activeHuddleCallId };
    const huddleView = view?.kind === 'huddle' ? view : null;
    const targetId = huddleView ? (huddleView.callId ?? huddleView.realCallId ?? huddleView.renderKey) : null;
    const mineCallId = targetId ?? activeHuddleCallId;
    if (!mineCallId) return { calls, mineCallId: null };

    let changed = false;
    const out: Record<string, DisplayHuddleCall[]> = {};
    for (const [hid, list] of Object.entries(calls)) {
        out[hid] = list.map(c => {
            if (c.call_id !== mineCallId) return c;
            const participants = withMe(c.participants, me);
            const renderKey = huddleView && huddleView.callId === null && huddleView.realCallId === c.call_id
                ? huddleView.renderKey : undefined;
            if (participants === c.participants && !renderKey) return c;
            changed = true;
            return { ...c, participants, ...(renderKey ? { render_key: renderKey } : {}) };
        });
    }

    // A call being started that the server's list doesn't have yet.
    if (huddleView && huddleView.callId === null) {
        const list = out[huddleView.huddleId] ?? [];
        if (!list.some(c => c.call_id === mineCallId)) {
            changed = true;
            out[huddleView.huddleId] = [...list, {
                call_id: mineCallId,
                huddle_id: huddleView.huddleId,
                name: huddleView.realName ?? huddleView.predictedName ?? '',
                // Not "you" until the server has the call: owner-only actions
                // (rename) on a call that does not exist yet could only fail.
                spawner_user_id: huddleView.realCallId ? me : '',
                spawned_at: huddleView.spawnedAt,
                participants: [me],
                render_key: huddleView.renderKey,
            }];
        }
    }
    return { calls: changed ? out : calls, mineCallId };
}

/**
 * Legacy voice channel: everyone voice presence says is in the channel, minus
 * you (you are drawn first, as SidebarConference draws the local participant),
 * in the server's order.
 */
export function voiceJoinPeers(
    participantIds: string[] | undefined,
    me: string | null,
    lookup: (uid: string) => { name: string; avatarId: string | null; roleColor?: string },
): JoinPeer[] {
    return (participantIds ?? []).filter(uid => uid !== me).map(uid => ({ userId: uid, ...lookup(uid) }));
}
