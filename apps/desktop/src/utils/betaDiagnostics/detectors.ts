/**
 * Beta diagnostics — the few detectors that did not exist anywhere yet.
 * Everything else is a one-line bridge from an existing diagnostic (see
 * bridges.ts). Each detector here is pure or takes its clock/timers
 * injected, and does NO work while beta diagnostics is off.
 *
 *   KeyWaitTracker      key_request_unanswered — a channel-key request this
 *                       device filed has had no key installed for 2 minutes.
 *   watchPendingSend    msg_pending_stuck — a message still "sending" 30 s
 *                       after it was handed to the delivery queue.
 *   WsChurnCounter      ws_churn — 5+ WebSocket drops inside 10 minutes.
 *   KeylessWaitTracker  call_keyless_wait — a call sat without its room key
 *                       for 3 s or more before connecting (or gave up).
 *   memoryHighCheck     memory_high — renderer JS heap above 1 GiB.
 *
 * Channel ids are used ONLY as in-memory map keys and never leave here.
 */
import { isBetaActive, reportBeta } from './reporter';
import { isStaleEpochError } from '../pendingSend';

/** A send / edit refused with 409 STALE_EPOCH (this device missed a key rotation) → key_stale_epoch_refused. */
export function reportStaleEpochRefused(err: unknown, action: string): void {
    try { if (isStaleEpochError(err)) reportBeta('key_stale_epoch_refused', { action }); } catch { /* diagnostics only */ }
}

// ── key requests ───────────────────────────────────────────────────────────

export const KEY_UNANSWERED_MS = 2 * 60_000;
const KEY_TICK_MS = 15_000;

/** heldEpoch: a number = the epoch held; null = no key at all; undefined = not known. */
interface KeyWait { askedAt: number; targetEpoch: number | null; heldEpoch: number | null | undefined; reported: boolean }

export class KeyWaitTracker {
    private waits = new Map<string, KeyWait>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly clock: () => number;
    private readonly emit: (detail: { waited_s: number; epoch_gap?: number; keyless?: boolean }) => void;
    private readonly autoTimer: boolean;

    constructor(o: { clock?: () => number; emit?: KeyWaitTracker['emit']; autoTimer?: boolean } = {}) {
        this.clock = o.clock ?? (() => Date.now());
        this.emit = o.emit ?? (d => reportBeta('key_request_unanswered', d));
        this.autoTimer = o.autoTimer ?? true;
    }

    /** A key request for this channel was accepted by the API. The FIRST ask of a wait starts its clock. */
    noteAsked(channelId: string, o: { targetEpoch?: number | null; heldEpoch?: number | null } = {}): void {
        if (!channelId) return;
        const cur = this.waits.get(channelId);
        const targetEpoch = typeof o.targetEpoch === 'number' ? o.targetEpoch : null;
        const heldEpoch = typeof o.heldEpoch === 'number' || o.heldEpoch === null ? o.heldEpoch : undefined;
        if (cur) {
            if (targetEpoch !== null) cur.targetEpoch = Math.max(cur.targetEpoch ?? 0, targetEpoch);
            return;
        }
        if (this.waits.size >= 500) return; // leak guard
        this.waits.set(channelId, { askedAt: this.clock(), targetEpoch, heldEpoch, reported: false });
        this.ensureTimer();
    }

    /** A key envelope for this channel was installed: the wait is over. */
    noteReceived(channelId: string): void {
        this.waits.delete(channelId);
        if (!this.waits.size) this.stopTimer();
    }

    tick(): void {
        const now = this.clock();
        for (const w of this.waits.values()) {
            if (w.reported || now - w.askedAt < KEY_UNANSWERED_MS) continue;
            w.reported = true;
            const gap = w.targetEpoch !== null && w.heldEpoch !== undefined ? w.targetEpoch - (w.heldEpoch ?? 0) : undefined;
            this.emit({
                waited_s: Math.round((now - w.askedAt) / 1000),
                ...(gap !== undefined && gap >= 0 ? { epoch_gap: gap } : {}),
                ...(w.heldEpoch !== undefined ? { keyless: w.heldEpoch === null } : {}),
            });
        }
    }

    clear(): void { this.waits.clear(); this.stopTimer(); }
    get size(): number { return this.waits.size; }

    private ensureTimer(): void {
        if (!this.autoTimer || this.timer) return;
        this.timer = setInterval(() => { try { this.tick(); } catch { /* diagnostics only */ } }, KEY_TICK_MS);
        (this.timer as { unref?: () => void }).unref?.();
    }

