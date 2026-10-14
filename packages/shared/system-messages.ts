/**
 * Persistent system messages in a server channel (member joined / left / was
 * kicked / was banned).
 *
 * These are REAL rows in the channel's history (`channel_messages` with
 * `kind = 'system'`), not an ephemeral push: they are returned by
 * `GET /v1/channels/:cid/messages` in the same order as any other row, so a
 * member who was offline, a member who reloads, and the joiner themself all see
 * them. Docs: docs/system-messages.md.
 *
 * The server stores NO plaintext and NO names for them. A row carries only the
 * event and the user ids (metadata the server already holds in `server_members`
 * and the moderation audit log); clients render the CURRENT username from their
 * roster by id, and fall back to `FORMER_MEMBER_NAME` when the id is unknown or
 * the account was deleted (the FK is ON DELETE SET NULL, so a deleted user's id
 * arrives as null).
 *
 * Additive: nothing here changes an existing type.
 */

export const SYSTEM_MESSAGE_EVENTS = ['member_join', 'member_leave', 'member_kick', 'member_ban'] as const;
export type SystemMessageEvent = (typeof SYSTEM_MESSAGE_EVENTS)[number];

/** Shown in place of a name the client cannot resolve (unknown / deleted user). */
export const FORMER_MEMBER_NAME = 'A former member';
/** Shown in place of a moderator the client cannot resolve. */
export const A_MODERATOR_NAME = 'a moderator';

export function isSystemMessageEvent(v: unknown): v is SystemMessageEvent {
    return typeof v === 'string' && (SYSTEM_MESSAGE_EVENTS as readonly string[]).includes(v);
}

/**
 * The system-row variant of a channel history row, as returned by
 * `GET /v1/channels/:cid/messages?include_system=1`. The encrypted-payload
 * fields are null on these rows (and ONLY on these rows — a CHECK constraint
 * enforces `kind = 'system'` <=> payload null AND `system_event` non-null).
 * Regular rows carry `kind: 'message'` (older servers omit the field; treat a
 * missing `kind` as `'message'`).
 */
export interface SystemChannelHistoryRow {
    id: string;
    channel_id: string;
    kind: 'system';
    system_event: SystemMessageEvent;
    /** The user the event is about. Null once that account is deleted. */
    system_subject_user_id: string | null;
    /** The moderator who acted (kick / ban only). Null for join / leave, or once deleted. */
    system_actor_user_id: string | null;
    created_at: string;
    expires_at: string | null;
    sender_device_id: null;
    sender_user_id: null;
    sender_identity_pub_b64: '';
    epoch: null;
    nonce_b64: null;
    ciphertext_b64: null;
    signature_b64: null;
    reply_to_id: null;
    mentions_everyone: false;
    deleted: false;
}

/**
 * WebSocket `channel:system_message` payload — the live twin of the history row
 * above (same ids, same meaning). Sent to members who can VIEW_CHANNEL the
 * system channel. A client that is offline gets the row from history instead;
 * the two are de-duplicated by `message_id` === history `id`.
 */
export interface ChannelSystemMessageEvent {
    channel_id: string;
    server_id: string;
    message_id: string;
    kind: 'system';
    system_event: SystemMessageEvent;
    system_subject_user_id: string | null;
    system_actor_user_id: string | null;
    created_at: string;
}

/** Display text for a system row. Pass already-resolved names; a missing name
 *  falls back (`FORMER_MEMBER_NAME` for the subject, `A_MODERATOR_NAME` for the actor). */
export function systemMessageText(
    event: SystemMessageEvent,
    subjectName?: string | null,
    actorName?: string | null,
): string {
    const subject = subjectName && subjectName.trim() ? subjectName : FORMER_MEMBER_NAME;
    const actor = actorName && actorName.trim() ? actorName : A_MODERATOR_NAME;
    switch (event) {
        case 'member_join':  return `${subject} joined the server.`;
        case 'member_leave': return `${subject} left the server.`;
        case 'member_kick':  return `${subject} was kicked by ${actor}.`;
        case 'member_ban':   return `${subject} was banned by ${actor}.`;
    }
}
