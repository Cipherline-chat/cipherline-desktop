/**
 * clickBurst: "N clicks within W ms" as a pure, clock-free rule (the caller
 * passes `now`). Used by the title-bar mark's hidden lap: ten clicks in four
 * seconds.
 *
 * It is a sliding window, not a streak: the Nth click counts when it lands
 * within `windowMs` of the click N-1 places before it, so a slow start followed
 * by a fast finish still counts. A trigger clears the window (the next lap needs
 * ten fresh clicks) and starts a cool-down during which clicks are ignored
 * entirely, so a held-down auto-clicker can never keep it firing.
 */
export const BURST_CLICKS = 10;
export const BURST_WINDOW_MS = 4000;
export const BURST_COOLDOWN_MS = 12_000;

export function createClickBurst(
    count = BURST_CLICKS,
    windowMs = BURST_WINDOW_MS,
    cooldownMs = BURST_COOLDOWN_MS,
) {
    let times: number[] = [];
    let coolUntil = -Infinity;
    return {
        /** One click at `now`. True exactly when this click completes a burst. */
        hit(now: number): boolean {
            if (now < coolUntil) return false;
            // A clock that stepped back would make the window nonsense: start over.
            if (times.length && now < times[times.length - 1]) times = [];
            times.push(now);
            if (times.length > count) times.shift();
            if (times.length === count && now - times[0] <= windowMs) {
                times = [];
                coolUntil = now + cooldownMs;
                return true;
            }
            return false;
        },
        /** Test hook. */
        get pending() { return times.length; },
    };
}
