/**
 * Instant reactions: clicking a reaction changes the chip (and its count) on
 * the spot; the send happens behind it, and a failure stays ON THE CHIP (red,
 * with Retry / Remove) instead of silently taking the reaction back.
 *
 * How reactions travel: a reaction is an E2EE `{ type: 'reaction', target_id,
 * emoji, action: 'add' | 'remove' }` content message, sent exactly like a chat
 * message (channel Sender Key -> POST /channels/:id/messages, or per-device
 * envelopes -> POST /messages/send). Receivers fold it into the target
 * message's `reactions` map: emoji -> list of reactor ids, with SET semantics
 * (add = include once, remove = filter out). That is why this file never
 * counts: it only decides whether "me" is in a list.
 *
 * This module is the local, in-memory overlay on top of that map. It owns:
 *   - what the user last asked for, per (conversation, message, emoji);
 *   - one request at a time per key, coalescing rapid toggles so the LAST
 *     intent wins (add -> remove -> add sends one add; add -> remove before the
 *     add left sends nothing);
 *   - the failed / slow state that turns the chip red;
 *   - reconciliation with the confirmed state (`msg.reactions`), which arrives
 *     by the HTTP response, a WS echo, or history sync - in ANY order.
 *
 * Reconciliation key: (convKey, msgId, emoji) + "is my reactor id in the list".
 * No nonce is needed because the map is a set: the optimistic add and the
 * server's copy of the same add are the same membership, so they can never
 * count twice, whichever lands first.
 *
 * The overlay is deliberately NOT written into the stored messages: a failed or
 * in-flight reaction never reaches `msg.reactions`, so it is never persisted,
 * never backed up, and never shown to anyone else. It does not survive an app
 * restart (the same reaction, if it did reach the server, comes back through
 * the normal history path).
 */

import { UNDELIVERED_AFTER_MS } from './undeliveredSend';
import { retryAfterMs } from './deliveryQueue';
import { sendFailureReason } from './pendingSend';

export type ReactionIntent = 'add' | 'remove';

export interface PendingReaction {
    readonly key: string;
    readonly convKey: string;
    readonly msgId: string;
    readonly emoji: string;
    /** What the user wants right now. */
    readonly intent: ReactionIntent;
    /** Whether this device's reaction existed when the entry was created. */
    readonly baseHad: boolean;
    /** The last intent the server acknowledged (null = nothing sent yet). */
    readonly confirmed: ReactionIntent | null;
    /** 'failed' = the last attempt was refused or timed out. */
    readonly state: 'pending' | 'failed';
    /** Still unanswered after UNDELIVERED_AFTER_MS: drawn red like a failure. */
    readonly slow: boolean;
    /** Short reason for a failure ("No connection", "Timed out", ...). */
    readonly error?: string;
    /** A request is on the wire / a pump is running. */
    readonly inFlight: boolean;
    /** Sent and acknowledged; waiting only for `msg.reactions` to show it. */
    readonly settled: boolean;
    /** Bumped on every (re)start so a superseded attempt can tell it was. */
    readonly attempt: number;
}

/** Sends one reaction. Must throw on failure; should honour `signal`. */
export type ReactionSend = (intent: ReactionIntent, signal: AbortSignal) => Promise<void>;

/** How long an acknowledged entry may wait for `msg.reactions` to catch up. */
export const SETTLED_GRACE_MS = 5_000;

const keyOf = (convKey: string, msgId: string, emoji: string) => `${convKey}\u0000${msgId}\u0000${emoji}`;
const msgKeyOf = (convKey: string, msgId: string) => `${convKey}\u0000${msgId}`;

/** What the server holds for this device's reaction, as far as we know. */
const ackedOf = (e: PendingReaction): ReactionIntent => e.confirmed ?? (e.baseHad ? 'add' : 'remove');

export const REACTION_ADD_FAILED = 'Reaction failed to send';
export const REACTION_REMOVE_FAILED = "Couldn't remove reaction";

/** The words on a red chip: what did not happen. */
export const reactionFailureTitle = (kind: ReactionIntent): string =>
    kind === 'add' ? REACTION_ADD_FAILED : REACTION_REMOVE_FAILED;

/** Short reason for a failed reaction, from whatever was thrown. */
export function reactionFailureReason(err: unknown): string {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403) return "You don't have permission to react here";
    const r = sendFailureReason(err);
    return r === 'Not delivered' ? 'Not sent' : r;
}

export interface ReactionStore {
    /** The user clicked this reaction. Flips the intent and (re)starts delivery. */
    toggle(args: { convKey: string; msgId: string; emoji: string; baseHas: boolean; send: ReactionSend }): void;
    /** Retry a failed / slow reaction (aborts a stuck attempt first). */
    retry(key: string, send: ReactionSend): void;
    /** Drop the local state: a failed add vanishes, a failed remove is kept as it was. */
    discard(key: string): void;
    get(key: string): PendingReaction | undefined;
    /** Entries for one message; the array identity only changes when they do. */
    forMessage(convKey: string, msgId: string): readonly PendingReaction[] | undefined;
    hasEntries(convKey: string): boolean;
    /**
     * Fold the confirmed state in. `baseHas(msgId, emoji)` says whether this
     * device's reaction is in `msg.reactions` (undefined = message not loaded).
     */
    reconcile(convKey: string, baseHas: (msgId: string, emoji: string) => boolean | undefined): void;
    subscribe(fn: () => void): () => void;
    getVersion(): number;
    /** Resolves when no delivery is running (tests). */
    idle(): Promise<void>;
}

