/**
 * Voice / Calls-channel JOIN gate (UX mirror only).
 *
 * The server is the authority: `POST /channels/:cid/join_voice` and the
 * huddle-call join need VIEW_CHANNEL + CONNECT (resolved with overrides) and
 * refuse otherwise. A member who can SEE a live call (the server's presence
 * fan-out is VIEW_CHANNEL-filtered) but lacks CONNECT must not be offered a
 * Join that can only 403. This module decides what the UI offers; nothing
 * here is load-bearing, a client that skips it is refused by the server.
 *
 * Source: the channel list row's `my_permissions` (decimal bigint string the
 * API resolves per channel, already cached client-side). Not yet loaded or
 * unparsable is OPTIMISTIC (true), matching ServerContextPanel.canConnect, so a
 * cold cache never hides a Join the user is entitled to. Video / screen share
 * entitlements do not block an audio join and are not considered here.
 */
import { Permissions } from '@cipherline/shared';

/** Shown instead of attempting a join the server would refuse. */
export const VOICE_JOIN_DENIED_MESSAGE = "You don't have permission to join this voice channel";

export interface VoiceJoinChannelFields {
    my_permissions?: string | null;
}

const NEEDED = Permissions.VIEW_CHANNEL | Permissions.CONNECT;

/** May the current user join a call in this channel? */
export function canJoinVoice(ch: VoiceJoinChannelFields | null | undefined): boolean {
    const raw = ch?.my_permissions;
    if (!raw) return true;
    let bits: bigint;
    try { bits = BigInt(raw); } catch { return true; }
    return (bits & NEEDED) === NEEDED;
}
