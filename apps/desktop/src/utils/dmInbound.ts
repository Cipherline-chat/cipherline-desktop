/**
 * The DM pull loop's storage rules, pulled out of Dashboard.tsx so they can be
 * tested without the component.
 *
 * ## Nothing is ACKed that is not on disk (Message integrity §3, 2026-09-24)
 *
 * `POST /v1/messages/ack` DELETES the server's copy of an envelope. The pull
 * loop used to ACK first and only then call `setMessagesState`, whose write to
 * disk `useCoalescedPersist` debounces another 600 ms (and secureLocalStore a
 * further 300 ms). A crash, a kill, or a power cut in that window destroyed the
 * message: gone from the server, never written here. Mobile persists first and
 * then ACKs (cipherline-mobile `src/features/messages/pipeline/pull.ts`); so
 * does this now:
 *
 *   decrypt → merge into the on-disk threads → durable flush → ACK → UI state
 *
 * {@link commitPulledBatch} owns that order. If the persist fails, the stored
 * envelopes are NOT acked; they come back on the next pull, and the caller
 * keeps their decrypted form in memory ({@link CommitResult.carry}) so it never
 * decrypts them twice — a second decrypt of the same ciphertext is a `REPLAY`,
 * a permanent failure that would ACK the only copy away.
 *
 * ## Never silent (Message integrity §2)
 *
 * A message this device cannot decrypt used to be ACKed with no trace but a
 * diagnostics entry: the user never learned it existed. It now becomes a
 * visible placeholder row, stored and ACKed like any other message
 * ({@link decryptFailureOutcome}, {@link undecryptablePlaceholder}). Two
 * failures are still dropped, both deliberately:
 *  - `LEGACY` — a pre-E2EE envelope from before this app encrypted anything;
 *  - `REPLAY` — this device already decrypted exactly this ciphertext. With
 *    persist-before-ACK that almost always means it is already stored and only
 *    the earlier ACK was lost; a placeholder there would sit next to the real
 *    message, telling the user something is missing when nothing is.
 */
import { classifyDecryptFailure, extractE2eeCode, isLegacyEnvelope } from './e2eeErrors';
import * as messageStore from './messageStore';
import { secureLocalStore } from './secureLocalStore';
import { serverOrderIndex } from './messageOrder';

export type ThreadMap = messageStore.ThreadMap;
/** One stored DM row (the shape the thread arrays hold). */
export type DmRow = ThreadMap[string][number];

/** How many transient failures an envelope gets before it becomes a placeholder. */
export const TRANSIENT_STRIKE_LIMIT = 3;

/** `content.kind` of the placeholder row — rendered by ChatPane as a lock pill. */
export const UNDECRYPTABLE_KIND = 'undecryptable';

/** One thing the pull must store before it may ACK the envelope that carried it. */
export interface PulledForStore {
    envelopeId: string;
    conversationId: string;
    message: DmRow;
}

export interface PulledEnvelopeLike {
    envelope_id: string;
    conversation_id: string;
    sent_at_client?: string | null;
    sender_device_id?: string | null;
}

export type DecryptFailureOutcome =
    | { action: 'retry'; strikes: number }
    | { action: 'drop'; why: 'legacy' | 'replay' }
    | { action: 'placeholder'; reason: string };

/**
 * What to do with an envelope whose decrypt threw.
 *
 * Mirrors the RC-3 rules (`classifyDecryptFailure`): a permanent failure is
 * given up on at once, a transient one after {@link TRANSIENT_STRIKE_LIMIT}
 * attempts. What changed is what "give up" means — a placeholder the user can
 * see, not a silent ACK — except for the two drops explained in the module doc.
 */
