import axios from 'axios';
import { API_BASE } from '../constants';

/**
 * C-2 — ECIES wrapping of the one-time history transfer key.
 *
 * The bug this closes
 * -------------------
 * History sync encrypted the user's entire message history under a fresh
 * AES-256-GCM key, uploaded the ciphertext to the server, and then POSTed
 * that AES key to the server as PLAINTEXT base64 (`transfer_key_b64`), which
 * the server rebroadcast verbatim over `device:approved`. A server operator —
 * or anyone with read access to the DB and MinIO — held both halves and could
 * decrypt a user's whole history. That directly falsified "the server never
 * sees plaintext".
 *
 * The fix reuses the pattern this codebase already uses for `call_key` and
 * `channel_key` distribution: wrap the symmetric key to the recipient DEVICE's
 * signed prekey with `encryptMessageV2` (X25519 ECDH + HKDF-SHA256 +
 * AES-256-GCM in `electron/e2ee-engine.ts`). No new crypto is introduced.
 *
 * Device targeting becomes STRUCTURAL
 * ------------------------------------
 * `device:approved` is broadcast to every socket for the user, not to one
 * device. Until now the ONLY thing stopping an unrelated online device from
 * applying another device's transfer was a client-side
 * `msg.data.device_id === deviceId` check — and a regression that removed that
 * check actually shipped (fixed 2026-08-12). `encryptForDevices` writes one
 * wrap entry per device keyed by `device_id`, and `decryptEnvelope` looks up
 * only its OWN `device_id`, so an envelope wrapped to the requesting device
 * alone cannot be opened by any other device even if the filter were deleted
 * again. The filter stays as defence in depth; it is no longer load-bearing.
 *
 * C-2b — the downgrade this originally left open
 * ----------------------------------------------
 * As first shipped, WHICH path ran was decided by the requester advertising
 * `accepts_wrapped_key`, relayed unauthenticated through the server. A hostile
 * pod flipped it to false and the approver handed over the raw AES key, which
 * the server already had the matching ciphertext for. The wrapped path was
 * therefore a real gain against PASSIVE inspection and worth nothing against an
 * ACTIVE server.
 *
 * That advertisement is now signed with the requesting device's Ed25519
 * identity key, and — the half that actually closes it — the approver REFUSES
 * to send a plaintext key at all when the signature does not verify, instead of
 * falling back. See `historyRequestProof.ts`.
 *
 * Residual risk, stated plainly: the recipient's public key still comes from
 * the server (`GET /v1/keys/prekey_bundle`), so an ACTIVE server that
 * substitutes a key it controls can still intercept — and, since C-2b, forge
 * the advertisement that verifies against that substituted key. That is the
 * same trust assumption `call_key` and `channel_key` already make, and the same
 * one Safety Numbers exist to check. It is also strictly more expensive and
 * more detectable than the flipped boolean it replaces, and it never yields
 * the key in the clear. What these changes eliminate is the class of
 * compromise that required no attack at all.
 */

/** Shape carried inside the envelope. Not a `ClientContent` variant: this
 *  never travels through `/messages/send`, only the deliver-history body. */
export interface HistoryTransferKeyPayload {
    type: 'history_transfer_key';
    /** The raw AES-256-GCM history key, base64. */
    key_b64: string;
    /** Device this key was wrapped FOR — checked on unwrap. */
    device_id: string;
    issued_at: string;
}

export interface PrekeyBundleEntry {
    device_id: string;
    identity_key_pub_b64: string;
    signed_prekey: { id: number; pub_b64: string; sig_b64: string };
    one_time_prekey: { prekey_id: number; prekey_pub_b64: string } | null;
}

/**
 * Fetch ONE of the caller's own devices' key bundles.
 *
 * Split out of `wrapHistoryTransferKey` for C-2b so the approver can fetch the
 * bundle exactly ONCE and use the same entry for both jobs: verifying the
 * requester's signed capability advertisement (against
 * `identity_key_pub_b64`) and wrapping the transfer key (to
 * `signed_prekey`). Fetching twice would open a window where the server serves
 * identity key K1 to the verification step and K2 to the wrap step — the
 * signature would check out against a key that is not the one the history
 * actually gets encrypted to. One fetch, one entry, no such gap.
 *
 * `user_id` is the caller's OWN id — the self branch of the endpoint, which
 * needs no relationship check.
 */
