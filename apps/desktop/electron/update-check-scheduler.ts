/**
 * update-check-scheduler — WHEN the app asks "is there a newer version?".
 *
 * ── Why this exists (2026-10-12: "the clients aren't checking for updates") ──
 * The old schedule lived inline in main.ts's configureUpdater():
 *     setTimeout(check, 30 s);  setInterval(check, 4 h);
 * and failed in practice for four separate reasons:
 *   1. ONE attempt at startup, and a failure was swallowed (idle stays idle).
 *      A launch before the network is up (start-at-login, wake) then waited
 *      a full interval for the next try.
 *   2. 4 h of PROCESS TIME. Timers do not advance across sleep (main.ts's own
 *      freeze monitor logs "main:loop-gap sleep or suspended process" for
 *      exactly this), and a close-to-tray app is typically running for hours
 *      on a laptop that sleeps every night. Short sessions never reached 4 h.
 *   3. Nothing reacted to the events that mean "now is a good time": waking up
 *      and getting the network back.
 *   4. A check that fires while an update is already downloaded re-announced
 *      it ('available' flicker) because nothing looked at the phase.
 *
 * ── The schedule ────────────────────────────────────────────────────────────
 *   startup   ~5 s after the window exists (0 s when a download is already
 *             cached, so it can be installed before the user starts working)
 *   interval  60 min of WALL CLOCK since the last attempt. A 30 s tick compares
 *             Date.now(), so a sleep cannot make the interval late: the first
 *             tick after waking sees it is overdue.
 *   resume    RESUME_SETTLE_MS after the machine wakes (the network and the
 *             renderer's own catch-up get a head start)
 *   online    the network came back (offline -> online edge on the tick)
 *   manual / channel  user-initiated: never debounced
 * Automatic checks are debounced to one per MIN_GAP_MS (a FAILED attempt only
 * waits ERROR_MIN_GAP_MS, so "wake, no wifi yet, check fails, wifi arrives" is
 * retried), are never started while one is running, and are skipped while an
 * update is already in flight or downloaded (canCheck).
 *
 * Every attempt, including a skipped one, is reported through `log`/`record` as
 * `check reason=<why> result=<what>` — the "I never see it check" report is now
 * a grep. No `electron` import: unit-testable with fake timers.
 */

export type CheckReason = 'startup' | 'interval' | 'resume' | 'online' | 'manual' | 'channel';

export const UPDATE_SCHEDULE = Object.freeze({
    STARTUP_DELAY_MS: 5_000,
    INTERVAL_MS: 60 * 60 * 1000,
    MIN_GAP_MS: 10 * 60 * 1000,
    ERROR_MIN_GAP_MS: 60 * 1000,
    RESUME_SETTLE_MS: 45_000,
    TICK_MS: 30_000,
});
export type UpdateScheduleConfig = typeof UPDATE_SCHEDULE;

export interface SchedulerDeps {
    now(): number;
    isOnline(): boolean;
    /** null = a check may run; otherwise why not (e.g. 'update-ready'). */
    canCheck(): string | null;
    /** Perform the check; resolves with a short result ('not-available', 'available version=1.2.3'). May throw. */
    run(reason: CheckReason): Promise<string>;
    /** Short, scrubbed description of a thrown error, e.g. 'error code=ERR_X'. */
    describeError(e: unknown): string;
    log(line: string): void;
    record(reason: CheckReason, result: string): void;
}

export interface CheckOutcome { result: string; error?: unknown }

const isAutomatic = (r: CheckReason): boolean => r !== 'manual' && r !== 'channel';

export class UpdateCheckScheduler {
    private startupTimer: ReturnType<typeof setTimeout> | null = null;
    private resumeTimer: ReturnType<typeof setTimeout> | null = null;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private inFlight: Promise<CheckOutcome> | null = null;
    private lastAttemptAt: number | null = null;
    private lastFailed = false;
    private quietUntil = 0;
    private lastTickAt = 0;
    private lastOnline = true;
    /** The network came back but the check was held off (debounce); retried on the next tick. */
    private pendingOnline = false;
    private startedAt = 0;
    private disposed = false;

    constructor(private readonly d: SchedulerDeps, private readonly cfg: UpdateScheduleConfig = UPDATE_SCHEDULE) {}

