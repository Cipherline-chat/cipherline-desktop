/**
 * Merging server-channel history into the local cache.
 *
 * The local cache is the source of truth for channel history (Phase Q' parity
 * with DMs). `GET /v1/channels/:id/messages` only ever returns the server's
 * newest 50 rows, so it can only ever CONTRIBUTE — it must never be treated as
 * the authoritative list, or every channel entry would silently truncate a long
 * local history down to the last 50 messages.
 *
 * That invariant is why the Sender-Key `envelopes_ready` handler must not drop
 * a channel's cache before re-fetching: `foldChannelHistory` already upgrades
 * "couldn't decrypt" placeholders in place once a decrypted copy arrives, so
 * dropping bought nothing and destroyed everything older than the 50-row
 * window (as well as producing a visible empty→content flash in the pane).
 */

import { adoptServerCopy } from './pendingSend';

/** A cached or freshly-decrypted channel row, as far as the merge cares.
 *  Structurally a superset-tolerant view of Dashboard's `StoredChannelMsg`. */
export interface ChannelRow {
    id: string;
    timestamp: string;
    sender_user_id?: string | null;
    sender_device_id?: string;
    /** The decrypted ClientContent union, or the placeholder shape. Left loose
     *  for the same reason StoredChannelMsg leaves it loose: this reducer
     *  reaches into edit/delete/reaction envelopes. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content?: any;
    reactions?: Record<string, string[]>;
    edited?: boolean;
    /** Instant-send marker on a row this device sent (utils/pendingSend.ts). */
    send_state?: 'sending' | 'failed';
    send_error?: string;
}

interface EditContent { type: 'edit'; target_id: string; text: string }
interface DeleteContent { type: 'delete'; target_id: string }
interface ReactionContent { type: 'reaction'; target_id: string; emoji: string; action: 'add' | 'remove' }

/**
 * A cached row that stands in for a message we couldn't decrypt (missing epoch
 * key). Written by both the history path and the live-poll path in the same
 * shape. Lets the merge tell "we already have this message" apart from "we
 * already have a placeholder for this message and can now do better".
 */
export function isUndecryptablePlaceholder(m: { content?: unknown } | null | undefined): boolean {
    const c = m?.content as { type?: string; kind?: string } | undefined;
    return c?.type === 'system' && c?.kind === 'encrypted';
}

const tsOf = (m: ChannelRow): number => new Date(m.timestamp).getTime();

/**
 * The slice of server history that one `GET /v1/channels/:id/messages`
 * response is known to cover COMPLETELY. Half-open: `[fromTs, toTs)`.
 *
 * The endpoint is `ORDER BY created_at DESC LIMIT n` (optionally `AND
 * created_at < before`), so whatever it returns is a contiguous run counting
 * back from the top of the queried range — there are no gaps inside it. That
 * makes absence provable: a row whose timestamp lands inside the window and
 * whose id is NOT in the response does not exist on the server any more.
 */
export interface ServerWindow {
    /** Inclusive lower bound, ms since epoch. `-Infinity` = back to the start. */
    fromTs: number;
    /** Exclusive upper bound, ms since epoch. `Infinity` = up to now. */
    toTs: number;
}

/**
 * Derive the {@link ServerWindow} a history response covers.
 *
 * @param returned the rows the server just handed back (any order)
 * @param beforeIso the exclusive top of the range this fetch queried: the
 *                  `before=` cursor for a paginated fetch, or — for a
 *                  "newest page" fetch, which has no cursor — the moment the
 *                  REQUEST WAS ISSUED. Passing request time rather than
 *                  `Infinity` there is what stops a live `channel:message_new`
 *                  placeholder that landed while the fetch was in flight from
 *                  being read as "absent from the server" and evicted: it is
 *                  newer than anything the response could have contained.
 *                  Omitting it altogether means "up to now" and reintroduces
 *                  that race, so only do so when nothing can be arriving.
 *
 * An EMPTY response is the strongest answer, not the weakest: the query asked
 * for the newest rows in the range and got none, so the server holds nothing
 * in it at all — the window opens all the way back to `-Infinity`.
 */
export function coveredServerWindow(
    returned: ReadonlyArray<ChannelRow>,
    beforeIso?: string | null,
): ServerWindow {
    const parsedBefore = beforeIso ? new Date(beforeIso).getTime() : NaN;
    const toTs = Number.isFinite(parsedBefore) ? parsedBefore : Infinity;

    let fromTs = Infinity;
    for (const r of returned) {
        const t = tsOf(r);
        if (Number.isFinite(t) && t < fromTs) fromTs = t;
    }
    return { fromTs: fromTs === Infinity ? -Infinity : fromTs, toTs };
}

