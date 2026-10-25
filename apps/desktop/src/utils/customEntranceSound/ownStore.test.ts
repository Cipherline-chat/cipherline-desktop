import { describe, expect, it, vi } from 'vitest';

// The real secureLocalStore is IndexedDB-backed; this module only needs it for
// the lazy real instance, which these tests never build.
vi.mock('../secureLocalStore', () => ({ default: {}, secureLocalStore: {} }));

const { OwnEntranceSoundStore, ownSoundFileName, ownSoundKey, parseOwnSoundRecord } = await import('./ownStore');
const { exportEntranceSound, importEntranceSound, parseEntranceSoundTransfer } = await import('./transfer');
const { contentIdOf } = await import('./identity');
const { EBML_MAGIC, MAX_ENCODED_BYTES } = await import('./constants');
const { bytesToB64 } = await import('../personalEmoji/token');

const UID = 'user-1';

function fakeIO(uid: string | null = UID) {
    const kv = new Map<string, string>();
    const files = new Map<string, Uint8Array>();
    let t = 1_000;
    const io = {
        uid: () => uid,
        kvGet: (u: string) => kv.get(ownSoundKey(u)) ?? null,
        kvSet: (u: string, v: string) => { kv.set(ownSoundKey(u), v); },
        readFile: async (n: string) => files.get(n) ?? null,
        writeFile: async (n: string, b: Uint8Array) => { files.set(n, b.slice()); },
        deleteFile: async (n: string) => { files.delete(n); },
        now: () => t,
        tick: (ms: number) => { t += ms; },
    };
    return { io, kv, files };
}

function webm(n: number, seed: number): Uint8Array {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed * 53) & 0xff);
    b.set(EBML_MAGIC, 0);
    return b;
}

describe('OwnEntranceSoundStore', () => {
    it('stores the sound sealed (no plaintext on disk) and reads it back verified', async () => {
        const { io, files, kv } = fakeIO();
        const s = new OwnEntranceSoundStore(io);
        const bytes = webm(5000, 1);
        const id = await s.set(bytes, 1800);
        expect(id).toBe(await contentIdOf(bytes));
        const sealed = files.get(ownSoundFileName(id))!;
        expect(sealed.length).toBe(bytes.length + 12 + 16);
        expect(Array.from(sealed.subarray(12, 40))).not.toEqual(Array.from(bytes.subarray(0, 28)));
        const rec = parseOwnSoundRecord(kv.get(ownSoundKey(UID)));
        expect(rec).toMatchObject({ id, size: 5000, durationMs: 1800, at: 1000 });
        expect(typeof rec?.key).toBe('string');
        // A fresh instance (no in-memory copy) decrypts from disk.
        expect(await new OwnEntranceSoundStore(io).read()).toEqual(bytes);
    });

    it('keeps one sound per account: replacing deletes the old file', async () => {
        const { io, files } = fakeIO();
        const s = new OwnEntranceSoundStore(io);
        const a = await s.set(webm(3000, 1), 1000);
        const b = await s.set(webm(3000, 2), 1000);
        expect(a).not.toBe(b);
        expect(files.has(ownSoundFileName(a))).toBe(false);
        expect(files.has(ownSoundFileName(b))).toBe(true);
        expect(s.current()?.id).toBe(b);
    });

    it('remove deletes the file and leaves a tombstone', async () => {
        const { io, files } = fakeIO();
        const s = new OwnEntranceSoundStore(io);
        const id = await s.set(webm(3000, 1), 1000);
        io.tick(50);
        await s.remove();
        expect(files.size).toBe(0);
        expect(s.current()).toBeNull();
        expect(s.record()).toEqual({ v: 1, id: null, at: 1050 });
        expect(await s.read()).toBeNull();
        expect(id).toBeTruthy();
    });

    it('refuses bytes over the cap or not WebM, and a signed-out store', async () => {
        const s = new OwnEntranceSoundStore(fakeIO().io);
        await expect(s.set(new Uint8Array(100), 100)).rejects.toThrow('invalid_sound:container');
        const big = new Uint8Array(MAX_ENCODED_BYTES + 1); big.set(EBML_MAGIC);
        await expect(s.set(big, 100)).rejects.toThrow('invalid_sound:size');
        await expect(new OwnEntranceSoundStore(fakeIO(null).io).set(webm(100, 1), 100)).rejects.toThrow('signed_out');
    });

    it('a tampered file reads as nothing', async () => {
        const { io, files } = fakeIO();
        const id = await new OwnEntranceSoundStore(io).set(webm(3000, 1), 1000);
        const f = files.get(ownSoundFileName(id))!;
        f[40] ^= 1;
        expect(await new OwnEntranceSoundStore(io).read()).toBeNull();
    });

    it('notifies subscribers with the origin', async () => {
        const s = new OwnEntranceSoundStore(fakeIO().io);
        const seen: string[] = [];
        s.subscribe(o => seen.push(o));
        await s.set(webm(100, 1), 10);
        await s.remove({ origin: 'sync' });
        expect(seen).toEqual(['local', 'sync']);
    });
});

