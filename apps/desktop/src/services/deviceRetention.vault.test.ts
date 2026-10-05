import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Round trips derive a real PBKDF2 key (same cost as backupHomeState.test.ts).
vi.setConfig({ testTimeout: 60_000 });

/**
 * Retention is PER DEVICE: nothing about it may leave a device in a backup or
 * history transfer (both are built by exportLocalHistory), and nothing about
 * it may be imposed on a device by a restore — including from an OLD vault
 * that still carries it. The one exception is explicitly SAVED ids, which are
 * user intent about content and travel additively (retentionPortability.ts).
 *
 * Same in-memory secureLocalStore fake as backupHomeState.test.ts.
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

const { exportLocalHistory, importLocalHistory } = await import('../utils/crypto');
const { splitVaultForRecords, specsFromVault, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { readDeviceStorageDecision } = await import('../utils/deviceStorageSetup');
const { getPurgedMessageIds, markMessagesPurged } = await import('../utils/retentionTombstones');
const { foldChannelHistory } = await import('../utils/channelHistoryMerge');

const USER = 'device-retention-user';
const PW = 'pw-for-test';
const CH = 'chan-1';

// Device A: short retention, per-conv + per-server overrides, a purge ledger,
// a setup marker, and a mix of saved and unsaved ids.
const DEVICE_A_POLICY = {
    messageRetention: 'never', attachmentRetention: 'never',
    dmMessageRetention: '1wk', dmAttachmentRetention: '24h',
    groupMessageRetention: '1wk', groupAttachmentRetention: '24h',
    serverMessageRetention: '1wk', serverAttachmentRetention: '24h',
    savedMessageIds: ['saved-msg'], savedAttachmentIds: ['saved-att'],
    unsavedMessageIds: ['unsaved-msg'], unsavedAttachmentIds: ['unsaved-att'],
    unsavedMessageTimestamps: { 'unsaved-msg': 1 }, unsavedAttachmentTimestamps: { 'unsaved-att': 1 },
};
function seedDeviceA(): void {
    mem.set(`cipherline_storage_policy_${USER}`, JSON.stringify(DEVICE_A_POLICY));
    mem.set(`cipherline_conv_retention_${USER}_conv-1`, JSON.stringify({ messageRetention: '1wk' }));
    mem.set(`cipherline_server_retention_${USER}_srv-1`, JSON.stringify({ attachmentRetention: '24h' }));
    mem.set(`cipherline_retention_purged_${USER}_${CH}`, JSON.stringify(['purged-by-A']));
    mem.set(`cipherline_device_storage_setup_${USER}`, JSON.stringify({ v: 1, at: 1, how: 'chosen' }));
    // A registry-INCLUDED key alongside, so the round trip is provably live.
    mem.set(`cipherline_home_pins_${USER}`, JSON.stringify([{ type: 'conversation', id: 'conv-1' }]));
}

const RETENTION_KEY_PREFIXES = [
    `cipherline_storage_policy_${USER}`,
    `cipherline_conv_retention_${USER}_`,
    `cipherline_server_retention_${USER}_`,
    `cipherline_retention_purged_${USER}_`,
    `cipherline_device_storage_setup_${USER}`,
];

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined });
});
beforeEach(() => {
    mem.clear();
    Object.assign(window, { electronAPI: undefined, dispatchEvent: () => true });
});

async function exportVault(): Promise<Record<string, unknown>> {
    return JSON.parse(await (await exportLocalHistory(USER, { includeGifFiles: false })).text());
}

/** Full real-container round trip; `mem` is replaced by `onto` (the target
 *  device's own prior state) before applying. */
async function backupAndRestoreOnto(onto: Map<string, string>): Promise<void> {
    const vault = await exportVault();
    const { meta, history, channelHistory } = splitVaultForRecords(vault as never);
    const records = await specsFromVault({ meta, history, channelHistory });
    const plan = { userId: USER, fingerprint: 'fp', records, attachmentIds: [], attachmentSizeHints: {} };
    const container = new MemoryContainer();
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
    const opened = await openContainer(memorySource(container.bytes()), PW);
    mem.clear();
    for (const [k, v] of onto) mem.set(k, v);
    await applyBackupContainer(USER, opened);
}