/**
 * Drop cached "couldn't decrypt" placeholders whose ciphertext is GONE from
 * the server.
 *
 * Why this is not the same as the additive rule above. The local cache is
 * deliberately allowed to outlive the server's 30-day channel retention — a
 * DECRYPTED row the server no longer returns is still the user's message and
 * must survive. A PLACEHOLDER is the opposite: it carries no content, only the
 * promise "we'll show this once the channel key arrives". The only thing that
 * can ever keep that promise is a decrypted copy of the same id arriving from
 * the server (the upgrade path in `foldChannelHistory`). Once the server has
 * hard-deleted the row — `cleanup.service.ts` `sweepExpiredChannelMessages`,
 * `DELETE ... WHERE expires_at < NOW()` — no such copy can ever exist, on this
 * device or any other. The pill is unhealable, and it is persisted
 * (`cipherline_channel_msgs_<userId>`), so it sits in the thread for good
 * claiming a key problem for a message that no longer exists anywhere.
 *
 * That is the owner-reported symptom: "messages that were deleted by the
 * server ... it says that it couldn't decrypt the message, even though it is
 * not there on the server."
 *
 * Removal, not a "message deleted" tombstone, is the right end state — it
 * matches what this codebase already does everywhere else deletion is
 * expressed: the `delete` branch below SPLICES the target out, and
 * `retentionTombstones.ts` exists precisely so purged messages VANISH rather
 * than reappear as a pill. Rendering "something was here" for content this
 * device never decrypted would also invent a claim the user has no way to
 * check, and would announce that a message existed at time T — metadata this
 * project deliberately does not surface.
 *
 * Scope guards, all three required before a row is dropped:
 *   1. it is a placeholder (a decrypted row is never touched);
 *   2. its id was not in this response (a still-undecryptable row the server
 *      DID return is a live key gap — keep the pill, keep requesting the key);
 *   3. its timestamp falls inside a window the response fully covers.
 *
 * Pure: `rows` is not mutated.
 */
export function pruneVanishedPlaceholders<T extends ChannelRow>(
    rows: T[],
    returnedIds: ReadonlySet<string>,
    window: ServerWindow | null | undefined,
): T[] {
    if (!window) return rows;
    return rows.filter(r => {
        if (!isUndecryptablePlaceholder(r)) return true;
        if (returnedIds.has(r.id)) return true;
        const t = tsOf(r);
        // Unparseable timestamp — can't place it in the window, so leave it be.
        if (!Number.isFinite(t)) return true;
        return t < window.fromTs || t >= window.toTs;
    });
}

/**
 * Fold a batch of freshly-fetched, already-decrypted channel rows onto the
 * locally-cached thread.
 *
 * - `existing` is never truncated: rows the server no longer returns survive.
 * - Action rows (`edit` / `delete` / `reaction`) are applied to their target and
 *   the envelope itself is dropped.
 * - A plain row is inserted only if its id isn't cached yet.
 * - A plain row whose id IS cached upgrades the cached copy when the cached one
 *   is an undecryptable placeholder and the incoming one decrypted. This is the
 *   heal path for "granted channel access, opened the channel before the Sender
 *   Key landed".
 * - A row whose id the LOCAL retention sweep purged is skipped outright. Absence
 *   from `existing` means two very different things — "never seen" and "seen and
 *   deliberately deleted" — and without `purgedIds` this reducer could only read
 *   it as the first, so every retention-purged message came straight back on the
 *   next fetch (and, once its epoch key had also aged out, came back as the
 *   "waiting on this channel's key" placeholder). See utils/retentionTombstones.ts.
 * - A cached PLACEHOLDER inside `serverWindow` that the server no longer
 *   returns is dropped: its ciphertext is gone server-side, so nothing can ever
 *   decrypt it. See `pruneVanishedPlaceholders` for the full argument and for
 *   why decrypted rows are deliberately exempt.
 *
 * Pure: no argument is mutated.
 *
 * @param existing locally-cached thread, chronological
 * @param incoming freshly-decrypted rows (any order; sorted internally)
 * @param purgedIds message ids the local retention sweep deleted on purpose
 * @param serverWindow the slice of history `incoming` completely covers, from
 *                     `coveredServerWindow`. Omit to skip absence detection.
 * @returns a new chronologically-sorted array
 */
