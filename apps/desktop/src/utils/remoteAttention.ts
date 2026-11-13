/**
 * Cross-device continuity — what this PC knows about the user's OTHER devices.
 *
 * Owner rule R6: "If I am on my phone with the mobile app open, I want no
 * notification on my computer." The desktop cannot see the phone, so the
 * server tells it, over the socket it already has:
 *
 *   - every `presence:ack` (the reply to the 15 s heartbeat) carries
 *     `data: { mobile_attentive: boolean }` for desktop sockets, and
 *   - when a phone flips foreground <-> background the server pushes the new
 *     answer at once as `presence:attention` with the same `data` shape
 *     (debounced server-side), so the wait is not a full heartbeat.
 *
 * This module is the tiny pure holder for that answer, so the notification
 * pipeline can read it without any React or socket plumbing and the rules are
 * unit-testable. Metadata only: one boolean about the user's OWN devices; no
 * device ids, no conversations, no content.
 *
 * Failure direction is the SAFE one for notifications: anything unknown reads
 * as "no phone is attentive", i.e. today's behaviour, the desktop notifies.
 * A missing or malformed field clears the flag; so does an answer older than
 * REMOTE_ATTENTION_FRESH_MS (the socket went quiet, so we no longer know); so
 * does a closed socket (resetRemoteAttention). An old server that never sends
 * the field therefore changes nothing.
 */

/**
 * How long a "phone is attentive" answer stays believable without a refresh.
 * Three heartbeat periods (15 s each): one dropped ack must not flip a quiet
 * desktop to noisy, but a dead socket must not keep it quiet for long.
 */
export const REMOTE_ATTENTION_FRESH_MS = 45_000;

interface RemoteAttention {
    mobileAttentive: boolean;
    /** Epoch ms the answer was received. */
    at: number;
}

let current: RemoteAttention = { mobileAttentive: false, at: 0 };

/**
 * Record the `data` payload of a `presence:ack` / `presence:attention` frame.
 * Anything other than a boolean `mobile_attentive` is "unknown" and clears the
 * flag (never carries a previous `true` forward).
 */
export function applyRemoteAttention(data: unknown, now: number = Date.now()): void {
    const v = data && typeof data === 'object'
        ? (data as { mobile_attentive?: unknown }).mobile_attentive
        : undefined;
    current = { mobileAttentive: v === true, at: now };
}

/** Forget everything (socket closed, sign-out): unknown reads as not attentive. */
export function resetRemoteAttention(): void {
    current = { mobileAttentive: false, at: 0 };
}

/** Is one of the user's phones attentive right now, as far as we know? */
export function isMobileAttentive(now: number = Date.now()): boolean {
    return current.mobileAttentive && now - current.at >= 0 && now - current.at <= REMOTE_ATTENTION_FRESH_MS;
}
