import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * A store that loaded in `partial` mode (some records unreadable — a power loss left
 * two records that read back as "not a record") must still be backed up, must never
 * overwrite a backup that holds what it cannot read, and must leave a trace a report
 * can show. Reported 2026-11-26 from a Windows 0.1.4 tester: "unable to back up".
 *
 * Real secureLocalStore over fake IndexedDB; the damaged record is made the way the
 * field made it (a `null` where the sealed record was). Real runSingleFileBackup /
 * runBackup against an in-memory destination; PBKDF2 at 600k iterations, so slow.
 */
vi.setConfig({ testTimeout: 120_000 });

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

const { buildBackupPlanMock } = vi.hoisted(() => ({ buildBackupPlanMock: vi.fn() }));
vi.mock('./backupRecords', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./backupRecords')>();
    return { ...actual, buildBackupPlan: buildBackupPlanMock };
});
vi.mock('../utils/betaDiagnostics/reporter', () => ({ reportBeta: vi.fn() }));

const { secureLocalStore } = await import('../utils/secureLocalStore');
const { openDb, KV_STORE } = await import('../utils/attachmentCache');
const {
    runSingleFileBackup, runBackup, restoreFromLocalFile, HELD_UNVERIFIABLE_MESSAGE,
} = await import('./driveBackup');
const { backupStoreBlock } = await import('./backupStoreGuard');
const { holdFromUnreadable, mergeHeldMeta } = await import('./backupHold');
const { openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { specsFromVault, splitVaultForRecords, writeBackupRecords, fingerprintFromSpecs } = await import('./backupRecords');
const { backupDiagSettings, recordBackupDiag, classifyBackupError } = await import('../utils/backupDiagnostics');
const { buildSettingsSnapshot } = await import('../utils/diagnostics/settingsSnapshot');
const { buildDiagnosticReport } = await import('../utils/diagnostics/bundle');
const { KvCrypto } = await import('../../electron/kv-crypto');
import type { SingleFileDestination, DestinationSink, WriteMode } from './driveBackup';
import type { BackupPlan } from './backupRecords';

const USER = '66666666-6666-4666-8666-666666666666';
const CONV1 = `cipherline_msgs_${USER}_conv-1`;
const CONV2 = `cipherline_msgs_${USER}_conv-2`;
const TOPICS = `cipherline_convs_${USER}`;
const PW = 'correct horse battery staple';
const FILE = 'cipherline-backup.enc';
const BASE = 'cipherline-backup';

// ── real store, damaged the way the field damaged it ────────────────────────

const KEY = Buffer.from(new Uint8Array(32).fill(7));
function installBridge(): void {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        getLocalMasterKeyStatus: async () => ({ status: 'ok' }),
        secureKvOpen: async (recs: unknown[]) => kv.open(recs as never),
        secureKvSeal: async (recs: unknown[]) => kv.seal(recs as never),
    };
}
async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}
async function boot(): Promise<void> {
    secureLocalStore._resetForTest();
    installBridge();
    await secureLocalStore.hydrate();
    await secureLocalStore.hydrateMessages();
}
/** Overwrite a stored record with `null`: it lists, but reads back as "not a record" (MalformedRecord). */
async function damage(...keys: string[]): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(KV_STORE, 'readwrite');
        for (const k of keys) tx.objectStore(KV_STORE).put(null, k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function onDisk(key: string): Promise<unknown> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** A signed-in account with two conversations on disk, then the power cut: conv-1 and the conversation list damaged. */
async function bootPartial(): Promise<void> {
    await wipeDb();
    await boot();
    secureLocalStore.setItem('cipherline_user_id', USER);
    await secureLocalStore.whenAccountReady();
    secureLocalStore.setItem(TOPICS, '[{"id":"conv-1"},{"id":"conv-2"}]');
    secureLocalStore.setItem(CONV1, '[{"id":"a1"}]');
    secureLocalStore.setItem(CONV2, '[{"id":"b1"}]');
    await secureLocalStore.flushNow();
    await damage(CONV1, TOPICS);
    await boot();
}

// ── an in-memory destination (same contract as the local folder / Drive) ────

function makeDest(label: 'local' | 'drive', seed: Record<string, Uint8Array> = {}) {
    const files = new Map<string, Uint8Array>(Object.entries(seed));
    const dest: SingleFileDestination = {
        label,
        supportsUpdate: label === 'local',
        stat: async (name) => { const f = files.get(name); return f ? { size: f.length } : null; },
        openSink: async (name, mode: WriteMode) => {
            const buf = mode === 'update' ? new MemoryContainer(files.get(name)) : new MemoryContainer();
            const sink: DestinationSink = {
                write: (b) => buf.write(b),
                writeAt: (o, b) => buf.writeAt(o, b),
                commit: async () => { const bytes = buf.bytes(); files.set(name, bytes); return { size: bytes.length }; },
                abort: async () => {},
            };
            return sink;
        },
        openSource: async (name) => { const f = files.get(name); return f ? memorySource(f) : null; },
        verify: async (name, expect) => {
            const f = files.get(name);
            if (!f) throw new Error('missing');
            const c = await openContainer(memorySource(f), expect.password);
            if (c.index.fingerprint !== expect.fingerprint) throw new Error('fingerprint mismatch');
        },
        listFiles: async () => [...files.keys()],
        deleteFiles: async (names) => { for (const n of names) files.delete(n); },
    };
    return { dest, files };
}

const T = (m: number, d: number) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T10:00:00Z`;

/** A plan from vault pieces. `withConv1` false = the export a partial store produces (conv-1 unreadable, so absent). */
async function makePlan(opts: { withConv1: boolean; hold?: boolean; topics?: unknown[] | null; extraB?: boolean }): Promise<BackupPlan> {
    const history: Record<string, unknown[]> = {
        ...(opts.withConv1 ? { 'conv-1': [{ id: 'a1', timestamp: T(1, 5), content: { attachment_id: 'att-1' } }, { id: 'a2', timestamp: T(2, 5) }] } : {}),
        'conv-2': [{ id: 'b1', timestamp: T(1, 6) }, ...(opts.extraB ? [{ id: 'b2', timestamp: T(3, 1) }] : [])],
    };
    const vault = {
        version: 4, userId: USER, deviceId: 'dev',
        topics: opts.topics === null ? [] : (opts.topics ?? [{ id: 'conv-1' }, { id: 'conv-2' }]),
        history, kv: {},
    };
    const { meta, history: h, channelHistory } = splitVaultForRecords(vault as never);
    const records = await specsFromVault({
        meta, history: h, channelHistory, attachmentIds: opts.withConv1 ? ['att-1'] : [],
        loaders: { attachment: async () => new Uint8Array([9, 9, 9]) },
    });
    const hold = opts.hold ? holdFromUnreadable(secureLocalStore.unreadableKeyList(), USER) : undefined;
    return {
        userId: USER, fingerprint: await fingerprintFromSpecs(records), records,
        attachmentIds: opts.withConv1 ? ['att-1'] : [], attachmentSizeHints: {},
        ...(hold ? { hold } : {}),
    };
}

const run = (dests: SingleFileDestination[], plan: BackupPlan, password = PW) =>
    runSingleFileBackup({
        destinations: dests, plan, password, fileName: FILE, basePattern: BASE, lastFingerprints: {},
        writeRecords: (w) => writeBackupRecords(plan, w),
    });

const ids = async (files: Map<string, Uint8Array>) =>
    (await openContainer(memorySource(files.get(FILE)!), PW)).index.records.map(r => r.id).sort();

beforeEach(() => {
    buildBackupPlanMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = undefined;
});

describe('the field state: a store that loaded with two damaged records', () => {
    it('is `partial`, and backups are NOT refused for it (before the fix: backupStoreBlock was "partial" and runBackup threw)', async () => {
        await bootPartial();
        expect(secureLocalStore.loadHealth().status).toBe('partial');
        expect(secureLocalStore.unreadableRecordCount()).toBe(2);
        expect(secureLocalStore.loadHealth().lastFailure?.name).toBe('MalformedRecord');
        expect(backupStoreBlock(USER)).toBeNull();
    });

    it('runBackup goes ahead on it: it reaches the export instead of refusing first', async () => {
        await bootPartial();
        const reached = new Error('reached the export');
        buildBackupPlanMock.mockRejectedValue(reached);
        await expect(runBackup({ userId: USER, token: 't', password: PW, destinations: { localDir: '/backups' } })).rejects.toBe(reached);
        expect(buildBackupPlanMock).toHaveBeenCalledTimes(1);
    });
});

describe('holdFromUnreadable — what a damaged store key means for the backup', () => {
    it('maps a thread, a vault field, an included setting and a foreign record', () => {
        const hold = holdFromUnreadable([
            CONV1, `cipherline_channel_msgs_${USER}_chan-9`, TOPICS,
            `cipherline_notif_global_prefs_${USER}`,
            'cipherline_game_art_v1',
            `cipherline_convs_77777777-7777-4777-8777-777777777777`,
        ], USER)!;
        expect(hold.recordPrefixes).toEqual(['ch:chan-9:', 'dm:conv-1:']);
        expect(hold.metaFields).toEqual(['topics']);
        expect(hold.kvKeys).toEqual(['cipherline_notif_global_prefs_{uid}']);
        expect(hold.fillMissing).toBe(false);
        expect(hold.count).toBe(6);
    });

    it('returns nothing when no key touches the backup, and fills missing fields for a key it cannot place', () => {
        expect(holdFromUnreadable(['cipherline_game_art_v1'], USER)).toBeUndefined();
        expect(holdFromUnreadable([], USER)).toBeUndefined();
        expect(holdFromUnreadable(['some_future_key_that_nothing_knows'], USER)?.fillMissing).toBe(true);
    });

    it('mergeHeldMeta takes only what could not be read', () => {
        const hold = holdFromUnreadable([TOPICS, `cipherline_notif_prefs_${USER}`], USER)!;
        const merged = mergeHeldMeta(
            { topics: [], voiceSettings: { v: 2 }, kv: { a: 'new', 'cipherline_notif_prefs_{uid}': 'EMPTY' } },
            { topics: [{ id: 'conv-1' }], voiceSettings: { v: 1 }, kv: { a: 'old', 'cipherline_notif_prefs_{uid}': 'OLD' } },
            hold,
        );
        expect(merged).toEqual({ topics: [{ id: 'conv-1' }], voiceSettings: { v: 2 }, kv: { a: 'new', 'cipherline_notif_prefs_{uid}': 'OLD' } });
    });
});

describe('the backup writer keeps what the store could not read', () => {
    it('control (the old behaviour): an export without conv-1 DROPS conv-1 from the only backup', async () => {
        await bootPartial();
        const { dest, files } = makeDest('local');
        await run([dest], await makePlan({ withConv1: true }));
        expect(await ids(files)).toContain('dm:conv-1:2026-01');
        // Same destination, next run: the store lost conv-1, no hold.
        await run([dest], await makePlan({ withConv1: false, extraB: true }));
        const after = await ids(files);
        expect(after.some(i => i.startsWith('dm:conv-1:'))).toBe(false);
        expect(after).not.toContain('att:att-1');
    });

    it('with the hold: conv-1 (its months and its attachment) and the conversation list survive, new conv-2 messages are backed up', async () => {
        await bootPartial();
        const { dest, files } = makeDest('local');
        await run([dest], await makePlan({ withConv1: true }));
        const res = await run([dest], await makePlan({ withConv1: false, hold: true, extraB: true, topics: [] }));
        expect(res.results.local?.skipped).toBe(false);
        expect(res.results.local?.mode).toBe('update');
        expect(res.held).toEqual({ unreadable: 2, kept: 3, lost: 0 }); // 2 months + 1 attachment
        const c = await openContainer(memorySource(files.get(FILE)!), PW);
        const after = c.index.records.map(r => r.id).sort();
        expect(after).toEqual(['att:att-1', 'dm:conv-1:2026-01', 'dm:conv-1:2026-02', 'dm:conv-2:2026-01', 'dm:conv-2:2026-03', 'meta']);
        expect(await c.readJson('dm:conv-1:2026-02')).toEqual([{ id: 'a2', timestamp: T(2, 5) }]);
        // conv-2's new message is in; the conversation list is the previous backup's, not the empty stand-in.
        expect(await c.readJson('dm:conv-2:2026-03')).toEqual([{ id: 'b2', timestamp: T(3, 1) }]);
        expect(((await c.readJson('meta')) as { topics: unknown[] }).topics).toEqual([{ id: 'conv-1' }, { id: 'conv-2' }]);
    });

    it('a fresh destination (Drive) takes the held records from the file already there', async () => {
        await bootPartial();
        const first = makeDest('drive');
        await run([first.dest], await makePlan({ withConv1: true }));
        const second = makeDest('drive', Object.fromEntries(first.files));
        const res = await run([second.dest], await makePlan({ withConv1: false, hold: true, extraB: true }));
        expect(res.results.drive?.mode).toBe('fresh');
        expect(res.held?.kept).toBe(3);
        expect(await ids(second.files)).toEqual(['att:att-1', 'dm:conv-1:2026-01', 'dm:conv-1:2026-02', 'dm:conv-2:2026-01', 'dm:conv-2:2026-03', 'meta']);
    });

    it('a backup it cannot open (another passphrase) is NOT replaced while a hold is in force; without one it is, as before', async () => {
        await bootPartial();
        const { dest, files } = makeDest('local');
        await run([dest], await makePlan({ withConv1: true }), 'a different passphrase entirely');
        const before = files.get(FILE)!.slice();
        const err = await run([dest], await makePlan({ withConv1: false, hold: true, extraB: true })).catch(e => e);
        expect(err.message).toBe(HELD_UNVERIFIABLE_MESSAGE);
        expect(files.get(FILE)).toEqual(before);
        // Healthy store, same file: replaced (unchanged behaviour).
        const ok = await run([dest], await makePlan({ withConv1: true, extraB: true }));
        expect(ok.results.local?.skipped).toBe(false);
    });

    it('a first backup (no file there yet) goes ahead, holding nothing', async () => {
        await bootPartial();
        const { dest, files } = makeDest('local');
        const res = await run([dest], await makePlan({ withConv1: false, hold: true }));
        expect(res.results.local?.skipped).toBe(false);
        expect(res.held).toEqual({ unreadable: 2, kept: 0, lost: 0 });
        expect(await ids(files)).toEqual(['dm:conv-2:2026-01', 'meta']);
    });
});

describe('restore on a partial store', () => {
    it('before the fix a restore wrote over a held key in memory only: gone after the restart. Now it asks first, and removing the damaged records lets the restore persist', async () => {
        await bootPartial();
        // The backup (made earlier, healthy) holds conv-1.
        const { dest, files } = makeDest('local');
        await run([dest], await makePlan({ withConv1: true }));
        const bytes = files.get(FILE)!;
        // Control: a held key is not written to disk.
        secureLocalStore.setItem(CONV1, '[{"id":"stand-in"}]');
        await secureLocalStore.flushNow();
        expect(await onDisk(CONV1)).toBeNull();

        // The restore's own confirm gate: declining changes nothing.
        let asked = 0;
        const declined = await restoreFromLocalFile({
            userId: USER, password: PW, file: new Blob([bytes as BlobPart]), beforeApply: () => { asked++; return false; },
        });
        expect(declined.restored).toBe(false);
        expect(asked).toBe(1);
        expect(secureLocalStore.unreadableRecordCount()).toBe(2);

        // Accepting: the damaged records are removed first, then the restore lands on disk.
        const done = await restoreFromLocalFile({
            userId: USER, password: PW, file: new Blob([bytes as BlobPart]),
            beforeApply: async () => { await secureLocalStore.discardUnreadableRecords(); return true; },
        });
        expect(done.restored).toBe(true);
        expect(secureLocalStore.unreadableRecordCount()).toBe(0);
        await secureLocalStore.flushNow();
        await boot();
        expect(secureLocalStore.loadHealth().status).toBe('ok');
        expect(JSON.parse(secureLocalStore.getItem(CONV1) ?? 'null')).toEqual([
            { id: 'a1', timestamp: T(1, 5), content: { attachment_id: 'att-1' } }, { id: 'a2', timestamp: T(2, 5) },
        ]);
    });

    it('a restore that fails says where, and the report carries it', async () => {
        await bootPartial();
        const err = await restoreFromLocalFile({ userId: USER, password: PW, file: new Blob([new Uint8Array(64)]) }).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        const s = backupDiagSettings();
        expect(s.restore_last_ok).toBe(false);
        expect(typeof s.restore_last_step).toBe('string');
        expect(typeof s.restore_last_error).toBe('string');
        expect(typeof s.restore_last_reason).toBe('string');
    });
});

describe('discardUnreadableRecords', () => {
    it('removes exactly the damaged records, nothing readable, and refuses on a failed load', async () => {
        await bootPartial();
        expect(await secureLocalStore.discardUnreadableRecords()).toBe(2);
        expect(await onDisk(CONV1)).toBeUndefined();
        expect(await onDisk(TOPICS)).toBeUndefined();
        expect(await onDisk(CONV2)).toBeTruthy();
        expect(secureLocalStore.unreadableRecordCount()).toBe(0);
        expect(secureLocalStore.loadHealth().status).toBe('ok');
        // Writes to the freed key now reach disk.
        secureLocalStore.setItem(CONV1, '[{"id":"new"}]');
        await secureLocalStore.flushNow();
        expect(await onDisk(CONV1)).toBeTruthy();
    });
});

describe('diagnostics: the report says what the last backup / restore did', () => {
    it('classifyBackupError reduces an error to labels (no message, no path)', () => {
        const e = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\Dawson Kraai\\Backups\\x.enc'"), { name: 'Error' });
        expect(classifyBackupError(e)).toEqual({ error: 'Error', reason: 'fs_not_found' });
        expect(classifyBackupError(Object.assign(new Error('x'), { name: 'BackupWrongPasswordError' }))).toEqual({ error: 'BackupWrongPasswordError', reason: 'wrong_password' });
        expect(classifyBackupError(Object.assign(new Error('This backup belongs to a different account — refusing to restore.'), { name: 'Error' })).reason).toBe('wrong_account');
    });

    it('a failed backup is recorded with its step and error type and appears in every report category, without the path', () => {
        recordBackupDiag('backup', { ok: false, step: 'write', err: new Error("EACCES: permission denied, open 'C:\\Users\\Dawson Kraai\\Backups\\x.enc'"), dest: 'local', held: 2, at: 1_000_000 });
        const settings = backupDiagSettings(1_000_000 + 3 * 3_600_000);
        expect(settings).toMatchObject({
            backup_last_ok: false, backup_last_step: 'write', backup_last_error: 'Error', backup_last_reason: 'fs_access',
            backup_last_dest: 'local', backup_last_held: 2, backup_last_age_h: 3,
        });
        for (const category of ['other', 'crash', 'performance'] as const) {
            const { body } = buildDiagnosticReport({
                category, trigger: 'manual', now: 1_000_000 + 3 * 3_600_000,
                system: { app_version: '0.1.4', build_commit: 'fa1466f', channel: 'stable', electron: '43.8.7', chrome: '150.0.7871.250', node: '24.22.1', platform: 'win32', os_version: '10.0.22000', arch: 'x64', cpu_model: 'x', cpu_cores: 4, ram_gb: 8, gpu: { devices: [], feature_status: {} }, displays: [], hardware_acceleration: true, uptime_s: 100 },
                settings: buildSettingsSnapshot({ backup: settings }),
                scrub: { sensitiveTerms: ['Dawson Kraai'], homeDir: 'C:\\Users\\Dawson Kraai' },
            });
            expect(body.payload.settings).toMatchObject({ backup_last_step: 'write', backup_last_reason: 'fs_access', backup_last_ok: false });
            expect(JSON.stringify(body)).not.toMatch(/Dawson|Backups|x\.enc/);
        }
    });

    it('a guard refusal is recorded too (it used to leave no trace)', async () => {
        await wipeDb();
        await boot();
        // Not signed in / account not ready: the guard refuses.
        await expect(runBackup({ userId: USER, token: 't', password: PW, destinations: { localDir: '/x' } })).rejects.toMatchObject({ name: 'BackupStoreUnreadableError' });
        expect(backupDiagSettings()).toMatchObject({ backup_last_ok: false, backup_last_step: 'guard', backup_last_error: 'BackupStoreUnreadableError', backup_last_reason: 'not-ready' });
    });
});
