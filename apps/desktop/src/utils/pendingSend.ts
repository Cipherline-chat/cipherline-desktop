/**
 * Instant send: a text message is put in the feed the moment you press Enter,
 * marked `send_state: 'sending'`, and delivered behind it. If delivery fails it
 * stays where it is, marked `'failed'` with a short reason, and can be retried
 * or deleted — it never vanishes and the composer is never held for it.
 *
 * The marker lives on the stored message itself (so a failed send survives a
 * restart instead of silently looking delivered). It is local-only: it never
 * travels in a ciphertext, and a delivered message carries no marker at all.
 */

import { repositionByServerOrder } from './messageOrder';
import { markDelivered } from './undeliveredSend';

export type SendState = 'sending' | 'failed';

export interface SendMarked {
    id: string;
    content?: { client_msg_id?: string } | unknown;
    send_state?: SendState;
    send_error?: string;
    /** DM/group: the server's timestamp, once known (utils/messageOrder.ts). */
    server_ts?: string;
}

export interface SendPatch {
    /** New state, or null once delivered (the marker is removed). */
    send_state?: SendState | null;
    /** Short reason shown under a failed message. */
    send_error?: string | null;
    /** Channel messages only: the server row id that replaces the local one. */
    id?: string;
    sender_user_id?: string | null;
    /** The server's time for the message. Channels: the row's created_at. */
    timestamp?: string;
    /** DM/group: the server's received_at_server. The row takes it as its
     *  ordering key AND its displayed time, and moves to its server position
     *  (utils/messageOrder.ts) — the same place every other device shows it. */
    server_ts?: string;
}

const clientIdOf = (m: SendMarked): string | undefined =>
    (m.content as { client_msg_id?: string } | undefined)?.client_msg_id;

/** True for a row this device put in the feed but the server has not confirmed. */
export function isUnconfirmedSend(m: SendMarked | null | undefined): boolean {
    return !!m && (m.send_state === 'sending' || m.send_state === 'failed');
}

/**
 * Apply a patch to the row whose id or client_msg_id is `clientMsgId`. Returns
 * the same array when there is nothing to change (no matching row, or no
 * difference), so callers can skip a state update.
 */
export function applySendPatch<T extends SendMarked>(thread: T[], clientMsgId: string, patch: SendPatch): T[] {
    const idx = thread.findIndex(m => m.id === clientMsgId || clientIdOf(m) === clientMsgId);
    if (idx === -1) return thread;
    const next = { ...thread[idx] } as T & Record<string, unknown>;
    let changed = false;
    const set = (k: string, v: unknown) => {
        if (v === undefined) return;
        if (v === null) {
            if (k in next) { delete next[k]; changed = true; }
        } else if (next[k] !== v) {
            (next as Record<string, unknown>)[k] = v;
            changed = true;
        }
    };
    set('send_state', patch.send_state);
    // A delivered or re-sending message has no error to show.
    set('send_error', patch.send_state === null || patch.send_state === 'sending' ? null : patch.send_error);
    if (patch.id) set('id', patch.id);
    if (patch.sender_user_id) set('sender_user_id', patch.sender_user_id);
    if (patch.timestamp) set('timestamp', patch.timestamp);
    if (patch.server_ts) {
        set('server_ts', patch.server_ts);
        // Displayed time too, unless the caller supplied a (clamped) one.
        if (!patch.timestamp) set('timestamp', patch.server_ts);
    }
    if (!changed) return thread;
    const out = [...thread];
    out[idx] = next;
    // A just-confirmed DM row moves from "below everything confirmed" to where
    // the server put it.
    return patch.server_ts && next.send_state !== 'sending' ? repositionByServerOrder(out, idx) : out;
}

/**
 * The server's copy of a message this device sent (a WS echo or a history
 * fetch) arriving while the local row still carries its client id: hand the
 * local row the server id and the server's timestamp and drop its marker,
 * instead of inserting a second copy. Returns null when `row` is not one of ours (the caller inserts it as
 * usual). Content is kept from the local row — it is what we encrypted.
 */
export function adoptServerCopy<T extends SendMarked & { sender_user_id?: string | null; timestamp?: string }>(
    thread: T[],
    row: { id: string; content?: unknown; sender_user_id?: string | null; timestamp?: string },
): T[] | null {
    const cid = (row.content as { client_msg_id?: string } | undefined)?.client_msg_id;
    if (!cid || row.id === cid) return null;
    const idx = thread.findIndex(m => clientIdOf(m) === cid && m.id !== row.id);
    if (idx === -1) return null;
    const cur = thread[idx];
    // Only a row still under its LOCAL id is adopted; a row that already has a
    // different server id is some other copy and is left alone.
    if (cur.id !== cid) return null;
    const next = { ...cur, id: row.id } as T;
    // The server's time, not this device's compose time: a channel thread is
    // sorted by timestamp, and only the server's value puts our message where
    // everyone else sees it. (The caller re-sorts.)
    if (row.timestamp) (next as { timestamp?: string }).timestamp = row.timestamp;
    delete (next as SendMarked).send_state;
    delete (next as SendMarked).send_error;
    // The server has it (an attempt that timed out client-side landed after all):
    // a Retry still waiting in the delivery queue must not POST a second copy.
    markDelivered(cid);
    if (row.sender_user_id) (next as { sender_user_id?: string | null }).sender_user_id = row.sender_user_id;
    const out = [...thread];
    out[idx] = next;
    return out;
}

/**
 * At load: a message still marked 'sending' was interrupted (the app closed or
 * crashed mid-send) and was never confirmed — show it as failed, so it can be
 * retried, rather than as a send that spins forever. Returns the same map when
 * nothing needed settling.
 */
export function settleInterruptedSends<T extends SendMarked>(map: Record<string, T[]>): Record<string, T[]> {
    let out: Record<string, T[]> | null = null;
    for (const [k, thread] of Object.entries(map)) {
        if (!Array.isArray(thread) || !thread.some(m => m?.send_state === 'sending')) continue;
        out ??= { ...map };
        out[k] = thread.map(m => (m?.send_state === 'sending'
            ? { ...m, send_state: 'failed' as const, send_error: 'Not sent — the app closed first' }
            : m));
    }
    return out ?? map;
}

/** A short, human reason for a failed send, from whatever was thrown. */
/**
 * The API refused a channel write encrypted under an epoch older than the
 * channel's current one (409 STALE_EPOCH, apps/api ChannelMessagesService
 * .requireCurrentEpoch): this device missed a key rotation. Treated exactly
 * like "no channel key" — fetch the key, the user retries.
 */
export function isStaleEpochError(err: unknown): boolean {
    const r = (err as { response?: { status?: number; data?: { code?: unknown } } })?.response;
    return r?.status === 409 && r.data?.code === 'STALE_EPOCH';
}

export function sendFailureReason(err: unknown): string {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (/No channel key|Channel key for epoch/.test(msg)) return "This channel's key hasn't arrived yet";
    if (isStaleEpochError(err)) return "This channel's newest key hasn't arrived yet";
    if (status === 429) return 'Sending too fast';
    if (status === 403) return "You don't have permission to send here";
    if (status === 413) return 'Message too large';
    if (status && status >= 500) return 'Server problem';
    const code = (err as { code?: string } | null)?.code;
    if (!status && (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(msg))) return 'Timed out';
    if (!status && /network|ECONN|Failed to fetch/i.test(msg)) return 'No connection';
    if (status === 401) return 'Signed out';
    return 'Not delivered';
}
