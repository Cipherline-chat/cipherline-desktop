/**
 * Cross-device continuity — the desktop attention state machine.
 *
 * The server's per-device presence registry (`ws:attn:<userId>`, written by
 * `presence:heartbeat`'s optional `{ active: boolean }` body — see
 * apps/api/src/gateway/gateway.gateway.ts's onHeartbeat and
 * apps/api/src/gateway/dto/ws.dto.ts's HeartbeatEventDto) is what decides
 * whether an unread message suppresses or escalates to the owner's phone.
 * This module is the client's answer to "is the person actually in front of
 * THIS screen right now" — a pure, DOM/Electron-free function so the
 * decision is unit-testable without a real window or socket.
 *
 * `active: true` must mean exactly one thing: a human is looking at this
 * window right now. Getting this wrong in the permissive direction (a
 * minimised/backgrounded window reporting true) is the precise bug this
 * feature exists to remove — it would silence the user's own phone while
 * nobody is actually reading the message. Getting it wrong in the
 * conservative direction (an attentive user occasionally reported false) is
 * merely an extra buzz. The rule below is deliberately asymmetric for that
 * reason: `focused` gates everything, unconditionally.
 */

/**
 * Reused from the same source useUserStatus.ts's own-away detection reads —
 * see utils/idleThreshold.ts's doc comment. Attention does NOT invent a
 * separate idle notion; it imports these same constants so "away"
 * (self-reported status) and "not attentive" (continuity's
 * suppress/escalate signal) never disagree about how long is too long.
 */
import { IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS } from './idleThreshold';
export { IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS };

/**
 * The state machine's one decision, as a pure function.
 *
 * @param focused      Window has OS focus right now (not minimised, not
 *                      behind another app, not screen-locked). Any `false`
 *                      here is decisive — idle time is irrelevant once the
 *                      window isn't even in front of the user.
 * @param idleSeconds  OS-wide idle time in seconds, from
 *                      `electronAPI.getSystemIdleTime()` (the SAME polled
 *                      value useUserStatus.ts uses for auto-away).
 * @param idleThresholdSeconds  Defaults to the real IDLE_THRESHOLD_SECONDS
 *                      constant (not a re-typed literal, so there is only
 *                      ever one 300 written down) — overridable only for
 *                      tests.
 */
export function computeIsAttentive(
    focused: boolean,
    idleSeconds: number,
    idleThresholdSeconds: number = IDLE_THRESHOLD_SECONDS,
): boolean {
    if (!focused) return false;
    // NaN/negative/unknown idle readings must never read as "recent input" —
    // fail toward not-attentive (see module doc: conservative direction is
    // the safe one).
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return false;
    return idleSeconds < idleThresholdSeconds;
}

/**
 * The reasons an off-cycle (immediate, outside the 15s heartbeat cadence)
 * `active: false` must be sent — see the spec: "without it the user waits
 * their full idle threshold plus 90s [server escalation]." Exported as a
 * union so callers (useRealtime.ts) and tests share one vocabulary for why
 * a transition fired, useful for logging/debugging without affecting the
 * wire payload (the server only ever sees `active: false`).
 */
export type AttentionLostReason = 'blur' | 'minimize' | 'lock' | 'quit';

/**
 * Can a human be looking at this window RIGHT NOW? Every input must say yes.
 *
 * Read from the live window at the moment a heartbeat is sent, not from a
 * value cached when the last focus/blur event fired: a missed event (a tray
 * hide on a platform that fires no blur, a window hidden while it was already
 * unfocused) must not leave `active: true` on the wire from a window nobody
 * can see. The server's push routing reads that flag to decide whether to
 * wake the user's phone, and a hidden desktop claiming attention silences it.
 *
 *  - `focusedByEvent`   — the focus/blur/minimise/lock event stream's view;
 *  - `documentHasFocus` — `document.hasFocus()`, false for a minimised or
 *                         background window even when an event was missed;
 *  - `visibilityState`  — `document.visibilityState`; Chromium reports
 *                         `hidden` for a minimised or hidden window. Only
 *                         `visible` counts — anything else, or unknown, is no.
 */
export function isWindowAttendable(w: {
    focusedByEvent: boolean;
    documentHasFocus: boolean;
    visibilityState: string | undefined;
}): boolean {
    return w.focusedByEvent && w.documentHasFocus && w.visibilityState === 'visible';
}

/**
 * The one `presence:heartbeat` frame this client sends, in every state:
 * `{"event":"presence:heartbeat","data":{"active":<boolean>}}`. The server
 * (gateway.gateway.ts onHeartbeat, HeartbeatEventDto) owns what it does with
 * `active`; this client only guarantees it is never `true` from a window that
 * is hidden, minimised, unfocused, locked, or idle past the threshold.
 */
export function heartbeatPayload(active: boolean): string {
    return JSON.stringify({ event: 'presence:heartbeat', data: { active } });
}
