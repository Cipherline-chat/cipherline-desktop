/**
 * START_CALLS — who may START a new call in a Calls channel (UX mirror only).
 *
 * The server is the authority: `POST /huddles/:hid/calls` (and a moderator's
 * move onto an EMPTY Calls channel, which spawns one) needs VIEW_CHANNEL +
 * CONNECT + START_CALLS, and refuses otherwise with
 *   403 { code: 'missing_permission', permission: 'START_CALLS', message }
 * Joining a call that is already running needs only CONNECT, so a member
 * without START_CALLS still gets every running call's Join affordance.
 *
 * Everything here only decides what the UI offers. Nothing load-bearing: an
 * older or modified client that skips these checks is refused by the server.
 *
 * Source of truth for the UI: the channel list's per-Calls-channel
 * `can_start_call` boolean. It is deliberately NOT derived from the
 * START_CALLS bit in `my_permissions` alone: an API that predates the bit
 * (desktop builds can reach an older API — staging builds talk to an API that
 * tracks main) never sets it, and reading "bit absent" as "denied" would grey
 * out Start for every member there. No `can_start_call` field = older API =
 * the old rule (starting needs only VIEW_CHANNEL + CONNECT).
 */
import { Permissions } from '@cipherline/shared';

/** Shown on the disabled "start a call" affordances, and on a refused start. */
export const START_CALLS_DENIED_MESSAGE = "You don't have permission to start calls here";

/** The fields of a channel-list row this module reads. */
export interface StartCallsChannelFields {
    my_permissions?: string | null;
    /** Present (Calls channels only) from an API that knows START_CALLS. */
    can_start_call?: boolean;
}

const ACCESS = Permissions.VIEW_CHANNEL | Permissions.CONNECT;

function parseBits(s: string | null | undefined): bigint | undefined {
    if (!s) return undefined;
    try { return BigInt(s); } catch { return undefined; }
}

/** Can the user JOIN calls in this channel (VIEW_CHANNEL + CONNECT)?
 *  Not-yet-loaded is optimistic, matching the panel's existing check. */
function canJoinCallsIn(ch: StartCallsChannelFields | undefined): boolean {
    const bits = parseBits(ch?.my_permissions);
    if (bits === undefined) return true;
    return (bits & ACCESS) === ACCESS;
}

/**
 * May the user START a new call in this Calls channel?
 *  - `can_start_call` present → it (the server resolved it, overrides and all);
 *  - absent → older API → the old rule: same as being able to join;
 *  - channel / permissions not loaded → optimistic (the server still decides).
 */
export function canStartCallsIn(ch: StartCallsChannelFields | undefined): boolean {
    if (!ch) return true;
    if (typeof ch.can_start_call === 'boolean') return ch.can_start_call;
    return canJoinCallsIn(ch);
}

/**
 * Join-only: can connect (so the running calls are joinable) but may not
 * start one. This is the state that gets the disabled start button + tooltip,
 * rather than the general "no permission to connect" lock.
 */
export function isJoinOnlyIn(ch: StartCallsChannelFields | undefined): boolean {
    if (!ch || parseBits(ch.my_permissions) === undefined) return false;
    return canJoinCallsIn(ch) && !canStartCallsIn(ch);
}

interface HttpishError {
    response?: { status?: number; data?: unknown };
}

/** Is this the server's "you may not start calls here" 403? */
export function isStartCallsDenied(err: unknown): boolean {
    const r = (err as HttpishError | null | undefined)?.response;
    if (r?.status !== 403) return false;
    const d = r.data as { code?: unknown; permission?: unknown } | null | undefined;
    return d?.code === 'missing_permission' && d?.permission === 'START_CALLS';
}
