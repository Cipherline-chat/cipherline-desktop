/**
 * "Automatically send crash reports" — the opt-in (default OFF) and the policy
 * that decides what an automatic send may do.
 *
 * POLICY (planAutoSend, pure):
 *   • only when the toggle is ON and someone is signed in (the report is tied
 *     to the account by the server, from the JWT);
 *   • at most AUTO_SEND_DAILY_CAP automatic sends in any rolling 24 h;
 *   • one send per crash SIGNATURE per AUTO_SEND_DEDUPE_MS — a crash that
 *     keeps happening is reported once, then quietly cleared;
 *   • newest first; anything over the cap stays pending for the next launch
 *     (or for a manual report).
 *
 * STORAGE: both keys are PER ACCOUNT in secureLocalStore (encrypted at rest).
 * Per account rather than per device because the report is linked to the
 * account that sends it — one person's consent on a shared machine must not
 * send crash reports under another's. Both are excluded from backups
 * (backupRegistry.ts): consent to upload must be given on each device, never
 * restored onto a new one; the send log is bookkeeping. The log stores a short
 * HASH of each signature, not the signature text.
 */
import { useSyncExternalStore } from 'react';
import secureLocalStore from '../secureLocalStore';

export const AUTO_SEND_DAILY_CAP = 3;
export const AUTO_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUTO_SEND_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOG = 50;

// Keys are written as literal templates at each call site (not via a helper)
// so backupRegistry.test.ts's source scan sees them and insists they are
// classified.

export interface AutoSendLogEntry { h: string; at: number }

/** FNV-1a 32-bit, hex — enough to dedupe, reveals nothing about the text. */
export function signatureHash(signature: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < signature.length; i++) {
        h ^= signature.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

export interface PendingLike { signature: string }

export interface AutoSendPlan<T extends PendingLike> {
    /** Send these now (newest first). */
    send: T[];
    /** Already reported recently — clear without sending. */
    duplicates: T[];
    /** Over today's cap — leave pending. */
    deferred: T[];
}

export function planAutoSend<T extends PendingLike>(o: {
    enabled: boolean;
    signedIn: boolean;
    /** Oldest → newest, as main returns them. */
    pending: readonly T[];
    log: readonly AutoSendLogEntry[];
    now: number;
}): AutoSendPlan<T> {
    const plan: AutoSendPlan<T> = { send: [], duplicates: [], deferred: [] };
    if (!o.enabled || !o.signedIn || o.pending.length === 0) return plan;
    const recent = o.log.filter(e => o.now - e.at < AUTO_SEND_WINDOW_MS && e.at <= o.now).length;
    let budget = Math.max(0, AUTO_SEND_DAILY_CAP - recent);
    const recentlySent = new Set(o.log.filter(e => o.now - e.at < AUTO_SEND_DEDUPE_MS).map(e => e.h));
    const planned = new Set<string>();
    for (const p of [...o.pending].reverse()) {
        const h = signatureHash(p.signature);
        if (recentlySent.has(h) || planned.has(h)) { plan.duplicates.push(p); continue; }
        if (budget > 0) { plan.send.push(p); planned.add(h); budget--; } else plan.deferred.push(p);
    }
    return plan;
}

/** Append a successful send to the log (pure); keeps the log bounded. */
export function appendAutoSendLog(log: readonly AutoSendLogEntry[], signature: string, now: number): AutoSendLogEntry[] {
    return [...log.filter(e => now - e.at < AUTO_SEND_DEDUPE_MS), { h: signatureHash(signature), at: now }].slice(-MAX_LOG);
}

export function parseAutoSendLog(raw: string | null): AutoSendLogEntry[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw) as unknown;
        if (!Array.isArray(v)) return [];
        return v.filter((e): e is AutoSendLogEntry =>
            !!e && typeof e === 'object' && typeof (e as AutoSendLogEntry).h === 'string' && /^[0-9a-f]{8}$/.test((e as AutoSendLogEntry).h)
            && typeof (e as AutoSendLogEntry).at === 'number' && Number.isFinite((e as AutoSendLogEntry).at)).slice(-MAX_LOG);
    } catch {
        return [];
    }
}

// ── Persistence + a tiny external store for the Settings toggle ─────────────

const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function getAutoSendEnabled(userId: string | null | undefined): boolean {
    if (!userId) return false;
    try { return secureLocalStore.getItem(`cipherline_diag_auto_send_${userId}`) === '1'; } catch { return false; }
}

export function setAutoSendEnabled(userId: string | null | undefined, on: boolean): void {
    if (!userId) return;
    try { secureLocalStore.setItem(`cipherline_diag_auto_send_${userId}`, on ? '1' : '0'); } catch { /* locked store */ }
    emit();
}

export function useAutoSendEnabled(userId: string | null | undefined): boolean {
    return useSyncExternalStore(subscribe, () => getAutoSendEnabled(userId), () => false);
}

export function readAutoSendLog(userId: string): AutoSendLogEntry[] {
    try { return parseAutoSendLog(secureLocalStore.getItem(`cipherline_diag_auto_send_log_${userId}`)); } catch { return []; }
}

export function writeAutoSendLog(userId: string, log: readonly AutoSendLogEntry[]): void {
    try { secureLocalStore.setItem(`cipherline_diag_auto_send_log_${userId}`, JSON.stringify(log)); } catch { /* locked store */ }
}
