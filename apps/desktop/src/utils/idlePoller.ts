/**
 * The OS idle-clock poll behind the attention heartbeat, hardened.
 *
 * The old inline loop in useRealtime could die silently: a synchronous throw from
 * `getSystemIdleTime` escaped before any reschedule, and a promise that never
 * settled left the loop waiting forever. Either way the last reading stayed in
 * the ref, and if it was low every heartbeat kept claiming `active:true` for as
 * long as the process lived, silencing the owner's phone (audit 2026-11-25, A4).
 *
 * Guarantees here:
 *  - the read is wrapped (sync throw, rejection and hang all become "unknown",
 *    i.e. +Infinity, i.e. not attentive);
 *  - the IPC has a timeout (IDLE_READ_TIMEOUT_MS);
 *  - every poll reschedules itself, whatever happened;
 *  - a watchdog restarts a loop that has made no attempt for IDLE_WATCHDOG_STALL_MS;
 *  - `idleSeconds()` reports +Infinity once the reading is older than
 *    IDLE_READING_STALE_MS, so a frozen value can never read as "recent input".
 */
import { IDLE_READING_STALE_MS, freshIdleSeconds } from './inputRecency';

export const IDLE_READ_TIMEOUT_MS = 5_000;
/** How often the watchdog looks. */
export const IDLE_WATCHDOG_INTERVAL_MS = 15_000;
/** No poll attempt for this long = the loop is dead; restart it. */
export const IDLE_WATCHDOG_STALL_MS = 45_000;

export interface IdlePollerOptions {
    /** `electronAPI.getSystemIdleTime`, possibly missing. May throw, reject or hang. */
    read: (() => Promise<number> | number) | undefined;
    /** Post-process a good reading (the unlock cap). */
    transform?: (osIdleSeconds: number) => number;
    /** The attention verdict, evaluated before and after each poll. */
    isAttentive: () => boolean;
    /** Verdict changed because of a poll: report it off the heartbeat cadence. */
    onVerdictChange: (attentive: boolean) => void;
    /** A reading (or +Infinity for unknown) was recorded. */
    onReading?: (idleSeconds: number, at: number) => void;
    /** Delay before the next poll. */
    nextDelayMs: (idleSeconds: number) => number;
    timeoutMs?: number;
    now?: () => number;
}

export interface IdlePoller {
    pollNow(): void;
    /** Seconds since last input; +Infinity when unknown or stale. */
    idleSeconds(now?: number): number;
    readAgeMs(now?: number): number;
    /** Forget the reading (unlock / resume: the old value is meaningless). */
    invalidate(): void;
    dispose(): void;
}

export function createIdlePoller(o: IdlePollerOptions): IdlePoller {
    const now = o.now ?? Date.now;
    const timeoutMs = o.timeoutMs ?? IDLE_READ_TIMEOUT_MS;
    let disposed = false;
    let gen = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let value = Number.POSITIVE_INFINITY;
    let readAt = 0;
    let lastAttemptAt = now();

    const record = (secs: number) => {
        value = secs;
        readAt = now();
        o.onReading?.(secs, readAt);
    };

    const schedule = () => {
        if (disposed) return;
        if (timer) clearTimeout(timer);
        let delay = 10_000;
        try { delay = o.nextDelayMs(idleSecondsNow()); } catch { /* keep the safe default */ }
        if (!Number.isFinite(delay) || delay < 1_000) delay = 1_000;
        timer = setTimeout(pollNow, delay);
    };

    const idleSecondsNow = (t: number = now()) => freshIdleSeconds(value, readAt, t, IDLE_READING_STALE_MS);

    // One bounded read: never throws, never hangs, always resolves to a number
    // (+Infinity = unknown).
    const readOnce = (): Promise<number> => new Promise<number>(resolve => {
        let settled = false;
        const done = (n: number) => { if (!settled) { settled = true; clearTimeout(t); resolve(n); } };
        const t = setTimeout(() => done(Number.POSITIVE_INFINITY), timeoutMs);
        try {
            if (!o.read) { done(Number.POSITIVE_INFINITY); return; }
            Promise.resolve(o.read()).then(
                v => done(typeof v === 'number' && Number.isFinite(v) && v >= 0 ? (o.transform ? o.transform(v) : v) : Number.POSITIVE_INFINITY),
                () => done(Number.POSITIVE_INFINITY),
            );
        } catch {
            done(Number.POSITIVE_INFINITY);
        }
    });

    function pollNow(): void {
        if (disposed) return;
        if (timer) { clearTimeout(timer); timer = null; }
        lastAttemptAt = now();
        const myGen = ++gen;
        const before = safeVerdict();
        void readOnce().then(secs => {
            // A newer poll superseded this one: it owns the reschedule, and its
            // reading is the newer of the two.
            if (disposed || myGen !== gen) return;
            record(secs);
            const after = safeVerdict();
            if (after !== before) { try { o.onVerdictChange(after); } catch { /* never break the loop */ } }
            schedule();
        });
    }

    const safeVerdict = (): boolean => { try { return o.isAttentive(); } catch { return false; } };

    const watchdog = setInterval(() => {
        if (disposed) return;
        if (now() - lastAttemptAt > IDLE_WATCHDOG_STALL_MS) pollNow();
    }, IDLE_WATCHDOG_INTERVAL_MS);

    return {
        pollNow,
        idleSeconds: (t) => idleSecondsNow(t),
        readAgeMs: (t = now()) => (readAt > 0 ? Math.max(0, t - readAt) : 0),
        invalidate: () => { value = Number.POSITIVE_INFINITY; readAt = 0; o.onReading?.(Number.POSITIVE_INFINITY, now()); },
        dispose: () => { disposed = true; if (timer) clearTimeout(timer); clearInterval(watchdog); },
    };
}