export function decryptFailureOutcome(error: unknown, priorStrikes: number): DecryptFailureOutcome {
    const message = error instanceof Error ? error.message : String(error);
    if (isLegacyEnvelope(message)) return { action: 'drop', why: 'legacy' };
    const code = extractE2eeCode(message);
    if (code === 'REPLAY') return { action: 'drop', why: 'replay' };
    if (classifyDecryptFailure(error) === 'permanent') {
        return { action: 'placeholder', reason: code ?? 'permanent' };
    }
    const strikes = priorStrikes + 1;
    if (strikes >= TRANSIENT_STRIKE_LIMIT) return { action: 'placeholder', reason: code ?? 'retries_exhausted' };
    return { action: 'retry', strikes };
}

/** Placeholder reasons that mean "decrypted fine, but unusable" rather than
 *  "could not be decrypted" — the row says "couldn't be shown" for these. */
const NOT_SHOWABLE_REASONS = new Set(['malformed', 'unprocessable']);

/** The words a placeholder row (and its notification) shows for `reason`. */
export function placeholderText(reason: unknown): string {
    return typeof reason === 'string' && NOT_SHOWABLE_REASONS.has(reason)
        ? 'A message couldn’t be shown'
        : 'A message couldn’t be decrypted on this device';
}

/**
 * The visible stand-in for a message that could not be shown.
 *
 * `id` is the envelope id: a UUID (so it is a valid `last_read_message_id` if it
 * is ever the newest row — the gateway validates that field as a UUID), and
 * stable across re-pulls, so a retried ACK re-stores the SAME row rather than a
 * second one. Envelope ids are per device, which is why read receipts skip
 * these rows (see `lastReadableMessageId`): another of the user's devices has
 * no message by this id.
 */
export interface PlaceholderRow {
    id: string;
    content: { type: 'system'; kind: typeof UNDECRYPTABLE_KIND; data: { reason: string } };
    sender_user_id: null;
    sender_device_id: string;
    timestamp: string;
    conversation_id: string;
}

export function undecryptablePlaceholder(env: PulledEnvelopeLike, reason: string): PlaceholderRow {
    return {
        id: env.envelope_id,
        content: { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason } },
        // Sealed sender: who sent it is inside the ciphertext we could not open.
        sender_user_id: null,
        sender_device_id: env.sender_device_id ?? '',
        timestamp: env.sent_at_client ?? new Date().toISOString(),
        conversation_id: env.conversation_id,
    };
}

/**
 * May `action` (an edit or a delete) change `target`? Only its author may.
 *
 * This used to compare `sender_device_id` alone. Since sealed sender the pull
 * response carries no sender device, so EVERY message from anyone but this
 * user was stored with `sender_device_id: ''` — and `'' === ''` let any group
 * member edit or delete any other member's message on this desktop. The
 * author is now matched by a NON-EMPTY device id or, failing that, by the
 * `sender_user_id` sealed inside the envelope (the server cannot forge it).
 * Every message from me carries this device's id on this device, whichever of
 * my devices sent it, so an edit from my phone of a message I sent from this
 * desktop still matches.
 */
export function isSameAuthor(
    target: { sender_user_id?: string | null; sender_device_id?: string | null },
    action: { sender_user_id?: string | null; sender_device_id?: string | null },
): boolean {
    // A NON-EMPTY device match: how my own rows match my own actions (both
    // carry this device's id, whichever of my devices sent them — rows I sent
    // from here have no sender_user_id at all), and how a legacy row matches.
    if (target.sender_device_id && target.sender_device_id === action.sender_device_id) return true;
    if (target.sender_user_id && action.sender_user_id) return target.sender_user_id === action.sender_user_id;
    return false;
}

/**
 * Apply a batch of pulled DM messages to a thread map. Pure: returns a new map
 * and never mutates `threads`. Used for BOTH the on-disk merge (before the ACK)
 * and the React state update (after it), so the two can never disagree.
 *
 * Idempotent per message — applying the same batch twice gives the same result
 * — which is what makes re-storing a carried batch, or a state update landing
 * on threads that already hold the merged messages, safe:
 *  - edit / delete: only by the original sender (isSameAuthor), by target id;
 *  - reaction add/remove: set semantics per device;
 *  - pin, profile_update, group_update: no thread row (their side effects run
 *    in the pull loop, outside any reducer);
 *  - everything else is a row, appended once per id.
 */
