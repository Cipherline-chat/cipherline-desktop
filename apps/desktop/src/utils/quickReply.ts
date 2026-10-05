/**
 * quickReply.ts — pure logic behind "reply from the OS toast".
 *
 * The OS notification carries exactly two things back to us: the `conv_id` we
 * stamped on the toast, and the text the user typed. Everything else — is that
 * id a DM or a server channel? is the text sendable? what do we tell the user
 * when it fails? — is decided here, deliberately free of React state, axios and
 * Electron, so it can be unit-tested without an OS notification centre (which
 * this repo's Linux dev box cannot produce a Windows-shaped one of anyway).
 *
 * Why this file exists at all: the reply handler used to resolve the target
 * inline with `conversations.find(...)` and `return` on a miss. That silently
 * dropped every server-channel reply (channel toasts advertise a reply field
 * too) and every reply whose conversation list hadn't hydrated yet. Making the
 * resolution a total function — one that names the "I don't know" case instead
 * of falling off the end — is what makes those failures visible.
 */

import { MAX_TEXT_MESSAGE_LENGTH } from '../constants';

/** Minimal shape of a conversation row, as the notification path sees it. */
export interface QuickReplyConversation {
    id?: string;
    conversation_id?: string;
}

/** Minimal shape of a channel row, as the notification path sees it. */
export interface QuickReplyChannel {
    channel_id: string;
}

export type QuickReplyTarget =
    /** A DM or group conversation — encrypt per recipient device (ECIES). */
    | { kind: 'dm'; conversationId: string }
    /** A server channel — encrypt under the channel epoch key. */
    | { kind: 'channel'; channelId: string; serverId: string }
    /**
     * The id matched nothing we have loaded. NOT a failure by itself: the
     * caller is expected to refresh and re-resolve before giving up, because a
     * toast can legitimately fire (and be replied to from the Action Center)
     * while the conversation list is still loading.
     */
    | { kind: 'unknown'; id: string };

/**
 * Resolve a notification's `conv_id` against whatever the renderer currently
 * has loaded.
 *
 * Conversations are checked first: both `id` and `conversation_id` are accepted
 * because the two API shapes are mixed in the client's conversation list.
 */
export function resolveQuickReplyTarget(
    convId: string,
    conversations: readonly QuickReplyConversation[],
    serverChannels: Readonly<Record<string, readonly QuickReplyChannel[]>>,
): QuickReplyTarget {
    if (!convId) return { kind: 'unknown', id: convId };

    for (const c of conversations) {
        if (c.id === convId || c.conversation_id === convId) {
            return { kind: 'dm', conversationId: convId };
        }
    }

    for (const serverId of Object.keys(serverChannels)) {
        const chans = serverChannels[serverId] ?? [];
        for (const ch of chans) {
            if (ch.channel_id === convId) {
                return { kind: 'channel', channelId: convId, serverId };
            }
        }
    }

    return { kind: 'unknown', id: convId };
}

export type QuickReplyTextResult =
    | { ok: true; text: string }
    /** Nothing worth sending — the user submitted an empty/whitespace reply. */
    | { ok: false; reason: 'empty' }
    /** Past the wire cap. Refused rather than truncated: silently sending a
     *  clipped message is worse than telling the user it didn't go. */
    | { ok: false; reason: 'too_long'; limit: number };

/**
 * Normalise the raw string the OS handed us.
 *
 * Windows' toast input can carry a trailing newline from the Enter that
 * submitted it, and both platforms will happily hand back a whitespace-only
 * string, so trimming is required before the emptiness test.
 */
export function normalizeQuickReplyText(raw: unknown): QuickReplyTextResult {
    if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
    const text = raw.trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (text.length > MAX_TEXT_MESSAGE_LENGTH) {
        return { ok: false, reason: 'too_long', limit: MAX_TEXT_MESSAGE_LENGTH };
    }
    return { ok: true, text };
}

/**
 * Build the `ClientContent` for a quick reply.
 *
 * Intentionally a bare `text` message: the composer's mention/emoji wire-token
 * transforms need the composer's token map, which a toast reply has no way to
 * populate. A typed "@name" therefore travels as literal text rather than a
 * broken half-encoded mention token.
 */
export function buildQuickReplyContent(text: string, clientMsgId: string) {
    return { client_msg_id: clientMsgId, type: 'text' as const, text };
}

/** ID generator that tolerates a missing `crypto.randomUUID` (older webviews). */
export function newClientMsgId(): string {
    const c: Crypto | undefined = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `qr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Map a thrown send error to something worth showing the user.
 *
 * Mirrors the composer's mapping (ChatPane's send catch) so a failure reads the
 * same whether you typed it in the app or in a toast — the previous handler
 * swallowed all of these into a `console.warn` nobody sees, which is precisely
 * why a failed reply was indistinguishable from a successful one.
 */
export function describeQuickReplyError(err: unknown): string {
    const anyErr = err as any;
    const status: number | undefined = anyErr?.response?.status;
    const serverMsg: string | undefined = anyErr?.response?.data?.message;
    const msg: string = typeof anyErr?.message === 'string' ? anyErr.message : '';

    if (status === 429) return 'You are sending messages too quickly. Try again in a moment.';
    if (status === 403) return serverMsg || 'You do not have permission to post here.';
    if (status === 401) return 'Your session expired. Open Cipherline and sign in again.';
    if (/No channel key|Channel key for epoch/i.test(msg)) {
        return 'This channel’s key hasn’t arrived on this device yet. Open the channel once, then reply.';
    }
    if (status && status >= 500) return 'The server could not accept the message. Try again.';
    if (anyErr?.code === 'ERR_NETWORK' || /Network Error/i.test(msg)) {
        return 'You appear to be offline. The reply was not sent.';
    }
    return 'Your reply could not be sent.';
}
