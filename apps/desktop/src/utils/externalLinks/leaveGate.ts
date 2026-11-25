/**
 * The pending "You're leaving Cipherline" request — a one-slot store between
 * openExternalLink (which raises a request) and LeavingCipherlineHost (the
 * single dialog, mounted once at the app root).
 *
 * The open itself happens only in `confirmLeave`, which:
 *   - acts on the request THIS store raised, never on a URL handed to it
 *     (the dialog cannot be asked to open something other than what it shows);
 *   - requires a live user gesture (the Visit click / Enter on it), the same
 *     check openExternalLink applies before it shows the dialog at all.
 * So no code path from message content can reach the OS without a click on a
 * dialog that displayed the destination.
 */
import type { LinkModel } from './describeLink';
import { hasUserGesture, sendToShell } from './shellOpen';
import { trustDomain } from './trustedDomains';

export interface LeaveRequest {
    readonly id: number;
    readonly model: LinkModel;
}

let current: LeaveRequest | null = null;
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();

function emit(): void { for (const fn of [...listeners]) { try { fn(); } catch { /* listener's own problem */ } } }

export function subscribeLeave(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getLeaveSnapshot(): LeaveRequest | null { return current; }

/** The dialog host announces itself; no host mounted = no way to confirm = refuse. */
export function registerLeaveHost(): () => void {
    hosts++;
    let done = false;
    return () => { if (!done) { done = true; hosts--; if (hosts === 0 && current) { current = null; emit(); } } };
}

export function hasLeaveHost(): boolean { return hosts > 0; }

/** Raise a request (replacing any pending one — the newest click wins). */
export function requestLeave(model: LinkModel): LeaveRequest {
    current = { id: nextId++, model };
    emit();
    return current;
}

export function cancelLeave(id: number): void {
    if (current?.id !== id) return;
    current = null;
    emit();
}

export type ConfirmResult =
    | { ok: true; trusted: boolean }
    | { ok: false; reason: 'stale' | 'no-user-gesture' };

/**
 * The Visit button. Opens the pending request's own validated href; with
 * `trust`, first stores its registrable domain (if the dialog offered one).
 */
export function confirmLeave(id: number, opts: { trust?: boolean } = {}): ConfirmResult {
    const req = current;
    if (!req || req.id !== id) return { ok: false, reason: 'stale' };
    if (!hasUserGesture()) return { ok: false, reason: 'no-user-gesture' };
    current = null;
    emit();
    const trusted = !!(opts.trust && req.model.trustDomain && trustDomain(req.model.trustDomain));
    sendToShell(req.model.href);
    return { ok: true, trusted };
}
