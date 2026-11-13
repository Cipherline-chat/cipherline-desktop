import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Every backup round trip derives a real PBKDF2 key.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Backup + device-to-device transfer audit (2026-10-27): everything personal
 * that is NOT a plain settings key must actually arrive on a FRESH device —
 * My Emojis (images, names, order), the custom entrance sound, custom
 * notification sounds, the GIF library's KLIPY references, and the settings
 * that ride the vault — through BOTH paths:
 *
 *   backup:   buildBackupPlan -> writeBackupRecords -> openContainer -> applyBackupContainer
 *   transfer: exportLocalHistory (all-in-one vault, what HistoryRequestModal sends)
 *             -> importLocalHistory (what HistorySyncBanner applies)
 *
 * plus the compatibility edges (an old vault on a new build, an unknown record
 * kind from a newer build) and the restore-merges-not-overwrites keys.
 *
 * secureLocalStore and the Electron bridge are in-memory fakes; the crypto,
 * container format, vault builder and importers are the real ones.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
    flushNow: async () => {},
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
// The selective-transfer path lazily imports the attachment downloader, whose
// axios import reads window.location at load. No attachments are sent here.
vi.mock('../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async () => null }));

/** `userData/cipherline-gifs/<name>.enc` and `userData/custom-sounds/<name>`. */
const gifFiles = new Map<string, Uint8Array>();
const soundFiles = new Map<string, Uint8Array>();
let soundDir = '/machineA/custom-sounds';
const electronAPI = {
    getUserDataPath: async () => '/ud',
    listGifFiles: async () => [...gifFiles.keys()],
    readGifFile: async (name: string) => { const f = gifFiles.get(name); if (!f) throw new Error('ENOENT'); return f; },
    writeGifFile: async (name: string, data: Uint8Array) => { gifFiles.set(name, data.slice()); },
    deleteFile: async (path: string) => { gifFiles.delete(path.replace('/ud/cipherline-gifs/', '').replace(/\.enc$/, '')); return { ok: true }; },
    listCustomSounds: async () => [...soundFiles.keys()].map(name => ({ name, file: `file://${soundDir}/${name}` })),
    readCustomSound: async (file: string) => {
        const f = soundFiles.get(file.split('/').pop()!);
        if (!f) throw new Error('ENOENT');
        return f;
    },
    uploadCustomSound: async (name: string, data: Uint8Array) => {
        soundFiles.set(name, data.slice());
        return { name, file: `file://${soundDir}/${name}` };
    },
};

const { exportLocalHistory, importLocalHistory } = await import('../utils/crypto');
const { buildBackupPlan, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { personalEmojis } = await import('../utils/personalEmoji/service');
const { ownEntranceSound } = await import('../utils/customEntranceSound/ownStore');
const { EBML_MAGIC } = await import('../utils/customEntranceSound/constants');
const { classifyHistoryPayload, HistoryPayloadRefusedError } = await import('../utils/historyPayloadFormat');
const { applyIncludedKv, ownedCustomSounds, referencedCustomSoundNames } = await import('./backupRegistry');
const { kvMergerFor } = await import('./backupKvMerge');
const { VOICE_DEFAULTS_MIGRATION_KEY } = await import('../utils/voiceDefaultsMigration');
const { KEYBINDS_MIGRATION_KEY } = await import('../hooks/useKeybinds');

const USER = 'audit-user';
const PW = 'pw-for-test';
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7, 7]);
const webm = (n: number, seed: number) => { const b = Uint8Array.from({ length: n }, (_, i) => (i * 11 + seed) & 0xff); b.set(EBML_MAGIC, 0); return b; };
const ogg = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

const KLIPY_FAV = { id: 'klipy-abc', source: 'klipy', fileName: 'klipy-ref', klipy: { slug: 'abc', url: 'https://static.klipy.com/x.gif', w: 100, h: 80, mime: 'image/gif' }, addedAt: 5 };
const notifPrefs = (dir: string) => JSON.stringify({
    enabled: true,
    custom_sounds: [{ name: 'ding.ogg', file: `file://${dir}/ding.ogg` }],
    sounds: { message: { enabled: true, file: `file://${dir}/ding.ogg`, volume: 0.5 } },
});

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

