import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Every round trip derives a real PBKDF2 key (same cost as driveBackup.test.ts).
vi.setConfig({ testTimeout: 60_000 });

/**
 * Home-screen pins (`cipherline_home_pins_<uid>`) round-trip through a real
 * encrypted backup + restore.
 *
 * backupRegistry.ts already classifies the key `include: true` — this test
 * proves the classification actually DOES something, by driving the full
 * chain a real backup/restore uses:
 *
 *   exportLocalHistory (collectIncludedKv)
 *     -> splitVaultForRecords (kv survives into `meta`)
 *     -> specsFromVault + writeBackupRecords (the `meta` record, encrypted)
 *     -> openContainer (decrypt)
 *     -> applyBackupContainer -> importLocalHistory (applyIncludedKv)
 *
 * secureLocalStore is mocked with a plain in-memory Map, same pattern as
 * backupBinding.test.ts — crypto.ts and messageStore.ts both import the
 * default AND named export, so the mock supplies both.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    // messageStore refuses to read history from a namespace that is not in
    // memory (a backup built from a cold store would be an EMPTY vault written
    // over a good one), so the fake has to report the account as loaded.
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { exportLocalHistory } = await import('../utils/crypto');
const { splitVaultForRecords, specsFromVault, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');

const USER = 'home-pins-user';
const PW = 'pw-for-test';

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined });
});

beforeEach(() => {
    mem.clear();
    Object.assign(window, { electronAPI: undefined });
});

/** Export whatever is currently in `mem` for USER, write it into a real v3
 *  container, decrypt it back, wipe `mem` (simulating a fresh device / a
 *  post-sign-out restore), and apply it. Mirrors what `backup.apply()` does
 *  in driveBackup.ts, minus the Drive/local-file plumbing that's irrelevant
 *  to whether the KV settings themselves survive. */
async function roundTrip(): Promise<void> {
    const vaultBlob = await exportLocalHistory(USER, { includeGifFiles: false });
    const vault = JSON.parse(await vaultBlob.text());
    const { meta, history, channelHistory } = splitVaultForRecords(vault);
    const records = await specsFromVault({ meta, history, channelHistory });
    const plan = { userId: USER, fingerprint: 'test-fp', records, attachmentIds: [], attachmentSizeHints: {} };

    const container = new MemoryContainer();
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });

    const opened = await openContainer(memorySource(container.bytes()), PW);
    mem.clear();
    await applyBackupContainer(USER, opened);
}

describe('Home-screen pins survive a real backup + restore round trip', () => {
    it('cipherline_home_pins_<uid> comes back exactly as it went in', async () => {
        const pins = JSON.stringify([
            { type: 'conversation', id: 'conv-1' },
            { type: 'server', serverId: 'srv-1' },
        ]);
        mem.set(`cipherline_home_pins_${USER}`, pins);

        await roundTrip();

        expect(mem.get(`cipherline_home_pins_${USER}`)).toBe(pins);
    });

    it('an empty pin list round-trips too (not just non-empty state)', async () => {
        mem.set(`cipherline_home_pins_${USER}`, '[]');
        await roundTrip();
        expect(mem.get(`cipherline_home_pins_${USER}`)).toBe('[]');
    });

    // Positive control: proves this test suite can actually detect a broken
    // round trip, not just pass vacuously. A key the registry has never heard
    // of must NOT survive (applyIncludedKv only writes registry-included
    // keys) — if it did, the assertion above would be worthless because
    // collectIncludedKv/applyIncludedKv wouldn't be doing any real filtering.
    it('POSITIVE CONTROL: an unregistered key does NOT survive the round trip', async () => {
        mem.set(`cipherline_home_pins_${USER}`, '[]');
        mem.set(`totally_unregistered_settings_key_${USER}`, 'must not travel');

        await roundTrip();

        expect(mem.has(`totally_unregistered_settings_key_${USER}`)).toBe(false);
        // The registered key still made it, confirming the round trip itself
        // works and the exclusion above isn't just everything failing.
        expect(mem.get(`cipherline_home_pins_${USER}`)).toBe('[]');
    });
});