export function foldChannelHistory(
    existing: ChannelRow[],
    incoming: ChannelRow[],
    purgedIds: ReadonlySet<string> = new Set(),
    serverWindow?: ServerWindow | null,
): ChannelRow[] {
    const sorted = [...incoming].sort((a, b) => tsOf(a) - tsOf(b));
    const folded: ChannelRow[] = [...existing];
    const existingIds = new Set(existing.map(m => m.id));

    const indexOfTarget = (targetId: string) => folded.findIndex(
        t => t.id === targetId || (t.content as { client_msg_id?: string } | undefined)?.client_msg_id === targetId,
    );

    for (const m of sorted) {
        const c = m.content as (EditContent | DeleteContent | ReactionContent | { type?: string } | undefined);

        // Retention purged this exact message locally. Drop it before any
        // other branch — including the placeholder-upgrade path, which would
        // otherwise re-seat it whenever a stale copy was still cached.
        if (purgedIds.has(m.id)) continue;

        if (c?.type === 'edit') {
            const { target_id, text } = c as EditContent;
            const idx = indexOfTarget(target_id);
            if (idx !== -1) {
                folded[idx] = {
                    ...folded[idx],
                    content: { ...(folded[idx].content as object), text },
                    edited: true,
                };
            }
            // Drop the edit envelope itself once applied.
        } else if (c?.type === 'delete') {
            const idx = indexOfTarget((c as DeleteContent).target_id);
            if (idx !== -1) folded.splice(idx, 1);
        } else if (c?.type === 'reaction') {
            const { target_id, emoji, action } = c as ReactionContent;
            const idx = indexOfTarget(target_id);
            if (idx !== -1) {
                const target = folded[idx];
                const reactions: Record<string, string[]> = { ...(target.reactions || {}) };
                const reactor = (m.sender_user_id || m.sender_device_id) as string;
                const list = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
                const next = action === 'add'
                    ? (list.includes(reactor) ? list : [...list, reactor])
                    : list.filter(id => id !== reactor);
                if (next.length === 0) delete reactions[emoji];
                else reactions[emoji] = next;
                folded[idx] = { ...target, reactions };
            }
        } else if (!existingIds.has(m.id)) {
            // Our own instantly-shown message, still under its local id: the
            // server copy takes over that row rather than adding a second one.
            const adopted = adoptServerCopy(folded, m);
            if (adopted) {
                folded.splice(0, folded.length, ...adopted);
                existingIds.add(m.id);
                continue;
            }
            // Plain message — only insert if we don't already have it.
            folded.push(m);
            existingIds.add(m.id);
        } else if (!isUndecryptablePlaceholder(m)) {
            // We already have this id — but if what we cached was a "couldn't
            // decrypt" placeholder and this copy decrypted, upgrade it in place.
            const idx = folded.findIndex(t => t.id === m.id);
            if (idx !== -1 && isUndecryptablePlaceholder(folded[idx])) folded[idx] = m;
        }
    }

    // Anything the server has hard-deleted can never be decrypted again, so a
    // cached placeholder for it is a permanent lie. Runs last so rows this
    // batch just contributed are already in `folded` (and are protected by
    // their id being in `returnedIds`).
    const pruned = serverWindow
        ? pruneVanishedPlaceholders(folded, new Set(incoming.map(m => m.id)), serverWindow)
        : folded;

    // Keep chronological order in case the fetch returned rows newer than some
    // we appended after older local ones.
    pruned.sort((a, b) => tsOf(a) - tsOf(b));
    return pruned;
}

/**
 * Which cached rows a batch of incoming channel messages will delete when
 * folded via {@link foldChannelHistory} — same target matching (id OR
 * `client_msg_id`) and the same `purgedIds` skip, without duplicating any of
 * that function's other behaviour (edits, reactions, placeholder pruning).
 * Pure, like `foldChannelHistory` itself; never mutates its arguments.
 *
 * The Dashboard call site uses this to unpin a personally-saved ("Save for
 * me") channel message that a delete marker in this batch just removed — the
 * client-side twin of the DM/group case (`dmInbound.deletedDmTargets`).
 * Server-pinned messages don't need this: the server's own
 * `removePinForDeletedMessage` already cleans up `ChannelPin` rows.
 *
 * Returns the REMOVED ROW's own `id` (not `target_id`, which may instead be
 * a `client_msg_id`) — that's what `localChannelPins` is keyed by.
 */
export function deletedChannelTargetIds(
    existing: ChannelRow[],
    incoming: ChannelRow[],
    purgedIds: ReadonlySet<string> = new Set(),
): string[] {
    const sorted = [...incoming].sort((a, b) => tsOf(a) - tsOf(b));
    const folded: ChannelRow[] = [...existing];
    const out: string[] = [];

    const indexOfTarget = (targetId: string) => folded.findIndex(
        t => t.id === targetId || (t.content as { client_msg_id?: string } | undefined)?.client_msg_id === targetId,
    );

    for (const m of sorted) {
        const c = m.content as (DeleteContent | { type?: string } | undefined);
        if (purgedIds.has(m.id)) continue;
        if (c?.type === 'delete') {
            const idx = indexOfTarget((c as DeleteContent).target_id);
            if (idx !== -1) {
                out.push(folded[idx].id);
                folded.splice(idx, 1);
            }
        }
        // Edits, reactions and plain rows never remove a cached row, so
        // they're irrelevant to this function.
    }
    return out;
}