function freshDevice(dir: string): void {
    mem.clear();
    gifFiles.clear();
    soundFiles.clear();
    soundDir = dir;
    ownEntranceSound().resetSession();
    mem.set('cipherline_user_id', USER);
}

beforeEach(() => {
    freshDevice('/machineA/custom-sounds');
    Object.assign(window, { electronAPI });
});

/** Device A: everything the owner listed, set up the way the app writes it. */
async function populateDeviceA() {
    const lib = personalEmojis();
    const a = await lib.add(png(1), 'party');
    const b = await lib.add(png(2), 'wave');
    const c = await lib.add(png(3), 'blob');
    if (!a.ok || !b.ok || !c.ok) throw new Error('emoji add failed');
    lib.move(c.entry.id, 0); // a non-default order must survive
    lib.rename(a.entry.id, 'party_parrot');
    const order = lib.load().entries.map(e => e.name);

    const soundId = await ownEntranceSound().set(webm(5000, 3), 1800);

    // Custom notification sounds: one this account uses, one another account
    // on the same machine uploaded into the shared directory.
    soundFiles.set('ding.ogg', ogg(4000, 1));
    soundFiles.set('other-account.ogg', ogg(3000, 2));
    mem.set(`cipherline_notif_global_prefs_${USER}`, notifPrefs('/machineA/custom-sounds'));

    mem.set(`cipherline_gif_favorites_${USER}`, JSON.stringify([KLIPY_FAV]));
    mem.set(`cipherline_home_pins_${USER}`, JSON.stringify(['conv-1']));
    mem.set(`cipherline_pinned_${USER}`, JSON.stringify({ 'conv-1': ['m1'] }));
    mem.set('cipherline_keybinds', JSON.stringify({ 'toggle-mute': 'ctrl+m' }));
    mem.set('cipherline_voice_settings', JSON.stringify({ noiseSuppressionMode: 'strong', echoCancellation: true }));
    mem.set(VOICE_DEFAULTS_MIGRATION_KEY, '1');
    mem.set(KEYBINDS_MIGRATION_KEY, '1');
    mem.set(`cipherline_listening_share_${USER}`, '1');
    mem.set(`cipherline_listening_watching_${USER}`, '0');
    mem.set(`cipherline_listening_asked_${USER}`, '1');
    return { order, soundId, ids: [a.entry.id, b.entry.id, c.entry.id] };
}

async function assertArrived(want: Awaited<ReturnType<typeof populateDeviceA>>, dir: string) {
    const lib = personalEmojis();
    // My Emojis: names, order, and every image readable (decrypts under the
    // key that came with it).
    expect(lib.load().entries.map(e => e.name)).toEqual(want.order);
    for (const [i, id] of want.ids.entries()) expect(await lib.store.read(id)).toEqual(png(i + 1));
    // Custom entrance sound.
    expect(ownEntranceSound().current()?.id).toBe(want.soundId);
    expect(await ownEntranceSound().read()).toEqual(webm(5000, 3));
    // Custom notification sound: arrived, and the prefs now point at THIS machine's copy.
    expect(soundFiles.get('ding.ogg')).toEqual(ogg(4000, 1));
    const prefs = JSON.parse(mem.get(`cipherline_notif_global_prefs_${USER}`)!);
    expect(prefs.sounds.message.file).toBe(`file://${dir}/ding.ogg`);
    expect(prefs.custom_sounds).toEqual([{ name: 'ding.ogg', file: `file://${dir}/ding.ogg` }]);
    // Another account's upload never rides along.
    expect(soundFiles.has('other-account.ogg')).toBe(false);
    // GIF library KLIPY reference (a reference, never media).
    expect(JSON.parse(mem.get(`cipherline_gif_favorites_${USER}`)!)).toEqual([KLIPY_FAV]);
    // Settings that ride the vault / the kv map.
    expect(JSON.parse(mem.get(`cipherline_home_pins_${USER}`)!)).toEqual(['conv-1']);
    expect(JSON.parse(mem.get(`cipherline_pinned_${USER}`)!)).toEqual({ 'conv-1': ['m1'] });
    expect(JSON.parse(mem.get('cipherline_keybinds')!)).toEqual({ 'toggle-mute': 'ctrl+m' });
    // The one-time migration markers came WITH the blobs they describe, so the
    // restored deliberate Strong / echo-on is not migrated away on next load.
    expect(mem.get(VOICE_DEFAULTS_MIGRATION_KEY)).toBe('1');
    expect(mem.get(KEYBINDS_MIGRATION_KEY)).toBe('1');
    // The listening switches travel, including a deliberate off (owner 2026-10-31).
    expect(mem.get(`cipherline_listening_share_${USER}`)).toBe('1');
    expect(mem.get(`cipherline_listening_watching_${USER}`)).toBe('0');
    expect(mem.get(`cipherline_listening_asked_${USER}`)).toBe('1');
}

