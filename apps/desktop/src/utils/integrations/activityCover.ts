/**
 * A friend-visible Spotify album cover, END-TO-END ENCRYPTED: the format and
 * the crypto. No I/O; WebCrypto AES-256-GCM only (CLAUDE.md: never roll
 * custom crypto).
 *
 * The sharer's device takes the cover its own media session handed it,
 * downscales and re-encodes it (coverImage.ts: <= 160 px JPEG, so no source
 * metadata survives), pads it, and encrypts it under the sharer's ACTIVITY
 * KEY - a random AES-256 key their device delivers to each accepted friend
 * inside the ordinary E2EE message envelope and rotates when a friend is
 * removed or blocked (activityKeys.ts). The API stores the result as one
 * opaque blob next to the listening record (apps/api/src/integrations/
 * listening-cover.ts) and serves it only to the record's audience; friends
 * decrypt it on their own device.
 *
 * Blob = version(1) || kid(8) || iv(12) || AES-GCM(plaintext) || tag(16)
 * plaintext = u32be(len) || image || zero padding, to a multiple of 2 KiB
 * AAD = "cl-activity-cover-v1" \n sharerUserId \n coverId \n kid
 *
 * The AAD binds a blob to WHO shared it and to the id the record names, so
 * the server (or anyone else) cannot move a blob to another person or another
 * id, nor swap in an old cover under a new id: decryption simply fails and the
 * viewer falls back to the catalogue cover / the platform logo.
 */
import { sniffCover } from './listeningArt';

/** Mirrors apps/api/src/integrations/listening-cover.ts (activityCover.test.ts reads that file). */
export const COVER_VERSION = 1;
export const COVER_KID_BYTES = 8;
export const COVER_IV_BYTES = 12;
export const COVER_HEADER_BYTES = 1 + COVER_KID_BYTES + COVER_IV_BYTES;
export const COVER_TAG_BYTES = 16;
export const COVER_PAD_BYTES = 2048;
export const COVER_MAX_PLAINTEXT = 12 * COVER_PAD_BYTES;
/** The largest image that fits (the publisher aims for a few KB). */
export const COVER_MAX_IMAGE_BYTES = COVER_MAX_PLAINTEXT - 4;
export const COVER_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const KID_RE = /^[0-9a-f]{16}$/;
export const isCoverId = (v: unknown): v is string => typeof v === 'string' && COVER_ID_RE.test(v);

const enc = new TextEncoder();

export function bytesToB64(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array | null {
    try {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch { return null; }
}

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16)));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A fresh activity key: 32 random bytes + an 8-byte id (hex) friends file it under. */
export function newActivityKey(): { kid: string; keyB64: string } {
    return { kid: hex(rand(COVER_KID_BYTES)), keyB64: bytesToB64(rand(32)) };
}

/** A fresh, meaningless cover id (16 random bytes, base64url). */
export function newCoverId(): string {
    return bytesToB64(rand(16)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const isActivityKey = (kid: unknown, keyB64: unknown): boolean =>
    typeof kid === 'string' && KID_RE.test(kid) && typeof keyB64 === 'string' && keyB64.length === 44 && b64ToBytes(keyB64)?.length === 32;

export function coverAad(sharerUserId: string, coverId: string, kid: string): Uint8Array {
    return enc.encode(`cl-activity-cover-v1\n${sharerUserId}\n${coverId}\n${kid}`);
}

/** u32be(len) || image || zeros, to a whole number of 2 KiB blocks. null = too big. */
export function padCover(image: Uint8Array): Uint8Array | null {
    if (image.length === 0 || image.length > COVER_MAX_IMAGE_BYTES) return null;
    const size = Math.ceil((image.length + 4) / COVER_PAD_BYTES) * COVER_PAD_BYTES;
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, image.length);
    out.set(image, 4);
    return out;
}

export function unpadCover(pt: Uint8Array): Uint8Array | null {
    if (pt.length < 4 || pt.length % COVER_PAD_BYTES !== 0) return null;
    const len = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getUint32(0);
    if (len === 0 || len > pt.length - 4) return null;
    return pt.slice(4, 4 + len);
}

async function aesKey(keyB64: string, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    const raw = b64ToBytes(keyB64);
    if (!raw || raw.length !== 32) throw new Error('bad key');
    return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [use]);
}

/** Encrypt one cover image for `sharerUserId`'s friends. null = the image does not fit. */
export async function encryptCover(a: {
    sharerUserId: string; coverId: string; kid: string; keyB64: string; image: Uint8Array;
}): Promise<Uint8Array | null> {
    if (!KID_RE.test(a.kid) || !isCoverId(a.coverId)) return null;
    const pt = padCover(a.image);
    if (!pt) return null;
    const iv = rand(COVER_IV_BYTES);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: coverAad(a.sharerUserId, a.coverId, a.kid) as BufferSource, tagLength: 128 },
        await aesKey(a.keyB64, 'encrypt'), pt as BufferSource,
    ));
    const out = new Uint8Array(COVER_HEADER_BYTES + ct.length);
    out[0] = COVER_VERSION;
    out.set(unhex(a.kid), 1);
    out.set(iv, 1 + COVER_KID_BYTES);
    out.set(ct, COVER_HEADER_BYTES);
    return out;
}

/** The key id a blob was encrypted under (hex), or null when it is not a cover blob. */
export function coverKid(blob: Uint8Array): string | null {
    const body = blob.length - COVER_HEADER_BYTES - COVER_TAG_BYTES;
    if (blob[0] !== COVER_VERSION || body < COVER_PAD_BYTES || body % COVER_PAD_BYTES !== 0) return null;
    return hex(blob.subarray(1, 1 + COVER_KID_BYTES));
}

export interface DecryptedCover { bytes: Uint8Array; type: 'image/jpeg' | 'image/png' | 'image/webp' }

/**
 * Decrypt a friend's cover with the key THEY delivered to this device
 * (`keyFor(kid)`; null = not delivered / rotated away). null for everything
 * that is not a JPEG / PNG / WebP that authenticates under exactly this
 * sharer + id + key. Never throws.
 */
export async function decryptCover(a: {
    sharerUserId: string; coverId: string; blob: Uint8Array; keyFor: (kid: string) => string | null;
}): Promise<DecryptedCover | null> {
    try {
        const kid = coverKid(a.blob);
        if (!kid || !isCoverId(a.coverId)) return null;
        const keyB64 = a.keyFor(kid);
        if (!keyB64) return null;
        const iv = a.blob.slice(1 + COVER_KID_BYTES, COVER_HEADER_BYTES);
        const pt = new Uint8Array(await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as BufferSource, additionalData: coverAad(a.sharerUserId, a.coverId, kid) as BufferSource, tagLength: 128 },
            await aesKey(keyB64, 'decrypt'), a.blob.slice(COVER_HEADER_BYTES) as BufferSource,
        ));
        const bytes = unpadCover(pt);
        const type = bytes ? sniffCover(bytes) : null;
        return bytes && type ? { bytes, type } : null;
    } catch { return null; }
}
