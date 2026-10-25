import { pushWithin } from './easterEggs';
import { STATUS_FLAP_POOL, pickRotating } from './eggPools';

/**
 * Egg: flipping your presence status six times inside a minute. The picker's
 * "Status" label briefly turns into a line from STATUS_FLAP_POOL ("Still
 * deciding?"). Counts only real CHANGES (picking the status you already have
 * is not a flip) and fires on the exact hit, not on every flip after it.
 */
export const STATUS_FLAP_COUNT = 6;
export const STATUS_FLAP_WINDOW_MS = 60_000;
export const STATUS_FLAP_EGG = 'status-flap';
/** Once it has spoken it stays quiet for a while, however long they keep flipping. */
export const STATUS_FLAP_COOLDOWN_MS = 5 * 60_000;
/** How long the line replaces the label. */
export const STATUS_FLAP_SHOW_MS = 4000;

export interface FlapStep { times: number[]; fire: boolean }

export function flapStep(prev: readonly number[], now: number): FlapStep {
    const times = pushWithin(prev, now, STATUS_FLAP_WINDOW_MS);
    return { times, fire: times.length === STATUS_FLAP_COUNT };
}

export function flapLine(timesShownBefore: number): string {
    return pickRotating(STATUS_FLAP_POOL, timesShownBefore);
}

/** The clock, kept out of the component so the picker's handler stays free of impure calls. */
export const flapNow = (): number => Date.now();
