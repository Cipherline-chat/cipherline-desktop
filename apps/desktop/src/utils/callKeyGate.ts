/**
 * The connect/wait/degrade decision for EVERY call — Calls channel and
 * DM/group alike.
 *
 * It covered only Calls channels until 2026-09-20, and the DM/group half was
 * explicitly documented as out of scope ("DM/group calls use the separate
 * call_key flow and are not gated here at all"). That gap was a live
 * plaintext hole, not a tidiness problem: a DM/group call whose `call_key`
 * had not arrived yet mounted CallPane with an empty key, CallPane's
 * `...(e2eeKeyB64 ? { encryption: ... } : {})` built the LiveKit Room with no
 * encryption block at all, and E2EEActivator's keyless branch logged "media
 * is NOT end-to-end encrypted" and carried on. Media then went to the SFU in
 * the clear for the WHOLE call, because a key arriving afterwards has nowhere
 * to be installed — there is no key provider on a room built without
 * `encryption:`, and the key store is a ref, so its arrival re-renders
 * nothing.
 *
 * The race is easy to lose, not exotic: the client learns it is in a call
 * from a REST status check while the key arrives as an encrypted message.
 * Answer quickly and the key loses. Both peers can be desktops.
 *
 * So the gate now answers for both, and `not_applicable` is gone from the
 * result type on purpose — there is no longer a call shape this does not
 * decide, and the missing case must be a compile error rather than a silently
 * ungated mount.
 *
 * `useCallsChannelKey` answers "do we hold a usable room key right now?".
 * This turns that answer plus the call's own history into "what should the UI
 * actually do?", because those are NOT the same question:
 *
 *   - Before the room is joined, no key means DO NOT CONNECT. There is no
 *     plaintext fallback and there must not be one.
 *   - AFTER the room is joined under a real key, losing the ability to *read*
 *     the key back out of local storage does not make the live call
 *     unencrypted — the derived key is already installed in LiveKit's key
 *     provider and the media stays encrypted under it. Tearing the call down
 *     on a transient IPC/keystore hiccup would look identical to a crash
 *     while buying no confidentiality at all.
 *
 * Extracted from Dashboard so the security-critical part — "can we hand a key
 * to CallPane, and is it non-empty?" — is unit-testable without React.
 *
 * INVARIANTS, asserted by the tests:
 *   1. `kind: 'connect'` is returned ONLY with a non-empty `keyB64`. Every
 *      other outcome blocks the connection. This holds for BOTH call kinds —
 *      it is the single thing standing between a lost key race and plaintext
 *      media on the relay.
 *   2. A key is only ever usable for the channel it was derived for. Both the
 *      fresh key and the latched last-known-good one carry the channel they
 *      belong to, and a mismatch is treated as "no key" — never as a key.
 */

/**
 * How long a call may sit with no key at all before the UI stops implying
 * progress and says so plainly. Applies to both call kinds. Long enough to cover a mint + epoch-record +
 * distribute round (seconds) and an online holder answering a key request
 * (jittered 0.5–3.5 s, plus delivery), short enough that a user who is never
 * getting a key isn't left staring at a spinner.
 */
export const CALL_KEY_STALL_MS = 20_000;

/**
 * How long a LIVE call may go without readable keys before we surface a
 * warning. Below this the gap is silent: a single failed IPC poll (2 s
 * cadence) must not put a scary banner over a call that is working fine.
 */
export const CALL_KEY_DEGRADED_GRACE_MS = 15_000;

export type CallKeyGate =
    /** No key has EVER been held for this call. CallPane must not mount.
     *  `stalled` = past CALL_KEY_STALL_MS, so stop implying progress. */
    | { kind: 'blocked'; stalled: boolean }
    /** Safe to connect with `keyB64` (always non-empty). `degraded` = the key
     *  is the latched last-known-good one and the gap has outlived the grace
     *  window, so the user should be told. */
    | { kind: 'connect'; keyB64: string; degraded: boolean };

export interface CallKeyGateInput {
    /**
     * The Calls channel this call is actually in (`activeCall.callsChannelId`),
     * or null for a DM/group call. Null means "not a Calls channel" — those use
     * the separate `call_key` flow and are not gated here.
     */
    channelId: string | null;
    /**
     * The DM/group room key delivered by the `call_key` flow — from
     * `activeCall.e2ee_key_b64`, or the key store for a call this device
     * joined rather than started. Read ONLY when `channelId` is null; a Calls
     * channel derives its key and never carries a delivered one.
     */
    deliveredKeyB64: string | null;
    /** Current resolver output. 'ready' must come with a key; anything else must not. */
    status: 'idle' | 'waiting' | 'ready';
    /** The freshly derived room key when `status === 'ready'`. */
    keyB64: string | null;
    /**
     * The channel `keyB64` was derived for. React state lags its input by a
     * render, so on the pass where the call moves to a different Calls channel
     * this is still the PREVIOUS channel — which is exactly the case that must
     * not connect.
     */
    keyChannelId: string | null;
    /**
     * The last key this call successfully connected under, latched by the
     * caller, with the channel it belongs to. Both are checked: a key is never
     * carried into a room it was not derived for.
     */
    lastGoodKeyB64: string | null;
    lastGoodChannelId: string | null;
    /** When the current keyless stretch began (ms epoch), or null if not keyless. */
    waitingSinceMs: number | null;
    nowMs: number;
}

export function resolveCallKeyGate(input: CallKeyGateInput): CallKeyGate {
    const elapsed = input.waitingSinceMs == null ? 0 : Math.max(0, input.nowMs - input.waitingSinceMs);

    // ── DM / group: the key is DELIVERED, so we either have it or we wait ──
    if (!input.channelId) {
        if (input.deliveredKeyB64) {
            return { kind: 'connect', keyB64: input.deliveredKeyB64, degraded: false };
        }
        // Deliberately does NOT fall through to the last-known-good latch
        // below. That latch is scoped by channel id, and for a DM call the
        // channel id is null on both sides — so `lastGoodChannelId ===
        // channelId` would be null === null, i.e. TRUE, and would happily
        // carry a key latched from some earlier Calls-channel call into an
        // unrelated DM. There is nothing to latch here anyway: a delivered key
        // lives on the call object and in the key store and never becomes
        // unreadable mid-call the way a derived one can.
        return { kind: 'blocked', stalled: elapsed >= CALL_KEY_STALL_MS };
    }

    // Happy path: a current, non-empty derived key FOR THIS CHANNEL.
    if (input.status === 'ready' && input.keyB64 && input.keyChannelId === input.channelId) {
        return { kind: 'connect', keyB64: input.keyB64, degraded: false };
    }

    // Already connected once under a real key for this same channel — hold the
    // connection rather than unmounting. See the header comment for why this is
    // not fail-open.
    if (input.lastGoodKeyB64 && input.lastGoodChannelId === input.channelId) {
        return {
            kind: 'connect',
            keyB64: input.lastGoodKeyB64,
            degraded: elapsed >= CALL_KEY_DEGRADED_GRACE_MS,
        };
    }

    // Never had a key for this call: fail CLOSED.
    return { kind: 'blocked', stalled: elapsed >= CALL_KEY_STALL_MS };
}
