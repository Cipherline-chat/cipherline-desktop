/**
 * Recurring key-traffic gates (2026-11-25 key-load audit).
 *
 * Every recurring timer in the desktop key code used to do the same full pass
 * per joined server no matter what had changed since the last one:
 * GET channel-keys/pending + GET channels + GET key-epochs (every epoch of every
 * channel of the server), every 5 minutes, for ALL joined servers (a member of
 * 23 servers: ~830 GETs/hour from one idle device), and, whenever ONE channel
 * stayed gated or undecryptable, again every 75 s for that server. A
 * converged server answers "nothing to do" every time, so all of that is load
 * with no information in it. Two small, pure, injectable pieces fix it:
 *
 *  • KeySweepLedger — per-server record of when the server was last evaluated /
 *    when its epoch registry was last swept, and whether it was converged
 *    (no keyless or stale channel, no open history gap). The background tick
 *    re-checks a CONVERGED server only every CONVERGED_RECHECK_MS; an
 *    unconverged one stays on the tick. The key-epochs GET (the heaviest of the
 *    three) is rate-limited per server for every trigger and is re-armed
 *    (`invalidate`) the moment a key is installed, so a state change is never
 *    held behind the gap.
 *  • RecheckBackoff — the 75 s "something is still gated" timer re-checks a
 *    server on an exponential back-off while its set of affected channels does
 *    not change; a change in that set (a new channel gated, one recovered)
 *    makes the very next tick eligible again.
 *
 * Nothing here removes an event trigger (connect, server open, join, envelopes
 * ready, permission change): those still run at once. What is removed is
 * polling that re-reads an answer which has not changed.
 */

export type SweepMode = 'tick' | 'event';

/** A converged server is re-checked by the background tick this often (the tick
 *  itself still fires every PREFETCH_TICK_MS; it just skips converged servers). */
export const CONVERGED_RECHECK_MS = 15 * 60_000;
/** key-epochs is not re-fetched for a server inside this window by an event trigger… */
export const EPOCH_SWEEP_MIN_GAP_EVENT_MS = 2 * 60_000;
/** …nor inside this one by the background tick. */
export const EPOCH_SWEEP_MIN_GAP_TICK_MS = 30 * 60_000;

interface SweepEntry {
    evalAt: number;
    sweepAt: number;
    /** Last evaluation found no keyless / stale channel. */
    clean: boolean;
    /** Last completed sweep found a missing-epoch gap (asked or backing off). */
    gap: boolean;
}

export class KeySweepLedger {
    private readonly map = new Map<string, SweepEntry>();

    private entry(serverId: string): SweepEntry {
        let e = this.map.get(serverId);
        if (!e) { e = { evalAt: 0, sweepAt: 0, clean: false, gap: false }; this.map.set(serverId, e); }
        return e;
    }

    isConverged(serverId: string): boolean {
        const e = this.map.get(serverId);
        return !!e && e.evalAt > 0 && e.clean && !e.gap;
    }

    /** Should a BACKGROUND tick evaluate this server now? Event triggers always evaluate. */
    shouldEvaluate(serverId: string, mode: SweepMode, now: number): boolean {
        if (mode === 'event') return true;
        const e = this.map.get(serverId);
        if (!e || e.evalAt === 0) return true;
        if (!this.isConverged(serverId)) return true;
        return now - e.evalAt >= CONVERGED_RECHECK_MS;
    }

    noteEvaluated(serverId: string, now: number, clean: boolean): void {
        const e = this.entry(serverId);
        e.evalAt = now;
        e.clean = clean;
    }

    /** Claim the key-epochs sweep. Stamps immediately, so two overlapping evaluations
     *  of one server cost one GET, not two. */
    tryBeginSweep(serverId: string, mode: SweepMode, now: number): boolean {
        const e = this.entry(serverId);
        const gap = mode === 'tick' ? EPOCH_SWEEP_MIN_GAP_TICK_MS : EPOCH_SWEEP_MIN_GAP_EVENT_MS;
        if (e.sweepAt > 0 && now - e.sweepAt < gap) return false;
        e.sweepAt = now;
        return true;
    }

    /** A sweep that failed does not count: the next trigger may retry. */
    endSweep(serverId: string, outcome: { ok: boolean; gap?: boolean }): void {
        const e = this.entry(serverId);
        if (!outcome.ok) { e.sweepAt = 0; return; }
        e.gap = !!outcome.gap;
    }

    /** State changed (a key was installed, membership/permissions moved): the next
     *  evaluation and sweep run regardless of the gaps. */
    invalidate(serverId: string): void {
        const e = this.map.get(serverId);
        if (!e) return;
        e.evalAt = 0;
        e.sweepAt = 0;
    }

    forget(serverId: string): void { this.map.delete(serverId); }
    clear(): void { this.map.clear(); }
}

// ── The 75 s "still gated" re-check ─────────────────────────────────────────

/** Re-checks run at the timer's own cadence this many times for an unchanged set… */
export const RECHECK_FAST_RUNS = 3;
/** …then back off from the timer's cadence, doubling, up to this. */
export const RECHECK_MAX_DELAY_MS = 10 * 60_000;
/** The timer's own period (Dashboard: 75 s); the back-off doubles from it. */
export const RECHECK_BASE_MS = 75_000;

interface RecheckEntry { sig: string; runs: number; nextAt: number }

/** Delay before the Nth consecutive unchanged re-check of one server. */
export function recheckDelayMs(runs: number, random: () => number = Math.random): number {
    if (runs <= RECHECK_FAST_RUNS) return 0;
    const base = Math.min(RECHECK_MAX_DELAY_MS, RECHECK_BASE_MS * 2 ** (runs - RECHECK_FAST_RUNS));
    // ±15 % so every device behind the same unservable gap does not re-check in step.
    return Math.round(base * (0.85 + 0.3 * random()));
}

export class RecheckBackoff {
    private readonly map = new Map<string, RecheckEntry>();
    private readonly random: () => number;
    constructor(random: () => number = Math.random) { this.random = random; }

    /**
     * May the re-check for `serverId` run now? `affected` is the set of channel ids on
     * that server that are gated / undecryptable. A different set than last time is
     * news and resets the back-off.
     */
    allow(serverId: string, affected: Iterable<string>, now: number): boolean {
        const sig = [...affected].sort().join(',');
        const e = this.map.get(serverId);
        if (!e || e.sig !== sig) {
            this.map.set(serverId, { sig, runs: 1, nextAt: now });
            return true;
        }
        if (now < e.nextAt) return false;
        e.runs++;
        e.nextAt = now + recheckDelayMs(e.runs, this.random);
        return true;
    }

    /** Forget every server not in `active` (nothing affected there any more). */
    prune(active: ReadonlySet<string>): void {
        for (const k of [...this.map.keys()]) if (!active.has(k)) this.map.delete(k);
    }
    reset(serverId: string): void { this.map.delete(serverId); }
    clear(): void { this.map.clear(); }
}
