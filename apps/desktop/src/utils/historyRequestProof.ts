import { ed25519 } from '@noble/curves/ed25519';

/**
 * C-2b — authenticating the history-sync capability advertisement, and closing
 * the server-mediated downgrade it left open.
 *
 * The bug this closes
 * -------------------
 * C-2 made history sync ECIES-wrap the one-time AES history key to the
 * requesting device, so the server relays an envelope instead of the key. But
 * WHICH path gets used was decided by the requester advertising
 * `accepts_wrapped_key: true` — and that flag reaches the approver only by
 * passing through the server, with nothing authenticating it.
 *
 * So a hostile or compromised API pod flips the boolean to `false`. The
 * approver's branch falls back to the legacy path and POSTs the raw AES key for
 * the ENTIRE history export in the clear; the requester accepted either form
 * without checking. The server already stores that export's ciphertext, so it
 * ends up holding both halves — exactly the compromise C-2 was written to
 * prevent, reachable by editing one field in transit and costing the attacker
 * nothing.
 *
 * Net before this change: the wrapped path moved exposure from *always* to *on
 * demand*. Real against passive inspection of the database and blob store;
 * worth nothing against an active server.
 *
 * Why a signature is only half the fix
 * ------------------------------------
 * Signing the advertisement alone does NOT close the downgrade. A server that
 * can strip a boolean can strip a signature too, and a stripped signature is
 * indistinguishable from a genuine legacy client that never had one. The
 * approver has to REFUSE the unsigned/legacy case rather than fall back to it.
 * That refusal is the part that breaks compatibility with the deployed fleet,
 * and it is the part that actually removes the attacker's move. Both halves
 * ship together; neither works alone.
 *
 * The scheme
 * ----------
 * The requesting device signs, with the SAME Ed25519 identity private key it
 * already proved possession of at `POST /v1/devices/register`:
 *
 *     cipherline-history-request:v1:<userId>:<deviceId>:<identityKeyPubB64>:wrapped:<ts>
 *
 * Domain separation follows `apps/api/src/devices/identity-proof.util.ts`
 * exactly — a distinct `cipherline-history-request:v1` prefix over the same
 * `:`-joined, colon-free-field layout, so a registration proof can never be
 * replayed here and vice versa. No second signature scheme is invented: same
 * key, same primitive, different domain.
 *
 * Fields, and why each is in the message:
 *   • userId   — binds the advertisement to one account.
 *   • deviceId — binds it to the requesting device, so a signature captured for
 *                device A cannot be replayed to authorise a transfer to B.
 *   • identityKeyPubB64 — commits to the key the approver must verify with, so
 *                a substituted key produces a message that does not match what
 *                was signed rather than silently verifying.
 *   • `wrapped` — THE CAPABILITY ITSELF is inside the signed message. This is
 *                what makes the flag untamperable: flipping
 *                `accepts_wrapped_key` to false no longer changes the
 *                approver's behaviour, because the approver reads the
 *                capability out of the verified message, not out of the
 *                relayed boolean.
 *   • ts       — freshness, checked against ±HISTORY_REQUEST_PROOF_WINDOW_S, so
 *                an advertisement recorded off the wire cannot be replayed
 *                indefinitely to trigger transfers the user did not ask for.
 *
 * What this does NOT fix, stated plainly
 * --------------------------------------
 * The approver still learns the requester's identity key from the server
 * (`GET /v1/keys/prekey_bundle`). A server that substitutes a key IT controls
 * can forge an advertisement that verifies against the substituted key — but it
 * must then also serve the matching signed prekey, because the approver
 * verifies against and wraps to THE SAME bundle entry. That is a full
 * device-key impersonation, which is the pre-existing active-MITM that
 * `call_key` and `channel_key` already live with and that Safety Numbers exist
 * to expose. It is a categorically more expensive and more detectable attack
 * than flipping one boolean, and it never yields the raw key in the clear.
 */

/** Domain-separation prefix. Mirrored verbatim in the electron main process's
 *  `crypto:history-request-proof` IPC handler, which is where the signing
 *  happens (the identity private key lives in SecureStore in main, never in the
 *  renderer). `historyRequestProof.test.ts` scans that source and fails if the
 *  two drift apart — they cannot share a module, because an import across the
 *  `electron/` ⇄ `src/` boundary re-roots the emitted dist-electron tree and
 *  breaks packaging (see the "Electron rootDir trap"). */
export const HISTORY_REQUEST_PROOF_PREFIX = 'cipherline-history-request:v1';

/** The single capability this scheme advertises today. Written INTO the signed
 *  message, not carried beside it. */
export const HISTORY_CAPABILITY_WRAPPED = 'wrapped';

/** Freshness window, seconds, either side of `ts`. Matches
 *  `REGISTER_PROOF_WINDOW_S` in the API's identity-proof util — same key, same
 *  clock-skew tolerance, no reason to differ. */
export const HISTORY_REQUEST_PROOF_WINDOW_S = 300;