    private stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

export const keyWaitTracker = new KeyWaitTracker();

/** Dashboard's key-request path: a request was accepted. No-op while beta diagnostics is off. */
export function noteBetaKeyAsked(channelId: string, o: { targetEpoch?: number | null; heldEpoch?: number | null } = {}): void {
    try { if (isBetaActive()) keyWaitTracker.noteAsked(channelId, o); } catch { /* diagnostics only */ }
}

/** channelKeyWait.noteChannelKeyReceived: a key arrived. */
export function noteBetaKeyReceived(channelId: string): void {
    try { keyWaitTracker.noteReceived(channelId); } catch { /* diagnostics only */ }
}

// ── stuck sends ────────────────────────────────────────────────────────────

export const PENDING_STUCK_MS = 30_000;

/**
 * Arm a one-shot check for a message just handed to the delivery queue.
 * `settled()` says whether it was delivered, failed or discarded since.
 * Returns a cancel function. Arms nothing while beta diagnostics is off.
 */
export function watchPendingSend(
    settled: () => boolean,
    detail: { kind: 'dm' | 'channel' },
    timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
): () => void {
    try {
        if (!isBetaActive()) return () => {};
        const t = timers.set(() => {
            try {
                if (!settled()) reportBeta('msg_pending_stuck', { waited_s: Math.round(PENDING_STUCK_MS / 1000), scope: detail.kind });
            } catch { /* diagnostics only */ }
        }, PENDING_STUCK_MS);
        return () => timers.clear(t);
    } catch {
        return () => {};
    }
}

// ── WebSocket churn ────────────────────────────────────────────────────────

export const WS_CHURN_WINDOW_MS = 10 * 60_000;
export const WS_CHURN_THRESHOLD = 5;

export class WsChurnCounter {
    private drops: number[] = [];
    private lastReportAt = -Infinity;

    /** A socket dropped. Returns the count to report, or null. */
    noteDrop(now: number): number | null {
        this.drops.push(now);
        while (this.drops.length && now - this.drops[0] > WS_CHURN_WINDOW_MS) this.drops.shift();
        if (this.drops.length >= WS_CHURN_THRESHOLD && now - this.lastReportAt >= WS_CHURN_WINDOW_MS) {
            this.lastReportAt = now;
            return this.drops.length;
        }
        return null;
    }
}

// ── keyless call wait ──────────────────────────────────────────────────────

export const KEYLESS_REPORT_MS = 3_000;

/**
 * Fed on every change of (active call id, key gate verdict). Reports how long
 * a call waited for its room key when that wait was long, or never ended.
 */
export class KeylessWaitTracker {
    private callId: string | null = null;
    private blockedSince: number | null = null;
    private done = false;

    /** Returns a detail to report, or null. */
    update(callId: string | null, blocked: boolean, now: number): { waited_ms: number; gave_up: boolean } | null {
        let out: { waited_ms: number; gave_up: boolean } | null = null;
        if (callId !== this.callId) {
            // The previous call ended (or was replaced) while still waiting.
            if (this.blockedSince !== null && !this.done && now - this.blockedSince >= KEYLESS_REPORT_MS) {
                out = { waited_ms: Math.round(now - this.blockedSince), gave_up: true };
            }
            this.callId = callId;
            this.blockedSince = callId && blocked ? now : null;
            this.done = !!callId && !blocked;
            return out;
        }
        if (!callId || this.done) return null;
        if (blocked) {
            if (this.blockedSince === null) this.blockedSince = now;
            return null;
        }
        // Key arrived: the call connects.
        this.done = true;
        if (this.blockedSince !== null && now - this.blockedSince >= KEYLESS_REPORT_MS) {
            out = { waited_ms: Math.round(now - this.blockedSince), gave_up: false };
        }
        this.blockedSince = null;
        return out;
    }
}

const keylessTracker = new KeylessWaitTracker();

/** Dashboard: the active call / key-gate verdict changed. */
export function noteBetaCallKeyGate(callId: string | null, blocked: boolean): void {
    try {
        if (!isBetaActive()) return;
        const r = keylessTracker.update(callId, blocked, Date.now());
        if (r) reportBeta('call_keyless_wait', r);
    } catch { /* diagnostics only */ }
}

// ── memory ─────────────────────────────────────────────────────────────────

export const MEMORY_HIGH_MB = 1024;

/** The JS heap in MB if it is above the line, else null. */
export function memoryHighCheck(read: () => number | null): number | null {
    const used = read();
    if (used === null || !Number.isFinite(used)) return null;
    const mb = Math.round(used / 1048576);
    return mb >= MEMORY_HIGH_MB ? mb : null;
}

export function jsHeapUsedBytes(): number | null {
    try {
        const m = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
        return typeof m?.usedJSHeapSize === 'number' ? m.usedJSHeapSize : null;
    } catch {
        return null;
    }
}

// ── startup ────────────────────────────────────────────────────────────────

export const STARTUP_SLOW_MS = 10_000;
