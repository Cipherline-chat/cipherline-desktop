import { describe, it, expect, beforeAll } from 'vitest';
import { encryptBlobCore, decryptBlobCore } from './attachmentCryptoCore';

beforeAll(() => {
    Object.assign(globalThis, { window: Object.assign((globalThis as { window?: object }).window ?? {}, { crypto: globalThis.crypto, btoa, atob }) });
});

const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const bytes = (n: number) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + 7) & 0xff; return u; };
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** The pre-worker implementation, verbatim in behaviour, for wire-compat checks. */
async function legacyEncrypt(file: Blob, k: CryptoKey, bundleIv: boolean) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, await file.arrayBuffer());
    if (bundleIv) {
        const combined = new Uint8Array(12 + ct.byteLength);
        combined.set(iv, 0); combined.set(new Uint8Array(ct), 12);
        return { blob: new Blob([combined]), ivB64: b64(iv) };
    }
    return { blob: new Blob([ct]), ivB64: b64(iv) };
}
async function legacyDecrypt(enc: Blob, k: CryptoKey, ivB64: string | null) {
    const combined = new Uint8Array(await enc.arrayBuffer());
    const iv = ivB64 ? Uint8Array.from(atob(ivB64), c => c.charCodeAt(0)) : combined.slice(0, 12);
    const ct = ivB64 ? combined : combined.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct));
}

describe('attachmentCryptoCore — same wire format as before the worker move', () => {
    for (const bundleIv of [false, true]) {
        it(`round-trips (bundleIv=${bundleIv}) and stays readable by / able to read the legacy code`, async () => {
            const k = await key();
            const plain = bytes(70_000);
            const ivArg = (iv: string) => (bundleIv ? null : iv);

            const mine = await encryptBlobCore(new Blob([plain]), k, bundleIv);
            expect(mine.encryptedBlob.size).toBe(plain.length + 16 + (bundleIv ? 12 : 0));
            expect(await legacyDecrypt(mine.encryptedBlob, k, ivArg(mine.ivB64))).toEqual(plain);

            const old = await legacyEncrypt(new Blob([plain]), k, bundleIv);
            const back = await decryptBlobCore(old.blob, k, ivArg(old.ivB64), 'image/gif');
            expect(back.type).toBe('image/gif');
            expect(new Uint8Array(await back.arrayBuffer())).toEqual(plain);
        });
    }

    it('bundled payload starts with the returned IV', async () => {
        const k = await key();
        const { encryptedBlob, ivB64 } = await encryptBlobCore(new Blob([bytes(100)]), k, true);
        const head = new Uint8Array(await encryptedBlob.slice(0, 12).arrayBuffer());
        expect(b64(head)).toBe(ivB64);
    });

    it('tampered ciphertext rejects with OperationError (callers show "couldn\'t decrypt")', async () => {
        const k = await key();
        const { encryptedBlob, ivB64 } = await encryptBlobCore(new Blob([bytes(1000)]), k, false);
        const t = new Uint8Array(await encryptedBlob.arrayBuffer()); t[5] ^= 1;
        await expect(decryptBlobCore(new Blob([t]), k, ivB64, 'image/png')).rejects.toMatchObject({ name: 'OperationError' });
    });
});

describe('attachmentCryptoWorker — no Worker available (tests, or a worker that cannot start)', () => {
    it('falls back to the in-thread path with identical results', async () => {
        const { encryptBlobOffThread, decryptBlobOffThread } = await import('./attachmentCryptoWorker');
        expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe('undefined');
        const k = await key();
        const plain = bytes(5000);
        const { encryptedBlob, ivB64 } = await encryptBlobOffThread(new Blob([plain]), k, false);
        const out = await decryptBlobOffThread(encryptedBlob, k, ivB64, 'application/octet-stream');
        expect(new Uint8Array(await out.arrayBuffer())).toEqual(plain);
    });

    it('crypto errors still propagate through the fallback', async () => {
        const { decryptBlobOffThread } = await import('./attachmentCryptoWorker');
        const k = await key();
        await expect(decryptBlobOffThread(new Blob([bytes(64)]), k, b64(bytes(12)), 'image/png')).rejects.toMatchObject({ name: 'OperationError' });
    });
});