async function backupRoundTrip(): Promise<string[]> {
    const plan = await buildBackupPlan(USER, { includeAttachments: false });
    const container = new MemoryContainer();
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
    const opened = await openContainer(memorySource(container.bytes()), PW);
    const ids = opened.index.records.map(r => r.id);
    freshDevice('/machineB/custom-sounds');
    await applyBackupContainer(USER, opened);
    return ids;
}

describe('encrypted backup -> restore on a fresh device', () => {
    it('My Emojis, entrance sound, custom notification sounds, KLIPY refs and settings all arrive', async () => {
        const want = await populateDeviceA();
        const ids = await backupRoundTrip();
        expect(ids.filter(i => i.startsWith('emoji:')).sort()).toEqual(want.ids.map(i => `emoji:${i}`).sort());
        expect(ids).toContain('sound:ding.ogg');
        expect(ids).not.toContain('sound:other-account.ogg');
        expect(ids.some(i => i.startsWith('gif:'))).toBe(false);
        await assertArrived(want, '/machineB/custom-sounds');
    });

    it('POSITIVE CONTROL: an empty device backs up and restores nothing of these', async () => {
        await backupRoundTrip();
        expect(personalEmojis().load().entries).toEqual([]);
        expect(ownEntranceSound().current()).toBeNull();
        expect(soundFiles.size).toBe(0);
    });
});

describe('device-to-device history transfer -> a newly linked device', () => {
    it('carries the same set inline (the all-in-one vault HistoryRequestModal sends)', async () => {
        const want = await populateDeviceA();
        const blob = await exportLocalHistory(USER, { rangeDays: null });
        const vault = JSON.parse(await blob.text());
        expect(Object.keys(vault.emojiFiles).sort()).toEqual([...want.ids].sort());
        expect(Object.keys(vault.customSounds)).toEqual(['ding.ogg']);
        expect(vault.entranceSound.id).toBe(want.soundId);

        freshDevice('/machineB/custom-sounds');
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        await assertArrived(want, '/machineB/custom-sounds');
    });

    it('bounds: an oversize custom sound is not exported; a bad name / oversize payload is not imported', async () => {
        soundFiles.set('huge.ogg', ogg(1024 * 1024 + 1, 1));
        soundFiles.set('ok.ogg', ogg(10, 1));
        mem.set(`cipherline_notif_global_prefs_${USER}`, JSON.stringify({
            custom_sounds: [{ name: 'huge.ogg', file: 'file:///machineA/custom-sounds/huge.ogg' }, { name: 'ok.ogg', file: 'file:///machineA/custom-sounds/ok.ogg' }],
        }));
        const vault = JSON.parse(await (await exportLocalHistory(USER, { rangeDays: null })).text());
        expect(Object.keys(vault.customSounds)).toEqual(['ok.ogg']);

        freshDevice('/machineB/custom-sounds');
        vault.customSounds = {
            'ok.ogg': vault.customSounds['ok.ogg'],
            '../../evil.ogg': vault.customSounds['ok.ogg'],
            'script.exe': vault.customSounds['ok.ogg'],
            'big.ogg': btoa('x'.repeat(1024 * 1024 + 1)),
        };
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        expect([...soundFiles.keys()]).toEqual(['ok.ogg']);
    });
});

