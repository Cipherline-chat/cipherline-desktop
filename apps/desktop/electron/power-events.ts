/**
 * power-events — one coalesced picture of "the machine slept / was locked and
 * is back", for the main process and the renderer.
 *
 * WHY: on wake Windows delivers `resume` and, once the user signs back in,
 * `unlock-screen` — and main.ts forwarded EACH of them as two separate
 * renderer events (os-resume + app:resumed), so a single wake could start two
 * socket rebuilds and two full rehydrates seconds apart, on a machine whose
 * CPU, disk and network are all still coming back. Meanwhile the main
 * process's own timers (game scan, update check) all fired in the same
 * instant because their intervals had elapsed during sleep.
 *
 * This module:
 *   • tracks suspended/locked state and how long each lasted;
 *   • tells main-process subscribers about 'suspend' and 'resume' phases (the
 *     game poller pauses, the freeze monitor stops counting sleep as a stall,
 *     pending vault writes are flushed before sleep);
 *   • emits ONE `power:resumed` renderer event per wake episode, a short beat
 *     after the wake so it is not stacked on the OS's own resume burst. A
 *     `resume` followed by `unlock-screen` within WAKE_EPISODE_MS is one
 *     episode (reason 'resume+unlock'); an unlock with no sleep is its own
 *     episode (reason 'unlock').
 *
 * The legacy `os-resume` / `app:resumed` events are left exactly as they were
 * (the renderer consumes them today); `power:resumed` is the new, coalesced
 * signal the renderer can move to and pace its own catch-up with.
 *
 * No `electron` import, so it is unit-testable; main.ts wires it up.
 */

export type PowerSignal = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen' | 'on-ac' | 'on-battery';
export type PowerPhase = 'suspend' | 'resume';
export type ResumeReason = 'resume' | 'unlock' | 'resume+unlock' | 'clock-jump';

/** Payload of the `power:resumed` renderer event. Durations only. */
export interface PowerResumedPayload {
    reason: ResumeReason;
    /** How long the machine was suspended, ms (null if it never suspended). */
    asleepMs: number | null;
    /** How long the screen was locked, ms (null if it was never locked). */
    lockedMs: number | null;
    /** Wall clock (Date.now()) at which this event was sent. */
    at: number;
}

/** Wait this long after a wake before telling the renderer — lets an
 *  immediately following unlock-screen join the same episode and keeps the
 *  renderer's catch-up out of the OS's own resume burst. */
export const RESUME_NOTIFY_DELAY_MS = 1500;
/** An unlock this soon after a reported resume is the same wake. */
export const WAKE_EPISODE_MS = 60_000;

export class PowerCoordinator {
    private suspendedAt: number | null = null;
    private lockedAt: number | null = null;
    private lastAsleepMs: number | null = null;
    private pending: { reason: ResumeReason; asleepMs: number | null; lockedMs: number | null } | null = null;
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;
    private lastResumeReportAt = 0;
    private phaseListeners: Array<(phase: PowerPhase) => void> = [];
    private _onBattery = false;

    private readonly now: () => number;
    private readonly emit: (p: PowerResumedPayload) => void;

    constructor(emit: (p: PowerResumedPayload) => void, now: () => number = () => Date.now()) {
        this.emit = emit;
        this.now = now;
    }

    get suspended(): boolean { return this.suspendedAt !== null; }
    get locked(): boolean { return this.lockedAt !== null; }
    get onBattery(): boolean { return this._onBattery; }

    onPhase(fn: (phase: PowerPhase) => void): () => void {
        this.phaseListeners.push(fn);
        return () => { this.phaseListeners = this.phaseListeners.filter(f => f !== fn); };
    }

    private phase(p: PowerPhase): void {
        for (const fn of [...this.phaseListeners]) {
            try { fn(p); } catch (e) { console.error('[Power] phase listener failed', e); }
        }
    }

    handle(signal: PowerSignal): void {
        const t = this.now();
        switch (signal) {
            case 'suspend':
                if (this.suspendedAt === null) {
                    this.suspendedAt = t;
                    this.phase('suspend');
                }
                return;
            case 'resume': {
                const asleepMs = this.suspendedAt !== null ? t - this.suspendedAt : null;
                this.suspendedAt = null;
                this.lastAsleepMs = asleepMs;
                this.phase('resume');
                this.queue('resume', asleepMs, null);
                return;
            }
            case 'lock-screen':
                if (this.lockedAt === null) this.lockedAt = t;
                return;
            case 'unlock-screen': {
                const lockedMs = this.lockedAt !== null ? t - this.lockedAt : null;
                this.lockedAt = null;
                if (this.pending) {
                    // Same episode as a wake that is still about to be reported.
                    this.pending = { ...this.pending, reason: this.pending.reason === 'resume' ? 'resume+unlock' : this.pending.reason, lockedMs };
                    return;
                }
                if (t - this.lastResumeReportAt < WAKE_EPISODE_MS) return; // already told the renderer about this wake
                this.queue('unlock', null, lockedMs);
                return;
            }
            case 'on-ac': this._onBattery = false; return;
            case 'on-battery': this._onBattery = true; return;
        }
    }

    /**
     * The main loop slept far longer than any real stall (Modern Standby on
     * Windows can freeze desktop apps without a suspend event). Treat it as a
     * wake if powerMonitor did not report one.
     */
    noteClockJump(ms: number): void {
        if (this.suspendedAt !== null || this.pending) return;
        if (this.now() - this.lastResumeReportAt < WAKE_EPISODE_MS) return;
        this.lastAsleepMs = ms;
        this.phase('resume');
        this.queue('clock-jump', ms, null);
    }

    /** Duration of the most recent sleep, for the perf log. */
    lastSleepMs(): number | null { return this.lastAsleepMs; }

    private queue(reason: ResumeReason, asleepMs: number | null, lockedMs: number | null): void {
        if (this.pending) {
            this.pending = { reason: this.pending.reason, asleepMs: this.pending.asleepMs ?? asleepMs, lockedMs: this.pending.lockedMs ?? lockedMs };
            return;
        }
        this.pending = { reason, asleepMs, lockedMs };
        this.pendingTimer = setTimeout(() => this.flushPending(), RESUME_NOTIFY_DELAY_MS);
        (this.pendingTimer as { unref?: () => void }).unref?.();
    }

    private flushPending(): void {
        this.pendingTimer = null;
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        const at = this.now();
        this.lastResumeReportAt = at;
        this.emit({ ...p, at });
    }

    dispose(): void {
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
        this.pending = null;
        this.phaseListeners = [];
    }
}
