/**
 * Beta diagnostics — the one live call (there is never more than one), from
 * CallPane mount to unmount: its summary accumulator, its end reason, and the
 * rating card that may follow it.
 *
 * CallPane calls beginBetaCall() on mount and endBetaCall() on unmount; the
 * places that know WHY a call ended (a failed connect, an E2EE failure, the
 * Leave button, LiveKit's disconnect reason) call noteBetaCallEnd(). The
 * summary is computed at end — from samples the accumulator collected through
 * the bridges — and is SENT only if beta diagnostics is active.
 */
import { useSyncExternalStore } from 'react';
import { CallSummaryAccumulator } from './callSummary';
import { betaReporter, isBetaActive, type CallSummaryInput } from './reporter';
import { decideRatingPrompt, readRatingLedger, writeRatingLedger } from './settings';
import type { CallEndReason, CallType, RatingTag } from './types';

let active: { acc: CallSummaryAccumulator; startedAt: number; token: number; callType: CallType } | null = null;
let seq = 0;
/** The signed-in account (the host keeps it current) — the rating ledger is per account. */
let userId: string | null = null;
export function setBetaCallUser(id: string | null): void { userId = id; }

export function getActiveCallSummary(): CallSummaryAccumulator | null {
    return active?.acc ?? null;
}

/** CallPane mounted for a new call. Returns a token for endBetaCall (StrictMode-safe). */
export function beginBetaCall(o: { callType: CallType; e2ee: boolean }, now = Date.now()): number {
    try {
        const token = ++seq;
        active = { acc: new CallSummaryAccumulator({ callType: o.callType, e2ee: o.e2ee, startedAt: now }), startedAt: now, token, callType: o.callType };
        return token;
    } catch {
        return -1;
    }
}

export function noteBetaCallEnd(reason: CallEndReason): void {
    try { active?.acc.noteEndReason(reason); } catch { /* diagnostics only */ }
}

export function noteBetaPeers(n: number): void {
    try { active?.acc.notePeers(n); } catch { /* diagnostics only */ }
}

/**
 * The call is over (CallPane unmounted). Decides whether the rating card
 * shows, and — ONLY when beta diagnostics is active — builds and queues the
 * call summary.
 *
 * The rating card is NOT gated on the "Share beta diagnostics" toggle: a
 * rating, and the call-quality reports a low one offers, are explicit user
 * actions. Nothing automatic is sent for a user with the toggle off — the
 * summary (the automatic part) is skipped, so such a card carries
 * `callSummaryId: null` and its rating stays on the device.
 */
export function endBetaCall(token: number, now = Date.now()): void {
    try {
        if (!active || active.token !== token) return;
        const { acc, startedAt, callType } = active;
        active = null;
        let id: string | null = null;
        let held: CallSummaryInput | undefined;
        const summary = acc.finish(now);
        if (isBetaActive()) id = betaReporter.sendCallSummary(summary);
        else held = summary; // toggle off: kept with the card, sent only if the user rates
        if (!userId) return;
        const seconds = (now - startedAt) / 1000;
        const ledger = readRatingLedger(userId);
        const d = decideRatingPrompt(ledger, seconds, now);
        writeRatingLedger(userId, d.next);
        if (d.show) showRatingCard({ callSummaryId: id, callType, heldSummary: held });
    } catch { /* diagnostics only */ }
}

// ── rating card store ──────────────────────────────────────────────────────

export interface RatingCardState {
    /** The queued summary this rating attaches to; null when nothing was sent automatically (toggle off). */
    callSummaryId: string | null;
    callType: CallType;
    /**
     * Toggle off: this call's summary, computed but NOT sent. It goes out only
     * together with the rating, if the user submits one (see
     * BetaReporter.sendRatedSummary). Dismissing the card drops it.
     */
    heldSummary?: CallSummaryInput;
    /** Bumped per card so a new card remounts cleanly. */
    nonce?: number;
}
let cardSeq = 0;
let card: RatingCardState | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* isolate */ } } };

export function showRatingCard(s: RatingCardState): void { card = { ...s, nonce: ++cardSeq }; emit(); }
export function dismissRatingCard(): void { if (card) { card = null; emit(); } }
export function getRatingCard(): RatingCardState | null { return card; }
export function subscribeRatingCard(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
export function useRatingCard(): RatingCardState | null {
    return useSyncExternalStore(subscribeRatingCard, getRatingCard, () => null);
}

/**
 * The user submitted a rating on the card. Toggle on: it rides the queued
 * summary. Toggle off: the held summary + rating go out as one body (server
 * gate still applies). Nothing held and nothing queued: nothing is sent.
 */
export function submitCallRating(c: RatingCardState, rating: 1 | 2 | 3 | 4 | 5, tags: readonly RatingTag[] = []): void {
    try {
        if (c.callSummaryId) betaReporter.rateCall(c.callSummaryId, rating, tags);
        else if (c.heldSummary) void betaReporter.sendRatedSummary(c.heldSummary, rating, tags);
    } catch { /* diagnostics only */ }
}

/** Test hook. */
export function __resetBetaCallForTests(): void {
    active = null;
    card = null;
    userId = null;
    listeners.clear();
}
