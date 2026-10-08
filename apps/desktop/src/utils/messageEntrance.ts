/**
 * A sent message animates in ONCE.
 *
 * Instant send (utils/pendingSend.ts) puts a message in the feed under its
 * client id, then — within a few hundred ms — the same message is touched again
 * and again: the server echo or the delivery patch hands a CHANNEL row the
 * server's id, the delivered patch clears its `send_state`, the server's time
 * replaces this device's compose time and may move the row
 * (utils/messageOrder.ts), and a history fetch folds the server copy in.
 *
 * The feed used to key each row by `msg.id`, and decide "is this new? animate
 * it" by `msg.id` too. So the client-id → server-id swap unmounted the row and
 * mounted a fresh one that played its entrance again, and the "reveal the new
 * last message" effect — keyed on `id::timestamp` — re-ran on every one of those
 * updates. This module gives every row an identity that survives all of them,
 * and makes both decisions idempotent per identity.
 *
 * Everything that needs the row's CURRENT server id (DOM `id="msg-…"`, jump to
 * message, hover, read receipts, reactions) keeps using `msg.id`; only React's
 * key and the entrance/reveal bookkeeping use the stable identity.
 */

export interface FeedRow {
    id?: string | null;
    content?: unknown;
    sender_device_id?: string | null;
    timestamp?: string | number | null;
}

const clientIdOf = (m: FeedRow): string | undefined => {
    const cid = (m.content as { client_msg_id?: unknown } | null | undefined)?.client_msg_id;
    return typeof cid === 'string' && cid ? cid : undefined;
};

/**
 * The row's stable identity. A message THIS device sent is identified by its
 * `client_msg_id` — the one thing that never changes between the instant local
 * row and the confirmed server row. Anything else is identified by its id (a
 * row this device did not author never changes id here). `fallback` covers a
 * row with no id at all.
 *
 * Restricted to this device's own rows on purpose: a `client_msg_id` from
 * someone else is whatever their client chose, and must not be able to steer
 * this feed's identities.
 */
export function messageRowKey(m: FeedRow, deviceId: string | null | undefined, fallback: string | number): string {
    const cid = deviceId && m.sender_device_id === deviceId ? clientIdOf(m) : undefined;
    if (cid) return `c:${cid}`;
    return m.id ? String(m.id) : `i:${fallback}`;
}

/**
 * One key per row for the list, in order. Never repeats a key within a render:
 * a collision (two of this device's rows carrying one client_msg_id, say) falls
 * back to the row's id, then to its index, so React never sees a duplicate.
 */
export function assignRowKeys(rows: readonly FeedRow[], deviceId: string | null | undefined): string[] {
    const used = new Set<string>();
    return rows.map((m, i) => {
        let k = messageRowKey(m, deviceId, i);
        if (used.has(k)) k = m.id ? `d:${m.id}` : `i:${i}`;
        if (used.has(k)) k = `i:${i}`;
        used.add(k);
        return k;
    });
}

const tsOf = (m: FeedRow): number =>
    typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp || '');

/** Longest a row may hold its entrance class without its animationend having
 *  been seen (the entrances are .38s/.44s). Past it the row counts as seen, so a
 *  lost animationend can never leave a row able to replay later. */
export const ENTRANCE_MAX_MS = 1500;

/**
 * Which rows play the entrance animation. Only genuinely new messages (just
 * sent, freshly arrived) — never the first populated render of a conversation
 * and never older messages paginated in at the top.
 *
 *  • The first populated render seeds `seen` and animates nothing.
 *  • After that, an unseen row animates if it is at/after the newest time seen
 *    so far (appended at the bottom), and is then `animating` until its
 *    animationend calls `finish` — re-renders in between keep it animating, no
 *    matter what changed on the row (its id, its timestamp, its position).
 *  • Anything else unseen is older content: marked seen, never animated.
 */
export interface EntranceTracker {
    reset(): void;
    /** Keys (from assignRowKeys) that carry the entrance class this render. */
    decide(rows: readonly FeedRow[], keys: readonly string[], now?: number): Set<string>;
    /** The row's entrance finished — it never animates again. */
    finish(key: string): void;
}

export function createEntranceTracker(): EntranceTracker {
    let seen = new Set<string>();
    let animating = new Map<string, number>();
    let init = false;
    let maxTs = 0;
    return {
        reset() {
            seen = new Set();
            animating = new Map();
            init = false;
            maxTs = 0;
        },
        decide(rows, keys, now = Date.now()) {
            const out = new Set<string>();
            if (!init) {
                if (rows.length === 0) return out;
                rows.forEach((m, i) => {
                    seen.add(keys[i]);
                    const t = tsOf(m);
                    if (Number.isFinite(t)) maxTs = Math.max(maxTs, t);
                });
                init = true;
                return out;
            }
            rows.forEach((m, i) => {
                const k = keys[i];
                const started = animating.get(k);
                if (started !== undefined) {
                    if (now - started < ENTRANCE_MAX_MS) out.add(k);
                    else { animating.delete(k); seen.add(k); }
                    return;
                }
                if (!m.id || seen.has(k)) return;
                const t = tsOf(m);
                if (Number.isFinite(t) && t >= maxTs - 1000) {
                    animating.set(k, now);
                    out.add(k);
                    maxTs = Math.max(maxTs, t);
                } else {
                    seen.add(k); // older / paginated in — never animate
                }
            });
            return out;
        },
        finish(key) {
            animating.delete(key);
            seen.add(key);
        },
    };
}

/**
 * "A new message landed at the bottom — reveal it" (the feed's FLIP slide and
 * snap to bottom), at most once per message. The last row's identity, not its
 * id or time: confirmation, id adoption and a server-time re-sort are the SAME
 * message and must not slide the feed again. A row that was already the last
 * one before (it became last again because a newer one moved above it, or was
 * deleted) does not reveal again either.
 */
export interface RevealGate {
    /** True when `lastKey` is a message that should be revealed now. */
    check(chatId: string | null, lastKey: string | null): boolean;
}

export function createRevealGate(): RevealGate {
    let chat: string | null | undefined;
    let current: string | null = null;
    let revealed = new Set<string>();
    return {
        check(chatId, lastKey) {
            if (chatId !== chat) {
                // Chat switch: the chat-switch effect does the snap; just record.
                chat = chatId;
                current = lastKey;
                revealed = new Set(lastKey ? [lastKey] : []);
                return false;
            }
            if (lastKey === current) return false;
            current = lastKey;
            if (!lastKey || revealed.has(lastKey)) return false;
            revealed.add(lastKey);
            return true;
        },
    };
}
