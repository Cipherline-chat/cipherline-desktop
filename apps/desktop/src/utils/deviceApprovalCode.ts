/**
 * Device approval — the six-digit verification code, derived in the renderer.
 *
 * Shown on BOTH screens of an approval: the NEW device derives it from its
 * OWN identity key (which it knows first-hand) and the server-issued nonce;
 * each APPROVING device derives it from the identity key and nonce the
 * server relayed in `device:approval_pending`. If the relay substituted a
 * different key for the pending device, the two screens disagree and the
 * human does not approve. That is the whole reason the code is derived here
 * rather than read out of a server response — a Signal-safety-number-shaped
 * check scaled down to six digits for a one-shot, time-boxed decision.
 *
 *   code = BE_uint32( SHA-256("cipherline-device-approval-code:v1:<userId>:<identityKeyB64>:<nonceB64>")[0..4] ) mod 10^6
 *
 * zero-padded to six digits. Mirrored verbatim in
 * `apps/api/src/devices/device-approval.util.ts` (`deriveApprovalCode`), whose
 * spec reads THIS file's source and fails if the two drift, and specified
 * with test vectors in `docs/device-approval-mobile-spec.md`.
 */

export const DEVICE_APPROVAL_CODE_PREFIX = 'cipherline-device-approval-code:v1';

export async function deriveDeviceApprovalCode(userId: string, identityKeyB64: string, nonceB64: string): Promise<string> {
    const input = new TextEncoder().encode(`${DEVICE_APPROVAL_CODE_PREFIX}:${userId}:${identityKeyB64}:${nonceB64}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const n = (((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3]) % 1_000_000;
    return n.toString().padStart(6, '0');
}

/** "123456" → "123 456" for display. Spacing only; never used for comparison. */
export function formatDeviceApprovalCode(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Normalise what a human typed/pasted: strip spaces and anything non-digit. */
export function normalizeDeviceApprovalCode(raw: string): string {
    return raw.replace(/\D+/g, '').slice(0, 6);
}
