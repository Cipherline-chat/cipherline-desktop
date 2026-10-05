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

async function uploadKeyBundle(deviceId: string, token: string) {
    if (!window.electronAPI?.ensureIdentityBundle) return;
    try {
        const bundle = await window.electronAPI.ensureIdentityBundle(deviceId);
        await axios.post(`${API_BASE}/keys/upload_bundle`, {
            device_id:              bundle.device_id,
            identity_key_pub_b64:   bundle.identity_key_pub_b64,
            registration_id:        bundle.registration_id,
            signed_prekey_id:       bundle.signed_prekey.id,
            signed_prekey_pub_b64:  bundle.signed_prekey.pub_b64,
            signed_prekey_sig_b64:  bundle.signed_prekey.sig_b64,
            one_time_prekeys:       bundle.one_time_prekeys,
        }, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
        console.error('[Auth] Failed to upload key bundle:', err);
    }
}

/**
 * After tokens are issued (verify-email, login-2fa-verify, or — new — an
 * opened QR link grant), register the device with the server. Returns the
 * resolved deviceId and whether pairing approval is still needed.
 */
export async function registerOrReuseDevice(
    userId: string,
    accessToken: string,
    label: string,
): Promise<{ deviceId: string; requiresPairing: boolean }> {
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
    const { device_id: deviceId, requires_pairing } = devRes.data;
    if (proof) secureLocalStore.setItem('cipherline_identity_pub_b64', proof.identityPub);
    await uploadKeyBundle(deviceId, accessToken);
    return { deviceId, requiresPairing: requires_pairing === true };
}
