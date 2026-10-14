/**
 * callMemberDisconnect - the moderator side of "Disconnect" in a call
 * participant's right-click menu.
 *
 * Kept out of the components so the three promises it makes are testable
 * without mounting a 7k-line panel:
 *
 *  - the item is offered only to someone holding MANAGE_CALL_MEMBERS (or
 *    ADMINISTRATOR), never on yourself, and only for someone who is actually in
 *    a call (a UX mirror - the server re-checks the permission and the role
 *    hierarchy, and is the only thing that counts);
 *  - it asks first, in the same words everywhere ("Disconnect <name> from the
 *    call?");
 *  - it hits the right endpoint for a Calls-channel call vs a legacy voice
 *    channel, and a rejection is explained in the server's own words.
 */

import { Permissions, hasPermission } from '@cipherline/shared';
import { apiPath } from './apiPath';

export type DisconnectTarget =
    | { kind: 'huddle'; callId: string }
    | { kind: 'voice'; channelId: string };

/** MANAGE_CALL_MEMBERS (move + disconnect), or the ADMINISTRATOR trump card. */
export function hasManageCallMembers(perms: bigint): boolean {
    return hasPermission(perms, Permissions.MANAGE_CALL_MEMBERS) || hasPermission(perms, Permissions.ADMINISTRATOR);
}

/** MODERATE_CALL_MEDIA (server mute / deafen / disable video / disable screen
 *  share), or ADMINISTRATOR. One bit for all four controls. */
export function hasModerateCallMedia(perms: bigint): boolean {
    return hasPermission(perms, Permissions.MODERATE_CALL_MEDIA) || hasPermission(perms, Permissions.ADMINISTRATOR);
}

export interface OfferDisconnectInput {
    canManageCallMembers: boolean;
    targetUserId: string;
    selfUserId: string | null | undefined;
    /** The target is listed in a call we can address. */
    targetInCall: boolean;
}

/** Should the menu show "Disconnect" for this participant? */
export function canOfferDisconnect(i: OfferDisconnectInput): boolean {
    if (!i.canManageCallMembers) return false;
    if (!i.targetInCall) return false;
    // Not on yourself: use Leave. (The server refuses it too.)
    if (!i.selfUserId || i.targetUserId === i.selfUserId) return false;
    return true;
}

/** The confirmation copy - one wording for every surface. */
export function disconnectConfirmCopy(displayName: string): { title: string; message: string; confirmLabel: string } {
    const name = displayName.trim() || 'this member';
    return {
        title: `Disconnect ${name}?`,
        message: `Disconnect ${name} from the call?`,
        confirmLabel: 'Disconnect',
    };
}

/** Where to POST. */
export function disconnectPath(target: DisconnectTarget, userId: string): string {
    return target.kind === 'huddle'
        ? apiPath`/huddles/calls/${target.callId}/participants/${userId}/disconnect`
        : apiPath`/channels/${target.channelId}/participants/${userId}/disconnect`;
}

/** Minimal axios-shaped poster, so tests need no HTTP. */
export type PostFn = (url: string, body: object, config: { headers: Record<string, string>; timeout: number }) => Promise<unknown>;

export async function requestDisconnect(
    post: PostFn,
    apiBase: string,
    token: string,
    target: DisconnectTarget,
    userId: string,
): Promise<void> {
    await post(apiBase + disconnectPath(target, userId), {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
    });
}

/** The toast for a rejected disconnect: the server's reason when it gave one. */
export function disconnectErrorToast(err: unknown): { kind: 'error'; title: string; message: string } {
    const msg = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
    return {
        kind: 'error',
        title: "Couldn't disconnect them",
        message: typeof msg === 'string' && msg
            ? msg
            : 'The request was rejected - they may have left the call already.',
    };
}
