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
import { sanitizeChannelRefs } from './channelRefs';

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

interface EditContent { type: 'edit'; target_id: string; text: string; channel_refs?: unknown }
interface DeleteContent { type: 'delete'; target_id: string }
interface ReactionContent { type: 'reaction'; target_id: string; emoji: string; action: 'add' | 'remove' }

// ── Who may edit / delete a channel row (F3) ───────────────────────────────
//
// The server authorizes edits (author only) and deletes (author, or
// MANAGE_MESSAGES) from the `action_type` the client DECLARES next to the
// ciphertext; it cannot read the encrypted body. A member could therefore
// post an ordinary message (no action_type) whose encrypted content is an
// edit or delete of someone else's row, and every receiver applied it. So the
// receiver authorizes too:
//
//   • edit   — only the target's author;
//   • delete — the target's author, or a moderator delete the SERVER has
//              confirmed (it tombstones a validated delete's target before
//              fanning the marker out; Dashboard checks that tombstone). In
//              history a validated delete needs no marker at all: the target
//              is served as a tombstone and dropped before decrypting.
//
// The author is the server-labelled `sender_user_id`, which the sender also
// binds inside the AEAD (G4 `_cb`), with the server-labelled device as the
// fallback for rows that carry no user id.

/** Same author for a channel action and its target. */
export function sameChannelAuthor(target: Pick<ChannelRow, 'sender_user_id' | 'sender_device_id'>, action: Pick<ChannelRow, 'sender_user_id' | 'sender_device_id'>): boolean {
    if (target.sender_user_id && action.sender_user_id) return target.sender_user_id === action.sender_user_id;
    return !!target.sender_device_id && target.sender_device_id === action.sender_device_id;
}

/**
 * Index of the row an action targets: an exact row id first; only failing
 * that, a row whose `client_msg_id` matches AND that the actor wrote (the
 * actor's own message still under its local id). `client_msg_id` is chosen by
 * whoever wrote the row, so it must never let one member's action land on
 * another member's row.
 */
export function findChannelActionTarget(thread: ReadonlyArray<ChannelRow>, targetId: string, action: ChannelRow): number {
    if (typeof targetId !== 'string' || !targetId) return -1;
    const exact = thread.findIndex(t => t.id === targetId);
    if (exact !== -1) return exact;
    return thread.findIndex(t => (t.content as { client_msg_id?: unknown } | undefined)?.client_msg_id === targetId
        && sameChannelAuthor(t, action));
}

export interface ChannelActionOptions {
    /** Target row ids whose deletion the server has confirmed (tombstoned). */
    moderatorDeleteTargets?: ReadonlySet<string>;
}

/** Whether `action` (an edit or a delete) may change `target`. */
export function channelActionAllowed(target: ChannelRow, action: ChannelRow, kind: 'edit' | 'delete', opts: ChannelActionOptions = {}): boolean {
    if (sameChannelAuthor(target, action)) return true;
    return kind === 'delete' && !!opts.moderatorDeleteTargets?.has(target.id);
}

/**
 * Apply one edit or delete to a thread, authorized as above. Pure; returns the
 * same array when nothing applies. Shared by the history fold and the live
 * channel-message path so the two cannot disagree.
 */
export function applyChannelEditDelete<T extends ChannelRow>(thread: T[], action: ChannelRow, opts: ChannelActionOptions = {}): T[] {
    const c = action.content as (EditContent | DeleteContent | undefined);
    if (c?.type !== 'edit' && c?.type !== 'delete') return thread;
    const idx = findChannelActionTarget(thread, c.target_id, action);
    if (idx === -1 || !channelActionAllowed(thread[idx], action, c.type, opts)) return thread;
    const next = [...thread];
    if (c.type === 'edit') {
        next[idx] = { ...next[idx], content: editedContent(next[idx].content, c.text, c.channel_refs), edited: true };
    } else {
        next.splice(idx, 1);
    }
    return next;
}

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
 * The content of a message after an edit is applied.
 *
 * An edit carries the message's complete new text, so it does not need the
 * original at all. When the target is a "couldn't decrypt" placeholder — the
 * original is under an epoch this reader lacks, but the edit (always written
 * under the current epoch) decrypted — the edit becomes the message: a text
 * row with the latest text. Merging the text into the placeholder instead (as
 * this used to) left `type: 'system', kind: 'encrypted'` in place, so the
 * reader kept seeing "waiting on this channel's key" for a message whose
 * latest text it held. A later real decrypt of the original never downgrades
 * it back: the upgrade path only replaces PLACEHOLDERS.
 */