export async function fetchOwnDeviceKeyBundle(
    targetDeviceId: string,
    userId: string,
    token: string,
): Promise<PrekeyBundleEntry> {
    const { data } = await axios.get<PrekeyBundleEntry[]>(`${API_BASE}/keys/prekey_bundle`, {
        params: { user_id: userId },
        headers: { Authorization: `Bearer ${token}` },
    });

    const target = data.find(d => d.device_id === targetDeviceId);
    if (!target?.signed_prekey?.pub_b64 || !target.identity_key_pub_b64) {
        throw new Error(`[HistoryTransfer] no key bundle for device ${targetDeviceId}`);
    }
    return target;
}

/**
 * Wrap `keyB64` so that only `target.device_id` can read it.
 *
 * `encryptForDevices` verifies the SPK's Ed25519 signature against the device's
 * identity key before using it, so the server cannot swap in an unsigned key
 * without also swapping the identity key (which changes the device's Safety
 * Number). C-2b makes that same identity key do double duty: it is also the key
 * the capability advertisement was verified against, so there is exactly ONE
 * key an attacker must substitute rather than two independent ones — and
 * substituting it is the Safety-Number-visible active MITM, not a free move.
 *
 * Takes an already-fetched `PrekeyBundleEntry` rather than a device id: see
 * `fetchOwnDeviceKeyBundle` for why the caller must not re-fetch.
 *
 * @throws if the bundle does not yield a usable wrap — the caller must then NOT
 *         fall back to sending the key in plaintext; it should surface an error
 *         instead. Silently downgrading would reintroduce C-2.
 */
export async function wrapHistoryTransferKey(
    keyB64: string,
    target: PrekeyBundleEntry,
    userId: string,
    senderDeviceId: string | null,
): Promise<string> {
    if (!window.electronAPI) throw new Error('[HistoryTransfer] electronAPI unavailable');

    const targetDeviceId = target.device_id;

    const payload: HistoryTransferKeyPayload = {
        type: 'history_transfer_key',
        key_b64: keyB64,
        device_id: targetDeviceId,
        issued_at: new Date().toISOString(),
    };

    // Exactly one recipient. Passing the full device list here would wrap the
    // key for every device of the user and defeat the targeting property above.
    const { envelope_b64, wrapped_device_ids } = await window.electronAPI.encryptMessageV2(
        JSON.stringify(payload),
        userId,
        [{
            device_id: target.device_id,
            spk_pub_b64: target.signed_prekey.pub_b64,
            sig_b64: target.signed_prekey.sig_b64,
            identity_pub_b64: target.identity_key_pub_b64,
            otp_pub_b64: target.one_time_prekey?.prekey_pub_b64 ?? null,
            otp_id: target.one_time_prekey?.prekey_id ?? null,
        }],
        senderDeviceId ?? undefined,
    );

    // `encryptForDevices` SKIPS a device whose SPK signature fails to verify
    // rather than throwing, so an empty wrap list is the signal that the key
    // material was rejected. Sending the envelope anyway would ship a payload
    // nobody can open; falling back to plaintext would hand the key to the
    // server. Fail instead.
    if (!wrapped_device_ids.includes(targetDeviceId)) {
        throw new Error(
            `[HistoryTransfer] refused to wrap for ${targetDeviceId} — signed prekey did not verify`,
        );
    }

    return envelope_b64;
}

/**
 * Unwrap a transfer key addressed to THIS device.
 *
 * @param myDeviceId this device's id; `decryptEnvelope` looks up only this
 *        key in the envelope's recipient map, which is what makes a transfer
 *        addressed elsewhere undecryptable here rather than merely ignored.
 */
export async function unwrapHistoryTransferKey(
    envelopeB64: string,
    myDeviceId: string,
): Promise<string> {
    if (!window.electronAPI) throw new Error('[HistoryTransfer] electronAPI unavailable');

    const { contentJson } = await window.electronAPI.decryptMessage(envelopeB64, myDeviceId);
    const payload = JSON.parse(contentJson) as HistoryTransferKeyPayload;

    if (payload?.type !== 'history_transfer_key' || !payload.key_b64) {
        throw new Error('[HistoryTransfer] unexpected payload in transfer-key envelope');
    }
    // Belt and braces over the AEAD: the wrap already binds this device, but an
    // explicit check keeps a future envelope-reuse mistake loud rather than
    // silently importing somebody else's history.
    if (payload.device_id !== myDeviceId) {
        throw new Error('[HistoryTransfer] transfer key was addressed to a different device');
    }
    return payload.key_b64;
}