describe('backup / sync transfer (LWW)', () => {
    it('exports the bytes and imports them on another device, re-sealed under a new key', async () => {
        const a = fakeIO();
        const src = new OwnEntranceSoundStore(a.io);
        const bytes = webm(4000, 3);
        const id = await src.set(bytes, 2000);
        const t = await exportEntranceSound(src);
        expect(t).toMatchObject({ v: 1, id, at: 1000, durationMs: 2000 });

        const b = fakeIO();
        const dst = new OwnEntranceSoundStore(b.io);
        expect(await importEntranceSound(dst, JSON.parse(JSON.stringify(t)))).toBe('applied');
        expect(await dst.read()).toEqual(bytes);
        expect(dst.record()?.at).toBe(1000);
        expect(dst.record()?.key).not.toBe(src.record()?.key);
    });

    it('an older copy does not overwrite a newer local one; the same id is a no-op', async () => {
        const dev = fakeIO();
        const s = new OwnEntranceSoundStore(dev.io);
        dev.io.tick(5000);
        const localId = await s.set(webm(1000, 1), 100);
        const old = { v: 1, id: await contentIdOf(webm(1000, 2)), at: 10, durationMs: 100, b64: bytesToB64(webm(1000, 2)) };
        expect(await importEntranceSound(s, old)).toBe('older');
        expect(s.current()?.id).toBe(localId);
        expect(await importEntranceSound(s, await exportEntranceSound(s))).toBe('same');
    });

    it('a newer tombstone removes it; a missing field means no information', async () => {
        const dev = fakeIO();
        const s = new OwnEntranceSoundStore(dev.io);
        await s.set(webm(1000, 1), 100);
        expect(await importEntranceSound(s, undefined)).toBe('none');
        expect(s.current()).not.toBeNull();
        expect(await importEntranceSound(s, { v: 1, id: null, at: 999_999 })).toBe('applied');
        expect(s.current()).toBeNull();
    });

    it('rejects a copy whose bytes do not match its id, or are not a sound', async () => {
        const s = new OwnEntranceSoundStore(fakeIO().io);
        const lie = { v: 1, id: 'a'.repeat(32), at: 5, durationMs: 1, b64: bytesToB64(webm(1000, 1)) };
        expect(await importEntranceSound(s, lie)).toBe('invalid');
        const notWebm = new Uint8Array(500);
        expect(await importEntranceSound(s, { v: 1, id: await contentIdOf(notWebm), at: 5, b64: bytesToB64(notWebm) })).toBe('invalid');
        expect(await importEntranceSound(s, { v: 1, id: '../../x', at: 5, b64: 'AAAA' })).toBe('invalid');
        expect(s.current()).toBeNull();
        expect(parseEntranceSoundTransfer({ id: null, at: -1 })).toBeNull();
    });
});