export function createReactionStore(now: () => number = Date.now): ReactionStore {
    const entries = new Map<string, PendingReaction>();
    const sends = new Map<string, ReactionSend>();
    const ctrls = new Map<string, AbortController>();
    const slowTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const sweepTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const retryAfterAt = new Map<string, number>();
    const byMsg = new Map<string, readonly PendingReaction[]>();
    const listeners = new Set<() => void>();
    const running = new Set<Promise<void>>();
    let version = 0;

    const emit = () => { version++; for (const l of [...listeners]) l(); };

    const rebuild = (e: { convKey: string; msgId: string }) => {
        const mk = msgKeyOf(e.convKey, e.msgId);
        const list = [...entries.values()].filter(x => x.convKey === e.convKey && x.msgId === e.msgId);
        if (list.length) byMsg.set(mk, list); else byMsg.delete(mk);
    };

    const clearTimers = (key: string) => {
        const s = slowTimers.get(key); if (s) { clearTimeout(s); slowTimers.delete(key); }
        const w = sweepTimers.get(key); if (w) { clearTimeout(w); sweepTimers.delete(key); }
    };

    const remove = (key: string) => {
        const e = entries.get(key);
        if (!e) return;
        clearTimers(key);
        ctrls.get(key)?.abort();
        ctrls.delete(key);
        sends.delete(key);
        retryAfterAt.delete(key);
        entries.delete(key);
        rebuild(e);
        emit();
    };

    const patch = (key: string, p: Partial<PendingReaction>): PendingReaction | undefined => {
        const e = entries.get(key);
        if (!e) return undefined;
        const next = { ...e, ...p } as PendingReaction;
        entries.set(key, next);
        rebuild(next);
        emit();
        return next;
    };

    /** (Re)start the "still unanswered" clock. */
    const startSlowClock = (key: string) => {
        const old = slowTimers.get(key); if (old) clearTimeout(old);
        const t = setTimeout(() => {
            slowTimers.delete(key);
            const e = entries.get(key);
            if (e && e.state === 'pending' && !e.settled && !e.slow) patch(key, { slow: true });
        }, UNDELIVERED_AFTER_MS);
        slowTimers.set(key, t);
    };

    const settle = (key: string) => {
        const e = entries.get(key);
        if (!e) return;
        // Nothing was ever sent and the user is back where they started.
        if (e.confirmed === null) { remove(key); return; }
        clearTimers(key);
        patch(key, { inFlight: false, settled: true, slow: false, state: 'pending', error: undefined });
        // Safety net: if msg.reactions never shows it (message gone), let go.
        sweepTimers.set(key, setTimeout(() => { sweepTimers.delete(key); remove(key); }, SETTLED_GRACE_MS));
    };

    async function pump(key: string, attempt: number): Promise<void> {
        for (;;) {
            const e = entries.get(key);
            if (!e || e.attempt !== attempt) return;
            const acked = ackedOf(e);
            if (e.intent === acked) { settle(key); return; }

            // A 429 told us when to come back; honour it before the Retry goes out.
            const wait = (retryAfterAt.get(key) ?? 0) - now();
            if (wait > 0) {
                await new Promise<void>(r => setTimeout(r, wait));
                const again = entries.get(key);
                if (!again || again.attempt !== attempt) return;
            }
            retryAfterAt.delete(key);

            const sent = e.intent;
            const send = sends.get(key);
            if (!send) return;
            const ctrl = new AbortController();
            ctrls.set(key, ctrl);
            try {
                await send(sent, ctrl.signal);
            } catch (err) {
                const cur = entries.get(key);
                if (!cur || cur.attempt !== attempt) return; // discarded or superseded by Retry
                ctrls.delete(key);
                if (cur.intent === sent) {
                    const wait429 = (err as { response?: { status?: number } } | null)?.response?.status === 429
                        ? retryAfterMs(err) : undefined;
                    if (wait429) retryAfterAt.set(key, now() + wait429);
                    const t = slowTimers.get(key); if (t) { clearTimeout(t); slowTimers.delete(key); }
                    patch(key, { state: 'failed', slow: false, inFlight: false, error: reactionFailureReason(err) });
                    return;
                }
                // The user changed their mind while this was out: judge the new intent.
                continue;
            }
            const cur = entries.get(key);
            if (!cur || cur.attempt !== attempt) return;
            ctrls.delete(key);
            patch(key, { confirmed: sent });
        }
    }

    const start = (key: string) => {
        const e = entries.get(key);
        if (!e) return;
        const attempt = e.attempt + 1;
        const grace = sweepTimers.get(key); if (grace) { clearTimeout(grace); sweepTimers.delete(key); }
        patch(key, { attempt, inFlight: true, settled: false, state: 'pending', slow: false, error: undefined });
        startSlowClock(key);
        const p = pump(key, attempt).finally(() => { running.delete(p); });
        running.add(p);
    };

    return {
        toggle({ convKey, msgId, emoji, baseHas, send }) {
            const key = keyOf(convKey, msgId, emoji);
            const existing = entries.get(key);
            sends.set(key, send);
            if (!existing) {
                const e: PendingReaction = {
                    key, convKey, msgId, emoji,
                    intent: baseHas ? 'remove' : 'add', baseHad: baseHas, confirmed: null,
                    state: 'pending', slow: false, inFlight: false, settled: false, attempt: 0,
                };
                entries.set(key, e);
                rebuild(e);
                start(key);
                return;
            }
            const intent: ReactionIntent = existing.intent === 'add' ? 'remove' : 'add';
            const acked = ackedOf(existing);
            if (!existing.inFlight && intent === acked && existing.confirmed === null) {
                // Back to what the server already has: nothing to send.
                remove(key);
                return;
            }
            patch(key, { intent });
            if (existing.inFlight) {
                // The running pump picks the new intent up when its request ends.
                startSlowClock(key);
                patch(key, { slow: false });
            } else {
                start(key);
            }
        },

        retry(key, send) {
            const e = entries.get(key);
            if (!e) return;
            sends.set(key, send);
            ctrls.get(key)?.abort();
            ctrls.delete(key);
            start(key);
        },

        discard(key) { remove(key); },

        get: key => entries.get(key),
        forMessage: (convKey, msgId) => byMsg.get(msgKeyOf(convKey, msgId)),
        hasEntries(convKey) {
            for (const e of entries.values()) if (e.convKey === convKey) return true;
            return false;
        },

        reconcile(convKey, baseHas) {
            for (const e of [...entries.values()]) {
                if (e.convKey !== convKey) continue;
                const has = baseHas(e.msgId, e.emoji);
                const satisfied = has !== undefined && has === (e.intent === 'add');
                if (e.settled || e.state === 'failed') {
                    // Settled: the confirmed state caught up. Failed: it caught up
                    // anyway (an attempt we gave up on landed). Either way nothing
                    // is left to show. A vanished message leaves nothing to show.
                    if (has === undefined || satisfied) remove(e.key);
                } else if (satisfied && e.slow) {
                    // Still awaiting the HTTP answer, but the echo already
                    // proves the server has it: not red any more.
                    patch(e.key, { slow: false });
                }
            }
        },

        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        getVersion: () => version,
        async idle() { while (running.size) await Promise.allSettled([...running]); },
    };
}

