import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { shouldUploadBundle, otpPoolIsLow, subscribePrekeyCheckTriggers } from '../utils/prekeyHealth';
import { fetchKeyStatus, postBundle, toUploadBundleBody } from '../utils/keyBundleUpload';

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
    // which would generate two bundles and upload them out of order.
    const inFlight = useRef(false);
    // G3: when the last check STARTED, for spacing event-triggered checks.
    const lastCheckAt = useRef<number | null>(null);

    useEffect(() => {
        // `enabled` — the Dashboard passes `bundleReady`, so the first check
        // runs AFTER the launch publish (useKeyBundleSync) has landed. Two
        // uploads racing each other replace the server's pool in either
        // order, and the loser's freshly minted prekeys would be dropped from
        // it (their privates then held forever, offered to no one).
        if (!token || !deviceId || !enabled) return;
        let cancelled = false;

        const check = async () => {
            if (inFlight.current || cancelled) return;
            inFlight.current = true;
            lastCheckAt.current = Date.now();
            try {
                // GET /v1/keys/status, with the `held_from` paging cursor for
                // retired_prekey_ids (the lowest prekey id this device still
                // holds). The id lists are OPTIONAL in the type on purpose: a
                // client can outrun the server it talks to, and `undefined`
                // must reach the generator as "unknown" rather than as an
                // empty set. Absent => carry what we hold, delete nothing.
                const data = await fetchKeyStatus(deviceId, token);

                // G3: the server's flag (< 20 left, or an aging SPK) OR the
                // client's higher low-water mark — see utils/prekeyHealth.ts.
                if (cancelled || !shouldUploadBundle(data)) return;

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
                if (!bundle || cancelled) return;

                // FLAT body. This used to post `{ ...bundle, device_id }` with
                // the signed prekey nested, which the server's validation
                // rejects (400) — every top-up since June failed silently
                // here. See keyBundleUpload.ts.
                await postBundle(toUploadBundleBody(bundle, deviceId), token);
            } catch (err) {
                // Not surfaced to the user — crypto falls back to existing
                // keys, and the next tick retries; a failed top-up costs
                // forward secrecy on some messages, and an error banner would
                // cost the user something they cannot act on. But it IS
                // logged: a fully silent catch is how every top-up 400'ing
                // went unnoticed for three months. Status + server message
                // only (validation text), never the body.
                const e = err as { response?: { status?: number; data?: { message?: unknown } }; message?: string };
                console.warn('[E2EE] Key top-up failed:', e?.response?.status ?? 'network', e?.response?.data?.message ?? e?.message ?? '');
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
        return () => {
            cancelled = true;
            clearInterval(timer);
            unsubscribe();
        };
    }, [token, deviceId, enabled]);
}