export function applyIncomingDmMessages(threads: ThreadMap, incoming: ThreadMap): ThreadMap {
    const next: ThreadMap = { ...threads };
    for (const [cId, msgs] of Object.entries(incoming)) {
        const currentThread = [...(next[cId] || [])];
        for (const m of msgs) {
            const type = m?.content?.type;
            if (type === 'edit') {
                const i = currentThread.findIndex(t => t.id === m.content.target_id);
                if (i !== -1 && isSameAuthor(currentThread[i], m)) {
                    currentThread[i] = {
                        ...currentThread[i],
                        content: { ...currentThread[i].content, text: m.content.text },
                        edited: true,
                    };
                }
            } else if (type === 'delete') {
                const i = currentThread.findIndex(t => t.id === m.content.target_id);
                if (i !== -1 && isSameAuthor(currentThread[i], m)) {
                    currentThread.splice(i, 1);
                }
            } else if (type === 'reaction') {
                const i = currentThread.findIndex(t => t.id === m.content.target_id);
                if (i !== -1) {
                    const msg = currentThread[i];
                    const reactions = { ...(msg.reactions || {}) };
                    const rKey = m.content.emoji;
                    let rList: string[] = Array.isArray(reactions[rKey]) ? reactions[rKey] : [];
                    if (m.content.action === 'add') {
                        if (!rList.includes(m.sender_device_id)) rList = [...rList, m.sender_device_id];
                    } else {
                        rList = rList.filter((id: string) => id !== m.sender_device_id);
                    }
                    if (rList.length === 0) delete reactions[rKey];
                    else reactions[rKey] = rList;
                    currentThread[i] = { ...msg, reactions };
                }
            } else if (type === 'pin' || type === 'profile_update' || type === 'group_update') {
                // Not a row. Handled by the pull loop; the branch exists so these
                // don't reach the final append and show up as messages.
            } else if (!currentThread.find(t => t.id === m.id)) {
                // Server order, not arrival order (utils/messageOrder.ts): a
                // row carrying the server's timestamp goes where the server put
                // it — the same place on every device, sender included. Rows
                // without one (older senders' history paths) still append.
                currentThread.splice(serverOrderIndex(currentThread, m), 0, m);
            }
        }
        next[cId] = currentThread;
    }
    return next;
}

/** One delete marker in a pulled batch that actually removed a cached row. */
export interface DeletedDmTarget {
    conversationId: string;
    targetId: string;
}

/**
 * Which pinned-eligible ids a batch of incoming DM/group messages deletes.
 *
 * Mirrors {@link applyIncomingDmMessages}'s own delete authorization exactly
 * (target exists in `threads`, and the delete comes from the original
 * message's author — isSameAuthor) without folding pin-ledger side effects into that
 * pure merge — this file's own doc comment forbids side effects here, and
 * `applyIncomingDmMessages` is also used for the on-disk merge that runs
 * before React state (and thus before `pinnedMessagesState`) exists.
 *
 * The Dashboard call site uses this to unpin, on every one of this user's
 * devices, a personally-pinned DM/group message that a delete in this batch
 * just removed — otherwise `pinnedMessagesState` never learns the message is
 * gone, and the pinned panel shows "message no longer in local history" for
 * a message that was actually deleted rather than merely absent locally.
 *
 * Pure: never mutates `threads` or `incoming`.
 */
export function deletedDmTargets(threads: ThreadMap, incoming: ThreadMap): DeletedDmTarget[] {
    const out: DeletedDmTarget[] = [];
    for (const [conversationId, msgs] of Object.entries(incoming)) {
        const currentThread = [...(threads[conversationId] || [])];
        for (const m of msgs) {
            if (m?.content?.type !== 'delete') continue;
            const i = currentThread.findIndex(t => t.id === m.content.target_id);
            if (i !== -1 && isSameAuthor(currentThread[i], m)) {
                currentThread.splice(i, 1);
                out.push({ conversationId, targetId: m.content.target_id });
            }
        }
    }
    return out;
}

