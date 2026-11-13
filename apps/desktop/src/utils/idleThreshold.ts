/**
 * Shared idle-time polling cadence and the user's "Idle timeout".
 *
 * Single source of truth for `electronAPI.getSystemIdleTime()` consumers:
 * useUserStatus.ts's self-away detection, the listening-share idle state, AND
 * the continuity attention state machine (utils/attentionState.ts, wired into
 * useRealtime.ts's `presence:heartbeat`). All of them need the exact same
 * number — a user who goes "away" at a different moment than they stop being
 * "attentive" (continuity's suppress/escalate signal) would be confusing and
 * is exactly the "second idle notion" the continuity spec says not to invent.
 *
 * The number is the user's own setting (Settings > Notifications > "Idle
 * timeout", persisted in the encrypted notification prefs as
 * `idle_timeout_minutes`). It is the owner's rule R2: "if I walk away and a
 * message came in, wait until my idle timeout; if still no activity, notify my
 * phone." NotificationContext mirrors the saved value in here with
 * setIdleTimeoutMinutes() on load and on every change, so consumers read ONE
 * live value through getIdleThresholdSeconds() at the moment they decide, with
 * no per-hook copy to drift.
 *
 * Pulled into its own file (rather than importing straight from
 * useUserStatus.ts) so a pure module like attentionState.ts can depend on
 * just a few numbers without dragging in useUserStatus.ts's React/axios import
 * chain — that chain breaks under vitest's plain node environment (no
 * `window.location` for axios's platform detection) when the only thing a
 * pure-function test actually needs is these values.
 */

/** Default idle timeout, in minutes. Unchanged behaviour: 5 minutes. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;

/** The choices Settings offers, in minutes. Anything else read from storage is
 *  snapped back to the default rather than trusted (see normalize below). */
export const IDLE_TIMEOUT_CHOICES_MINUTES: readonly number[] = [1, 2, 5, 10, 15, 30];

/** The DEFAULT idle threshold in seconds (5 min). Kept as an export for
 *  callers and tests that mean "the default"; live code reads the user's
 *  value through getIdleThresholdSeconds(). */
export const IDLE_THRESHOLD_SECONDS = DEFAULT_IDLE_TIMEOUT_MINUTES * 60; // 300
export const IDLE_POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Coerce a stored/unknown value to a supported idle timeout. A missing,
 * non-numeric or out-of-menu value (a hand-edited blob, a future build's
 * extra choice, NaN) becomes the default: never trust an unvalidated
 * number to decide when to buzz someone's phone.
 */
export function normalizeIdleTimeoutMinutes(value: unknown): number {
    return typeof value === 'number' && IDLE_TIMEOUT_CHOICES_MINUTES.includes(value)
        ? value
        : DEFAULT_IDLE_TIMEOUT_MINUTES;
}

let currentMinutes = DEFAULT_IDLE_TIMEOUT_MINUTES;

/** Set the live idle timeout (minutes). Called by NotificationContext whenever
 *  the prefs load or change; normalised, so a bad value cannot get in. */
export function setIdleTimeoutMinutes(minutes: unknown): void {
    currentMinutes = normalizeIdleTimeoutMinutes(minutes);
}

/** The user's idle timeout in whole seconds, right now. */
export function getIdleThresholdSeconds(): number {
    return currentMinutes * 60;
}