    /** Arm the startup check and the wall-clock tick. Idempotent. */
    start(opts: { startupDelayMs?: number } = {}): void {
        if (this.disposed || this.tickTimer) return;
        const delay = opts.startupDelayMs ?? this.cfg.STARTUP_DELAY_MS;
        this.lastTickAt = this.startedAt = this.d.now();
        this.lastOnline = this.safeOnline();
        this.startupTimer = setTimeout(() => { this.startupTimer = null; this.fire('startup'); }, delay);
        this.tickTimer = setInterval(() => this.tick(), this.cfg.TICK_MS);
        (this.startupTimer as { unref?: () => void }).unref?.();
        (this.tickTimer as { unref?: () => void }).unref?.();
    }

    dispose(): void {
        this.disposed = true;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.startupTimer = this.resumeTimer = this.tickTimer = null;
    }

    /** The machine woke up. Coalesces repeated signals into one check after the settle delay. */
    noteResume(): void {
        if (this.disposed) return;
        this.quietUntil = this.d.now() + this.cfg.RESUME_SETTLE_MS;
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => { this.resumeTimer = null; this.fire('resume'); }, this.cfg.RESUME_SETTLE_MS);
        (this.resumeTimer as { unref?: () => void }).unref?.();
    }

    /**
     * Start a check nobody awaits (timers, the tick). check() already turns a
     * failed `run` into a logged `result=error…` outcome; the catch here only
     * stops a throwing dependency (canCheck, log, record) from becoming a
     * main-process unhandledRejection — i.e. a recorded "crash".
     */
    private fire(reason: CheckReason, silentSkips = false): void {
        this.check(reason, silentSkips).catch(() => { /* see above */ });
    }

    /**
     * Run (or join) a check. Never rejects; `error` carries the original
     * failure for the caller that wants to show it (manual "Check now").
     */
    async check(reason: CheckReason, silentSkips = false): Promise<CheckOutcome> {
        const skip = (why: string): CheckOutcome => {
            const result = `skipped-${why}`;
            if (!silentSkips) { this.d.log(`check reason=${reason} result=${result}`); this.d.record(reason, result); }
            return { result };
        };
        if (this.disposed) return { result: 'skipped-disposed' };
        if (this.inFlight) {
            // Never stack. A user-initiated check shares the running one.
            return isAutomatic(reason) ? skip('in-flight') : this.inFlight;
        }
        if (isAutomatic(reason)) {
            const why = this.d.canCheck();
            if (why) return skip(why);
            if (reason !== 'startup') {
                const now = this.d.now();
                if (reason !== 'resume' && now < this.quietUntil) return skip('resume-quiet');
                const gap = this.lastFailed ? this.cfg.ERROR_MIN_GAP_MS : this.cfg.MIN_GAP_MS;
                if (this.lastAttemptAt !== null && now - this.lastAttemptAt < gap) return skip('debounced');
            }
        }
        this.lastAttemptAt = this.d.now();
        this.pendingOnline = false;
        const p = this.execute(reason);
        this.inFlight = p;
        try { return await p; } finally { this.inFlight = null; }
    }

    private async execute(reason: CheckReason): Promise<CheckOutcome> {
        let result: string;
        let error: unknown;
        try {
            result = await this.d.run(reason);
            this.lastFailed = false;
        } catch (e) {
            error = e;
            result = this.d.describeError(e);
            this.lastFailed = true;
        }
        this.d.log(`check reason=${reason} result=${result}`);
        this.d.record(reason, result);
        return error === undefined ? { result } : { result, error };
    }

    private safeOnline(): boolean {
        try { return this.d.isOnline(); } catch { return true; }
    }

    /** Wall-clock tick: overdue interval, network edge, and sleep detection. */
    private tick(): void {
        if (this.disposed) return;
        const now = this.d.now();
        // Timers do not run while the machine sleeps, so a tick that arrives
        // far later than TICK_MS means we just woke: treat it like a resume
        // even if no power event reached us.
        if (this.lastTickAt && now - this.lastTickAt > this.cfg.TICK_MS * 3) this.noteResume();
        this.lastTickAt = now;

        const online = this.safeOnline();
        if (online && !this.lastOnline) this.pendingOnline = true;
        this.lastOnline = online;
        if (!online) return;
        if (this.pendingOnline) {
            // Held off by the debounce last time: try again until a check runs
            // (or there is nothing to check for).
            if (this.d.canCheck() !== null) this.pendingOnline = false;
            else { this.fire('online', true); return; }
        }
        // A skipped startup check still starts the clock, so the hourly check follows.
        const since = this.lastAttemptAt ?? this.startedAt;
        if (now - since >= this.cfg.INTERVAL_MS && this.d.canCheck() === null) {
            this.fire('interval', true);
        }
    }
}
