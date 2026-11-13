/**
 * The call roster of a moved-in guest: a member a moderator dragged into a call
 * whose channel they cannot see (HuddlesService "Moved-in guests").
 *
 * Why this needs its own handling. Every other participant's `huddleCalls` entry
 * comes from the boot seed (`GET /v1/voice-participants`) or the per-channel
 * auto-load, and both only cover channels the viewer can SEE. A guest's channel
 * is in neither, and `applyHuddleParticipant` drops events for a channel with no
 * bucket, so the guest had no row for the call they were in: the floating call
 * card fell back to `[self]` and everyone else was missing from it.
 *
 * The server already allows exactly this read: `GET /v1/huddles/:hid/calls`
 * answers a guest with the ONE call they are a guest of, and refuses them again
 * as soon as they are out of it. So the guest's client keeps one row, for that
 * call, for as long as it is in it:
 *   - fetched when the guest call becomes active, and again whenever the
 *     presence seed runs (boot, reconnect, the reconcile tick);
 *   - carried across the seed, which REPLACES the map and never contains it;
 *   - dropped when the guest is out of the call, because the server stops
 *     sending that call's events at that moment and a kept row would go stale.
 *
 * Other views (rail badge, Home deck, friends' activity, nudges) skip a channel
 * they cannot attribute, so this row never surfaces anywhere but the call card.
 */
import type { HuddleCallInfo } from '../hooks/useServers';

export interface GuestCallRef {
    callId: string;
    huddleId: string;
}

type CallMap = Record<string, HuddleCallInfo[]>;

/** The presence seed's map, with the guest's own row carried over from `prev`. */
export function keepGuestCallInSnapshot(next: CallMap, prev: CallMap, guest: GuestCallRef | null): CallMap {
    if (!guest) return next;
    if (next[guest.huddleId]?.some(c => c.call_id === guest.callId)) return next;
    const row = prev[guest.huddleId]?.find(c => c.call_id === guest.callId);
    if (!row) return next;
    return { ...next, [guest.huddleId]: [...(next[guest.huddleId] ?? []), row] };
}

/**
 * Fold the answer of `GET /huddles/:hid/calls` into the map: THIS call's row and
 * nothing else from the response. Same object back when the call is not in it.
 */
export function mergeGuestCallRoster(calls: CallMap, guest: GuestCallRef, rows: readonly HuddleCallInfo[]): CallMap {
    const row = rows.find(r => r.call_id === guest.callId);
    if (!row) return calls;
    const bucket = calls[guest.huddleId] ?? [];
    const next = bucket.some(c => c.call_id === guest.callId)
        ? bucket.map(c => (c.call_id === guest.callId ? row : c))
        : [...bucket, row];
    return { ...calls, [guest.huddleId]: next };
}

/** Forget the guest's call. The bucket goes too when that was all it held. */
export function dropGuestCall(calls: CallMap, guest: GuestCallRef): CallMap {
    const bucket = calls[guest.huddleId];
    if (!bucket?.some(c => c.call_id === guest.callId)) return calls;
    const rest = bucket.filter(c => c.call_id !== guest.callId);
    const next = { ...calls };
    if (rest.length > 0) next[guest.huddleId] = rest;
    else delete next[guest.huddleId];
    return next;
}

export interface GuestCallIdentity {
    userId: string;
    name: string;
    avatarId?: string;
}

/**
 * Names for people already in the call when the guest arrived. They get no JOIN
 * event for those people, and the seed's `users` omits a channel they cannot
 * see, so the names come from the server's member list, which any member can
 * read. Same precedence as the LiveKit participant name: nickname, then username.
 */
export function guestRosterIdentities(
    ids: readonly string[],
    members: ReadonlyArray<{ user_id: string; username: string; nickname: string | null; avatar_url: string | null }>,
): GuestCallIdentity[] {
    const byId = new Map(members.map(m => [m.user_id, m]));
    const out: GuestCallIdentity[] = [];
    for (const id of ids) {
        const m = byId.get(id);
        const name = m?.nickname || m?.username;
        if (!name) continue;
        out.push({ userId: id, name, ...(m?.avatar_url ? { avatarId: m.avatar_url } : {}) });
    }
    return out;
}