/**
 * The decline `reason` a current approver sends when it refuses to transfer
 * because the requester cannot receive a wrapped key.
 *
 * Mirrored in `apps/api/src/devices/devices.service.ts` as
 * `HISTORY_REFUSED_LEGACY_REQUESTER`, where it selects the
 * `historyTransfer key_form=refused` rollout-drain log line. Pinned by tests on
 * both sides.
 */
export const HISTORY_REFUSED_LEGACY_REQUESTER = 'requester_cannot_receive_wrapped_key';

/**
 * The decline `reason` the MOBILE app sends (cipherline-mobile
 * `src/features/history-sync/requesterPlatform.ts`,
 * `HISTORY_REFUSED_UNSUPPORTED_REQUESTER`) when a non-phone asks it for
 * history: desktop cannot read a phone's history format yet, so the phone
 * refuses instead of sending a payload this device would have to reject.
 * Relayed verbatim by the server (`DeclineHistoryDto.reason` is free-form).
 */
export const HISTORY_REFUSED_MOBILE_TO_DESKTOP = 'requester_cannot_import_mobile_history';

/** The exact message the requesting device signs with its identity key. */
export function historyRequestProofMessage(
    userId: string,
    requestingDeviceId: string,
    identityKeyPubB64: string,
    ts: number,
): string {
    return `${HISTORY_REQUEST_PROOF_PREFIX}:${userId}:${requestingDeviceId}:${identityKeyPubB64}:${HISTORY_CAPABILITY_WRAPPED}:${ts}`;
}

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Why an advertisement was rejected. Surfaced in logs and asserted in tests;
 *  the user-facing copy deliberately does not distinguish these, because from
 *  the user's side every one of them means the same thing — the other device
 *  needs updating. */
export type AdvertisementRejection =
    | 'no_signature'
    | 'no_timestamp'
    | 'stale_timestamp'
    | 'malformed_signature'
    | 'malformed_identity_key'
    | 'bad_signature';

export type AdvertisementVerdict =
    | { ok: true }
    | { ok: false; reason: AdvertisementRejection };

/**
 * Verify a relayed capability advertisement.
 *
 * `identityKeyPubB64` MUST come from the approver's own
 * `GET /v1/keys/prekey_bundle` fetch — the same bundle entry whose signed
 * prekey the transfer key will be wrapped to — and NOT from any field the
 * server put inside the `device:history_request` event. Verifying against a
 * key the relay chose would make the signature circular and prove nothing.
 *
 * Note what is deliberately absent: there is no `acceptsWrappedKey` parameter.
 * The relayed boolean is not an input to this decision at all. The capability
 * is read out of the signed message (`HISTORY_CAPABILITY_WRAPPED` is part of
 * what the signature covers), so there is nothing here for the server to flip.
 *
 * Never throws — every malformed input is a rejection.
 */
export function verifyHistoryRequestAdvertisement(params: {
    userId: string;
    requestingDeviceId: string;
    identityKeyPubB64: string;
    capabilitySigB64: string | undefined | null;
    capabilityTs: number | undefined | null;
    nowSec?: number;
}): AdvertisementVerdict {
    const { userId, requestingDeviceId, identityKeyPubB64, capabilitySigB64, capabilityTs } = params;
    const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);

    // A stripped signature and a genuine pre-C-2b client are indistinguishable
    // here by construction — which is precisely why this cannot fall back to
    // the plaintext path. Both are rejections.
    if (typeof capabilitySigB64 !== 'string' || capabilitySigB64.length === 0) {
        return { ok: false, reason: 'no_signature' };
    }
    if (typeof capabilityTs !== 'number' || !Number.isFinite(capabilityTs)) {
        return { ok: false, reason: 'no_timestamp' };
    }
    if (Math.abs(nowSec - capabilityTs) > HISTORY_REQUEST_PROOF_WINDOW_S) {
        return { ok: false, reason: 'stale_timestamp' };
    }

    let sig: Uint8Array;
    try {
        sig = b64ToBytes(capabilitySigB64);
    } catch {
        return { ok: false, reason: 'malformed_signature' };
    }
    if (sig.length !== 64) return { ok: false, reason: 'malformed_signature' };

    let pub: Uint8Array;
    try {
        pub = b64ToBytes(identityKeyPubB64);
    } catch {
        return { ok: false, reason: 'malformed_identity_key' };
    }
    if (pub.length !== 32) return { ok: false, reason: 'malformed_identity_key' };

    const msg = new TextEncoder().encode(
        historyRequestProofMessage(userId, requestingDeviceId, identityKeyPubB64, capabilityTs),
    );

    try {
        return ed25519.verify(sig, msg, pub)
            ? { ok: true }
            : { ok: false, reason: 'bad_signature' };
    } catch {
        // noble throws on non-canonical / low-order points rather than
        // returning false. Same outcome here: not a valid advertisement.
        return { ok: false, reason: 'bad_signature' };
    }
}
