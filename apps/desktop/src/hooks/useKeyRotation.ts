import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { otpPoolIsLow, subscribePrekeyCheckTriggers } from '../utils/prekeyHealth';
import { fetchKeyStatus, postBundle, toUploadBundleBody, type UploadBundleBody } from '../utils/keyBundleUpload';
import { reportBeta } from '../utils/betaDiagnostics/reporter';
import { httpStatusOf } from '../utils/betaDiagnostics/sanitize';
import { ensureNetworkReady } from '../utils/networkReady';
import { failureCauseOf } from '../utils/networkError';
import { isReportableTopupFailure, makeCancellableSleep, runTopupWithRetry } from '../utils/prekeyTopup';

/** Below this many one-time prekeys on the server, the pool is genuinely low (the client tops up at 50). */
const BETA_PREKEYS_LOW = 20;

/**
 * How often to re-check the server's view of this device's key material.
 *
 * This used to run exactly ONCE per login session (a `ran` ref guard), which
 * was adequate only because one-time prekeys were never actually being spent:
 * `GET /v1/conversations/:id/devices` returned no prekey, so the pool sat at
 * its uploaded size forever and a single check at boot could not miss anything.
 * Now that every message consumes one prekey per recipient device, a pool of
 * 100 drains in 100 received messages — comfortably within one sitting for an
 * active user. A once-per-session check would let the device sit exhausted for
 * the rest of that session, silently downgrading every inbound message to
 * signed-prekey-only forward secrecy: precisely the condition this whole change
 * exists to end, reintroduced through the back door.
 *
 * 15 minutes against the `< 20 remaining` low-water mark means a user would
 * have to receive more than 20 messages in 15 minutes to run dry between
 * checks, and even then the fallback is graceful rather than a failure. The
 * check itself is one indexed COUNT.
 */
const KEY_STATUS_POLL_MS = 15 * 60 * 1000;

/**
 * Keeps this device's published key material healthy.
 *
 * Two independent needs, deliberately decoupled (see `generateRotationBundle`):
 *
 *   • One-time prekeys run low  → top up the prekeys, leave the signed prekey
 *                                 alone. Frequent, cheap.
 *   • Signed prekey nears expiry → rotate the signed prekey (and top up).
 *                                 Roughly monthly.
 *
 * Coupling them — the old behaviour — would mean a new signed prekey on every
 * prekey top-up. Each retired signed prekey is retained locally for 35 days and
 * tried as a decrypt candidate, so that would pile up private keys that both
 * slow every decrypt and widen the exposure from a stolen key store.
 */
