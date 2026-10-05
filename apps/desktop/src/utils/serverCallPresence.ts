/**
 * Server-rail call presence — "is anyone in a call in this server right now,
 * and who?"
 *
 * The rail badge and its hover roster are a pure function of two things the
 * Dashboard already holds:
 *
 *   1. `voiceParticipants` — `Record<channel_id, user_id[]>`, seeded at app
 *      start from `GET /v1/voice-participants` and kept live by
 *      `channel:voice_state` WS events.
 *   2. `channelToServerId` — the channel → server index Dashboard already
 *      derives from `serverChannels`, which is loaded for every joined server
 *      on boot (so it covers servers you have not opened this session).
 *
 * Both of those inputs are ALREADY permission-filtered by the server, and that
 * is the whole security story for this feature:
 *
 *   - `broadcastVoiceState` sends `channel:voice_state` only to members that
 *     `PermissionsService.filterUsersWithChannelView` says can VIEW_CHANNEL, so
 *     a private voice channel never produces a live event for someone who
 *     cannot see it.
 *   - `GET /v1/voice-participants` drops such channels from the seed and omits
 *     the SERVER entirely when nothing in it is visible — deliberately not an
 *     empty `channels: []`, because "something is happening in here" is itself
 *     the metadata being withheld.
 *
 * So a channel the caller cannot see is simply absent from `voiceParticipants`,
 * and this module derives no badge for it. There is no client-side permission
 * check here on purpose: the client cannot re-derive what it was never sent,
 * and adding a mirror check here would invite someone to later treat it as the
 * enforcement point. This is presentation over already-safe data.
 *
 * The one judgement call this module does make is to FAIL CLOSED on an
 * unattributable channel: a participant list whose channel is not in the
 * supplied channel list yields no badge anywhere, rather than being guessed
 * onto a server or surfaced unattributed.
 *
 * Scope: BOTH kinds of live call.
 *
 *   - `kind='voice'` channels, via `voiceParticipants`.
 *   - `kind='huddle'` "Calls" channels, via `huddleCalls` — a map of huddle
 *     CHANNEL id → the calls currently running under it.
 *
 * Huddles are not an optional extra here; they are the ones that exist.
 * `servers.service.createServer` seeds every new server with a `kind='huddle'`
 * channel and no voice channel, and the client's create-channel UI offers text
 * and huddle only — so a badge derived from `voiceParticipants` alone never lit
 * for anybody. That was the bug. Huddle calls now come down the same
 * VIEW_CHANNEL-filtered seed, and the same permission story applies unchanged:
 * a Calls channel the caller cannot see contributes no calls to the seed, so it
 * contributes no badge here.
 */

/** One server's live call activity, as the rail needs it. */
export interface ServerCallPresence {
    serverId: string;
    /** Channels of this server that currently have someone in a call — voice
     *  channels and Calls (huddle) channels alike, each listed once however
     *  many calls are running inside it. */
    channelIds: string[];
    /** Distinct users across those channels, in first-seen order. */
    userIds: string[];
}

/** The shape `deriveServerCallPresence` needs from one huddle call.
 *  Structurally a subset of `useServers`' `HuddleCallInfo`, declared locally so
 *  this pure module does not reach into a React hook for a type. */
export interface HuddleCallLike {
    participants: string[];
}

/**
 * Group live call participants by server.
 *
 * Only servers with at least one occupied, attributable channel appear in the
 * result — so `map.has(serverId)` is exactly the "show a badge" predicate, and
 * a server with a call you cannot see is indistinguishable from a server with
 * no call at all.
 *
 * Users are de-duplicated across channels AND across the calls inside one Calls
 * channel: someone can only be in one call at a time, but a stale entry during
 * a hop must not make the badge count them twice.
 *
 * A huddle channel that has call rows but nobody in any of them is NOT presence
 * — it yields no entry, matching the empty-voice-channel rule directly above.
 */
export function deriveServerCallPresence(
    voiceParticipants: Record<string, string[]>,
    channelToServerId: Readonly<Record<string, string>>,
    huddleCalls: Readonly<Record<string, readonly HuddleCallLike[]>> = {},
): Map<string, ServerCallPresence> {
    const out = new Map<string, ServerCallPresence>();

    /** Add one occupied channel's participants under its server, or drop it
     *  entirely when the channel cannot be attributed to a server. */
    const add = (channelId: string, participants: readonly string[]) => {
        if (participants.length === 0) return;
        const serverId = channelToServerId[channelId];
        if (!serverId) return;                         // unattributable → fail closed

        let entry = out.get(serverId);
        if (!entry) {
            entry = { serverId, channelIds: [], userIds: [] };
            out.set(serverId, entry);
        }
        if (!entry.channelIds.includes(channelId)) entry.channelIds.push(channelId);
        for (const uid of participants) {
            if (!entry.userIds.includes(uid)) entry.userIds.push(uid);
        }
    };

    for (const [channelId, participants] of Object.entries(voiceParticipants)) {
        add(channelId, participants ?? []);
    }
    for (const [huddleId, calls] of Object.entries(huddleCalls)) {
        // Flatten every call under the Calls channel: the rail badges the
        // CHANNEL, not the individual call, and the hover roster answers "who
        // is in a call in this server" — which spans sibling calls.
        const occupants: string[] = [];
        for (const call of calls ?? []) {
            for (const uid of call?.participants ?? []) occupants.push(uid);
        }
        add(huddleId, occupants);
    }
    return out;
}

