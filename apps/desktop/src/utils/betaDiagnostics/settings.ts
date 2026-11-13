/**
 * Beta diagnostics — the user's side: the "Share beta diagnostics" toggle
 * (OPT-IN: default OFF), whether the one-time consent ask was answered, and
 * the rating card's frequency bookkeeping.
 *
 * Why opt-in: these reports are account-linked (sent with the user's token and
 * device id). Until 2026-11 the toggle defaulted ON with an after-the-fact
 * notice; that is not acceptable for a public release whose privacy policy
 * does not describe this data. Nothing is sent unless the user explicitly
 * said yes on this device. A user who never answered is OFF.
 *
 * STORAGE: per account, in secureLocalStore (encrypted at rest), like the
 * crash-report auto-send opt-in next to it. All three keys are EXCLUDED from
 * backups (services/backupRegistry.ts): consent is given on each device and
 * never restored onto another; the rest is local bookkeeping. Keys are
 * written as literal templates at each call site so backupRegistry.test.ts's
 * source scan sees them.
 */
import { useSyncExternalStore } from 'react';
import secureLocalStore from '../secureLocalStore';

const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* isolate */ } } };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Opt-in: only an explicit '1' (the user said yes) turns it on. Unreadable store → off. */
export function getBetaDiagEnabled(userId: string | null | undefined): boolean {
    if (!userId) return false;
    try { return secureLocalStore.getItem(`cipherline_beta_diag_${userId}`) === '1'; } catch { return false; }
}

export function setBetaDiagEnabled(userId: string | null | undefined, on: boolean): void {
    if (!userId) return;
    try { secureLocalStore.setItem(`cipherline_beta_diag_${userId}`, on ? '1' : '0'); } catch { /* locked store */ }
    emit();
}

export function useBetaDiagEnabled(userId: string | null | undefined): boolean {
    return useSyncExternalStore(subscribe, () => getBetaDiagEnabled(userId), () => false);
}

export function subscribeBetaDiagSetting(cb: () => void): () => void {
    return subscribe(cb);
}

/**
 * Whether the one-time consent ask was answered (yes or no) on this device.
 * A NEW key, not the old `cipherline_beta_diag_notice_*`: that one recorded
 * "saw the it-is-already-on notice", which is not consent, so everyone is
 * asked once under the opt-in rule. Unreadable store → treat as answered, so
 * a locked store never nags.
 */
export function getBetaNoticeSeen(userId: string | null | undefined): boolean {
    if (!userId) return true;
    try { return secureLocalStore.getItem(`cipherline_beta_diag_ask_${userId}`) === '1'; } catch { return true; }
}

export function markBetaNoticeSeen(userId: string | null | undefined): void {
    if (!userId) return;
    try { secureLocalStore.setItem(`cipherline_beta_diag_ask_${userId}`, '1'); } catch { /* locked store */ }
    emit();
}

// ── rating card frequency ──────────────────────────────────────────────────

/** Calls shorter than this never get the card (contract). */
export const RATING_MIN_CALL_S = 30;
/** At most once per this many eligible calls (the 25th, 50th, … — never the first)… */
export const RATING_EVERY_N_CALLS = 25;
/** …and never twice within this window. */
export const RATING_MIN_GAP_MS = 10 * 60_000;

export interface RatingLedger {
    /** Eligible (≥ 30 s) calls since the card was last shown. */
    since: number;
    /** When the card was last shown (ms), or 0. */
    lastShownAt: number;
}

export const FRESH_LEDGER: RatingLedger = { since: 0, lastShownAt: 0 };

/**
 * Decide whether THIS call (just ended) gets the card, and the ledger after.
 * Every RATING_EVERY_N_CALLS-th eligible call (counted from the ledger's
 * `since`, so a ledger stored by an older build keeps counting where it was),
 * never inside RATING_MIN_GAP_MS of the last time the card showed. A fresh
 * ledger does NOT show on the first call any more.
 */
export function decideRatingPrompt(ledger: RatingLedger, callSeconds: number, nowMs: number): { show: boolean; next: RatingLedger } {
    if (!(callSeconds >= RATING_MIN_CALL_S)) return { show: false, next: ledger };
    const tooSoon = ledger.lastShownAt > 0 && nowMs - ledger.lastShownAt < RATING_MIN_GAP_MS;
    const due = ledger.since + 1 >= RATING_EVERY_N_CALLS;
    if (due && !tooSoon) return { show: true, next: { since: 0, lastShownAt: nowMs } };
    return { show: false, next: { since: ledger.since + 1, lastShownAt: ledger.lastShownAt } };
}

export function parseRatingLedger(raw: string | null): RatingLedger {
    if (!raw) return { ...FRESH_LEDGER };
    try {
        const v = JSON.parse(raw) as Partial<RatingLedger>;
        const since = typeof v.since === 'number' && Number.isFinite(v.since) && v.since >= 0 ? Math.min(Math.floor(v.since), 1000) : 0;
        const lastShownAt = typeof v.lastShownAt === 'number' && Number.isFinite(v.lastShownAt) && v.lastShownAt >= 0 ? v.lastShownAt : 0;
        return { since, lastShownAt };
    } catch {
        return { ...FRESH_LEDGER };
    }
}

export function readRatingLedger(userId: string): RatingLedger {
    try { return parseRatingLedger(secureLocalStore.getItem(`cipherline_beta_diag_rating_${userId}`)); } catch { return { ...FRESH_LEDGER }; }
}

export function writeRatingLedger(userId: string, ledger: RatingLedger): void {
    try { secureLocalStore.setItem(`cipherline_beta_diag_rating_${userId}`, JSON.stringify(ledger)); } catch { /* locked store */ }
}