export function useKeyRotation(enabled = true) {
    const { token, deviceId } = useAuth();
    // Guards against two checks overlapping (a slow upload straddling a tick),
    // which would generate two bundles and upload them out of order. A run now
    // includes its own retries (see prekeyTopup.ts), so a trigger that lands
    // mid-run is simply absorbed by it.
    const inFlight = useRef(false);
    // G3: when the last check STARTED, for spacing event-triggered checks.
    const lastCheckAt = useRef<number | null>(null);
    // A bundle minted but not yet accepted by the server. Survives failed runs
    // so the next one re-POSTs it instead of minting (and orphaning) another
    // batch of private prekeys. Keyed to the device it was minted for.
    const held = useRef<{ body: UploadBundleBody | null; deviceId: string | null }>({ body: null, deviceId: null });
    // True from a failed/abandoned top-up until one succeeds (or the server
    // says the pool is healthy). While owed, the `online` event re-runs the
    // check, on top of the poll and the WS-reconnect trigger.
    const owed = useRef(false);

    useEffect(() => {
        // `enabled` — the Dashboard passes `bundleReady`, so the first check
        // runs AFTER the launch publish (useKeyBundleSync) has landed. Two
        // uploads racing each other replace the server's pool in either
        // order, and the loser's freshly minted prekeys would be dropped from
        // it (their privates then held forever, offered to no one).
        if (!token || !deviceId || !enabled) return;
        let cancelled = false;
        const { sleep, cancelAll } = makeCancellableSleep();
        if (held.current.deviceId !== deviceId) held.current = { body: null, deviceId };

        const check = async () => {
            if (inFlight.current || cancelled) return;
            inFlight.current = true;
            lastCheckAt.current = Date.now();
            try {
                // Never throws: a failure is a RESULT, so this fire-and-forget
                // call cannot leak an unhandled rejection (the AxiosError the
                // resume diagnostics showed).
                const result = await runTopupWithRetry({
                    // GET /v1/keys/status, with the `held_from` paging cursor for
                    // retired_prekey_ids (the lowest prekey id this device still
                    // holds). The id lists are OPTIONAL in the type on purpose: a
                    // client can outrun the server it talks to, and `undefined`
                    // must reach the generator as "unknown" rather than as an
                    // empty set. Absent => carry what we hold, delete nothing.
                    fetchStatus: () => fetchKeyStatus(deviceId, token),
                    onStatus: (data) => {
                        if (typeof data.otp_remaining === 'number' && data.otp_remaining < BETA_PREKEYS_LOW) {
                            reportBeta('prekeys_low', { remaining: data.otp_remaining });
                        }
                    },
                    // G3: the server's flag (< 20 left, or an aging SPK) OR the
                    // client's higher low-water mark — see utils/prekeyHealth.ts
                    // (shouldUploadBundle, applied inside runTopupWithRetry).
                    mintBundle: async (data) => {
                        // Rotate the signed prekey ONLY when the signed prekey is what
                        // is actually aging. The server sets needs_rotation for either
                        // reason, so re-derive which one applies rather than assuming.
                        // The 25-day threshold mirrors KeysService.getKeyStatus.
                        const rotateSpk = data.spk_age_days >= 25;

                        // Pass the id sets straight through. They are NOT defaulted to
                        // [] — see the type note above: `undefined` is "the server did
                        // not say", and the generator must not read that as "delete
                        // everything" or "carry nothing".
                        //
                        // `otpPoolLow` turns on the main process's status-aware mode:
                        // it mints only when the pool is really low, rotates the
                        // signed prekey only when its OWN clock says it is 25 days old
                        // (the server's age never resets — see otpPoolIsLow), and
                        // answers null when neither holds, so nothing is uploaded.
                        const bundle = await window.electronAPI?.getRotationBundle?.({
                            rotateSpk,
                            unclaimedPrekeyIds: data.unclaimed_prekey_ids,
                            retiredPrekeyIds: data.retired_prekey_ids,
                            otpPoolLow: otpPoolIsLow(data),
                        });
                        // FLAT body. This used to post `{ ...bundle, device_id }` with
                        // the signed prekey nested, which the server's validation
                        // rejects (400) — every top-up since June failed silently
                        // here. See keyBundleUpload.ts.
                        return bundle ? toUploadBundleBody(bundle, deviceId) : null;
                    },
                    post: (body) => postBundle(body, token),
                    // Resume work waits for the network (networkReady.ts).
                    waitForNetwork: () => ensureNetworkReady(),
                    sleep,
                    isCancelled: () => cancelled,
                    held: held.current,
                });

                if (result.outcome === 'ok' || result.outcome === 'not_needed') {
                    owed.current = false;
                } else if (result.outcome === 'rejected' || result.outcome === 'gave_up') {
                    owed.current = true;
                    // Not surfaced to the user — crypto falls back to existing
                    // keys, and a later trigger retries; a failed top-up costs
                    // forward secrecy on some messages, and an error banner would
                    // cost the user something they cannot act on. But it IS
                    // logged: a fully silent catch is how every top-up 400'ing
                    // went unnoticed for three months. Reported only once the
                    // retries are spent (a transient blip that a retry healed is
                    // not a failure). Status + server message only (validation
                    // text), never the body.
                    const err = result.error;
                    const e = err as { response?: { status?: number; data?: { message?: unknown } }; message?: string } | undefined;
                    const topupStatus = httpStatusOf(err);
                    // Not when the network never came back (0 attempts): nothing
                    // failed, the top-up is still owed — see isReportableTopupFailure.
                    if (isReportableTopupFailure(result)) reportBeta('prekeys_low', {
                        topup_failed: true,
                        cause: failureCauseOf(err),
                        attempts: result.attempts,
                        ...(topupStatus !== undefined ? { status: topupStatus } : {}),
                    });
                    console.warn('[E2EE] Key top-up failed:', e?.response?.status ?? 'network', e?.response?.data?.message ?? e?.message ?? '');
                }
            } catch (err) {
                // runTopupWithRetry does not throw; this is the belt for a
                // reporter / console failure so the interval callback below can
                // never produce an unhandled rejection.
                console.warn('[E2EE] Key check crashed:', err);
            } finally {
                inFlight.current = false;
            }
        };

        void check();
        const timer = setInterval(() => { void check(); }, KEY_STATUS_POLL_MS);
        // G3: extra, locally-derived triggers — WS reconnect, an inbound DM
        // that used none of our one-time prekeys, a draining pool. Spaced and
        // deferred (never dropped); see utils/prekeyHealth.ts.
        const unsubscribe = subscribePrekeyCheckTriggers(window, () => { void check(); }, () => lastCheckAt.current);
        // A top-up that is still owed re-runs the moment the OS reports the
        // network back, rather than waiting for the next poll.
        const onOnline = () => { if (owed.current) void check(); };
        window.addEventListener('online', onOnline);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener('online', onOnline);
            cancelAll();
            unsubscribe();
        };
    }, [token, deviceId, enabled]);
}
