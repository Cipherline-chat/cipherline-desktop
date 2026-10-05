/**
 * Channel read state across a user's devices (multi-device audit, 2026-10-03).
 *
 * The owner's report this answers: "I read a message on one device and it
 * shows unread on another." For DMs the gateway already relays `message:read`
 * to the reader's own other devices. For server CHANNELS nothing did:
 *
 *  - `POST /v1/channels/:cid/read` advanced the server cursor and told no one,
 *  - the desktop's only reconciliation (`GET /servers/:id/unread` on reconnect)
 *    could only RAISE a count, never lower it,
 *  - and the cursor only moved on channel ENTRY, so messages read while sitting
 *    in a channel stayed "unread" for every other device.
 *
 * The server now sends `channel:read` to the reader's other sockets. These are
 * the pure pieces the Dashboard wires up, kept here so they are testable under
 * vitest's node environment (Dashboard.tsx itself is not).
 */

import type { CountMap } from './unreadBadges';

export interface ChannelReadEvent {
    server_id: string;
    channel_id: string;
    /** Server clock, ISO-8601: the cursor the server actually stored. */
    last_read_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a `channel:read` payload. The server is not trusted to send a
 * well-formed one (it is the documented adversary for content, and a bug for
 * everything else), so anything malformed is dropped rather than coerced.
 */
export function parseChannelReadEvent(data: unknown): ChannelReadEvent | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (typeof d.channel_id !== 'string' || !UUID.test(d.channel_id)) return null;
    if (typeof d.server_id !== 'string' || !UUID.test(d.server_id)) return null;
    if (typeof d.last_read_at !== 'string' || !Number.isFinite(Date.parse(d.last_read_at))) return null;
    return { server_id: d.server_id, channel_id: d.channel_id, last_read_at: d.last_read_at };
}

/**
 * Drop `ids` from a count map. Returns the SAME object when nothing changes,
 * so a React state setter given this does not re-render for a no-op (a
 * repeated or self-echoed read event is the common case).
 */
export function clearCounts(counts: CountMap, ids: Iterable<string>): CountMap {
    let next: CountMap | null = null;
    for (const id of ids) {
        if (!(id in counts)) continue;
        if (!next) next = { ...counts };
        delete next[id];
    }
    return next ?? counts;
}

export interface UnreadRow {
    channel_id: string;
    unread_count: number;
}

/**
 * Fold `GET /servers/:id/unread` into the local channel counts.
 *
 * The server count is the authority on "has anything happened since my
 * cursor" — it is the only source that knows about a read on another device
 * that this device missed (offline, asleep). So it may LOWER a local count,
 * which the old reconcile never allowed: a channel read on the phone stayed lit
 * on the desktop forever.
 *
 * The one thing it must not do is undo a message that arrived locally while
 * the request was in flight (the race the old "floor only" rule existed for).
 * So a count is lowered only when it is unchanged since the request was sent
 * (`atRequest`, a snapshot taken then). Raising keeps the old floor semantics.
 *
 * Mentions cannot be computed server-side (E2EE), so they are only ever
 * CLEARED, and only when the server says the channel has nothing unread at all
 * (and the local mention count, too, is unchanged since the request).
 *
 * Returns the same objects when nothing changes.
 */
export function reconcileChannelUnread(params: {
    unread: CountMap;
    mentions: CountMap;
    rows: ReadonlyArray<UnreadRow>;
    unreadAtRequest: CountMap;
    mentionsAtRequest: CountMap;
}): { unread: CountMap; mentions: CountMap; raised: string[] } {
    let unread: CountMap | null = null;
    let mentions: CountMap | null = null;
    const raised: string[] = [];
    for (const row of params.rows) {
        const id = row.channel_id;
        // A row the server got wrong decides nothing — never lower on garbage.
        if (typeof id !== 'string' || typeof row.unread_count !== 'number'
            || !Number.isFinite(row.unread_count) || row.unread_count < 0) continue;
        const server = Math.floor(row.unread_count);
        const local = (unread ?? params.unread)[id] ?? 0;
        if (server > local) {
            unread ??= { ...params.unread };
            unread[id] = server;
            raised.push(id);
            continue;
        }
        if (server < local && local === (params.unreadAtRequest[id] ?? 0)) {
            unread ??= { ...params.unread };
            if (server === 0) delete unread[id];
            else unread[id] = server;
        }
        if (server === 0) {
            const m = (mentions ?? params.mentions)[id] ?? 0;
            if (m > 0 && m === (params.mentionsAtRequest[id] ?? 0)) {
                mentions ??= { ...params.mentions };
                delete mentions[id];
            }
        }
    }
    return { unread: unread ?? params.unread, mentions: mentions ?? params.mentions, raised };
}

/**
 * Should a channel message that just arrived advance THIS user's server read
 * cursor? Only when a human is demonstrably looking at it: it is in the open
 * channel, the window has focus and is visible, and it is not our own message
 * (our own never counts as unread anywhere). Without this the cursor only moved
 * on channel entry, so every message read while sitting in a channel came back
 * as unread on the user's other devices.
 */
export function shouldAdvanceChannelCursor(p: {
    messageChannelId: string;
    activeChannelId: string | null | undefined;
    activeChannelIsText: boolean;
    windowFocused: boolean;
    documentVisible: boolean;
    isOwnMessage: boolean;
}): boolean {
    return !p.isOwnMessage
        && p.activeChannelIsText
        && p.activeChannelId === p.messageChannelId
        && p.windowFocused
        && p.documentVisible;
}
