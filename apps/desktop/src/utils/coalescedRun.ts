/**
 * Collapse overlapping calls to an async job into at most one run in flight
 * plus ONE trailing run.
 *
 * - No run in flight: start one.
 * - A run in flight: don't start a parallel one; remember that another was
 *   asked for, and return the in-flight promise. However many calls land in
 *   that window, exactly one follow-up run happens after it settles — so a
 *   caller whose request arrived mid-run still gets a run that STARTED after
 *   its request (fresh data), without every caller getting its own.
 *
 * Used for the dashboard's wake/reconnect resync, which one OS wake fires
 * twice within milliseconds (see Dashboard.tsx → rehydrateAll).
 */
export function createCoalescedRunner(job: () => Promise<void>): () => Promise<void> {
    let inFlight: Promise<void> | null = null;
    let again = false;
    return () => {
        if (inFlight) {
            again = true;
            return inFlight;
        }
        inFlight = (async () => {
            try {
                do {
                    again = false;
                    try {
                        await job();
                    } catch {
                        // A failed run must not wedge the runner or swallow a
                        // queued follow-up; the job reports its own errors.
                    }
                } while (again);
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    };
}
