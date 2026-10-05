/**
 * G3 — keep this device's one-time-prekey pool from running dry.
 *
 * When a device's pool is empty (or the claim fails, or a hostile relay simply
 * withholds the key), a sender falls back to signed-prekey-only ECDH. That
 * message's secrecy then rests on the SPK private, which lives ~25 days active
 * plus 35 retained — anyone who later lifts it from this device's store can
 * read the message. The fallback is graceful by design (failing the send would
 * cost the message itself), so the defence is making exhaustion RARE.
 *
 * Before this module the only replenishment trigger was `useKeyRotation`'s
 * 15-minute poll with the server's `< 20 remaining` low-water mark, so a burst
 * of >20 inbound messages inside one poll interval drained the pool and every
 * later message in that window went SPK-only, with a console warning on the
 * SENDER'S machine as the only trace.
 *
 * Three additions, none of which tells the server anything new:
 *   1. A higher CLIENT low-water mark (top up below 50, not only below 20).
 *      The server's `needs_rotation` still counts; this only adds headroom.
 *   2. A check on every confirmed WebSocket (re)connect (`useRealtime`'s
 *      existing `cipherline:ws-connected` event) — the moment a device that
 *      was offline, and whose pool others kept claiming from, comes back.
 *   3. A RECIPIENT-side signal from decryption itself: an inbound DM that
 *      used no one-time prekey of ours means our pool was empty (or withheld)
 *      when it was sent, so check now; and every N messages that DID consume
 *      one, check too, because the pool is draining. This is computed locally
 *      from the decrypt result — no logging, no telemetry, no new request
 *      beyond the existing `GET /v1/keys/status` that already runs on a timer.
 *
 * The hook de-duplicates bursts (`PREKEY_CHECK_MIN_SPACING_MS`), so a flood of
 * SPK-only messages cannot turn into a flood of status calls or uploads.
 */

export const PREKEY_CHECK_EVENT = 'cipherline:prekey-check';

/** Top up below this many unclaimed one-time prekeys. Must stay well under
 *  the 100-per-batch mint so a top-up (carried + 100 new) fits the server's
 *  200-prekey upload cap without trimming anything fresh. */
export const CLIENT_OTP_LOW_WATER = 50;

/** Event-triggered checks closer together than this collapse into one. */
export const PREKEY_CHECK_MIN_SPACING_MS = 60_000;

/** Consumed-OTP messages between drain-driven checks. */
export const OTP_DRAIN_CHECK_EVERY = 10;

export type PrekeyCheckReason = 'spk_only_inbound' | 'pool_draining';

export function requestPrekeyCheck(reason: PrekeyCheckReason): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(PREKEY_CHECK_EVENT, { detail: { reason } }));
}

let consumedSinceCheck = 0;

/**
 * Feed one inbound DM decrypt result. `undefined` (an older main process that
 * does not report it) is ignored — "unknown" must not read as "SPK-only".
 */
export function notePrekeyUsage(usedOneTimePrekey: boolean | undefined): void {
    if (usedOneTimePrekey === false) {
        consumedSinceCheck = 0;
        requestPrekeyCheck('spk_only_inbound');
        return;
    }
    if (usedOneTimePrekey === true) {
        consumedSinceCheck += 1;
        if (consumedSinceCheck >= OTP_DRAIN_CHECK_EVERY) {
            consumedSinceCheck = 0;
            requestPrekeyCheck('pool_draining');
        }
    }
}

/** Test seam. */
export function _resetPrekeyUsageCounter(): void {
    consumedSinceCheck = 0;
}

/**
 * Decide whether a `GET /v1/keys/status` response calls for an upload.
 * The server's own flag (low pool OR aging SPK) is always honoured; the client
 * adds headroom on the pool side only.
 */
export function shouldUploadBundle(status: { needs_rotation?: boolean; otp_remaining?: number }): boolean {
    if (status.needs_rotation) return true;
    return typeof status.otp_remaining === 'number'
        && Number.isFinite(status.otp_remaining)
        && status.otp_remaining < CLIENT_OTP_LOW_WATER;
}

/** Spacing gate for event-triggered checks. Pure, so the hook stays thin. */
export function mayRunTriggeredCheck(lastCheckAt: number | null, now: number): boolean {
    return lastCheckAt === null || now - lastCheckAt >= PREKEY_CHECK_MIN_SPACING_MS;
}

/** Dispatched by useRealtime on each CONFIRMED WebSocket (re)connection. */
export const WS_CONNECTED_EVENT = 'cipherline:ws-connected';

/**
 * Listen for every prekey-check trigger (explicit requests + WS reconnects)
 * and call `runCheck`, spaced by `PREKEY_CHECK_MIN_SPACING_MS`. A trigger that
 * lands inside the spacing window is DEFERRED to the window's end rather than
 * dropped — an SPK-only inbound message must still produce a check — and any
 * number of such triggers collapse into ONE deferred check.
 *
 * `getLastCheckAt` reads when the last check STARTED (set by the check itself,
 * so the periodic poll counts too). Returns the unsubscribe function.
 */
export function subscribePrekeyCheckTriggers(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    runCheck: () => void,
    getLastCheckAt: () => number | null,
    now: () => number = Date.now,
): () => void {
    let deferred: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const onTrigger = () => {
        if (stopped) return;
        const t = now();
        const last = getLastCheckAt();
        if (mayRunTriggeredCheck(last, t)) { runCheck(); return; }
        if (deferred) return;
        const wait = (last ?? t) + PREKEY_CHECK_MIN_SPACING_MS - t;
        deferred = setTimeout(() => { deferred = null; if (!stopped) runCheck(); }, Math.max(0, wait));
    };
    target.addEventListener(PREKEY_CHECK_EVENT, onTrigger);
    target.addEventListener(WS_CONNECTED_EVENT, onTrigger);
    return () => {
        stopped = true;
        if (deferred) clearTimeout(deferred);
        target.removeEventListener(PREKEY_CHECK_EVENT, onTrigger);
        target.removeEventListener(WS_CONNECTED_EVENT, onTrigger);
    };
}
