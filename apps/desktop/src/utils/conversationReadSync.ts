/**
 * DM / group read state across a user's devices (2026-10-12).
 *
 * The owner's report: "When I read a message on one PC and then go to my other
 * PC, it still shows unread." `message:read` was only relayed to sockets that
 * were connected at that moment, so a device that was asleep, closed or offline
 * never learned of it — it booted with its old badge and then PULLED the
 * messages that had already been read elsewhere and counted them unread again.
 *
 * The server now keeps the user's OWN read cursor per conversation
 * (`conversation_read_states`, DB clock — the same clock as every envelope's
 * `received_at_server`, which is what we compare it to) and returns it from
 * `GET /v1/conversations/read-states`. These are the pure pieces the Dashboard
 * wires up, kept here so they are testable under vitest's node environment
 * (Dashboard.tsx itself is not). Channels have had the equivalent since
 * utils/channelReadSync.ts; the difference is that a channel's unread COUNT is
 * computed server-side, whereas DM messages are deleted from the server once
 * delivered — so the client holds the messages and does the comparison itself.
 *
 * The rule everywhere: a message is read iff its server timestamp is at or
 * before the cursor. A message with no parseable server timestamp is NEVER
 * treated as read (fail toward showing unread, not toward hiding a message).
 */

import type { CountMap } from './unreadBadges';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** conversation_id -> cursor, epoch ms on the SERVER clock. */
export type ReadCursors = Record<string, number>;

/**
 * Validate `GET /conversations/read-states`. The server is not trusted to send
 * a well-formed body, so a malformed row is dropped rather than coerced; a
 * duplicate id keeps the later cursor.
 */
export function parseConversationReadStates(data: unknown): ReadCursors {
    const out: ReadCursors = {};
    if (!Array.isArray(data)) return out;
    for (const row of data) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        if (typeof r.conversation_id !== 'string' || !UUID.test(r.conversation_id)) continue;
        if (typeof r.last_read_at !== 'string') continue;
        const ms = Date.parse(r.last_read_at);
        if (!Number.isFinite(ms)) continue;
        if (!(r.conversation_id in out) || ms > out[r.conversation_id]) out[r.conversation_id] = ms;
    }
    return out;
}

/**
 * Fold newer cursors into the known ones. A cursor only ever moves FORWARD
 * (the server enforces the same with GREATEST), so a late or replayed value
 * can never resurrect messages the user already saw. Returns the SAME object
 * when nothing advanced.
 */
export function mergeReadCursors(prev: ReadCursors, incoming: ReadCursors): ReadCursors {
    let next: ReadCursors | null = null;
    for (const [id, ms] of Object.entries(incoming)) {
        if (!Number.isFinite(ms)) continue;
        if (ms > (prev[id] ?? -Infinity)) {
            next ??= { ...prev };
            next[id] = ms;
        }
    }
    return next ?? prev;
}

/** A pulled/stored DM row's server time in epoch ms, or NaN when unknown. */
export function messageServerMs(m: { server_ts?: unknown; timestamp?: unknown }): number {
    const v = m.server_ts ?? m.timestamp;
    if (typeof v === 'number') return v;
    return typeof v === 'string' ? Date.parse(v) : NaN;
}

/** Has the user already read this message on some device? */
export function isReadByCursor(
    cursors: ReadCursors,
    conversationId: string,
    m: { server_ts?: unknown; timestamp?: unknown },
): boolean {
    const cursor = cursors[conversationId];
    if (cursor === undefined) return false;
    const ms = messageServerMs(m);
    return Number.isFinite(ms) && ms <= cursor;
}

