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
import { betaReporter, isBetaActive } from './reporter';
import { decideRatingPrompt, readRatingLedger, writeRatingLedger } from './settings';
import type { CallEndReason, CallType } from './types';

let active: { acc: CallSummaryAccumulator; startedAt: number; token: number } | null = null;
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
        active = { acc: new CallSummaryAccumulator({ callType: o.callType, e2ee: o.e2ee, startedAt: now }), startedAt: now, token };
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
 * The call is over (CallPane unmounted). Builds the summary; sends it when
 * beta diagnostics is active; and decides whether the rating card shows.
 */
export function endBetaCall(token: number, now = Date.now()): void {
    try {
        if (!active || active.token !== token) return;
        const { acc, startedAt } = active;
        active = null;
        if (!isBetaActive()) return;
        const summary = acc.finish(now);
        const id = betaReporter.sendCallSummary(summary);
        if (!id || !userId) return;
        const seconds = (now - startedAt) / 1000;
        const ledger = readRatingLedger(userId);
        const d = decideRatingPrompt(ledger, seconds, now);
        writeRatingLedger(userId, d.next);
        if (d.show) showRatingCard({ callSummaryId: id, callType: summary.call_type });
    } catch { /* diagnostics only */ }
}

// ── rating card store ──────────────────────────────────────────────────────

export interface RatingCardState { callSummaryId: string; callType: CallType }
let card: RatingCardState | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* isolate */ } } };

export function showRatingCard(s: RatingCardState): void { card = { ...s }; emit(); }
export function dismissRatingCard(): void { if (card) { card = null; emit(); } }
export function getRatingCard(): RatingCardState | null { return card; }
export function subscribeRatingCard(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
export function useRatingCard(): RatingCardState | null {
    return useSyncExternalStore(subscribeRatingCard, getRatingCard, () => null);
}

/** Test hook. */
export function __resetBetaCallForTests(): void {
    active = null;
    card = null;
    userId = null;
    listeners.clear();
}