describe('compatibility', () => {
    it('a vault from before My Emojis / customSounds / migration flags restores on this build, leaving local markers alone', async () => {
        mem.set(VOICE_DEFAULTS_MIGRATION_KEY, '1');
        const old = {
            version: 4, userId: USER, deviceId: 'd-old', topics: [], history: { 'conv-1': [{ id: 'm1', timestamp: 1 }] },
            voiceSettings: { noiseSuppressionMode: 'strong' },
            kv: { 'cipherline_home_pins_{uid}': '["conv-1"]' },
        };
        await importLocalHistory(USER, new Blob([JSON.stringify(old)], { type: 'application/json' }));
        expect(mem.get(`cipherline_home_pins_${USER}`)).toBe('["conv-1"]');
        expect(mem.get(VOICE_DEFAULTS_MIGRATION_KEY)).toBe('1');
        expect(personalEmojis().load().entries).toEqual([]);
    });

    it('migration markers follow the blob: false clears the local marker so a pre-migration blob is migrated on next load', async () => {
        mem.set(VOICE_DEFAULTS_MIGRATION_KEY, '1');
        mem.set(KEYBINDS_MIGRATION_KEY, '1');
        const v = {
            version: 4, userId: USER, deviceId: 'd', topics: [], history: {},
            voiceSettings: { noiseSuppressionMode: 'strong' }, voiceDefaultsMigrated: false,
            keybinds: { 'toggle-screenshare': 'ctrl+shift+s' }, keybindsMigrated: false,
        };
        await importLocalHistory(USER, new Blob([JSON.stringify(v)], { type: 'application/json' }));
        expect(mem.has(VOICE_DEFAULTS_MIGRATION_KEY)).toBe(false);
        expect(mem.has(KEYBINDS_MIGRATION_KEY)).toBe(false);
    });

    it('a record kind from a NEWER build is skipped, not fatal (everything else restores)', async () => {
        mem.set(`cipherline_home_pins_${USER}`, '["conv-9"]');
        const plan = await buildBackupPlan(USER, { includeAttachments: false });
        const container = new MemoryContainer();
        const writer = await ContainerWriter.create(PW, container);
        await writeBackupRecords(plan, { fresh: writer });
        await writer.addBytes('future:thing', new TextEncoder().encode('{"x":1}'), 'h');
        await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
        const opened = await openContainer(memorySource(container.bytes()), PW);
        expect(opened.index.records.map(r => r.id)).toContain('future:thing');
        freshDevice('/machineB/custom-sounds');
        await applyBackupContainer(USER, opened);
        expect(mem.get(`cipherline_home_pins_${USER}`)).toBe('["conv-9"]');
    });

    it('the account binding still holds: a backup of another account is refused before anything is written', async () => {
        mem.set(`cipherline_home_pins_${USER}`, '["conv-9"]');
        const plan = await buildBackupPlan(USER, { includeAttachments: false });
        const container = new MemoryContainer();
        const writer = await ContainerWriter.create(PW, container);
        await writeBackupRecords(plan, { fresh: writer });
        await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
        const opened = await openContainer(memorySource(container.bytes()), PW);
        freshDevice('/machineB/custom-sounds');
        await expect(applyBackupContainer('someone-else', opened)).rejects.toThrow(/different account/);
        expect(mem.has(`cipherline_home_pins_${USER}`)).toBe(false);
    });

    it('the payload validator accepts the new fields and refuses them with the wrong type', () => {
        const base = { version: 4, userId: USER, deviceId: 'd', topics: [], history: {} };
        expect(classifyHistoryPayload(JSON.stringify({ ...base, customSounds: { 'a.ogg': 'AAAA' }, voiceDefaultsMigrated: true, keybindsMigrated: false }), USER).kind).toBe('desktop');
        for (const bad of [{ customSounds: ['x'] }, { customSounds: { 'a.ogg': 1 } }, { voiceDefaultsMigrated: 'yes' }, { keybindsMigrated: 1 }]) {
            expect(() => classifyHistoryPayload(JSON.stringify({ ...base, ...bad }), USER)).toThrow(HistoryPayloadRefusedError);
        }
    });
});

