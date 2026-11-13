/**
 * Cross-device continuity — the desktop attention state machine.
 *
 * The server's per-device presence registry (`ws:attn:<userId>`, written by
 * `presence:heartbeat`'s optional `{ active: boolean }` body — see
 * apps/api/src/gateway/gateway.gateway.ts's onHeartbeat and
 * apps/api/src/gateway/dto/ws.dto.ts's HeartbeatEventDto) is what decides
 * whether an unread message suppresses or escalates to the owner's phone.
 * This module is the client's answer to "is this PC in use right now" — a
 * pure, DOM/Electron-free set of functions so the decision is unit-testable
 * without a real window or socket.
 *
 * ── What `active: true` means ───────────────────────────────────────────────
 *
 * The PC is demonstrably IN USE: the OS-wide input idle time is under the
 * user's idle timeout AND the session is not locked, suspended or shutting
 * down. Which window has focus is deliberately NOT part of the answer.
 *
 * Why not focus: the question this flag answers is "does the phone need to
 * buzz", and a person typing in another app on this same PC does not. A PC
 * that is in use shows its own OS notification for a new message, so the
 * phone should stay quiet. The earlier rule ("`focused` gates everything,
 * unconditionally") reported not-attentive the instant Cipherline lost focus,
 * so working in a browser or an editor on the same machine made the phone buzz
 * for every message, which is exactly what the owner does not want while at
 * the PC. Input idle time is the honest signal of "someone is here";
 * window focus only says which app they are in.
 *
 * ── What still reports `active: false` immediately ──────────────────────────
 *
 * Anything that means nobody can be at this screen, whatever the idle clock
 * says: screen lock, suspend/sleep (lid close), shutdown/quit. The idle clock
 * alone is too slow for those (it would have to run out first, and a locked
 * session keeps counting while the user types a password), so they are
 * reported off-cycle by the session power state below. Failure direction is
 * asymmetric on purpose: an attentive user occasionally reported inactive is
 * merely an extra buzz; an absent user reported active silences their phone
 * while nobody reads the message. So an unknown/NaN/negative idle reading is
 * never "recent input".
 */

/**
 * Reused from the same source useUserStatus.ts's own-away detection reads —
 * see utils/idleThreshold.ts's doc comment. Attention does NOT invent a
 * separate idle notion; it takes the same threshold ("Idle timeout" in
 * Settings > Notifications), so "away" (self-reported status) and "not
 * attentive" (continuity's suppress/escalate signal) never disagree about how
 * long is too long. The constant is only the DEFAULT; callers pass the user's
 * live value (getIdleThresholdSeconds()).
 */
import { IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS } from './idleThreshold';
export { IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS };

/**
 * The state machine's one decision, as a pure function.
 *
 * @param sessionInUse  The OS session is available to a person right now:
 *                      not locked, not suspended. From isSessionInUse(). Any
 *                      `false` here is decisive — idle time is irrelevant once
 *                      the screen is locked or the machine is asleep. Window
 *                      focus/blur/minimise are NOT inputs (see the module doc).
 * @param idleSeconds   OS-wide idle time in seconds, from
 *                      `electronAPI.getSystemIdleTime()` (the SAME polled
 *                      value useUserStatus.ts uses for auto-away).
 * @param idleThresholdSeconds  The user's idle timeout in seconds. Defaults to
 *                      the real IDLE_THRESHOLD_SECONDS default (not a re-typed
 *                      literal, so there is only ever one 300 written down).
 */
export function computeIsAttentive(
    sessionInUse: boolean,
    idleSeconds: number,
    idleThresholdSeconds: number = IDLE_THRESHOLD_SECONDS,
): boolean {
    if (!sessionInUse) return false;
    // NaN/negative/unknown idle readings must never read as "recent input" —
    // fail toward not-attentive (see module doc: conservative direction is
    // the safe one).
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return false;
    // A nonsensical threshold (NaN, zero, negative) can never make anyone
    // "recently active" either.
    if (!Number.isFinite(idleThresholdSeconds) || idleThresholdSeconds <= 0) return false;
    return idleSeconds < idleThresholdSeconds;
}