describe('export — retention settings never leave the device', () => {
    it('the vault carries no retention policy and no retention kv keys', async () => {
        seedDeviceA();
        const vault = await exportVault();

        expect(vault).not.toHaveProperty('retentionPolicy');
        const kv = (vault.kv ?? {}) as Record<string, string>;
        for (const k of Object.keys(kv)) {
            expect(k, `retention key leaked into vault.kv: ${k}`).not.toMatch(
                /^cipherline_(storage_policy|conv_retention|server_retention|retention_purged|device_storage_setup)_/,
            );
        }
        // Liveness: the included key IS there, so kv collection actually ran.
        expect(kv['cipherline_home_pins_{uid}']).toBeDefined();
    });

    it('only explicitly SAVED ids travel — no windows, no unsaved ids', async () => {
        seedDeviceA();
        const vault = await exportVault();
        expect(vault.retentionSaves).toEqual({ savedMessageIds: ['saved-msg'], savedAttachmentIds: ['saved-att'] });
        const blob = JSON.stringify(vault);
        expect(blob).not.toContain('unsaved-msg');
        expect(blob).not.toContain('"dmAttachmentRetention"');
    });

    it('omits retentionSaves entirely when nothing is saved', async () => {
        mem.set(`cipherline_storage_policy_${USER}`, JSON.stringify({ ...DEVICE_A_POLICY, savedMessageIds: [], savedAttachmentIds: [] }));
        const vault = await exportVault();
        expect(vault.retentionSaves).toBeUndefined();
    });
});

describe('restore — a real backup never imposes another device’s retention', () => {
    it('onto a FRESH device: no windows, overrides, ledger or marker land; saved ids do; the device still prompts', async () => {
        seedDeviceA();
        await backupAndRestoreOnto(new Map());

        expect(mem.has(`cipherline_conv_retention_${USER}_conv-1`)).toBe(false);
        expect(mem.has(`cipherline_server_retention_${USER}_srv-1`)).toBe(false);
        expect(mem.has(`cipherline_retention_purged_${USER}_${CH}`)).toBe(false);
        expect(mem.has(`cipherline_device_storage_setup_${USER}`)).toBe(false);
        for (const prefix of RETENTION_KEY_PREFIXES.slice(1)) {
            expect([...mem.keys()].filter(k => k.startsWith(prefix)), prefix).toEqual([]);
        }

        const stored = JSON.parse(mem.get(`cipherline_storage_policy_${USER}`)!);
        expect(stored.savedMessageIds).toEqual(['saved-msg']);
        expect(stored.savedAttachmentIds).toEqual(['saved-att']);
        expect(stored).not.toHaveProperty('dmMessageRetention');
        expect(stored).not.toHaveProperty('unsavedMessageIds');

        // A saves-only record is not a retention choice: the first-run prompt still shows.
        expect(readDeviceStorageDecision(USER)).toBe('prompt');
        // Liveness: the included key came through the same round trip.
        expect(mem.get(`cipherline_home_pins_${USER}`)).toBeDefined();
    });

    it('onto a device that ALREADY chose: its own windows, overrides, ledger and marker survive untouched', async () => {
        seedDeviceA();
        const deviceB = new Map<string, string>([
            [`cipherline_storage_policy_${USER}`, JSON.stringify({ messageRetention: 'never', attachmentRetention: 'never', savedMessageIds: ['b-saved'], unsavedMessageIds: ['saved-msg'] })],
            [`cipherline_conv_retention_${USER}_conv-1`, JSON.stringify({ messageRetention: 'never' })],
            [`cipherline_retention_purged_${USER}_${CH}`, JSON.stringify(['purged-by-B'])],
            [`cipherline_device_storage_setup_${USER}`, JSON.stringify({ v: 1, at: 2, how: 'recommended' })],
        ]);
        await backupAndRestoreOnto(deviceB);

        const stored = JSON.parse(mem.get(`cipherline_storage_policy_${USER}`)!);
        expect(stored.messageRetention).toBe('never');          // B's window, not A's 1wk
        expect(stored).not.toHaveProperty('dmMessageRetention'); // A's per-type windows not imported
        expect(stored.savedMessageIds.sort()).toEqual(['b-saved', 'saved-msg']); // union
        expect(stored.unsavedMessageIds).toEqual([]);           // restored save wins over a local unsave
        expect(JSON.parse(mem.get(`cipherline_conv_retention_${USER}_conv-1`)!)).toEqual({ messageRetention: 'never' });
        expect(mem.has(`cipherline_server_retention_${USER}_srv-1`)).toBe(false);
        expect([...getPurgedMessageIds(USER, CH)]).toEqual(['purged-by-B']);
        expect(JSON.parse(mem.get(`cipherline_device_storage_setup_${USER}`)!).how).toBe('recommended');
    });
});