describe('restore MERGES the keys that only grow', () => {
    const U = 'u1';
    const store = () => {
        const m = new Map<string, string>();
        return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    };

    it('achievements: an older backup cannot roll this device\u2019s counters back', () => {
        const s = store();
        s.m.set(`cipherline_achievements_${U}`, JSON.stringify({ v: 1, devices: { devB: { messages: 50 } }, unlocked: { 'first-call': '2026-10' } }));
        applyIncludedKv(s, { 'cipherline_achievements_{uid}': JSON.stringify({ v: 1, devices: { devA: { messages: 7 }, devB: { messages: 3 } }, unlocked: { chatty: '2026-09' } }) }, U, kvMergerFor);
        const got = JSON.parse(s.m.get(`cipherline_achievements_${U}`)!);
        expect(got.devices.devB.messages).toBe(50);
        expect(got.devices.devA.messages).toBe(7);
        expect(Object.keys(got.unlocked).sort()).toEqual(['chatty', 'first-call']);
    });

    it('private notes: a newer local edit wins, a note only in the backup is added', () => {
        const s = store();
        s.m.set(`cipherline_profile_notes_${U}`, JSON.stringify({ p1: { text: 'new', at: 20 } }));
        applyIncludedKv(s, { 'cipherline_profile_notes_{uid}': JSON.stringify({ p1: { text: 'old', at: 10 }, p2: { text: 'kept', at: 5 } }) }, U, kvMergerFor);
        expect(JSON.parse(s.m.get(`cipherline_profile_notes_${U}`)!)).toEqual({ p1: { text: 'new', at: 20 }, p2: { text: 'kept', at: 5 } });
    });

    it('eggs found union; connected-call count takes the max; plain prefs still overwrite', () => {
        const s = store();
        s.m.set(`cipherline_egg_progress_${U}`, JSON.stringify({ found: ['a'], synced: ['a'], tier: 1, serverCount: 1 }));
        s.m.set(`cipherline_calls_connected_${U}`, '40');
        s.m.set(`cipherline_home_pins_${U}`, '["local"]');
        applyIncludedKv(s, {
            'cipherline_egg_progress_{uid}': JSON.stringify({ found: ['b', 'a'], synced: [], tier: 0, serverCount: 0 }),
            'cipherline_calls_connected_{uid}': '12',
            'cipherline_home_pins_{uid}': '["restored"]',
        }, U, kvMergerFor);
        expect(JSON.parse(s.m.get(`cipherline_egg_progress_${U}`)!)).toEqual({ found: ['a', 'b'], synced: ['a'], tier: 1, serverCount: 1 });
        expect(s.m.get(`cipherline_calls_connected_${U}`)).toBe('40');
        expect(s.m.get(`cipherline_home_pins_${U}`)).toBe('["restored"]');
    });

    it('importLocalHistory applies the vault kv through the mergers', async () => {
        mem.set(`cipherline_calls_connected_${USER}`, '40');
        const v = { version: 4, userId: USER, deviceId: 'd', topics: [], history: {}, kv: { 'cipherline_calls_connected_{uid}': '12' } };
        await importLocalHistory(USER, new Blob([JSON.stringify(v)], { type: 'application/json' }));
        expect(mem.get(`cipherline_calls_connected_${USER}`)).toBe('40');
    });

    it('POSITIVE CONTROL: without a merger the same restore overwrites (what it did before)', () => {
        const s = store();
        s.m.set(`cipherline_calls_connected_${U}`, '40');
        applyIncludedKv(s, { 'cipherline_calls_connected_{uid}': '12' }, U);
        expect(s.m.get(`cipherline_calls_connected_${U}`)).toBe('12');
    });
});

describe('custom notification sounds this account owns', () => {
    it('only files the prefs reference (list or a category), never bundled sounds or junk', () => {
        const prefs = JSON.stringify({
            custom_sounds: [{ name: 'a.ogg', file: 'file:///x/custom-sounds/a.ogg' }, null],
            sounds: { call: { file: 'C:\\Users\\me\\AppData\\custom-sounds\\b.mp3' }, msg: { file: './sounds/ping.ogg' } },
        });
        expect([...referencedCustomSoundNames(prefs)].sort()).toEqual(['a.ogg', 'b.mp3']);
        const listing = ['a.ogg', 'b.mp3', 'c.wav'].map(name => ({ name, file: `file:///y/custom-sounds/${name}` }));
        expect(ownedCustomSounds(listing, prefs).map(s => s.name)).toEqual(['a.ogg', 'b.mp3']);
        expect(ownedCustomSounds(listing, null)).toEqual([]);
        expect(ownedCustomSounds(listing, '{not json')).toEqual([]);
    });
});