export function editedContent(targetContent: unknown, text: string, channelRefs?: unknown): Record<string, unknown> {
    // `#channel` links (utils/channelRefs.ts) travel with the text they mark,
    // so the edit's own `channel_refs` REPLACES the original's — absent means
    // the new text names no channel. Keeping the old array would let a link
    // re-attach to a `#name` the edit typed by hand. Validated on the way in
    // (sender-controlled), and never written as an empty array.
    const refs = sanitizeChannelRefs(channelRefs);
    const withRefs = (c: Record<string, unknown>): Record<string, unknown> => {
        const rest = { ...c };
        delete rest.channel_refs;
        return refs.length > 0 ? { ...rest, channel_refs: refs } : rest;
    };
    if (isUndecryptablePlaceholder({ content: targetContent })) return withRefs({ type: 'text', text });
    return withRefs({ ...(targetContent as object), text });
}

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
    actionOpts: ChannelActionOptions = {},
): ChannelRow[] {
    const sorted = [...incoming].sort((a, b) => tsOf(a) - tsOf(b));
    const folded: ChannelRow[] = [...existing];
    const existingIds = new Set(existing.map(m => m.id));

    // Reactions only: a reaction is attributed to its own (server-labelled)
    // sender, so it cannot act as anyone else and keeps the permissive match.
    const indexOfReactionTarget = (targetId: string) => {
        const exact = folded.findIndex(t => t.id === targetId);
        return exact !== -1 ? exact : folded.findIndex(t => (t.content as { client_msg_id?: string } | undefined)?.client_msg_id === targetId);
    };

    for (const m of sorted) {
        const c = m.content as (EditContent | DeleteContent | ReactionContent | { type?: string } | undefined);

        // Retention purged this exact message locally. Drop it before any
        // other branch — including the placeholder-upgrade path, which would
        // otherwise re-seat it whenever a stale copy was still cached.
        if (purgedIds.has(m.id)) continue;

        // An edit / delete / reaction that once could NOT be decrypted was
        // cached as a "couldn't decrypt" placeholder under its own id — nothing
        // could tell it was an action. Now that it decrypts, it is applied
        // below and, like every action envelope, must not stay in the thread:
        // drop its placeholder. Without this the upgrade path never reached it
        // (that path only handles plain rows), so the pill stayed in the middle
        // of fully readable history for good, even after the key arrived.
        if (c?.type === 'edit' || c?.type === 'delete' || c?.type === 'reaction') {
            const self = folded.findIndex(t => t.id === m.id);
            if (self !== -1 && isUndecryptablePlaceholder(folded[self])) folded.splice(self, 1);
        }

        if (c?.type === 'edit' || c?.type === 'delete') {
            // F3: the author, or a moderator delete the caller had the server
            // confirm (actionOpts). An unconfirmed foreign delete is dropped;
            // a validated one also reaches history as the target's tombstone.
            const applied = applyChannelEditDelete(folded, m, actionOpts);
            if (applied !== folded) folded.splice(0, folded.length, ...applied);
            // Either way the action envelope itself is never a row.
        } else if (c?.type === 'reaction') {
            const { target_id, emoji, action } = c as ReactionContent;
            const idx = indexOfReactionTarget(target_id);
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
    opts: ChannelActionOptions = {},
): string[] {
    const sorted = [...incoming].sort((a, b) => tsOf(a) - tsOf(b));
    const folded: ChannelRow[] = [...existing];
    const out: string[] = [];

    for (const m of sorted) {
        const c = m.content as (DeleteContent | { type?: string } | undefined);
        if (purgedIds.has(m.id)) continue;
        if (c?.type === 'delete') {
            // Same target matching and authorization as the fold (F3).
            const idx = findChannelActionTarget(folded, (c as DeleteContent).target_id, m);
            if (idx !== -1 && channelActionAllowed(folded[idx], m, 'delete', opts)) {
                out.push(folded[idx].id);
                folded.splice(idx, 1);
            }
        }
        // Edits, reactions and plain rows never remove a cached row, so
        // they're irrelevant to this function.
    }
    return out;
}
