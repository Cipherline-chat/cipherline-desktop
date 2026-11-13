import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { resolveShareRef, peekShareRef, clearShareRefs, claimShareOnce, shareRefFromDigest, SHARE_REF_RE } from './shareRef';

afterEach(() => clearShareRefs());

const expected = (sid: string) => createHash('sha256').update('cipherline.share-ref.v1:' + sid).digest('hex').slice(0, 8);

describe('share_ref', () => {
    it('is the first 8 hex chars of SHA-256 over a domain tag + the SID (matches an independent hash)', async () => {
        for (const sid of ['TR_AbCdEf12345x', 'TR_other', 'x']) {
            const ref = await resolveShareRef(sid);
            expect(ref).toBe(expected(sid));
            expect(ref).toMatch(SHARE_REF_RE);
        }
    });

    it('both ends compute the same ref from the same SID; different SIDs differ', async () => {
        const a = await resolveShareRef('TR_share_1');
        clearShareRefs();
        expect(await resolveShareRef('TR_share_1')).toBe(a);
        expect(await resolveShareRef('TR_share_2')).not.toBe(a);
    });

    it('never contains the SID (or a long slice of it) and cannot be reversed to it by prefix', async () => {
        const sid = 'TR_AbCdEf12345x';
        const ref = (await resolveShareRef(sid))!;
        expect(ref).toHaveLength(8);
        expect(sid.toLowerCase()).not.toContain(ref);
        expect(ref).not.toContain(sid.slice(3, 7).toLowerCase());
    });

    it('nothing in, nothing out; unavailable WebCrypto yields null instead of throwing', async () => {
        expect(await resolveShareRef(null)).toBeNull();
        expect(await resolveShareRef('')).toBeNull();
        const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
        try { expect(await resolveShareRef('TR_nocrypto')).toBeNull(); }
        finally { if (real) Object.defineProperty(globalThis, 'crypto', real); }
    });

    it('is memoised: peekShareRef answers synchronously after the first resolve, and is bounded', async () => {
        expect(peekShareRef('TR_peek')).toBeUndefined();
        const ref = await resolveShareRef('TR_peek');
        expect(peekShareRef('TR_peek')).toBe(ref);
        for (let i = 0; i < 100; i++) await resolveShareRef(`TR_fill_${i}`);
        expect(peekShareRef('TR_peek')).toBeUndefined(); // evicted: the cache never grows without bound
    });

    it('shareRefFromDigest takes the first four bytes', () => {
        expect(shareRefFromDigest(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]))).toBe('deadbeef');
        expect(shareRefFromDigest(new Uint8Array([1, 2]).buffer)).toBe('0102');
    });
});

describe('claimShareOnce', () => {
    it('is true once per (tag, ref), independent across tags and refs, and reset with the refs', () => {
        expect(claimShareOnce('share_display', 'a1b2c3d4')).toBe(true);
        expect(claimShareOnce('share_display', 'a1b2c3d4')).toBe(false);
        expect(claimShareOnce('share_display', '0badf00d')).toBe(true);
        expect(claimShareOnce('other', 'a1b2c3d4')).toBe(true);
        clearShareRefs();
        expect(claimShareOnce('share_display', 'a1b2c3d4')).toBe(true);
    });
});
