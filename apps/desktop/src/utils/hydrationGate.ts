/**
 * hydrationGate — the rule for whether first paint may proceed.
 *
 * Split out from HydrationContext so the decision can be tested directly. The
 * failure modes here are the kind that only show up on a bad network, which is
 * exactly when nobody is watching: a gate that never opens strands the user on
 * a skeleton, and a gate that re-closes yanks a working app back to one.
 */

export type CoreLoad = 'conversations' | 'friends' | 'servers';

export interface GateInput {
    /** Core loads that have settled — resolved OR exhausted their retries. */
    settled: Partial<Record<CoreLoad, boolean>>;
    /** True once the timeout has fired and we've stopped waiting. */
    gateReleased: boolean;
}

export const CORE_LOADS: CoreLoad[] = ['conversations', 'friends', 'servers'];

/**
 * May the app render?
 *
 * Note "settled", not "succeeded". A core load that failed every retry still
 * settles: the user is better served by a partly-populated app that keeps
 * retrying in the background than by an indefinite skeleton. The gate is there
 * to avoid a *flash* of empty UI, not to guarantee completeness.
 */
export function isHydrationReady(input: GateInput): boolean {
    if (input.gateReleased) return true;
    return CORE_LOADS.every(l => input.settled[l] === true);
}

/**
 * Should the timeout still be armed? Once the gate is open there's nothing
 * left to time out, and re-arming it later must never re-close the gate.
 */
export function shouldArmGateTimeout(input: GateInput): boolean {
    return !isHydrationReady(input);
}
