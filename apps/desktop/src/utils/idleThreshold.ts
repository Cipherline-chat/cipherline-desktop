/**
 * Shared idle-time polling cadence and "away" threshold.
 *
 * Single source of truth for `electronAPI.getSystemIdleTime()` consumers:
 * useUserStatus.ts's self-away detection AND the continuity attention state
 * machine (utils/attentionState.ts, wired into useRealtime.ts's
 * `presence:heartbeat`). Both need the exact same numbers — a user who goes
 * "away" at a different moment than they stop being "attentive" (continuity's
 * suppress/escalate signal) would be confusing and is exactly the "second
 * idle notion" the continuity spec says not to invent.
 *
 * Pulled into its own file (rather than importing straight from
 * useUserStatus.ts) so a pure module like attentionState.ts can depend on
 * just two numbers without dragging in useUserStatus.ts's React/axios import
 * chain — that chain breaks under vitest's plain node environment (no
 * `window.location` for axios's platform detection) when the only thing a
 * pure-function test actually needs is these two constants.
 */
export const IDLE_THRESHOLD_SECONDS = 300; // 5 minutes
export const IDLE_POLL_INTERVAL_MS = 30_000; // 30 seconds
