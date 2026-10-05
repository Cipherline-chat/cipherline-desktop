import { useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { shouldUploadBundle, subscribePrekeyCheckTriggers } from '../utils/prekeyHealth';

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
export function useKeyRotation() {
    const { token, deviceId } = useAuth();
    // Guards against two checks overlapping (a slow upload straddling a tick),
    // which would generate two bundles and upload them out of order.
    const inFlight = useRef(false);
    // G3: when the last check STARTED, for spacing event-triggered checks.
    const lastCheckAt = useRef<number | null>(null);

    useEffect(() => {
        if (!token || !deviceId) return;
        let cancelled = false;

        const check = async () => {
            if (inFlight.current || cancelled) return;
            inFlight.current = true;
            lastCheckAt.current = Date.now();
            try {
                // Paging cursor for retired_prekey_ids — the lowest prekey id
                // this device still holds a private for. Best-effort: an older
                // preload has no such method, and the server treats an absent
                // cursor as "from the beginning".
                let heldFrom: number | null = null;
                try {
                    heldFrom = await (window as any).electronAPI?.getLowestHeldOtpId?.() ?? null;
                } catch { /* cursor is an optimization, never a precondition */ }

                const { data } = await axios.get<{
                    otp_remaining: number;
                    spk_age_days: number;
                    needs_rotation: boolean;
                    // Added with the one-time-prekey reuse fix; OPTIONAL in the
                    // type on purpose, because a client can outrun the server it
                    // talks to and `undefined` must reach the generator as
                    // "unknown" rather than as an empty set. Absent => carry
                    // what we hold, delete nothing.
                    unclaimed_prekey_ids?: number[];
                    retired_prekey_ids?: number[];
                }>(`${API_BASE}/keys/status`, {
                    params: {
                        device_id: deviceId,
                        ...(heldFrom != null ? { held_from: heldFrom } : {}),
                    },
                    headers: { Authorization: `Bearer ${token}` },
                });

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
                const bundle = await (window as any).electronAPI?.getRotationBundle?.({
                    rotateSpk,
                    unclaimedPrekeyIds: data.unclaimed_prekey_ids,
                    retiredPrekeyIds: data.retired_prekey_ids,
                });
                if (!bundle || cancelled) return;

                await axios.post(
                    `${API_BASE}/keys/upload_bundle`,
                    { ...bundle, device_id: deviceId },
                    { headers: { Authorization: `Bearer ${token}` } },
                );
            } catch {
                // Silent — crypto falls back to existing keys, and the next
                // tick retries. A failed top-up costs forward secrecy on some
                // messages; surfacing it would cost the user an error they
                // cannot act on.
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
    }, [token, deviceId]);
}
