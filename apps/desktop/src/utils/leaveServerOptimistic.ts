/**
 * Optimistic "Leave server".
 *
 * Owner report 2026-11-16: leaving a server "feels really slow". The old
 * handler awaited POST /servers/:id/leave BEFORE touching the UI (dialog frozen
 * for a full round trip, ~250 ms from the dev box plus the server's own work),
 * then only the follow-up GET /servers (loadServers, a second round trip) took
 * the server off the rail. Two serial round trips of "nothing happens".
 *
 * Now: the instant the user confirms, the server leaves the rail and the view
 * navigates away (`applyLocal`); the POST runs behind that. The server stays
 * authoritative: on failure the rail entry is put back (`rollbackLocal`) with
 * an error toast, and on success one reconcile (`reconcile`, the GET) confirms.
 * Local cleanup that only makes sense once the leave is real (rail layout
 * persistence, roster / retention caches) runs AFTER the UI update, off the
 * click's task, and is idempotent.
 *
 * Kept free of React so the success and rollback paths are unit-testable.
 */
export interface LeaveServerOptimisticDeps {
    /** POST /servers/:id/leave. Rejects on any failure. */
    post: () => Promise<unknown>;
    /** Synchronous optimistic UI: drop from the rail, navigate away. */
    applyLocal: () => void;
    /** Undo `applyLocal`'s rail removal after a failed POST. */
    rollbackLocal: () => void;
    /** Post-success local cleanup. Must be idempotent; never blocks the UI. */
    cleanupLocal: () => void;
    /** Post-success reconcile with the server (refetch the server list). */
    reconcile: () => void;
    /** Surface a failure to the user (toast). */
    onError: (err: unknown) => void;
    /** Diagnostics only (perf log). Must not throw. */
    recordTiming?: (activity: string, ms: number) => void;
    now?: () => number;
    /** Defers cleanup off the current task. Defaults to setTimeout(0). */
    defer?: (fn: () => void) => void;
}

/** Resolves true when the server confirmed the leave, false when it was rolled back. */
export async function leaveServerOptimistic(d: LeaveServerOptimisticDeps): Promise<boolean> {
    const now = d.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const defer = d.defer ?? ((fn: () => void) => { setTimeout(fn, 0); });
    const t0 = now();

    d.applyLocal();
    safeTiming(d, 'server_leave_ui', now() - t0);

    const tPost = now();
    try {
        await d.post();
    } catch (err) {
        safeTiming(d, 'server_leave_api_failed', now() - tPost);
        d.rollbackLocal();
        d.onError(err);
        return false;
    }
    safeTiming(d, 'server_leave_api', now() - tPost);
    defer(() => {
        // Each step isolated: a cleanup failure must not skip the reconcile.
        try { d.cleanupLocal(); } catch (e) { console.warn('[leaveServer] local cleanup failed:', e); }
        try { d.reconcile(); } catch (e) { console.warn('[leaveServer] reconcile failed:', e); }
    });
    return true;
}

function safeTiming(d: LeaveServerOptimisticDeps, activity: string, ms: number): void {
    try { d.recordTiming?.(activity, Math.max(0, ms)); } catch { /* diagnostics only */ }
}

/**
 * A leave counts as committed only when the server SAYS so (`{ ok: true }`).
 * A 2xx with any other body (a proxy page, an older API) is a failure, never a
 * silent success. Throws so `leaveServerOptimistic` rolls back.
 */
export function assertLeaveCommitted(res: unknown): void {
    const data = (res as { data?: { ok?: unknown } } | null | undefined)?.data;
    if (!data || data.ok !== true) throw new Error('The server did not confirm the leave.');
}

/** The message to show when a leave fails: the SERVER's own words when it sent
 *  any (e.g. "Owner cannot leave a server..."), else a generic network line. */
export function describeLeaveError(err: unknown): string {
    const m = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
    const text = Array.isArray(m) ? m.filter(x => typeof x === 'string').join(' ') : m;
    if (typeof text === 'string' && text.trim()) return text.trim();
    const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
    if (typeof status === 'number') return `The server refused the request (${status}).`;
    return 'Could not reach the server. Check your connection and try again.';
}
