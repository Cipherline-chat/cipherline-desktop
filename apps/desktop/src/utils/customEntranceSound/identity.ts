import { CUSTOM_SOUND_CONTENT_ID_RE, MAX_ENCODED_BYTES, hasEbmlMagic } from './constants';

/**
 * Content id of an encoded custom sound: the first 32 hex chars (128 bits) of
 * SHA-256 over the exact bytes. Content addressing is the integrity property:
 * a receiver recomputes it, so nobody can plant different audio under an id
 * that someone's server personalization points at.
 */
export async function contentIdOf(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    let hex = '';
    for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
    return hex;
}

export function isContentId(v: unknown): v is string {
    return typeof v === 'string' && CUSTOM_SOUND_CONTENT_ID_RE.test(v);
}

export type SoundBytesRejection = 'size' | 'container' | 'hash';

/**
 * Are these bytes a custom sound we will keep or play? Size cap, WebM magic,
 * and (when `expectId` is given) the content hash. Used on store, on restore,
 * on sync and on receive.
 */
export async function checkSoundBytes(bytes: Uint8Array, expectId?: string): Promise<SoundBytesRejection | null> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_ENCODED_BYTES) return 'size';
    if (!hasEbmlMagic(bytes)) return 'container';
    if (expectId !== undefined && (await contentIdOf(bytes)) !== expectId) return 'hash';
    return null;
}
