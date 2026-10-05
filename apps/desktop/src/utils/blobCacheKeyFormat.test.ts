/**
 * wrapBlob/unwrapBlob moved their copies + AES-GCM into the attachment crypto
 * worker and compose records from Blob parts. Every record already in a user's
 * IndexedDB (attachments_enc, avatars_dec) was written by the old in-thread
 * code, so the byte layout must not move: [tag][12-byte IV][ct||tag] / [tag][raw].
 */
import { describe, it, expect } from 'vitest';
import { wrapBlob, unwrapBlob, TAG_RAW, TAG_WRAPPED, IV_LEN } from './blobCacheKey';

const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const payload = () => { const u = new Uint8Array(4096); for (let i = 0; i < u.length; i++) u[i] = (i * 13) & 0xff; return u; };
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('blob-cache record format', () => {
    it('wrapped records keep the [tag][iv][ciphertext] layout the old code wrote and read', async () => {
        const k = await key();
        const rec = await bytesOf(await wrapBlob(new Blob([payload()]), k));
        expect(rec[0]).toBe(TAG_WRAPPED);
        expect(rec.length).toBe(1 + IV_LEN + payload().length + 16);
        // decrypt exactly as the pre-change unwrapBlob did
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.subarray(1, 1 + IV_LEN) }, k, rec.subarray(1 + IV_LEN));
        expect(new Uint8Array(pt)).toEqual(payload());
    });

    it('reads a record written by the old in-thread wrapBlob', async () => {
        const k = await key();
        const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, payload()));
        const old = new Uint8Array(1 + IV_LEN + ct.length);
        old[0] = TAG_WRAPPED; old.set(iv, 1); old.set(ct, 1 + IV_LEN);
        expect(await bytesOf(await unwrapBlob(new Blob([old]), k))).toEqual(payload());
    });

    it('raw records (no keystore) round-trip and keep their layout', async () => {
        const rec = await wrapBlob(new Blob([payload()]), null);
        const bytes = await bytesOf(rec);
        expect(bytes[0]).toBe(TAG_RAW);
        expect(bytes.subarray(1)).toEqual(payload());
        expect(await bytesOf(await unwrapBlob(rec, null))).toEqual(payload());
    });

    it('a tampered wrapped record fails (caller treats it as a cache miss)', async () => {
        const k = await key();
        const rec = await bytesOf(await wrapBlob(new Blob([payload()]), k));
        rec[40] ^= 0xff;
        await expect(unwrapBlob(new Blob([rec]), k)).rejects.toBeTruthy();
    });

    it('empty and unknown-tag records still throw', async () => {
        await expect(unwrapBlob(new Blob([]), null)).rejects.toThrow('empty record');
        await expect(unwrapBlob(new Blob([new Uint8Array([7, 1, 2])]), null)).rejects.toThrow('unknown record tag');
    });
});
