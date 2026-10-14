/**
 * Shared post-auth device registration — extracted from `AuthScreen.tsx` so
 * `QrSignInPanel.tsx` (QR sign-in's "NEW device" half, docs/QR-LINKING.md §2)
 * can reuse the EXACT same path a password login uses to register this
 * device, rather than a second hand-maintained copy. Both callers end up on
 * `POST /v1/devices/register`, proved by the same Ed25519 identity-key
 * signature machinery.
 */
import axios from 'axios';
import secureLocalStore from './secureLocalStore';
import { API_BASE } from '../constants';
import { publishIdentityBundle } from './keyBundleUpload';

async function uploadKeyBundle(deviceId: string, token: string) {
    try {
        // Same publish flow as the Dashboard's bundle sync: current signed
        // prekey, one-time prekeys gated by the server's unclaimed list and
        // capped at its 200 — see keyBundleUpload.ts.
        await publishIdentityBundle(deviceId, token);
    } catch (err) {
        console.error('[Auth] Failed to upload key bundle:', err);
    }
}

/**
 * After tokens are issued (verify-email, login-2fa-verify, or — new — an
 * opened QR link grant), register the device with the server. Returns the
 * resolved deviceId and whether pairing approval is still needed.
 */
/**
 * Device approval (server flag DEVICE_APPROVAL_REQUIRED=enforce). Present on
 * the register result ONLY when the server created — or re-found — a PENDING
 * request for this device. Absent for an approved device and for a server that
 * does not speak the pending flow (the legacy "Device Not Approved" screen
 * remains the fallback for `requiresPairing` without it).
 */
export interface PendingDeviceApproval {
    /** Server-issued nonce the six-digit code is derived from. */
    nonceB64: string;
    /** When the request lapses (ISO). */
    expiresAt: string | null;
    /** A scheduled cooling-off reset, if the user already asked for one. */
    resetDueAt: string | null;
    /** THIS device's identity public key — the other half of the code input. */
    identityPub: string;
}

export interface RegisterDeviceResult {
    deviceId: string;
    requiresPairing: boolean;
    approval?: PendingDeviceApproval;
}

export async function registerOrReuseDevice(
    userId: string,
    accessToken: string,
    label: string,
): Promise<RegisterDeviceResult> {
    // Label the device by its real hostname + OS so the approver can tell
    // multiple devices apart (e.g. "DAWSON-PC · windows", "MacBook · mac").
    const platform = window.electronAPI?.platform ?? 'windows';
    const host = (await window.electronAPI?.getDeviceName?.())?.trim();
    const deviceName = host && host.length > 0
        ? host
        : `${label}-Desktop-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    // Prove possession of this device's identity key. The server dedupes/reuses
    // by the VERIFIED key (not hostname), so logout→login on the same machine is
    // seamless regardless of hostname, and a password-only attacker who lacks the
    // key always lands in "new device → needs approval". We always hit the server
    // (it is the source of truth for requires_pairing). On web / no signer, we
    // register without proof (the server falls back to hostname unless proof is
    // enforced).
    const proofTs = Math.floor(Date.now() / 1000);
    const proof = await window.electronAPI?.getDeviceRegisterProof?.(userId, proofTs);

    const body: Record<string, unknown> = { device_name: deviceName, platform };
    if (proof) {
        body.identity_key_pub_b64 = proof.identityPub;
        body.identity_proof_sig_b64 = proof.sig;
        body.proof_ts = proofTs;
    }

    const devRes = await axios.post(`${API_BASE}/devices/register`, body,
        { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const { device_id: deviceId, requires_pairing, approval } = devRes.data;
    if (proof) secureLocalStore.setItem('cipherline_identity_pub_b64', proof.identityPub);
    await uploadKeyBundle(deviceId, accessToken);
    const pending = requires_pairing === true
        && proof
        && approval && approval.status === 'pending' && typeof approval.nonce_b64 === 'string' && approval.nonce_b64.length > 0;
    return {
        deviceId,
        requiresPairing: requires_pairing === true,
        ...(pending ? {
            approval: {
                nonceB64: approval.nonce_b64 as string,
                expiresAt: typeof approval.expires_at === 'string' ? approval.expires_at : null,
                resetDueAt: typeof approval.reset_due_at === 'string' ? approval.reset_due_at : null,
                identityPub: proof.identityPub,
            },
        } : {}),
    };
}
