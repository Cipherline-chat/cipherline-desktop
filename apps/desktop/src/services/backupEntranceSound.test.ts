import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Every round trip derives a real PBKDF2 key (same cost as driveBackup.test.ts).
vi.setConfig({ testTimeout: 60_000 });

/**
 * Your custom entrance sound round-trips through a REAL encrypted backup:
 *
 *   ownEntranceSound().set  (sealed file + key in secureLocalStore)
 *     -> exportLocalHistory (vault.entranceSound, bytes inline)
 *     -> splitVaultForRecords (it rides in the `meta` record - no new record
 *        kind, so an older build restoring this backup does not choke on it)
 *     -> writeBackupRecords -> openContainer -> applyBackupContainer
 *     -> importLocalHistory -> importEntranceSound (verified, re-sealed)
 *
 * secureLocalStore and the Electron file bridge are in-memory fakes.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const files = new Map<string, Uint8Array>();
const electronAPI = {
    getUserDataPath: async () => '/ud',
    readGifFile: async (name: string) => { const f = files.get(name); if (!f) throw new Error('ENOENT'); return f; },
    writeGifFile: async (name: string, data: Uint8Array) => { files.set(name, data.slice()); },
    deleteFile: async (path: string) => { files.delete(path.replace('/ud/cipherline-gifs/', '').replace(/\.enc$/, '')); return { ok: true }; },
};

const { exportLocalHistory } = await import('../utils/crypto');
const { splitVaultForRecords, specsFromVault, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { ownEntranceSound, ownSoundFileName, ownSoundKey } = await import('../utils/customEntranceSound/ownStore');
const { EBML_MAGIC } = await import('../utils/customEntranceSound/constants');

const USER = 'entrance-sound-user';
const PW = 'pw-for-test';

function webm(n: number, seed: number): Uint8Array {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 11 + seed) & 0xff);
    b.set(EBML_MAGIC, 0);
    return b;
}

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

beforeEach(() => {
    mem.clear();
    files.clear();
    Object.assign(window, { electronAPI });
    mem.set('cipherline_user_id', USER);
});

async function roundTrip(): Promise<{ meta: Record<string, unknown> }> {
    const vault = JSON.parse(await (await exportLocalHistory(USER, { includeGifFiles: false })).text());
    const { meta, history, channelHistory } = splitVaultForRecords(vault);
    const records = await specsFromVault({ meta, history, channelHistory });
    const plan = { userId: USER, fingerprint: 'fp', records, attachmentIds: [], attachmentSizeHints: {} };
    const container = new MemoryContainer();
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
    const opened = await openContainer(memorySource(container.bytes()), PW);
    expect(opened.index.records.map(r => r.id)).toEqual(['meta']); // no new record kind
    // A fresh device: nothing in the store, no files, same account signed in.
    mem.clear();
    files.clear();
    ownEntranceSound().resetSession();
    mem.set('cipherline_user_id', USER);
    await applyBackupContainer(USER, opened);
    return { meta };
}

describe('custom entrance sound in the encrypted backup', () => {
    it('comes back byte-identical, re-sealed under a new key on the restoring device', async () => {
        const bytes = webm(6000, 1);
        const id = await ownEntranceSound().set(bytes, 2200);
        const keyBefore = JSON.parse(mem.get(ownSoundKey(USER))!).key;

        const { meta } = await roundTrip();
        expect((meta.entranceSound as { id: string }).id).toBe(id);

        const store = ownEntranceSound();
        expect(store.current()).toMatchObject({ id, size: 6000, durationMs: 2200 });
        expect(await store.read()).toEqual(bytes);
        expect(files.has(ownSoundFileName(id))).toBe(true);
        expect(JSON.parse(mem.get(ownSoundKey(USER))!).key).not.toBe(keyBefore);
        // Never via the generic settings map (that would copy a device-local key).
        expect(JSON.stringify(meta.kv ?? {})).not.toContain('cipherline_entrance_sound_');
    });

    it('POSITIVE CONTROL: with no sound set, nothing comes back', async () => {
        await roundTrip();
        expect(ownEntranceSound().current()).toBeNull();
    });
});
