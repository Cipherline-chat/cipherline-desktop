/**
 * Does this chat have a `GET /v1/conversations/:id/devices` roster?
 *
 * Only DMs and groups do. A server text channel is shown through the same
 * ChatPane as an `activeChat` of `{ id: <channel_id>, type: 'channel' }`
 * (Dashboard.activeChannelAsChat), but its id is a CHANNEL id, not a
 * conversation id: the API's conversation-devices route answers 403 for it
 * (the caller is not a participant of any such conversation), which is the
 * server being right. Asking anyway produced a 403 on every channel open and
 * on every avatar change while one was open.
 *
 * A channel gets its member list/names/avatars from the server-members fetch
 * and its encryption from per-channel keys (channelKeys, epoch-based), not from
 * per-device envelopes, so nothing that used the conversation roster is
 * missing for a channel. Voice channels are the same: the call-key sharing
 * hook already skips `isVoiceChannel` / `callsChannelId` calls.
 */
export function hasConversationDeviceRoster(chat: { id?: string | null; type?: string | null } | null | undefined): boolean {
    return !!chat?.id && chat.type !== 'channel';
}
