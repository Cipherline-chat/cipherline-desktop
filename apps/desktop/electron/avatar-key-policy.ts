/**
 * What the main process will persist under `avatar_key:<attachmentId>`.
 *
 * Avatar and banner keys arrive from OTHER users (profile_update /
 * group_update) and are written one SecureStore entry per sender-chosen id. The
 * SecureStore is a single flat vault that is re-serialised whole on every
 * change and also holds the Signal identity and the channel keys, so this
 * namespace must not be a free-growth surface. The renderer is the untrusted
 * side of this IPC, so the rules live here, in main:
 *
 *   • the id must be a UUID (attachment ids are server-generated UUIDs) and the
 *     key / nonce the exact shapes the app writes (AES-256 key = 32 bytes,
 *     GCM IV = 12 bytes, standard base64);
 *   • an identical re-send is a no-op (no vault write);
 *   • empty key AND nonce is the "forget this key" tombstone
 *     (avatarKeyStore.deleteAvatarKey): it deletes the entry, and is a no-op for
 *     an id that is not stored — it never creates one;
 *   • at most AVATAR_KEY_MAX_ENTRIES entries. A NEW id beyond the cap is
 *     REFUSED — existing entries are never evicted to make room, and an
 *     existing id may still be updated or cleared. A refused avatar still
 *     renders: useEncryptedAvatar falls back to the authorised
 *     `GET /attachments/:id/key` fetch and holds the key in memory.
 */

export const AVATAR_KEY_PREFIX = 'avatar_key:';
/** A long-lived real install holds a few hundred (the vault benchmark's worst
 *  shape is 1 500); this leaves several times that and still stops runaway growth. */
export const AVATAR_KEY_MAX_ENTRIES = 5_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 bytes, standard base64 (padding optional). */
const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=?$/;
/** 12 bytes, standard base64 (no padding is ever needed at this length). */
const NONCE_B64_RE = /^[A-Za-z0-9+/]{16}$/;

export function isAvatarKeyId(v: unknown): v is string {
    return typeof v === 'string' && UUID_RE.test(v);
}

export type AvatarKeyOutcome = 'stored' | 'unchanged' | 'cleared' | 'refused_invalid' | 'refused_full';

/** The slice of SecureStore this policy needs (SecureStore satisfies it). */
export interface AvatarKeyStoreLike {
    get(key: string): string | null;
    set(key: string, value: string): void;
    delete(key: string): void;
    keysWithPrefix(prefix: string): string[];
}

/** Decide and apply one `secure:set-avatar-key` call. Synchronous; the caller awaits durability. */
export function applyAvatarKey(store: AvatarKeyStoreLike, id: unknown, keyB64: unknown, nonceB64: unknown): AvatarKeyOutcome {
    if (!isAvatarKeyId(id) || typeof keyB64 !== 'string' || typeof nonceB64 !== 'string') return 'refused_invalid';
    const name = `${AVATAR_KEY_PREFIX}${id}`;
    const existing = store.get(name);

    if (keyB64 === '' && nonceB64 === '') {
        if (existing === null) return 'unchanged';
        store.delete(name);
        return 'cleared';
    }
    if (!KEY_B64_RE.test(keyB64) || !NONCE_B64_RE.test(nonceB64)) return 'refused_invalid';

    const value = JSON.stringify({ keyB64, nonceB64 });
    if (existing === value) return 'unchanged';
    if (existing === null && store.keysWithPrefix(AVATAR_KEY_PREFIX).length >= AVATAR_KEY_MAX_ENTRIES) return 'refused_full';
    store.set(name, value);
    return 'stored';
}
