import { ALONE_ECHO_POOL, pickEscalating } from './eggPools';

/**
 * Egg: sitting alone in a call for a few minutes → Keys echoes. Timing and
 * line selection only (the component owns the clock), so it is testable.
 *
 * "Alone" is the LiveKit roster being just you. The trigger reads nothing but
 * that count and the clock — never who was in the call or what was said.
 */

/** Alone this long before Keys says anything. */
export const ALONE_ECHO_AFTER_MS = 4 * 60 * 1000;
/** Gap between his lines; after the last one he goes quiet. */
export const ALONE_ECHO_STEP_MS = 6500;
/** Ledger id + rate limit: at most once per six hours, however many calls. */
export const ALONE_ECHO_EGG = 'alone-echo';
export const ALONE_ECHO_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The line for step `i` (0 = the opener), or null once he has finished. */
export function aloneEchoLine(step: number): string | null {
    if (step < 0 || step >= ALONE_ECHO_POOL.length) return null;
    return pickEscalating(ALONE_ECHO_POOL, step);
}

/** Total time from first line to him going quiet. */
export const ALONE_ECHO_TOTAL_MS = ALONE_ECHO_STEP_MS * ALONE_ECHO_POOL.length;