/** Group a batch by conversation, in arrival order. */
export function groupByConversation(items: PulledForStore[]): ThreadMap {
    const out: ThreadMap = {};
    for (const it of items) (out[it.conversationId] ||= []).push(it.message);
    return out;
}

export interface CommitResult {
    /** Stored AND included in the ACK. The caller forgets any carried copy. */
    stored: PulledForStore[];
    /** Decrypted but NOT stored — keep in memory, store before ever acking. */
    carry: PulledForStore[];
    /** Every envelope id sent in the ACK. */
    acked: string[];
    persistError?: unknown;
    /** Set only when the ACK was awaited (the default). */
    ackError?: unknown;
    /** Settles when the ACK has: to the ACK error, or undefined. With
     *  `awaitAck: false` this is the only place an ACK failure shows up. */
    ackDone: Promise<unknown>;
}

/**
 * Store, then ACK. The one place the order is decided.
 *
 * `ackOnly` are envelopes with nothing to store (a legacy or replayed envelope);
 * they are ACKed whether or not the persist succeeds. `toStore` envelopes are
 * ACKed only after `persist` has resolved. `ack` is expected not to throw (the
 * real one, `ackMessageEnvelopes`, cannot), but a throw is still reported
 * rather than lost; an un-ACKed stored envelope is simply delivered again,
 * which the idempotent merge absorbs.
 *
 * `awaitAck: false` returns as soon as the batch is STORED, with the ACK still
 * in flight (`ackDone`). The ordering rule is unchanged — the ACK is still only
 * ever sent after the persist resolved — but the caller can show the messages
 * without first waiting a network round trip for an acknowledgement nobody
 * sees. The caller must await `ackDone` before pulling again, or the next pull
 * would fetch the not-yet-deleted envelopes a second time.
 */
export async function commitPulledBatch(args: {
    toStore: PulledForStore[];
    ackOnly: string[];
    persist: (byConversation: ThreadMap) => Promise<void>;
    ack: (envelopeIds: string[]) => Promise<{ ok: boolean; error?: unknown }>;
}, opts: { awaitAck?: boolean } = {}): Promise<CommitResult> {
    const { toStore, ackOnly, persist, ack } = args;
    let persistError: unknown;
    let persisted = toStore.length === 0;
    if (!persisted) {
        try {
            await persist(groupByConversation(toStore));
            persisted = true;
        } catch (e) {
            persistError = e ?? new Error('persist failed');
        }
    }
    const stored = persisted ? toStore : [];
    const carry = persisted ? [] : toStore;
    const acked = [...ackOnly, ...stored.map(s => s.envelopeId)];
    const ackDone: Promise<unknown> = acked.length === 0
        ? Promise.resolve(undefined)
        : (async () => {
            try {
                const r = await ack(acked);
                return r.ok ? undefined : (r.error ?? new Error('ack failed'));
            } catch (e) {
                return e ?? new Error('ack failed');
            }
        })();
    if (opts.awaitAck === false) return { stored, carry, acked, persistError, ackDone };
    const ackError = await ackDone;
    return { stored, carry, acked, persistError, ackError, ackDone };
}

/**
 * The real `persist` for {@link commitPulledBatch}: merge the batch into the
 * on-disk threads and wait until those records are durable. Throws if either
 * step cannot be completed — the caller must then not ACK.
 */
export async function persistIncomingDms(userId: string, byConversation: ThreadMap): Promise<void> {
    const keys = await messageStore.mergeThreads('dm', userId, byConversation, applyIncomingDmMessages);
    await secureLocalStore.flushDurable(keys);
}
