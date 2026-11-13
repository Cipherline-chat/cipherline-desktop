import { describe, it, expect } from 'vitest';
import {
    COVER_HEADER_BYTES, COVER_MAX_IMAGE_BYTES, COVER_TAG_BYTES,
    b64ToBytes, bytesToB64, coverKid, decryptCover, encryptCover, isActivityKey, isCoverId, newActivityKey, newCoverId, padCover, unpadCover,
} from './activityCover';

/**
 * Friends' END-TO-END ENCRYPTED Spotify covers: the format and the crypto,
 * with the real WebCrypto AES-256-GCM. The sharer encrypts; a friend holding
 * the delivered key decrypts; nobody else (no key, an old key after a
 * rotation, a different sharer / id) can. (The cross-check against the API's
 * own validator is activityCover.apiContract.test.ts - private repo only.)
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 3000 }, (_, i) => i % 251)]);

async function seal(over: Partial<{ sharerUserId: string; coverId: string; kid: string; keyB64: string; image: Uint8Array }> = {}) {
    const key = newActivityKey();
    const coverId = newCoverId();
    const args = { sharerUserId: ALICE, coverId, kid: key.kid, keyB64: key.keyB64, image: JPEG, ...over };
    return { key, coverId: args.coverId, blob: (await encryptCover(args))!, args };
}

describe('ids and keys', () => {
    it('cover ids are 22-char base64url, random; keys are 32 bytes with a 16-hex id', () => {
        const a = newCoverId(), b = newCoverId();
        expect(isCoverId(a)).toBe(true);
        expect(a).not.toBe(b);
        const k = newActivityKey();
        expect(k.kid).toMatch(/^[0-9a-f]{16}$/);
        expect(b64ToBytes(k.keyB64)?.length).toBe(32);
        expect(isActivityKey(k.kid, k.keyB64)).toBe(true);
        expect(isActivityKey('xyz', k.keyB64)).toBe(false);
        expect(isActivityKey(k.kid, bytesToB64(new Uint8Array(16)))).toBe(false);
    });
});

describe('padding (the server sees only 2 KiB buckets)', () => {
    it('pads to whole blocks, round-trips, and refuses empty / oversize', () => {
        expect(padCover(new Uint8Array(1))!.length).toBe(2048);
        expect(padCover(new Uint8Array(2044))!.length).toBe(2048);
        expect(padCover(new Uint8Array(2045))!.length).toBe(4096);
        expect(unpadCover(padCover(JPEG)!)).toEqual(JPEG);
        expect(padCover(new Uint8Array(0))).toBeNull();
        expect(padCover(new Uint8Array(COVER_MAX_IMAGE_BYTES + 1))).toBeNull();
        expect(unpadCover(new Uint8Array(2048))).toBeNull(); // length 0
    });

    it('two covers of different sizes in the same bucket produce blobs of the same size', async () => {
        const a = await seal({ image: JPEG.slice(0, 900) });
        const b = await seal({ image: JPEG.slice(0, 1900) });
        expect(a.blob.length).toBe(b.blob.length);
        expect(a.blob.length).toBe(COVER_HEADER_BYTES + 2048 + COVER_TAG_BYTES);
    });
});

describe('round trip: sharer encrypts, a friend with the key decrypts', () => {
    it('the friend gets the exact image back, typed by its magic bytes', async () => {
        const { key, coverId, blob } = await seal();
        expect(coverKid(blob)).toBe(key.kid);
        const out = await decryptCover({ sharerUserId: ALICE, coverId, blob, keyFor: kid => (kid === key.kid ? key.keyB64 : null) });
        expect(out?.type).toBe('image/jpeg');
        expect(out?.bytes).toEqual(JPEG);
    });

    it('the blob is ciphertext: the image bytes do not appear in it, and two encryptions differ (fresh IV)', async () => {
        const { blob, args } = await seal();
        const hay = Buffer.from(blob);
        expect(hay.includes(Buffer.from(JPEG.slice(0, 64)))).toBe(false);
        const again = await encryptCover(args);
        expect(Buffer.from(again!).equals(hay)).toBe(false);
    });

    it('a non-friend (no key) cannot decrypt', async () => {
        const { coverId, blob } = await seal();
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob, keyFor: () => null })).toBeNull();
    });

    it('a REMOVED friend (holding only the key from before the rotation) cannot decrypt a cover made after it', async () => {
        const old = newActivityKey();
        const rotated = newActivityKey();
        const { coverId, blob } = await seal(rotated); // the rotated key (kid + keyB64) seals it
        // The removed friend's device only knows the old key (and even a forced kid match fails to authenticate).
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob, keyFor: kid => (kid === old.kid ? old.keyB64 : null) })).toBeNull();
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob, keyFor: () => old.keyB64 })).toBeNull();
    });

    it('the AAD binds sharer and id: a blob moved to another person or another id does not open', async () => {
        const { key, coverId, blob } = await seal();
        const keyFor = () => key.keyB64;
        expect(await decryptCover({ sharerUserId: BOB, coverId, blob, keyFor })).toBeNull();
        expect(await decryptCover({ sharerUserId: ALICE, coverId: newCoverId(), blob, keyFor })).toBeNull();
    });

    it('a tampered blob, a wrong version, or garbage: null, never a throw', async () => {
        const { key, coverId, blob } = await seal();
        const keyFor = () => key.keyB64;
        const flipped = blob.slice(); flipped[flipped.length - 1] ^= 1;
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob: flipped, keyFor })).toBeNull();
        const v2 = blob.slice(); v2[0] = 2;
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob: v2, keyFor })).toBeNull();
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob: new Uint8Array(10), keyFor })).toBeNull();
    });

    it('an authenticated plaintext that is not JPEG / PNG / WebP (an SVG, a script) is refused', async () => {
        const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const { key, coverId, blob } = await seal({ image: svg });
        expect(await decryptCover({ sharerUserId: ALICE, coverId, blob, keyFor: () => key.keyB64 })).toBeNull();
    });

    it('refuses to encrypt with a malformed key id or cover id', async () => {
        const k = newActivityKey();
        expect(await encryptCover({ sharerUserId: ALICE, coverId: 'bad', kid: k.kid, keyB64: k.keyB64, image: JPEG })).toBeNull();
        expect(await encryptCover({ sharerUserId: ALICE, coverId: newCoverId(), kid: 'nothex', keyB64: k.keyB64, image: JPEG })).toBeNull();
    });
});