describe('restore — an OLD vault (pre-2026-09) that still carries retention stays readable and is ignored', () => {
    /** The shape exportLocalHistory produced before this change: the whole
     *  StoragePolicy in `retentionPolicy`, and the overrides + purge ledger
     *  inside the registry-driven `kv` map. */
    function legacyVault(): Record<string, unknown> {
        return {
            version: 4, userId: USER, deviceId: 'dev-A', privateKey: '', publicKey: '',
            topics: [], history: {},
            retentionPolicy: DEVICE_A_POLICY,
            kv: {
                'cipherline_conv_retention_{uid}_conv-1': JSON.stringify({ messageRetention: '1wk' }),
                'cipherline_server_retention_{uid}_srv-1': JSON.stringify({ attachmentRetention: '24h' }),
                [`cipherline_retention_purged_{uid}_${CH}`]: JSON.stringify(['purged-by-A']),
                'cipherline_home_pins_{uid}': JSON.stringify([{ type: 'server', serverId: 'srv-1' }]),
            },
        };
    }
    const importVault = (v: Record<string, unknown>) =>
        importLocalHistory(USER, new Blob([JSON.stringify(v)], { type: 'application/json' }));

    it('parses, applies ordinary settings, and ignores every retention field', async () => {
        await importVault(legacyVault());

        // Liveness: an ordinary included kv key from the same vault DID apply.
        expect(JSON.parse(mem.get(`cipherline_home_pins_${USER}`)!)).toEqual([{ type: 'server', serverId: 'srv-1' }]);

        expect(mem.has(`cipherline_conv_retention_${USER}_conv-1`)).toBe(false);
        expect(mem.has(`cipherline_server_retention_${USER}_srv-1`)).toBe(false);
        expect(mem.has(`cipherline_retention_purged_${USER}_${CH}`)).toBe(false);

        const stored = JSON.parse(mem.get(`cipherline_storage_policy_${USER}`)!);
        expect(stored).toEqual({ savedMessageIds: ['saved-msg'], savedAttachmentIds: ['saved-att'] });
        expect(readDeviceStorageDecision(USER)).toBe('prompt');
    });

    it('keeps a device’s existing policy windows when an old vault is restored over it', async () => {
        mem.set(`cipherline_storage_policy_${USER}`, JSON.stringify({ messageRetention: 'never', attachmentRetention: '1y' }));
        mem.set(`cipherline_device_storage_setup_${USER}`, JSON.stringify({ v: 1, at: 3, how: 'chosen' }));
        await importVault(legacyVault());
        const stored = JSON.parse(mem.get(`cipherline_storage_policy_${USER}`)!);
        expect(stored.messageRetention).toBe('never');
        expect(stored.attachmentRetention).toBe('1y');
        expect(stored).not.toHaveProperty('dmAttachmentRetention');
        expect(readDeviceStorageDecision(USER)).toBe('done');
    });

    it('tolerates a malformed legacy retentionPolicy', async () => {
        await importVault({ ...legacyVault(), retentionPolicy: 'garbage' });
        expect(mem.get(`cipherline_storage_policy_${USER}`)).toBeUndefined();
        await importVault({ ...legacyVault(), retentionPolicy: { savedMessageIds: [1, null, 'ok'] } });
        expect(JSON.parse(mem.get(`cipherline_storage_policy_${USER}`)!).savedMessageIds).toEqual(['ok']);
    });
});

describe('tombstone decision — the purge ledger is DEVICE-LOCAL', () => {
    const row = (id: string, ts: string) => ({ id, timestamp: ts, content: { type: 'text', text: id } });

    it('a message device A purged is still fetched and kept by device B after B restores A’s old backup', async () => {
        // B restores an old backup that carries A's ledger for CH ...
        await importLocalHistory(USER, new Blob([JSON.stringify({
            version: 4, userId: USER, deviceId: 'dev-A', privateKey: '', publicKey: '',
            topics: [], history: {},
            kv: { [`cipherline_retention_purged_{uid}_${CH}`]: JSON.stringify(['purged-by-A']) },
        })]));
        // ... and then fetches channel history from the server, which still has it.
        const purged = getPurgedMessageIds(USER, CH);
        const folded = foldChannelHistory([], [row('purged-by-A', '2026-09-01T00:00:00Z')], purged);
        expect(folded.map(r => r.id)).toEqual(['purged-by-A']);
    });

    it('POSITIVE CONTROL: the device’s OWN ledger still hides what its own sweep purged', () => {
        markMessagesPurged(USER, CH, ['purged-here']);
        const folded = foldChannelHistory([], [row('purged-here', '2026-09-01T00:00:00Z'), row('kept', '2026-09-02T00:00:00Z')], getPurgedMessageIds(USER, CH));
        expect(folded.map(r => r.id)).toEqual(['kept']);
    });
});
