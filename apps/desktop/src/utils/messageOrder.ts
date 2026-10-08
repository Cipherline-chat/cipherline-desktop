/**
 * One order for every copy of a DM / group conversation.
 *
 * The problem this solves: a DM thread used to be in ARRIVAL order on each
 * device. The sender's own message went in when Enter was pressed; everyone
 * else's copy went in when their pull happened to fetch it. A message from the
 * other side that reached the server while ours was still being delivered sat
 * ABOVE ours on their screen and BELOW it on ours — and the longer delivery
 * took, the more often the two feeds disagreed. Displayed times were the
 * sender's own clock (`sent_at_client`), so a skewed clock made it worse.
 *
 * The fix is one ordering key that every client of the conversation sees with
 * the same value: the server's `received_at_server` — the database `now()`
 * stamped on every stored copy of a message. Recipients get it from
 * /messages/pull; the sender gets it back from POST /messages/send. Rows carry
 * it as `server_ts`, ties broken by message id (the client_msg_id, which is
 * the same on every copy), so every device converges on the same sequence.
 *
 * Why the server's clock and not the sender's:
 *   • One clock. Sender clocks are skewed by seconds or minutes; a server
 *     order is consistent across everyone by construction.
 *   • No new trust. `sent_at_client` is NOT authenticated — it travels in
 *     plaintext beside the ciphertext, so the relay could always rewrite it.
 *     The relay can also always delay or reorder delivery. Ordering by its
 *     timestamp hands it nothing it did not already control, and the content
 *     itself stays end-to-end authenticated.
 *
 * Rows still being sent (`send_state: 'sending'`) have no server position yet:
 * they stay below every confirmed row and move into place when the send is
 * confirmed. Rows WITHOUT a server stamp — history from before this change, a
 * failed send — are never moved and nothing is moved past them, so existing
 * threads keep exactly the order they had.
 */

export interface OrderRow {
    id: string;
    /** The server's timestamp for this message (ISO), when known. */
    server_ts?: string;
    send_state?: string;
}

/** The server timestamp in ms, or NaN when the row has none. */
export function serverMs(row: { server_ts?: string } | null | undefined): number {
    const v = row?.server_ts;
    return typeof v === 'string' ? Date.parse(v) : NaN;
}

/** Server order: timestamp, then id — the same answer on every device. */
export function compareServerOrder(a: OrderRow, b: OrderRow): number {
    const d = serverMs(a) - serverMs(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The index `row` belongs at in `thread` (which must not already contain it).
 * Scanning back from the end it passes rows still being sent and confirmed
 * rows the server stamped later; it stops at anything earlier or unstamped.
 * A row with no server stamp of its own goes at the end (arrival order).
 */
export function serverOrderIndex<T extends OrderRow>(thread: readonly T[], row: T): number {
    if (!Number.isFinite(serverMs(row))) return thread.length;
    let i = thread.length;
    while (i > 0) {
        const prev = thread[i - 1];
        if (prev.send_state === 'sending') { i--; continue; }
        if (Number.isFinite(serverMs(prev)) && compareServerOrder(prev, row) > 0) { i--; continue; }
        break;
    }
    return i;
}

/** A new thread with `row` inserted at its server position. */
export function placeByServerOrder<T extends OrderRow>(thread: readonly T[], row: T): T[] {
    const out = thread.slice();
    out.splice(serverOrderIndex(thread, row), 0, row);
    return out;
}

/**
 * A channel thread in timestamp order (every channel row except our own
 * still-unconfirmed one carries the server's created_at). Stable, so rows
 * with equal timestamps keep their relative order.
 */
export function sortChannelThread<T extends { timestamp?: string }>(thread: readonly T[]): T[] {
    const ms = (r: T) => {
        const v = Date.parse(String(r.timestamp));
        return Number.isFinite(v) ? v : 0;
    };
    return thread.slice().sort((a, b) => ms(a) - ms(b));
}

/** Move the row at `index` (just confirmed) to its server position. */
export function repositionByServerOrder<T extends OrderRow>(thread: readonly T[], index: number): T[] {
    if (index < 0 || index >= thread.length) return thread.slice();
    const row = thread[index];
    const rest = thread.slice(0, index).concat(thread.slice(index + 1));
    return placeByServerOrder(rest, row);
}
