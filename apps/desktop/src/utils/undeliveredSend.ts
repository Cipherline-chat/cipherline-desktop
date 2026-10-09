/**
 * "Looks sent, flags itself if it isn't" — the clock behind the red "!".
 *
 * A message put in the feed by instant send (utils/pendingSend.ts) renders
 * exactly like a delivered one. Only when it has gone UNDELIVERED does it get
 * a small red "!" beside it:
 *   - the delivery queue reported a definitive failure (`send_state: 'failed'`
 *     — shown at once), or
 *   - it has stayed `'sending'` for UNDELIVERED_AFTER_MS without the server
 *     confirming it (the slow / stuck case).
 *
 * The 10 s clock is deliberately NOT stored on the message: it is local UI
 * state, it must restart on Retry, and a persisted copy would only ever be
 * stale after a restart (an interrupted 'sending' row is settled to 'failed'
 * at load anyway — settleInterruptedSends). It lives in a module-level map
 * keyed by client_msg_id so it survives a ChatPane remount (switching
 * conversation and back must not give a stuck message a fresh 10 s).
 *
 * A late confirmation needs no code here: confirmation removes `send_state`
 * from the row, and a row with no `send_state` is never undelivered.
 */

import type React from 'react';
import type { ContextMenuItem } from '../components/primitives/ContextMenu';
import type { SendMarked } from './pendingSend';

export const UNDELIVERED_AFTER_MS = 10_000;
/** Safety cap on tracked ids (a leak guard — entries normally clear on their own). */
const MAX_TRACKED = 500;

const clientIdOf = (m: SendMarked): string | undefined =>
    (m.content as { client_msg_id?: string } | undefined)?.client_msg_id;

export interface SendClock {
    /** Sync the clock with a thread: start timing new 'sending' rows, forget settled ones. */
    reconcile(thread: readonly SendMarked[]): void;
    /** (Re)start the 10 s clock for a message — Retry. */
    restart(clientMsgId: string): void;
    /** Should this row carry the red "!" right now? */
    isUndelivered(msg: SendMarked | null | undefined): boolean;
    /** ms until the next still-pending row crosses the line, or null if none will. */
    msUntilNextDue(thread: readonly SendMarked[]): number | null;
}

export function createSendClock(now: () => number = Date.now): SendClock {
    const starts = new Map<string, number>();
    const track = (cid: string) => {
        starts.set(cid, now());
        if (starts.size > MAX_TRACKED) {
            const oldest = starts.keys().next().value;
            if (oldest !== undefined) starts.delete(oldest);
        }
    };
    return {
        reconcile(thread) {
            for (const m of thread) {
                const cid = m ? clientIdOf(m) : undefined;
                if (!cid) continue;
                if (m.send_state === 'sending') {
                    if (!starts.has(cid)) track(cid);
                } else {
                    // failed (shown at once, no clock) or confirmed: nothing to time.
                    starts.delete(cid);
                }
            }
        },
        restart(clientMsgId) {
            starts.delete(clientMsgId);
            track(clientMsgId);
        },
        isUndelivered(msg) {
            if (!msg) return false;
            if (msg.send_state === 'failed') return true;
            if (msg.send_state !== 'sending') return false;
            const cid = clientIdOf(msg);
            const start = cid ? starts.get(cid) : undefined;
            return start !== undefined && now() - start >= UNDELIVERED_AFTER_MS;
        },
        msUntilNextDue(thread) {
            let next: number | null = null;
            for (const m of thread) {
                if (m?.send_state !== 'sending') continue;
                const cid = clientIdOf(m);
                const start = cid ? starts.get(cid) : undefined;
                if (start === undefined) continue;
                const left = start + UNDELIVERED_AFTER_MS - now();
                if (left > 0 && (next === null || left < next)) next = left;
            }
            return next;
        },
    };
}

/** The app-wide clock (survives ChatPane remounts, like the delivery queue). */
export const sendClock = createSendClock();

// ── Late-success ledger ─────────────────────────────────────────────────────
// Retry re-enqueues the SAME client_msg_id. If the earlier attempt lands while
// the retry is still waiting its turn in the queue, the retry must not POST a
// second copy. (Receivers also dedupe on client_msg_id; this just avoids
// sending the duplicate at all.)
const delivered = new Set<string>();
export function markDelivered(clientMsgId: string): void {
    delivered.add(clientMsgId);
    if (delivered.size > MAX_TRACKED) {
        const oldest = delivered.values().next().value;
        if (oldest !== undefined) delivered.delete(oldest);
    }
}
export const wasDelivered = (clientMsgId: string): boolean => delivered.has(clientMsgId);

// Discard: a message the user threw away must not be POSTed by an attempt that
// is still waiting in the queue. (An attempt already on the wire cannot be
// recalled — the honest limit of discarding something that is merely slow.)
const cancelled = new Set<string>();
export function markCancelled(clientMsgId: string): void {
    cancelled.add(clientMsgId);
    if (cancelled.size > MAX_TRACKED) {
        const oldest = cancelled.values().next().value;
        if (oldest !== undefined) cancelled.delete(oldest);
    }
}
export const wasCancelled = (clientMsgId: string): boolean => cancelled.has(clientMsgId);
/** Retry of a discarded-then-restored message does not exist; but a Retry always clears a stale cancel. */
export const clearCancelled = (clientMsgId: string): void => { cancelled.delete(clientMsgId); };

// ── Right-click menu for an undelivered message ─────────────────────────────
export const UNDELIVERED_LABEL = 'Message not delivered';

export interface UndeliveredMenuHandlers {
    onRetry: () => void;
    onDiscard: () => void;
    /** Present only for a text message. */
    onCopyText?: () => void;
    icons?: { retry?: React.ReactNode; discard?: React.ReactNode; copy?: React.ReactNode };
}

/**
 * The context menu of a message that did not go through. It is the only menu
 * such a message gets: everything else in the normal one (react, reply, pin,
 * delete-for-everyone, copy id…) targets a server row that does not exist yet.
 * The header comes from the menu's `title`.
 */
export function undeliveredMenu(h: UndeliveredMenuHandlers): { title: string; items: ContextMenuItem[] } {
    const items: ContextMenuItem[] = [
        { icon: h.icons?.retry, label: 'Retry send', onSelect: h.onRetry },
        { icon: h.icons?.discard, label: 'Discard', danger: true, onSelect: h.onDiscard },
    ];
    if (h.onCopyText) {
        items.push({ divider: true }, { icon: h.icons?.copy, label: 'Copy Text', onSelect: h.onCopyText });
    }
    return { title: UNDELIVERED_LABEL, items };
}