/**
 * The OS power/lock signals main forwards (powerMonitor 'lock-screen' /
 * 'unlock-screen' / 'suspend' / 'resume'; on Linux the screensaver D-Bus
 * signal stands in for the lock pair). One closed vocabulary shared by
 * electron/main.ts, the preload bridge, and this reducer.
 */
export type OsPowerSignal = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume';

export const OS_POWER_SIGNALS: readonly OsPowerSignal[] = ['lock-screen', 'unlock-screen', 'suspend', 'resume'];

/**
 * Two independent facts, because the signals do not cancel each other:
 * a laptop locked at the desk and then closed emits lock → suspend → resume,
 * and after that resume the user is still looking at a lock screen. Folding
 * both into one boolean would mark the PC "in use" at the lock screen the
 * moment the lid opens; only the matching unlock clears the lock.
 */
export interface SessionPowerState {
    locked: boolean;
    suspended: boolean;
}

/** Initial state: nothing has happened, so the session is presumed available.
 *  Safe because the idle clock still has to say "recent input" on top. */
export const SESSION_AVAILABLE: SessionPowerState = { locked: false, suspended: false };

/** Fold one power signal into the state. Unknown signals change nothing. */
export function reduceSessionPowerState(prev: SessionPowerState, signal: string): SessionPowerState {
    switch (signal) {
        case 'lock-screen': return { ...prev, locked: true };
        case 'unlock-screen': return { ...prev, locked: false };
        case 'suspend': return { ...prev, suspended: true };
        case 'resume': return { ...prev, suspended: false };
        default: return prev;
    }
}

/** The session is available to a person: neither locked nor suspended. */
export function isSessionInUse(s: SessionPowerState): boolean {
    return !s.locked && !s.suspended;
}

/**
 * How long to wait before reading the OS idle time again.
 *
 * The idle clock is the only thing that can END attention (or restore it)
 * without an event, so how promptly it is read sets how precisely "wait until
 * my idle timeout" is honoured:
 *
 *  - Attentive: sleep until just after the threshold would be crossed, capped
 *    at `maxMs` (nothing can change sooner except a lock/suspend, which are
 *    events, not polls). A 5-minute timeout therefore flips at ~5:00, not
 *    somewhere in a 30 s polling slot after it.
 *  - Already past the threshold (or unknown): poll every `idleMs`, so the
 *    first keystroke after coming back is noticed in seconds. The phone
 *    should go quiet again as soon as the user is back at the PC.
 *
 * Never below `minMs`, so a threshold that is about to elapse cannot turn
 * into a hot loop.
 */
export function nextIdlePollDelayMs(
    idleSeconds: number,
    idleThresholdSeconds: number,
    opts: { maxMs?: number; idleMs?: number; minMs?: number } = {},
): number {
    const maxMs = opts.maxMs ?? IDLE_POLL_INTERVAL_MS;
    const idleMs = opts.idleMs ?? 10_000;
    const minMs = opts.minMs ?? 1_000;
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return idleMs;
    if (!Number.isFinite(idleThresholdSeconds) || idleThresholdSeconds <= 0) return idleMs;
    const remainingMs = (idleThresholdSeconds - idleSeconds) * 1000;
    if (remainingMs <= 0) return idleMs;
    return Math.min(maxMs, Math.max(minMs, remainingMs + 250));
}

/**
 * The reasons an off-cycle (immediate, outside the 15s heartbeat cadence)
 * `active: false` must be sent. Exported as a union so callers
 * (useRealtime.ts) and tests share one vocabulary for why a transition fired,
 * useful for logging/debugging without affecting the wire payload (the server
 * only ever sees `active: false`). Focus loss (blur/minimise/hide) is NOT a
 * reason any more: see the module doc.
 */
export type AttentionLostReason = 'lock' | 'suspend' | 'idle' | 'quit';

/**
 * The one `presence:heartbeat` frame this client sends, in every state:
 * `{"event":"presence:heartbeat","data":{"active":<boolean>}}`. The server
 * (gateway.gateway.ts onHeartbeat, HeartbeatEventDto) owns what it does with
 * `active`; this client only guarantees it is never `true` while the session
 * is locked or suspended, or once input idle time has reached the user's
 * idle timeout.
 */
export function heartbeatPayload(active: boolean): string {
    return JSON.stringify({ event: 'presence:heartbeat', data: { active } });
}