/**
 * Lower the local DM unread/mention counts to what the read cursors allow.
 *
 * Never RAISES: a DM count is built from messages this device has pulled, and
 * the server holds nothing it could add. It only lowers, to the number of
 * messages from other people this device holds that are newer than the cursor
 * (`incomingAfter`; null = the thread is not loaded, so nothing is known and the
 * count is left alone). Mentions follow independently: cleared when nothing is
 * unread, never above that same number.
 *
 * Race rule, identical to channelReadSync.reconcileChannelUnread: a count that
 * changed since the request was sent (`*AtRequest`) is left alone — a message
 * may have arrived while the response was in flight.
 *
 * Returns the same objects when nothing changes (no re-render for a no-op).
 */
export function reconcileDmUnread(params: {
    unread: CountMap;
    mentions: CountMap;
    cursors: ReadCursors;
    unreadAtRequest: CountMap;
    mentionsAtRequest: CountMap;
    incomingAfter: (conversationId: string, cursorMs: number) => number | null;
}): { unread: CountMap; mentions: CountMap } {
    let unread: CountMap | null = null;
    let mentions: CountMap | null = null;
    for (const [id, cursor] of Object.entries(params.cursors)) {
        const localUnread = params.unread[id] ?? 0;
        const localMentions = params.mentions[id] ?? 0;
        if (localUnread <= 0 && localMentions <= 0) continue;
        const after = params.incomingAfter(id, cursor);
        if (after === null || !Number.isFinite(after) || after < 0) continue;

        if (localUnread > after && localUnread === (params.unreadAtRequest[id] ?? 0)) {
            unread ??= { ...params.unread };
            if (after === 0) delete unread[id];
            else unread[id] = after;
        }
        if (localMentions > 0 && localMentions === (params.mentionsAtRequest[id] ?? 0)) {
            const cap = Math.min(localMentions, after);
            if (cap < localMentions) {
                mentions ??= { ...params.mentions };
                if (cap === 0) delete mentions[id];
                else mentions[id] = cap;
            }
        }
    }
    return { unread: unread ?? params.unread, mentions: mentions ?? params.mentions };
}

/** A read on ANOTHER of this account's devices, as the WS handler sees it. */
export interface SelfReadEvent {
    conversation_id: string;
    last_read_message_id: string;
    read_at: number;
    /** Server-clock cursor (epoch ms) the server stored, when it sent one. */
    last_read_at_ms?: number;
}

/**
 * Turn a `message:read` WS payload into a self-read event, or null.
 *
 * `reader_user_id` is whatever the server stamped from the SENDING socket's
 * verified identity; comparing it to our own id is the only thing that tells
 * "someone else read this" (a receipt) from "I read this, elsewhere" (clear my
 * badge). Fails closed: a missing id on either side is never a match, because a
 * false positive here hides a genuinely unread message.
 */
export function parseSelfReadEvent(data: unknown, myUserId: string | null | undefined): SelfReadEvent | null {
    if (!data || typeof data !== 'object' || !myUserId) return null;
    const d = data as Record<string, unknown>;
    if (typeof d.reader_user_id !== 'string' || d.reader_user_id !== myUserId) return null;
    if (typeof d.conversation_id !== 'string' || !d.conversation_id) return null;
    const ev: SelfReadEvent = {
        conversation_id: d.conversation_id,
        last_read_message_id: typeof d.last_read_message_id === 'string' ? d.last_read_message_id : '',
        read_at: typeof d.read_at === 'number' && Number.isFinite(d.read_at) ? d.read_at : Date.now(),
    };
    if (typeof d.last_read_at === 'string') {
        const ms = Date.parse(d.last_read_at);
        if (Number.isFinite(ms)) ev.last_read_at_ms = ms;
    }
    return ev;
}

/** The server-clock cursors carried by a batch of self-read events. */
export function cursorsFromSelfReads(events: ReadonlyArray<SelfReadEvent>): ReadCursors {
    const out: ReadCursors = {};
    for (const e of events) {
        if (e.last_read_at_ms === undefined) continue;
        if (e.last_read_at_ms > (out[e.conversation_id] ?? -Infinity)) out[e.conversation_id] = e.last_read_at_ms;
    }
    return out;
}
