/**
 * A small, passive moment inside a call, decided by a clock alone: after
 * THREE HOURS continuously in a call, a dismissable card ("Three hours in.
 * Maybe stretch?"), once per call.
 *
 * Nothing here reads anything about the call but "am I in it": no names, no
 * contents, no counts of people. Nothing leaves the device.
 *
 * `createMilestone` is a pure state machine over (active?, now). The caller
 * polls it (it uses wall-clock time, so a throttled or sleeping renderer fires
 * on the first check after the threshold rather than missing it) and also
 * reports edges as they happen.
 */

export const LONG_CALL_MS = 3 * 60 * 60 * 1000;

export interface MilestoneOptions {
    /** Continuous active time before it fires. */
    afterMs: number;
    /**
     * true: fires at most once for the life of this watcher (a call: leaving and
     * rejoining restarts the clock but never repeats the card).
     * false: fires once per continuous run (a share session: stopping and
     * starting again is a new session).
     */
    once: boolean;
}

export function createMilestone({ afterMs, once }: MilestoneOptions) {
    let since: number | null = null;
    let fired = false;
    return {
        /**
         * Report whether the thing is happening at `now`. Returns true on the
         * single call that crosses the threshold, false otherwise.
         */
        update(active: boolean, now: number): boolean {
            if (!active) {
                since = null;
                if (!once) fired = false;
                return false;
            }
            if (since === null || now < since) since = now;   // a clock that stepped back restarts the run
            if (fired) return false;
            if (now - since < afterMs) return false;
            fired = true;
            return true;
        },
        /** Test hook. */
        get runningSince() { return since; },
        get fired() { return fired; },
    };
}
