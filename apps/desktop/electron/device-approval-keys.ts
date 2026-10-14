import * as crypto from 'crypto';

/**
 * Device approval — the main-process crypto half, dependency-free so it is
 * covered by vitest (electron/** scope, see vitest.config.ts).
 *
 * Two jobs:
 *
 *  1. CANONICAL MESSAGES. Every decision in the device-approval flow is an
 *     Ed25519 signature over a domain-separated, `:`-joined message. The
 *     spellings below are duplicated from
 *     `apps/api/src/devices/device-approval.util.ts` rather than imported
 *     (an import across the electron/ ⇄ src/ boundary re-roots the emitted
 *     dist-electron tree and breaks packaging — see the history-request-proof
 *     handler in main.ts). The API's `device-approval.util.spec.ts` reads THIS
 *     file's source text and fails if the two drift.
 *
 *  2. THE RECOVERY-DERIVED KEYPAIR. The "recovery key" the user can export
 *     from Settings (RecoveryKeyCard) IS this device's master key — the root
 *     of everything at rest on this machine. To let a future new device prove
 *     "the user typed this device's recovery key" WITHOUT the server ever
 *     holding anything that decrypts a vault, each device derives an Ed25519
 *     keypair from its master key and publishes only the PUBLIC half
 *     (`PUT /v1/devices/:id/recovery-commitment`, signed by its identity key).
 *     A new device that is handed the typed key derives the same keypair and
 *     signs a challenge; the server verifies against the stored public key.
 *
 *       seed = HKDF-SHA256(ikm = master key (32 bytes), salt = empty,
 *                          info = "cl-device-approval-recovery:v1", L = 32)
 *       (priv, pub) = Ed25519 from seed
 *
 *     Empty salt matches every other HKDF in this app (kv-crypto.ts). The
 *     info string is distinct from every other subkey info in the keystore,
 *     so this key is independent of the per-account vault subkeys and of the
 *     blob-cache key: learning it reveals nothing about them (HKDF is one-way
 *     and the master key never leaves the derivation).
 */

export const RECOVERY_APPROVAL_INFO = 'cl-device-approval-recovery:v1';

/** PKCS#8 DER prefix for an Ed25519 private key — the 32-byte seed follows.
 *  Node has no "from seed" constructor for Ed25519; this is the standard
 *  encoding (RFC 8410 §7) and is what lets `createPrivateKey` ingest a seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface RecoveryApprovalKeypair {
    /** Raw 32-byte Ed25519 public key, base64 — what the server stores. */
    pubB64: string;
    /** Sign a utf8 message; returns the 64-byte signature, base64. */
    sign(message: string): string;
}

/**
 * Derive the recovery-approval keypair from a base64 master key. Returns null
 * for anything that is not a 32-byte key (a mistyped recovery key), never
 * throws. The caller holds the result only as long as it needs one signature.
 */
export function deriveRecoveryApprovalKeypair(masterKeyB64: string | null | undefined): RecoveryApprovalKeypair | null {
    if (typeof masterKeyB64 !== 'string') return null;
    let master: Buffer;
    try {
        master = Buffer.from(masterKeyB64.trim(), 'base64');
    } catch {
        return null;
    }
    if (master.length !== 32) return null;
    const seed = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(RECOVERY_APPROVAL_INFO, 'utf8'), 32));
    master.fill(0);
    try {
        const priv = crypto.createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
            format: 'der',
            type: 'pkcs8',
        });
        const jwk = crypto.createPublicKey(priv).export({ format: 'jwk' }) as { x: string };
        const pubB64 = Buffer.from(jwk.x, 'base64url').toString('base64');
        return {
            pubB64,
            sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), priv).toString('base64'),
        };
    } finally {
        seed.fill(0);
    }
}

// ── Canonical messages (mirror apps/api/src/devices/device-approval.util.ts) ──

export function approvalDecisionMessage(
    userId: string, approverDeviceId: string, pendingDeviceId: string,
    pendingIdentityKeyB64: string, decision: 'approve' | 'deny', ts: number,
): string {
    return `cipherline-device-approve:v1:${userId}:${approverDeviceId}:${pendingDeviceId}:${pendingIdentityKeyB64}:${decision}:${ts}`;
}

export function recoveryProofMessage(
    userId: string, pendingDeviceId: string, pendingIdentityKeyB64: string, recoveryPubB64: string, ts: number,
): string {
    return `cipherline-device-recovery-approve:v1:${userId}:${pendingDeviceId}:${pendingIdentityKeyB64}:${recoveryPubB64}:${ts}`;
}

export function recoveryCommitMessage(userId: string, deviceId: string, recoveryPubB64: string, ts: number): string {
    return `cipherline-device-recovery-commit:v1:${userId}:${deviceId}:${recoveryPubB64}:${ts}`;
}

export function linkApproveMessage(
    userId: string, approverDeviceId: string, linkId: string, newIdentityKeyB64: string | null, ts: number,
): string {
    return `cipherline-link-approve:v1:${userId}:${approverDeviceId}:${linkId}:${newIdentityKeyB64 ?? '-'}:${ts}`;
}