/** The app-wide store (survives ChatPane remounts, like the delivery queue). */
export const reactionStore = createReactionStore();

// ── Overlay ────────────────────────────────────────────────────────────────

export interface ReactionFailure {
    key: string;
    kind: ReactionIntent;
    reason?: string;
}

export interface AppliedReactions {
    reactions: Record<string, string[]> | undefined;
    /** Emoji -> failure, for the chips to draw red. */
    failures: Record<string, ReactionFailure>;
}

const NO_FAILURES: Record<string, ReactionFailure> = Object.freeze({}) as Record<string, ReactionFailure>;

/** A chip that is red: failed outright, or unanswered for too long. */
export const isFailedView = (e: PendingReaction): boolean => e.state === 'failed' || e.slow;

/**
 * `reactions` as the user should see them: confirmed state with the pending
 * intents laid over it. `mineKeys` = every id this device's reaction can be
 * stored under (user id in channels, plus device id); `selfId` = the one
 * appended for an optimistic add.
 *
 * Failed REMOVE: the chip is restored (the reaction is still yours), flagged.
 * Failed ADD: the chip stays with your reaction counted, flagged.
 */
export function applyPendingReactions(
    reactions: Record<string, unknown> | undefined,
    pending: readonly PendingReaction[] | undefined,
    mineKeys: readonly string[],
    selfId: string,
): AppliedReactions {
    if (!pending || pending.length === 0) {
        return { reactions: reactions as Record<string, string[]> | undefined, failures: NO_FAILURES };
    }
    const out: Record<string, string[]> = {};
    for (const [emoji, ids] of Object.entries(reactions ?? {})) out[emoji] = Array.isArray(ids) ? ids as string[] : [];
    const failures: Record<string, ReactionFailure> = {};
    const isMine = (id: string) => mineKeys.includes(id);
    for (const e of pending) {
        const ids = out[e.emoji] ?? [];
        const failed = isFailedView(e);
        // A failed remove is shown as not-removed.
        const showAs: ReactionIntent = failed && e.intent === 'remove' ? 'add' : e.intent;
        if (showAs === 'add') {
            if (!ids.some(isMine)) out[e.emoji] = [...ids, selfId];
        } else {
            const rest = ids.filter(id => !isMine(id));
            if (rest.length) out[e.emoji] = rest; else delete out[e.emoji];
        }
        if (failed) failures[e.emoji] = { key: e.key, kind: e.intent, reason: e.error };
    }
    return { reactions: out, failures };
}
