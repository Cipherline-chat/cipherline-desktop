/**
 * Shape check for an avatar / banner key BEFORE it is sent over the
 * `secure:set-avatar-key` IPC. Mirror of the main-process policy
 * (electron/avatar-key-policy.ts, which is authoritative and also enforces the
 * entry cap and identical-resend no-op — the two files cannot import each
 * other, see the Electron rootDir rule). Checking here keeps junk from a peer's
 * profile_update off the IPC at all.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** AES-256 key: 32 bytes, standard base64. */
const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=?$/;
/** AES-GCM IV: 12 bytes, standard base64. */
const NONCE_B64_RE = /^[A-Za-z0-9+/]{16}$/;

export function isValidAvatarKeyRecord(attachmentId: unknown, keyB64: unknown, nonceB64: unknown): boolean {
    return typeof attachmentId === 'string' && UUID_RE.test(attachmentId)
        && typeof keyB64 === 'string' && KEY_B64_RE.test(keyB64)
        && typeof nonceB64 === 'string' && NONCE_B64_RE.test(nonceB64);
}
