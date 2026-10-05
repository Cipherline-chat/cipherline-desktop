/**
 * Pure decision logic for the sleep-wake call-staleness backstop (Dashboard's
 * rehydrateAll wake path). On waking from sleep, the app has no way to know
 * whether a call it thinks is still active actually ended while the device
 * was suspended (server-side reaping, the other party hanging up, etc.) — the
 * WS socket was dead the whole time, so no `call:ended`-style event could
 * have arrived. This checks GET /v1/calls/:id/status and decides what to do
 * with the answer.
 *
 * Deliberately conservative: a FAILED status check (network still not fully
 * back post-wake — this is common, not an edge case) must never be treated
 * as "the call is dead". Only an explicit, successful "not active" answer
 * from the server is trusted to tear the call down locally. Absence of
 * evidence is not evidence of absence.
 */

export interface CallStatusResponse {
    active: boolean;
}

/** Does this status response justify tearing down a locally-held call? */
export function shouldTeardownForCallStatus(status: CallStatusResponse | null): boolean {
    if (status === null) return false; // failed/errored check — never conclusive
    return status.active === false;
}

/**
 * Should the staleness check keep retrying after a failed/no-answer attempt?
 * `elapsedMs` is time since the first attempt (i.e. since wake), not since
 * the last attempt. Generous by design — deliberately larger than the 15s
 * call-connect timeout elsewhere, because post-wake networking (Wi-Fi
 * re-association, VPN re-handshake, DNS) is often slower than a normal
 * mid-session blip.
 */
export function shouldKeepRetryingStalenessCheck(elapsedMs: number, graceWindowMs: number): boolean {
    return elapsedMs < graceWindowMs;
}
