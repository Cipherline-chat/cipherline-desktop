/**
 * Small, dependency-free scheduling helpers for work that must NOT compete with
 * what the user is looking at: startup prefetch and the post-wake/reconnect
 * catch-up.
 *
 *   whenIdle(fn)        — requestIdleCallback with a timeout, shimmed with
 *                         setTimeout where it does not exist (tests, old UAs).
 *   createTaskQueue()   — run async jobs with a concurrency cap and optional
 *                         start jitter; cancel everything not yet started in
 *                         one call (a newer wake supersedes an older one).
 */

type IdleCb = () => void;
type Ric = (cb: (d?: unknown) => void, o?: { timeout: number }) => number;
type Cic = (id: number) => void;

/** Run `fn` when the main thread is idle (or after `timeoutMs` at the latest).
 *  Returns a cancel function. */
export function whenIdle(fn: IdleCb, timeoutMs = 2000): () => void {
    const g = globalThis as { requestIdleCallback?: Ric; cancelIdleCallback?: Cic };
    if (typeof g.requestIdleCallback === 'function') {
        const id = g.requestIdleCallback(() => fn(), { timeout: timeoutMs });
        return () => { try { g.cancelIdleCallback?.(id); } catch { /* ignore */ } };
    }
    const t = setTimeout(fn, Math.min(timeoutMs, 50));
    return () => clearTimeout(t);
}

export interface TaskQueue {
    /** Queue a job. Lower `priority` runs first (stable within a priority). */
    add(job: () => Promise<unknown> | unknown, priority?: number): void;
    /** Drop every job that has not started yet. Running jobs finish. */
    cancelPending(): void;
    /** Jobs queued but not yet started. */
    readonly pending: number;
    /** Jobs currently running. */
    readonly running: number;
    /** Resolves when nothing is queued or running. */
    idle(): Promise<void>;
}

export interface TaskQueueOptions {
    /** Max jobs in flight at once. */
    concurrency: number;
    /** Each job start is delayed by a random 0..jitterMs (spreads a burst of
     *  requests from many clients waking at once, and keeps this client's own
     *  responses from all landing in the same frame). */
    jitterMs?: number;
    /** Start jobs only when the main thread is idle (whenIdle) rather than
     *  immediately. */
    waitForIdle?: boolean;
    /** Test seam. */
    random?: () => number;
}

export function createTaskQueue(opts: TaskQueueOptions): TaskQueue {
    const concurrency = Math.max(1, opts.concurrency);
    const random = opts.random ?? Math.random;
    let seq = 0;
    let queue: Array<{ job: () => Promise<unknown> | unknown; priority: number; seq: number }> = [];
    let running = 0;
    let idleWaiters: Array<() => void> = [];

    const settleIdle = () => {
        if (running === 0 && queue.length === 0) {
            const w = idleWaiters; idleWaiters = [];
            for (const r of w) r();
        }
    };

    const startOne = (entry: { job: () => Promise<unknown> | unknown }) => {
        running++;
        const run = async () => {
            try { await entry.job(); } catch { /* jobs report their own errors */ }
            finally {
                running--;
                pump();
                settleIdle();
            }
        };
        const delay = opts.jitterMs ? Math.floor(random() * opts.jitterMs) : 0;
        const go = () => { void run(); };
        if (opts.waitForIdle) {
            if (delay) setTimeout(() => whenIdle(go, 1000), delay); else whenIdle(go, 1000);
        } else if (delay) {
            setTimeout(go, delay);
        } else {
            go();
        }
    };

    const pump = () => {
        while (running < concurrency && queue.length > 0) {
            const next = queue.shift()!;
            startOne(next);
        }
    };

    return {
        add(job, priority = 10) {
            queue.push({ job, priority, seq: seq++ });
            queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
            pump();
        },
        cancelPending() {
            queue = [];
            settleIdle();
        },
        get pending() { return queue.length; },
        get running() { return running; },
        idle() {
            if (running === 0 && queue.length === 0) return Promise.resolve();
            return new Promise<void>(r => idleWaiters.push(r));
        },
    };
}