/** A roster capped for display, plus how many names did not fit. */
export interface CallRosterSummary<T> {
    shown: T[];
    overflow: number;
}

/**
 * Cap a hover roster to `max` entries.
 *
 * The tooltip sits against the screen edge on a rail that can hold many
 * servers, so an unbounded list is a real layout hazard — a busy 30-person
 * voice channel would produce a tooltip taller than the viewport.
 * `overflow > 0` is the caller's cue to render a "+N more" line.
 */
export function summarizeCallRoster<T>(entries: readonly T[], max: number): CallRosterSummary<T> {
    if (max <= 0) return { shown: [], overflow: entries.length };
    if (entries.length <= max) return { shown: [...entries], overflow: 0 };
    // Show max-1 real names so the "+N more" line is itself never the thing
    // that pushed a name out (showing 5 of 6 with "+1 more" reads as a bug).
    const keep = max - 1;
    return { shown: entries.slice(0, keep), overflow: entries.length - keep };
}

/**
 * The label shown for a call participant whose display name is not known.
 *
 * It should be rare, not gone: the name map is fed by BOTH the batched
 * `GET /v1/voice-participants` seed and, since the API started carrying it,
 * the `display_name` on every `channel:voice_state` / `huddle:participant`
 * JOIN event. This remains the honest answer for an id neither covered —
 * principally a client on a newer build talking to an API that predates the
 * event field, where the only names available are the ones the seed brought.
 * Showing a raw user id instead would be worse on every axis.
 */
export const UNKNOWN_CALL_PARTICIPANT = 'Someone';

/**
 * Fold a display name learned from a live JOIN event into the id → name map.
 *
 * Returns the SAME object reference when nothing changes, so a React
 * `setState` with this as the updater is a no-op re-render-wise for the
 * overwhelmingly common case (a name already known, or an older API that sent
 * none). `displayName` is optional precisely because of that older API — the
 * desktop app and the API roll separately.
 *
 * A later name wins over an earlier one: a server nickname change between the
 * boot seed and this join should be reflected, and the server resolves the
 * same `nickname ?? username ?? user_id` precedence used for the LiveKit
 * participant name, so the roster cannot disagree with the member list.
 */
export function mergeVoiceUserName(
    prev: Record<string, string>,
    userId: string,
    displayName?: string,
): Record<string, string> {
    if (!userId || !displayName) return prev;
    if (prev[userId] === displayName) return prev;
    return { ...prev, [userId]: displayName };
}

/**
 * Fold an AVATAR attachment id learned from a live JOIN event into the
 * id → avatar map. Same contract, same reference-stability rule and the same
 * optionality as `mergeVoiceUserName` above — see that docstring.
 *
 * ── Why this map exists at all ──────────────────────────────────────────────
 * Home's "Happening now" deck used to read participant avatars out of
 * `serverMemberAvatarMaps`, which `ServerContextPanel` fills only for the
 * server whose panel is mounted. A call in a server the user has not OPENED
 * this session therefore had no avatar id anywhere on the client, and the deck
 * rendered the colour placeholder for everyone in it — every time, forever.
 * That was never a caching problem: the id was never delivered.
 *
 * It is a separate map from `serverMemberAvatarMaps` rather than a write into
 * it because the two have different scopes: that one is per-server and
 * authoritative for a server you have open, this one is per-user, cross-server
 * and covers exactly the people currently in a call. The deck prefers the
 * per-server map and falls back to this one.
 */
export function mergeVoiceUserAvatarId(
    prev: Record<string, string>,
    userId: string,
    avatarId?: string,
): Record<string, string> {
    if (!userId || !avatarId) return prev;
    if (prev[userId] === avatarId) return prev;
    return { ...prev, [userId]: avatarId };
}

/** Map participant ids to display names, falling back to the neutral label. */
export function labelVoiceUsers(
    userIds: readonly string[],
    names: Record<string, string> | undefined,
): string[] {
    return userIds.map(uid => names?.[uid] ?? UNKNOWN_CALL_PARTICIPANT);
}
