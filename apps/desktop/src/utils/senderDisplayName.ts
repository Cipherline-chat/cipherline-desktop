/**
 * The name a message is shown under: server nickname (in a server channel),
 * else the username for the sender's USER id, else (no user id only) the
 * device's owner, else "You" / "Unknown User".
 *
 * F4: the user id (signed, sender-trust-checked) names the sender; the device
 * id is the sender's own claim and only a fallback when there is no user id,
 * so a group member cannot appear under another member's name.
 *
 * One function for the message header and the reply quote (owner, 2026-11-16:
 * replies show who sent the original, like mobile), so the two can't disagree.
 */
export interface SenderNameContext {
    inServerChannel: boolean;
    nicknames?: Record<string, string | null | undefined> | null;
    userIdToUsername: Record<string, string | undefined>;
    deviceToUsername: Record<string, string | undefined>;
    myUserId: string | null | undefined;
    myUsername: string | null | undefined;
    myDeviceIds: ReadonlySet<string>;
}

export function isOwnMessage(
    m: { sender_user_id?: string | null; sender_device_id?: string | null },
    ctx: Pick<SenderNameContext, 'myUserId' | 'myDeviceIds'>,
): boolean {
    return m.sender_user_id
        ? m.sender_user_id === ctx.myUserId
        : ctx.myDeviceIds.has(m.sender_device_id ?? '');
}

export function senderDisplayName(
    m: { sender_user_id?: string | null; sender_device_id?: string | null },
    ctx: SenderNameContext,
): string {
    const uid = m.sender_user_id || null;
    return (ctx.inServerChannel && uid && ctx.nicknames?.[uid])
        || (uid ? ctx.userIdToUsername[uid] : null)
        || (uid ? null : ctx.deviceToUsername[m.sender_device_id ?? ''])
        || (isOwnMessage(m, ctx) ? (ctx.myUsername ?? 'You') : 'Unknown User');
}
