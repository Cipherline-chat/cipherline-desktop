/**
 * socketLiveness — decides when a WebSocket that still *looks* open is actually
 * dead, so the client reconnects instead of sitting on a corpse.
 *
 * The failure this exists for: after the machine suspends, the TCP connection
 * is usually left half-open. `ws.send()` keeps succeeding, `readyState` stays
 * OPEN, and `onclose` never fires — so useRealtime never reconnects,
 * `wsConnectCount` never increments, and the refetch-on-reconnect path that
 * would repair the UI never runs. The user sees stale statuses and blank
 * avatars until they refresh.
 *
 * The signal we use is the heartbeat acknowledgement. The client already sends
 * `presence:heartbeat` every 15s and the server already answers
 * `{event:'presence:ack'}` (gateway.gateway.ts) — it just wasn't being
 * listened for. If ACKs stop arriving while we're still sending, the pipe is
 * dead regardless of what readyState claims.
 *
 * Pure and side-effect free so the rules can be tested directly, rather than by
 * suspending a laptop and hoping.
 */

/** Heartbeat send interval, mirrored from useRealtime. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Missed heartbeats tolerated before declaring the socket dead. Two (~30s)
 * sits below the server's own 45s zombie watchdog, so the client gives up on a
 * dead socket and starts reconnecting BEFORE the server force-offlines it and
 * tears down any active call.
 */
export const MISSED_HEARTBEATS_BEFORE_DEAD = 2;

export interface LivenessState {
    /**
     * True once this connection has ever produced an ACK. Until then the
     * timeout is NOT enforced — see shouldForceReconnect.
     */
    everAcked: boolean;
    /** Timestamp of the most recent ACK, or null if none yet. */
    lastAckAt: number | null;
    /** Timestamp of the most recent heartbeat we sent. */
    lastHeartbeatSentAt: number | null;
}

export function initialLivenessState(): LivenessState {
    return { everAcked: false, lastAckAt: null, lastHeartbeatSentAt: null };
}

export function onAckReceived(state: LivenessState, now: number): LivenessState {
    return { ...state, everAcked: true, lastAckAt: now };
}

export function onHeartbeatSent(state: LivenessState, now: number): LivenessState {
    return { ...state, lastHeartbeatSentAt: now };
}

/**
 * Should we tear this socket down and reconnect?
 *
 * The `everAcked` guard is load-bearing, not defensive padding. A client newer
 * than the server it's talking to would never receive an ACK, and without the
 * guard it would declare every healthy socket dead after 30s and reconnect
 * forever — turning a cosmetic version skew into a self-inflicted outage that
 * also hammers the server. So the rule is: only a connection that has PROVEN
 * the server answers is allowed to conclude that silence means death.
 */
export function shouldForceReconnect(
    state: LivenessState,
    now: number,
    intervalMs: number = HEARTBEAT_INTERVAL_MS,
    missedAllowed: number = MISSED_HEARTBEATS_BEFORE_DEAD,
): boolean {
    if (!state.everAcked) return false;
    if (state.lastAckAt === null) return false;
    return now - state.lastAckAt > intervalMs * missedAllowed;
}
