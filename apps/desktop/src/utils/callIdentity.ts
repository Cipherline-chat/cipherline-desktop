/**
 * Name + avatar resolution for people in the call the local user is IN,
 * independent of which server or DM is currently open.
 *
 * The floating call card (shown while the user is viewing anything other than
 * the call's server) used to read only the accepted-friends list, so anyone in
 * the call who was not a friend rendered as "Member" with no avatar - even
 * though the live JOIN event (`voiceUserNames` / `voiceUserAvatarIds` in
 * Dashboard) had already delivered both. Precedence mirrors the server's
 * LiveKit participant name: nickname, then username, then friend username.
 */
export interface CallIdentitySources {
    /** Server nicknames (flat id -> nickname), as ServerContextPanel reports them. */
    nicknames?: Record<string, string>;
    /** Cross-server id -> display name from the voice seed + live JOIN events. */
    voiceNames?: Record<string, string>;
    /** Per-server id -> avatar attachment id for the CALL's server (only filled once its panel mounted). */
    serverAvatars?: Record<string, string | null>;
    /** Cross-server id -> avatar attachment id from the voice seed + live JOIN events. */
    voiceAvatars?: Record<string, string>;
    /** Accepted friends: last-resort name/avatar. */
    friends?: Record<string, { username: string; avatar_url: string | null }>;
}

export type CallIdentity = { username: string; avatar_url: string | null };

export function buildCallIdentityMap(
    ids: readonly string[],
    s: CallIdentitySources,
): Record<string, CallIdentity> {
    const out: Record<string, CallIdentity> = {};
    for (const id of ids) {
        const friend = s.friends?.[id];
        const username = s.nicknames?.[id] || s.voiceNames?.[id] || friend?.username;
        if (!username) continue;
        out[id] = {
            username,
            avatar_url: s.serverAvatars?.[id] || s.voiceAvatars?.[id] || friend?.avatar_url || null,
        };
    }
    return out;
}

/** Ids from `ids` (other than `selfId`) with no resolvable display name in any source. */
export function unresolvedCallParticipants(
    ids: readonly string[],
    selfId: string | null | undefined,
    s: CallIdentitySources,
): string[] {
    return ids.filter(id => id !== selfId && !(s.nicknames?.[id] || s.voiceNames?.[id] || s.friends?.[id]?.username));
}
