/**
 * Who may POST a styled message here: the composer's mirror of the server
 * rule (UX only: the API enforces it, and readers enforce it again).
 *
 *  - DMs and group chats: anyone may style a message (no roles there).
 *  - Server channels: the user needs STYLE_MESSAGES in THIS channel (roles,
 *    category and channel overrides; ADMINISTRATOR / owner implicitly), and
 *    the server's "Message styles" setting must not be Off.
 *
 * Enforcement lives elsewhere, by design:
 *  - the API refuses a channel message with `styled: true` from a sender
 *    without STYLE_MESSAGES (channel-messages.service postMessage);
 *  - every reader drops a card style from a channel row whose server-checked
 *    `styled` flag is not true (shared gateCardStyleByFlag, at ingest), so a
 *    modified client's unflagged style renders plain for everyone.
 */
import { Permissions, type ServerMessageStyles } from '@cipherline/shared';

export interface CardStyleGateInput {
    /** A server channel (false in DMs / groups). */
    isServerChannel: boolean;
    /** The server's "Message styles" setting (null / undefined = on). */
    serverMessageStyles: ServerMessageStyles | null | undefined;
    /** The caller's resolved permissions in this channel (undefined = not loaded yet). */
    channelPermissions: bigint | undefined;
}

export interface CardStyleGate {
    allowed: boolean;
    /** Why not, for a disabled control or a tooltip. */
    reason?: string;
}

/** May the current user attach a card style to a message here? */
export function cardStylePostingGate(input: CardStyleGateInput): CardStyleGate {
    if (!input.isServerChannel) return { allowed: true };
    if (input.serverMessageStyles === 'off') return { allowed: false, reason: 'Message styles are turned off in this server' };
    // Strict while unknown, like MENTION_EVERYONE: a privileged action.
    if (input.channelPermissions === undefined) return { allowed: false, reason: 'Checking your permissions…' };
    if ((input.channelPermissions & Permissions.STYLE_MESSAGES) !== Permissions.STYLE_MESSAGES) {
        return { allowed: false, reason: 'You need the Style Messages permission in this channel' };
    }
    return { allowed: true };
}
