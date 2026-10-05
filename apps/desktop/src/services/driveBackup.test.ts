import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Every run derives a real PBKDF2 key at 600k iterations (once to write, once
// to verify each destination) — sequential runs genuinely take a few seconds.
vi.setConfig({ testTimeout: 60_000 });

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined });
});

// runBackup()'s stale-Drive-folder-recovery tests below mock out the vault
// export (buildBackupPlan) so they can exercise the REAL folder-resolution +
// runSingleFileBackup + Drive-REST-wiring path without needing a hydrated
// secureLocalStore/messageStore — see the "stale Drive folder recovery"
// describe block. Everything else backupRecords exports stays real.
const { buildBackupPlanMock } = vi.hoisted(() => ({ buildBackupPlanMock: vi.fn() }));
vi.mock('./backupRecords', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./backupRecords')>();
    return { ...actual, buildBackupPlan: buildBackupPlanMock };
});

const {
    runSingleFileBackup, isLegacyChunkedFile, backupFileName, manifestBasePattern, selectLatestManifest,
    runBackup, resolveDriveFolder, getDriveBackupInfo, restoreFromDrive, openBackupFile,
} = await import('./driveBackup');
const { encryptBackup, decryptBackup } = await import('../utils/crypto');
const { openContainer, MemoryContainer, memorySource, HEADER_LEN, CONTAINER_VERSION } = await import('../utils/backupContainer');
// The v3 writer exactly as shipped, to seed a destination with a legacy file.
const { ContainerWriterV3, MemoryContainerV3 } = await import('../utils/__fixtures__/backupContainerV3');
const { fingerprintPlan, splitVaultForRecords, specsFromVault, writeBackupRecords, bucketByMonth, monthBucket } = await import('./backupRecords');
import type { SingleFileDestination, DestinationSink, WriteMode, DriveManifestFile } from './driveBackup';
import type { BackupPlan } from './backupRecords';

/** In-memory fake destination — same contract the real local/Drive
 *  destinations implement, with zero IPC/network. Supports both write modes
 *  so the in-place update path is exercised for real. */
function makeFakeDestination(label: 'local' | 'drive', seed: Record<string, Uint8Array> = {}) {
    const files = new Map<string, Uint8Array>(Object.entries(seed));
    const log: string[] = [];
    let corruptNextCommit = false;

    const dest: SingleFileDestination = {
        label,
        supportsUpdate: label === 'local',
        stat: async (name) => { const f = files.get(name); return f ? { size: f.length } : null; },
        openSink: async (name, mode: WriteMode) => {
            const buf = mode === 'update' ? new MemoryContainer(files.get(name)) : new MemoryContainer();
            const sink: DestinationSink = {
                write: (b) => buf.write(b),
                writeAt: (o, b) => buf.writeAt(o, b),
                commit: async () => {
                    const bytes = buf.bytes();
                    if (corruptNextCommit) { bytes[bytes.length - 20] ^= 0xff; corruptNextCommit = false; }
                    files.set(name, bytes);
                    log.push(`commit:${mode}:${name}`);
                    return { size: bytes.length };
                },
                abort: async () => { log.push(`abort:${mode}:${name}`); },
            };
            return sink;
        },
        openSource: async (name) => { const f = files.get(name); return f ? memorySource(f) : null; },
        verify: async (name, expect) => {
            const f = files.get(name);
            if (!f) throw new Error('missing');
            const c = await openContainer(memorySource(f), expect.password);
            if (c.index.fingerprint !== expect.fingerprint) throw new Error('fingerprint mismatch');
            log.push(`verify:${name}`);
        },
        listFiles: async () => [...files.keys()],
        deleteFiles: async (names) => { for (const n of names) { files.delete(n); log.push(`delete:${n}`); } },
    };
    return { dest, files, log, corruptNext: () => { corruptNextCommit = true; } };
}

const JAN = (i: number) => `2026-01-${String(10 + i).padStart(2, '0')}T10:00:00Z`;
const FEB = (i: number) => `2026-02-${String(10 + i).padStart(2, '0')}T10:00:00Z`;

async function makePlan(overrides: {
    history?: Record<string, unknown[]>;
    attachmentIds?: string[];
    attachmentBytes?: Record<string, Uint8Array | null>;
} = {}): Promise<BackupPlan> {
    const vault = {
        version: 4, userId: 'user-1', deviceId: 'device-1', privateKey: 'priv', publicKey: 'pub',
        topics: [{ id: 'conv-a', type: 'dm' }],
        history: overrides.history ?? {
            'conv-a': [{ id: 'm1', text: 'hi', timestamp: JAN(1) }, { id: 'm2', text: 'feb', timestamp: FEB(1) }],
        },
    };
    const { meta, history, channelHistory } = splitVaultForRecords(vault as unknown as Parameters<typeof splitVaultForRecords>[0]);
    const attachmentIds = overrides.attachmentIds ?? [];
    const records = await specsFromVault({
        meta, history, channelHistory, attachmentIds,
        loaders: { attachment: async (id) => overrides.attachmentBytes?.[id] ?? new Uint8Array([1, 2, 3]) },
    });
    return {
        userId: 'user-1',
        fingerprint: await fingerprintPlan({ meta, history, channelHistory, gifIds: [], attachmentIds }),
        records,
        attachmentIds,
        attachmentSizeHints: {},
    };
}

const FILE = 'cipherline-backup.enc';
const BASE = 'cipherline-backup';
const run = (dests: SingleFileDestination[], plan: BackupPlan, last: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    runSingleFileBackup({
        destinations: dests, plan, password: 'pw', fileName: FILE, basePattern: BASE,
        lastFingerprints: last, writeRecords: (w) => writeBackupRecords(plan, w), ...extra,
    });

describe('runSingleFileBackup — first write', () => {
    it('writes exactly one file, which reopens with the passphrase and holds every record (month-bucketed)', async () => {
        const { dest, files, log } = makeFakeDestination('local');
        const plan = await makePlan();
        const { results } = await run([dest], plan);
        expect(results.local?.skipped).toBe(false);
        expect(results.local?.mode).toBe('fresh');
        expect([...files.keys()]).toEqual([FILE]);
        expect(log).toEqual([`commit:fresh:${FILE}`, `verify:${FILE}`]);
        const c = await openContainer(memorySource(files.get(FILE)!), 'pw');
        expect(c.index.userId).toBe('user-1');
        expect(c.index.fingerprint).toBe(plan.fingerprint);
        expect(c.index.records.map(r => r.id)).toEqual(['meta', 'dm:conv-a:2026-01', 'dm:conv-a:2026-02']);
        expect(await c.readJson('dm:conv-a:2026-02')).toEqual([{ id: 'm2', text: 'feb', timestamp: FEB(1) }]);
    });

    it('skips a destination whose file already holds this fingerprint — no write, no commit', async () => {
        const { dest, files, log } = makeFakeDestination('local');
        const plan = await makePlan();
        await run([dest], plan);
        const before = files.get(FILE)!;
        const { results } = await run([dest], plan, { local: plan.fingerprint });
        expect(results.local?.skipped).toBe(true);
        expect(files.get(FILE)).toBe(before);
        expect(log.filter(l => l.startsWith('commit')).length).toBe(1);
    });

    it('does NOT skip when the fingerprint matches but the file is gone (user deleted it)', async () => {
        const { dest, files } = makeFakeDestination('local');
        const plan = await makePlan();
        const { results } = await run([dest], plan, { local: plan.fingerprint });
        expect(results.local?.skipped).toBe(false);
        expect(files.has(FILE)).toBe(true);
    });
});

describe('runSingleFileBackup — in-place update (the point of the format)', () => {
    it('a new message appends only that month’s record + index; every other byte of the file is untouched', async () => {
        const { dest, files, log } = makeFakeDestination('local');
        const plan1 = await makePlan();
        await run([dest], plan1);
        const before = files.get(FILE)!;
        const c1 = await openContainer(memorySource(before), 'pw');

        const plan2 = await makePlan({
            history: {
                'conv-a': [
                    { id: 'm1', text: 'hi', timestamp: JAN(1) },
                    { id: 'm2', text: 'feb', timestamp: FEB(1) },
                    { id: 'm3', text: 'new in feb', timestamp: FEB(2) },
                ],
            },
        });
        const { results, attachments } = await run([dest], plan2, { local: plan1.fingerprint });
        const after = files.get(FILE)!;
        const c2 = await openContainer(memorySource(after), 'pw');

        expect(results.local?.mode).toBe('update');
        expect(log.at(-2)).toBe(`commit:update:${FILE}`);
        expect(attachments?.updatedRecords).toBe(1);        // dm:conv-a:2026-02 only
        expect(attachments?.carriedRecords).toBe(2);        // meta + dm:conv-a:2026-01
        // Old bytes intact (except the 12-byte pointer in the header).
        expect(after.length).toBeGreaterThan(before.length);
        expect(Array.from(after.slice(HEADER_LEN, before.length))).toEqual(Array.from(before.slice(HEADER_LEN)));
        // The write was small: roughly one record + one index.
        const febRec = c2.index.records.find(r => r.id === 'dm:conv-a:2026-02')!;
        expect(results.local?.bytesWritten).toBe(after.length - before.length);
        expect(results.local!.bytesWritten).toBeLessThan(febRec.len + 1024);
        // Unchanged records: same offsets as before.
        expect(c2.index.records.find(r => r.id === 'meta')).toEqual(c1.index.records.find(r => r.id === 'meta'));
        expect(c2.index.records.find(r => r.id === 'dm:conv-a:2026-01')).toEqual(c1.index.records.find(r => r.id === 'dm:conv-a:2026-01'));
        expect(c2.index.generation).toBe(2);
        expect(c2.index.fingerprint).toBe(plan2.fingerprint);
        expect(await c2.readJson('dm:conv-a:2026-02')).toHaveLength(2);
        expect(await c2.readJson('dm:conv-a:2026-01')).toEqual([{ id: 'm1', text: 'hi', timestamp: JAN(1) }]);
        // Dead space = the superseded feb record + the old index.
        expect(results.local?.deadBytes).toBe(c2.deadBytes);
        expect(c2.deadBytes).toBeGreaterThan(0);
    });

    it('a blob already in the file is never re-read or rewritten', async () => {
        const { dest, files } = makeFakeDestination('local');
        let loads = 0;
        const plan1 = await makePlan({ attachmentIds: ['att-1'] });
        await run([dest], plan1);
        const plan2 = await makePlan({ attachmentIds: ['att-1'] });
        plan2.records = plan2.records.map(r => r.id === 'att:att-1' ? { ...r, load: async () => { loads++; return new Uint8Array([1, 2, 3]); } } : r);
        // Force a change elsewhere so the run isn't skipped.
        plan2.fingerprint = 'different';
        const { results, attachments } = await run([dest], plan2, { local: plan1.fingerprint });
        expect(results.local?.mode).toBe('update');
        expect(loads).toBe(0);
        expect(attachments?.updatedRecords).toBe(0);
        const c = await openContainer(memorySource(files.get(FILE)!), 'pw');
        expect(Array.from(await c.readBytes('att:att-1'))).toEqual([1, 2, 3]);
    });

    it('a deleted conversation is dropped from the index without rewriting anything else', async () => {
        const { dest, files } = makeFakeDestination('local');
        const plan1 = await makePlan({ history: { 'conv-a': [{ id: 'm1', timestamp: JAN(1) }], 'conv-b': [{ id: 'x', timestamp: JAN(1) }] } });
        await run([dest], plan1);
        const before = files.get(FILE)!;
        const plan2 = await makePlan({ history: { 'conv-a': [{ id: 'm1', timestamp: JAN(1) }] } });
        const { results, attachments } = await run([dest], plan2, { local: plan1.fingerprint });
        expect(results.local?.mode).toBe('update');
        expect(attachments?.updatedRecords).toBe(0);
        const c = await openContainer(memorySource(files.get(FILE)!), 'pw');
        expect(c.has('dm:conv-b:2026-01')).toBe(false);
        expect(c.has('dm:conv-a:2026-01')).toBe(true);
        expect(Array.from(files.get(FILE)!.slice(HEADER_LEN, before.length))).toEqual(Array.from(before.slice(HEADER_LEN)));
    });

    it('compacts with a fresh rewrite once dead space passes the threshold', async () => {
        const { dest, files, log } = makeFakeDestination('local');
        const big = (n: number) => [{ id: 'm', text: 'x'.repeat(2000), n, timestamp: JAN(1) }];
        const p1 = await makePlan({ history: { 'conv-a': big(1) } });
        await run([dest], p1);
        const p2 = await makePlan({ history: { 'conv-a': big(2) } });
        const r2 = await run([dest], p2, { local: p1.fingerprint });
        expect(r2.results.local?.mode).toBe('update');
        const grown = files.get(FILE)!.length;
        // ~half the file is now the superseded record → over 0.3 → compaction.
        const p3 = await makePlan({ history: { 'conv-a': big(3) } });
        const r3 = await run([dest], p3, { local: p2.fingerprint });
        expect(r3.results.local?.mode).toBe('fresh');
        expect(log.at(-2)).toBe(`commit:fresh:${FILE}`);
        expect(files.get(FILE)!.length).toBeLessThan(grown);
        expect(r3.results.local?.deadBytes).toBe(0);
        expect((await openContainer(memorySource(files.get(FILE)!), 'pw')).index.generation).toBe(1);
    });

    it('a changed passphrase rewrites the file instead of appending under the old key', async () => {
        const { dest, files } = makeFakeDestination('local');
        const plan = await makePlan();
        await runSingleFileBackup({ destinations: [dest], plan, password: 'old', fileName: FILE, basePattern: BASE, lastFingerprints: {}, writeRecords: (w) => writeBackupRecords(plan, w) });
        const plan2 = await makePlan({ history: { 'conv-a': [{ id: 'm1', text: 'edited', timestamp: JAN(1) }] } });
        const { results } = await runSingleFileBackup({ destinations: [dest], plan: plan2, password: 'new', fileName: FILE, basePattern: BASE, lastFingerprints: {}, writeRecords: (w) => writeBackupRecords(plan2, w) });
        expect(results.local?.mode).toBe('fresh');
        await expect(openContainer(memorySource(files.get(FILE)!), 'old')).rejects.toThrow();
        expect((await openContainer(memorySource(files.get(FILE)!), 'new')).index.fingerprint).toBe(plan2.fingerprint);
    });

    it('local updates in place while Drive gets a fresh full copy in the same pass', async () => {
        const local = makeFakeDestination('local');
        const drive = makeFakeDestination('drive');
        const plan1 = await makePlan();
        await run([local.dest, drive.dest], plan1);
        expect(local.log[0]).toBe(`commit:fresh:${FILE}`);
        expect(drive.log[0]).toBe(`commit:fresh:${FILE}`);

        const plan2 = await makePlan({ history: { 'conv-a': [{ id: 'm1', text: 'hi', timestamp: JAN(1) }, { id: 'm2', text: 'feb', timestamp: FEB(1) }, { id: 'm3', timestamp: FEB(3) }] } });
        const { results } = await run([local.dest, drive.dest], plan2, { local: plan1.fingerprint, drive: plan1.fingerprint });
        expect(results.local?.mode).toBe('update');
        expect(results.drive?.mode).toBe('fresh');
        const cl = await openContainer(memorySource(local.files.get(FILE)!), 'pw');
        const cd = await openContainer(memorySource(drive.files.get(FILE)!), 'pw');
        expect(cl.index.fingerprint).toBe(plan2.fingerprint);
        expect(cd.index.fingerprint).toBe(plan2.fingerprint);
        expect(cd.deadBytes).toBe(0);
        expect(await cd.readJson('dm:conv-a:2026-02')).toEqual(await cl.readJson('dm:conv-a:2026-02'));
        // Both files share one salt this run (same key derivation).
        expect(Array.from(local.files.get(FILE)!.slice(4, 20))).toEqual(Array.from(drive.files.get(FILE)!.slice(4, 20)));
    });
});

describe('runSingleFileBackup — safety', () => {
    it('removes chunked-era files ONLY after the new file verifies, and leaves unrelated files alone', async () => {
        const legacy = {
            'cipherline-backup-2026-08-01.enc': new Uint8Array([1]),
            'cipherline-backup-2026-08-02.enc': new Uint8Array([2]),
            [`chunk-${'a'.repeat(64)}.enc`]: new Uint8Array([3]),
            'other-backup-2026-08-01.enc': new Uint8Array([4]),
            'notes.txt': new Uint8Array([5]),
        };
        const { dest, files, log } = makeFakeDestination('local', legacy);
        const plan = await makePlan();
        const { results } = await run([dest], plan);
        expect(results.local?.legacyFilesRemoved).toBe(3);
        expect([...files.keys()].sort()).toEqual([FILE, 'notes.txt', 'other-backup-2026-08-01.enc'].sort());
        expect(log.indexOf(`commit:fresh:${FILE}`)).toBeLessThan(log.findIndex(l => l.startsWith('delete:')));
    });

    it('fails loudly and keeps legacy files when the written file does not verify', async () => {
        const { dest, files, corruptNext } = makeFakeDestination('local', { 'cipherline-backup-2026-08-01.enc': new Uint8Array([1]) });
        corruptNext();
        const plan = await makePlan();
        await expect(run([dest], plan)).rejects.toThrow();
        expect(files.has('cipherline-backup-2026-08-01.enc')).toBe(true);
    });

    it('aborts every open sink (no commits) when producing records throws', async () => {
        const local = makeFakeDestination('local');
        const drive = makeFakeDestination('drive');
        const plan = await makePlan();
        await expect(runSingleFileBackup({
            destinations: [local.dest, drive.dest], plan, password: 'pw', fileName: FILE, basePattern: BASE,
            lastFingerprints: {}, writeRecords: async () => { throw new Error('IndexedDB exploded'); },
        })).rejects.toThrow(/exploded/);
        expect(local.log).toEqual([`abort:fresh:${FILE}`]);
        expect(drive.log).toEqual([`abort:fresh:${FILE}`]);
        expect(local.files.size).toBe(0);
    });

    it('an aborted in-place update leaves the previous generation readable', async () => {
        const { dest, files } = makeFakeDestination('local');
        const plan1 = await makePlan();
        await run([dest], plan1);
        const plan2 = await makePlan({ history: { 'conv-a': [{ id: 'm1', text: 'edited', timestamp: JAN(1) }] } });
        await expect(runSingleFileBackup({
            destinations: [dest], plan: plan2, password: 'pw', fileName: FILE, basePattern: BASE,
            lastFingerprints: {}, writeRecords: async () => { throw new Error('boom'); },
        })).rejects.toThrow(/boom/);
        expect((await openContainer(memorySource(files.get(FILE)!), 'pw')).index.fingerprint).toBe(plan1.fingerprint);
    });
});

describe('runSingleFileBackup — destination failure isolation', () => {
    it('a Drive `stat` failure (e.g. a 403/SCOPE_MISSING while checking for an existing file) does not stop the local backup from being attempted and succeeding', async () => {
        const { dest: localDest, files: localFiles, log: localLog } = makeFakeDestination('local');
        const driveDest: SingleFileDestination = {
            label: 'drive',
            supportsUpdate: false,
            stat: async () => { throw new Error('Drive query failed: 403'); },
            openSink: async () => { throw new Error('must not be reached — drive failed before any write attempt'); },
            openSource: async () => null,
            verify: async () => {},
            listFiles: async () => [],
            deleteFiles: async () => {},
        };
        const plan = await makePlan();
        const { results, errors } = await run([localDest, driveDest], plan);

        // Local ran to completion, untouched by Drive's failure.
        expect(results.local?.skipped).toBe(false);
        expect(localLog).toEqual([`commit:fresh:${FILE}`, `verify:${FILE}`]);
        expect(localFiles.has(FILE)).toBe(true);
        const c = await openContainer(memorySource(localFiles.get(FILE)!), 'pw');
        expect(c.index.fingerprint).toBe(plan.fingerprint);

        // Drive's failure is reported, not silently swallowed — and not
        // conflated with a local failure.
        expect(results.drive).toBeUndefined();
        expect(errors?.drive).toMatch(/403/);
        expect(errors?.local).toBeUndefined();
    });

    it('a Drive upload failure during commit (auth expired / network down / 403) does not stop the local backup from completing', async () => {
        const { dest: localDest, files: localFiles } = makeFakeDestination('local');
        const drive = makeFakeDestination('drive');
        const realOpenSink = drive.dest.openSink;
        // Simulate the real driveDestination(): openSink only stages locally
        // (never fails for auth/network reasons); the Drive REST call happens
        // inside commit() — see driveBackup.ts's driveDestination().
        drive.dest.openSink = async (name, mode) => {
            const sink = await realOpenSink(name, mode);
            return { ...sink, commit: async () => { throw new Error('Drive upload failed: HTTP 403 SCOPE_MISSING'); } };
        };

        const plan = await makePlan();
        const { results, errors } = await run([localDest, drive.dest], plan);

        expect(results.local?.skipped).toBe(false);
        expect(localFiles.has(FILE)).toBe(true);
        const c = await openContainer(memorySource(localFiles.get(FILE)!), 'pw');
        expect(c.index.fingerprint).toBe(plan.fingerprint);

        expect(results.drive).toBeUndefined();
        expect(errors?.drive).toMatch(/SCOPE_MISSING/);
        // commit() itself threw (never produced a committed file), so the
        // sink is aborted — never verified, never left half-committed.
        expect(drive.log).toEqual([`abort:fresh:${FILE}`]);
    });

    it('a local disk failure during commit does not stop a Drive upload from completing', async () => {
        const local = makeFakeDestination('local');
        const realOpenSink = local.dest.openSink;
        local.dest.openSink = async (name, mode) => {
            const sink = await realOpenSink(name, mode);
            return { ...sink, commit: async () => { throw new Error('ENOSPC: no space left on device'); } };
        };
        const { dest: driveDest, files: driveFiles } = makeFakeDestination('drive');

        const plan = await makePlan();
        const { results, errors } = await run([local.dest, driveDest], plan);

        expect(results.drive?.skipped).toBe(false);
        expect(driveFiles.has(FILE)).toBe(true);
        expect(results.local).toBeUndefined();
        expect(errors?.local).toMatch(/ENOSPC/);
    });

    it('when every destination fails, the call still rejects (no partial success to report)', async () => {
        const driveDest: SingleFileDestination = {
            label: 'drive',
            supportsUpdate: false,
            stat: async () => { throw new Error('Drive query failed: 403'); },
            openSink: async () => { throw new Error('unreachable'); },
            openSource: async () => null,
            verify: async () => {},
            listFiles: async () => [],
            deleteFiles: async () => {},
        };
        const plan = await makePlan();
        await expect(run([driveDest], plan)).rejects.toThrow(/403/);
    });
});

describe('month bucketing', () => {
    it('buckets by UTC month from timestamp/sent_at/created_at, `na` when absent, preserving order', () => {
        expect(monthBucket({ timestamp: '2026-01-31T23:59:59Z' })).toBe('2026-01');
        expect(monthBucket({ sent_at: Date.UTC(2026, 1, 1) })).toBe('2026-02');
        expect(monthBucket({ created_at: '2025-12-05' })).toBe('2025-12');
        expect(monthBucket({})).toBe('na');
        expect(monthBucket(null)).toBe('na');
        const b = bucketByMonth([{ id: 1, timestamp: JAN(2) }, { id: 2 }, { id: 3, timestamp: JAN(1) }, { id: 4, timestamp: FEB(1) }]);
        expect(Object.keys(b).sort()).toEqual(['2026-01', '2026-02', 'na']);
        expect(b['2026-01'].map((m) => (m as { id: number }).id)).toEqual([1, 3]);
    });
});

describe('fingerprintPlan', () => {
    it('is stable for identical content and insensitive to conversation ordering', async () => {
        const a = await makePlan({ history: { x: [{ id: 1 }], y: [{ id: 2 }] } });
        const b = await makePlan({ history: { y: [{ id: 2 }], x: [{ id: 1 }] } });
        expect(a.fingerprint).toBe(b.fingerprint);
    });
    it('changes when a message, or the attachment set, changes', async () => {
        const base = await makePlan();
        expect((await makePlan({ history: { 'conv-a': [{ id: 'm1', text: 'edited' }] } })).fingerprint).not.toBe(base.fingerprint);
        expect((await makePlan({ attachmentIds: ['att-1'] })).fingerprint).not.toBe(base.fingerprint);
    });
});

describe('filenames', () => {
    it('backupFileName is `<base>.enc` with no date, tolerating a trailing .enc or blank base', () => {
        expect(backupFileName('cipherline-backup-mypc')).toBe('cipherline-backup-mypc.enc');
        expect(backupFileName('cipherline-backup-mypc.enc')).toBe('cipherline-backup-mypc.enc');
        expect(backupFileName('')).toBe('cipherline-backup.enc');
        expect(backupFileName(undefined)).toBe('cipherline-backup.enc');
    });
    it('manifestBasePattern strips .enc and falls back to the default', () => {
        expect(manifestBasePattern(undefined)).toBe('cipherline-backup');
        expect(manifestBasePattern('   ')).toBe('cipherline-backup');
        expect(manifestBasePattern('cipherline-backup.enc')).toBe('cipherline-backup');
        expect(manifestBasePattern('my-backup')).toBe('my-backup');
    });
    it('isLegacyChunkedFile matches dated manifests for the base and chunk files, nothing else', () => {
        expect(isLegacyChunkedFile('cipherline-backup-2026-01-31.enc', 'cipherline-backup')).toBe(true);
        expect(isLegacyChunkedFile(`chunk-${'0'.repeat(64)}.enc`, 'cipherline-backup')).toBe(true);
        expect(isLegacyChunkedFile('cipherline-backup.enc', 'cipherline-backup')).toBe(false);
        expect(isLegacyChunkedFile('cipherline-backup-x-2026-01-31.enc', 'cipherline-backup')).toBe(false);
        expect(isLegacyChunkedFile('chunk-short.enc', 'cipherline-backup')).toBe(false);
        expect(isLegacyChunkedFile('my.backup-2026-01-31.enc', 'my.backup')).toBe(true);
        expect(isLegacyChunkedFile('myXbackup-2026-01-31.enc', 'my.backup')).toBe(false);
    });
    it('HEADER_LEN is what the byte-comparison tests assume', () => {
        // v4: 24 plaintext bytes (magic/flags/salt/iterations) + two 44-byte
        // sealed commit slots. Changing this changes every record offset.
        expect(HEADER_LEN).toBe(112);
    });
});

describe('runSingleFileBackup — a destination still holding a v3 file', () => {
    /** A real v3 container at the destination, written by the shipped v3 code. */
    async function seedV3(): Promise<Uint8Array> {
        const mem = new MemoryContainerV3();
        const w = await ContainerWriterV3.create('pw', mem);
        await w.addJson('meta', { userId: 'user-1' });
        await w.finish({ userId: 'user-1', fingerprint: 'stale-fp' });
        return mem.bytes();
    }

    it('rewrites it fresh rather than updating in place, and the result is a v4 container', async () => {
        const seeded = await seedV3();
        expect(seeded[2]).toBe(3);
        const { dest, files } = makeFakeDestination('local', { [FILE]: seeded });
        const plan = await makePlan();

        const { results } = await run([dest], plan);

        // In-place update would corrupt every record offset: v4's header is
        // 76 bytes longer. The upgrade must go through a full rewrite.
        expect(results.local?.mode).toBe('fresh');
        const written = files.get(FILE)!;
        expect(written[2]).toBe(CONTAINER_VERSION);
        const c = await openContainer(memorySource(written), 'pw');
        expect(c.version).toBe(CONTAINER_VERSION);
        expect(c.index.fingerprint).toBe(plan.fingerprint);
        expect(c.index.records.length).toBeGreaterThan(0);
    });

    it('still reads the v3 file before replacing it (nothing is written blind)', async () => {
        const seeded = await seedV3();
        const c = await openContainer(memorySource(seeded), 'pw');
        expect(c.version).toBe(3);
        expect(await c.readJson('meta')).toEqual({ userId: 'user-1' });
    });

    it('the run after the upgrade goes back to updating in place', async () => {
        const { dest, files } = makeFakeDestination('local', { [FILE]: await seedV3() });
        const plan = await makePlan();
        expect((await run([dest], plan)).results.local?.mode).toBe('fresh');

        const plan2 = await makePlan({ history: { 'conv-a': [{ id: 'm1', text: 'changed', timestamp: JAN(1) }] } });
        const { results } = await run([dest], plan2);
        expect(results.local?.mode).toBe('update');
        const c = await openContainer(memorySource(files.get(FILE)!), 'pw');
        expect(c.index.generation).toBe(2);
        expect(c.index.fingerprint).toBe(plan2.fingerprint);
    });
});

describe('selectLatestManifest (legacy restore fallback)', () => {
    it('picks the newest by modifiedTime among matching manifests, ignoring chunks and other bases', () => {
        const picked = selectLatestManifest([
            { id: 'a', name: 'cipherline-backup-2026-01-01.enc', modifiedTime: '2026-01-01T00:00:00Z' },
            { id: 'b', name: 'cipherline-backup-2026-01-03.enc', modifiedTime: '2026-01-03T00:00:00Z' },
            { id: 'c', name: `chunk-${'f'.repeat(64)}.enc`, modifiedTime: '2026-01-09T00:00:00Z' },
            { id: 'd', name: 'other-2026-01-09.enc', modifiedTime: '2026-01-09T00:00:00Z' },
        ], 'cipherline-backup');
        expect(picked?.id).toBe('b');
        expect(selectLatestManifest([], 'cipherline-backup')).toBeNull();
    });
});

// ── Stale Drive folder recovery ──────────────────────────────────────────
//
// The bug: destinations.driveFolderId (persisted once a user has ever picked
// an explicit Picker folder) was used DIRECTLY by runBackup/getDriveBackupInfo/
// restoreFromDrive with no fallback. Under the narrow `drive.file` OAuth
// scope, a folder the app no longer has standing access to (revoked grant,
// deleted, moved, or simply predates the Picker/scope work) 403s or 404s on
// EVERY future run — a permanent brick. resolveDriveFolder() (used by all
// three) now detects exactly that failure mode and falls back to the default
// app-owned folder instead of failing the whole operation, while any other
// failure (network outage, an expired token) still fails normally.
//
// These tests mock only two seams: `fetch` (the Drive REST calls) and
// `buildBackupPlan` (the vault export, irrelevant to folder resolution) — the
// same boundary the rest of this file already treats as the unit under test
// (runSingleFileBackup + the real Drive-REST wiring). secureLocalStore reads/
// writes inside runBackup (fingerprints, last-backup stamps) already degrade
// to a harmless no-op when unhydrated (see readFingerprints/writeFingerprints
// try/catch), so no IndexedDB setup is needed here either.
describe('stale Drive folder recovery', () => {
    const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
    const STALE_FOLDER_ID = 'stale-folder-abc';
    const DEFAULT_FOLDER_ID = 'default-folder-xyz';
    const DEFAULT_FOLDER_NAME = 'Cipherline Backups';

    function jsonResponse(status: number, body: unknown): Response {
        return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
    }

    /** Router for every Drive REST call runBackup/resolveDriveFolder can make. */
    function makeDriveFetchRouter(opts: {
        accessibleFolderIds: Set<string>;
        accessCheckStatus?: number;
        accessCheckError?: Error;
        defaultFolderExists?: boolean;
        existingFileInFolder?: DriveManifestFile | null;
    }) {
        const {
            accessibleFolderIds, accessCheckStatus = 403, accessCheckError,
            defaultFolderExists = true, existingFileInFolder = null,
        } = opts;
        return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
            const method = (init?.method || 'GET').toUpperCase();
            const accessMatch = url.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\?fields=id,trashed$/);
            if (accessMatch) {
                const id = accessMatch[1];
                if (accessibleFolderIds.has(id)) return jsonResponse(200, { id, trashed: false });
                if (accessCheckError) throw accessCheckError;
                return jsonResponse(accessCheckStatus, {});
            }
            if (method === 'POST' && url === DRIVE_FILES_URL) {
                const body = JSON.parse(init!.body!);
                return jsonResponse(200, { id: DEFAULT_FOLDER_ID, name: body.name });
            }
            if (method === 'DELETE') return jsonResponse(200, {});
            if (url.startsWith(`${DRIVE_FILES_URL}?`)) {
                const decoded = decodeURIComponent(url);
                if (decoded.includes("mimeType='application/vnd.google-apps.folder'")) {
                    // findFolder — the default-folder lookup.
                    return jsonResponse(200, { files: defaultFolderExists ? [{ id: DEFAULT_FOLDER_ID }] : [] });
                }
                if (decoded.includes("name='")) {
                    // findFile — is there already a backup file in this folder?
                    return jsonResponse(200, { files: existingFileInFolder ? [existingFileInFolder] : [] });
                }
                // listDriveFiles — legacy-file cleanup scan.
                return jsonResponse(200, { files: [] });
            }
            throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        });
    }

    function makeDriveElectronApi() {
        return {
            gdriveGetToken: vi.fn(async () => 'drive-token'),
            backupStagingDir: vi.fn(async () => '/staging'),
            backupBeginWrite: vi.fn(async () => ({ sessionId: 'sess-1' })),
            backupAppend: vi.fn(async () => {}),
            backupWriteAt: vi.fn(async () => {}),
            backupCommit: vi.fn(async () => ({ path: '/staging/cipherline-backup.enc', size: 1 })),
            backupAbort: vi.fn(async () => {}),
            gdriveUploadFile: vi.fn(async () => ({ size: 4242 })),
            deleteFile: vi.fn(async () => {}),
        };
    }

    beforeEach(() => {
        buildBackupPlanMock.mockReset();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        Object.assign(window, { electronAPI: undefined });
    });

    describe('resolveDriveFolder (unit)', () => {
        it('uses an explicit folder as-is when it is still accessible', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(['good-id']) }));
            const res = await resolveDriveFolder('tok', 'good-id', DEFAULT_FOLDER_NAME, { create: true });
            expect(res).toEqual({ folderId: 'good-id', recovered: false });
        });

        it('falls back to the default folder (creating it) on a 403 for the explicit folder', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), defaultFolderExists: false }));
            const res = await resolveDriveFolder('tok', STALE_FOLDER_ID, DEFAULT_FOLDER_NAME, { create: true });
            expect(res).toEqual({ folderId: DEFAULT_FOLDER_ID, recovered: true });
        });

        it('falls back on a 404 for the explicit folder too (deleted/moved)', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), accessCheckStatus: 404 }));
            const res = await resolveDriveFolder('tok', STALE_FOLDER_ID, DEFAULT_FOLDER_NAME, { create: true });
            expect(res).toEqual({ folderId: DEFAULT_FOLDER_ID, recovered: true });
        });

        it('with create:false, finds (never creates) the default folder on fallback', async () => {
            const fetchMock = makeDriveFetchRouter({ accessibleFolderIds: new Set() });
            vi.stubGlobal('fetch', fetchMock);
            const res = await resolveDriveFolder('tok', STALE_FOLDER_ID, DEFAULT_FOLDER_NAME, { create: false });
            expect(res).toEqual({ folderId: DEFAULT_FOLDER_ID, recovered: true });
            expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
        });

        it('propagates a network error unchanged — NOT treated as a stale folder', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), accessCheckError: new Error('network down') }));
            await expect(resolveDriveFolder('tok', STALE_FOLDER_ID, DEFAULT_FOLDER_NAME, { create: true }))
                .rejects.toThrow('network down');
        });

        it('propagates a 401 (expired token) unchanged — NOT treated as a stale folder', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), accessCheckStatus: 401 }));
            await expect(resolveDriveFolder('tok', STALE_FOLDER_ID, DEFAULT_FOLDER_NAME, { create: true }))
                .rejects.toThrow('401');
        });
    });

    describe('runBackup — the actual bug (403 on every future run)', () => {
        it('falls back to the default folder and the backup still completes', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set() }));
            const api = makeDriveElectronApi();
            Object.assign(window, { electronAPI: api });
            buildBackupPlanMock.mockResolvedValue(await makePlan());

            const res = await runBackup({
                userId: 'user-1', token: 'api-token', password: 'pw', includeAttachments: false,
                destinations: { drive: true, driveFolderId: STALE_FOLDER_ID, driveFolderName: DEFAULT_FOLDER_NAME },
            });

            expect(res.driveFolderRecovered).toEqual({ folderId: DEFAULT_FOLDER_ID, folderName: DEFAULT_FOLDER_NAME });
            expect(res.drive?.skipped).toBe(false);
            expect(res.drive?.bytes).toBe(4242);
            // The upload actually happened, into the recovered (default) folder.
            expect(api.gdriveUploadFile).toHaveBeenCalledWith(DEFAULT_FOLDER_ID, 'cipherline-backup.enc', expect.any(String));
        });

        it('a subsequent run using the recovered folder id succeeds without recovering again', async () => {
            // Simulates BackupSection/useBackupAutoSchedule having persisted
            // res.driveFolderRecovered from the previous run as the new
            // driveFolderId — the dead end should be gone for good.
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set([DEFAULT_FOLDER_ID]) }));
            const api = makeDriveElectronApi();
            Object.assign(window, { electronAPI: api });
            buildBackupPlanMock.mockResolvedValue(await makePlan());

            const res = await runBackup({
                userId: 'user-1', token: 'api-token', password: 'pw', includeAttachments: false,
                destinations: { drive: true, driveFolderId: DEFAULT_FOLDER_ID, driveFolderName: DEFAULT_FOLDER_NAME },
            });

            expect(res.driveFolderRecovered).toBeUndefined();
            expect(res.drive?.skipped).toBe(false);
            expect(api.gdriveUploadFile).toHaveBeenCalledWith(DEFAULT_FOLDER_ID, 'cipherline-backup.enc', expect.any(String));
        });

        it('a network error resolving the stored folder fails the run — NOT silently recovered', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), accessCheckError: new Error('network down') }));
            const api = makeDriveElectronApi();
            Object.assign(window, { electronAPI: api });
            buildBackupPlanMock.mockResolvedValue(await makePlan());

            await expect(runBackup({
                userId: 'user-1', token: 'api-token', password: 'pw', includeAttachments: false,
                destinations: { drive: true, driveFolderId: STALE_FOLDER_ID, driveFolderName: DEFAULT_FOLDER_NAME },
            })).rejects.toThrow('network down');
            expect(api.gdriveUploadFile).not.toHaveBeenCalled();
        });

        it('a 401 from an expired token fails the run normally — NOT treated as a stale folder', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), accessCheckStatus: 401 }));
            const api = makeDriveElectronApi();
            Object.assign(window, { electronAPI: api });
            buildBackupPlanMock.mockResolvedValue(await makePlan());

            await expect(runBackup({
                userId: 'user-1', token: 'api-token', password: 'pw', includeAttachments: false,
                destinations: { drive: true, driveFolderId: STALE_FOLDER_ID, driveFolderName: DEFAULT_FOLDER_NAME },
            })).rejects.toThrow('401');
            expect(api.gdriveUploadFile).not.toHaveBeenCalled();
        });
    });

    describe('getDriveBackupInfo — read path recovers too', () => {
        it('reports folderRecovered and looks in the default folder when the stored id 403s', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({
                accessibleFolderIds: new Set(),
                existingFileInFolder: { id: 'f1', name: 'cipherline-backup.enc', modifiedTime: '2026-01-01T00:00:00Z', size: '10' },
            }));
            Object.assign(window, { electronAPI: { gdriveGetToken: vi.fn(async () => 'drive-token') } });

            const info = await getDriveBackupInfo(DEFAULT_FOLDER_NAME, STALE_FOLDER_ID, 'cipherline-backup');
            expect(info).toEqual({
                exists: true, modifiedTime: '2026-01-01T00:00:00Z', sizeBytes: 10,
                folderRecovered: { folderId: DEFAULT_FOLDER_ID, folderName: DEFAULT_FOLDER_NAME },
            });
        });

        it('never creates a folder on the read path — a fresh account with no default folder yet reports "no backup", not an error', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), defaultFolderExists: false }));
            Object.assign(window, { electronAPI: { gdriveGetToken: vi.fn(async () => 'drive-token') } });

            const info = await getDriveBackupInfo(DEFAULT_FOLDER_NAME, STALE_FOLDER_ID, 'cipherline-backup');
            expect(info).toEqual({ exists: false, folderRecovered: undefined });
        });
    });

    describe('restoreFromDrive — read path recovers, genuine failures still fail', () => {
        it('recovers from a stale explicit folder and reports "no backup found" rather than a raw 403', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set() }));
            Object.assign(window, { electronAPI: { gdriveGetToken: vi.fn(async () => 'drive-token') } });

            await expect(restoreFromDrive({
                userId: 'user-1', password: 'pw', folderName: DEFAULT_FOLDER_NAME, folderId: STALE_FOLDER_ID,
            })).rejects.toThrow(/No backup found/);
        });

        it('a 401 from an expired token still fails restore normally — NOT treated as a stale folder', async () => {
            vi.stubGlobal('fetch', makeDriveFetchRouter({ accessibleFolderIds: new Set(), accessCheckStatus: 401 }));
            Object.assign(window, { electronAPI: { gdriveGetToken: vi.fn(async () => 'drive-token') } });

            await expect(restoreFromDrive({
                userId: 'user-1', password: 'pw', folderName: DEFAULT_FOLDER_NAME, folderId: STALE_FOLDER_ID,
            })).rejects.toThrow('401');
        });
    });
});

/**
 * Regression: the first-run "Restore from backup file" screen (AuthScreen's
 * `history-options` view, shown right after sign-in when the device has no
 * local history) used to read the picked file with `decryptBackup` +
 * JSON.parse — a v1/v2-only reader. Every backup the current app writes is a
 * v3 container, so that path always failed with "Decryption failed. Incorrect
 * password or corrupted file.", while restoring the identical file from
 * Settings → Backups worked, because that path detects the container.
 *
 * `openBackupFile` is the shared, format-aware reader both paths now use.
 */
describe('openBackupFile — the first-run restore reader', () => {
    /** Bytes of a real v3 container, written by the real backup writer. */
    async function makeV3Bytes(): Promise<Uint8Array> {
        const { dest, files } = makeFakeDestination('local');
        await run([dest], await makePlan());
        return files.get(FILE)!;
    }

    it('reads a v3 container — the format every backup the app writes today uses', async () => {
        const bytes = await makeV3Bytes();
        const backup = await openBackupFile(new Blob([bytes as BlobPart]), 'pw');
        expect(backup.userId).toBe('user-1');
        // The fixture vault still carries an old-style keypair; the reader must
        // not hand it on (History transfer §2 — per-device key material never
        // moves between devices; see utils/vaultKeyMaterial.test.ts).
        expect(backup).not.toHaveProperty('privateKey');
        expect(backup).not.toHaveProperty('publicKey');
    });

    it('THE BUG: the old v1/v2-only reader rejects that same v3 container as a bad password', async () => {
        const bytes = await makeV3Bytes();
        // Guards the root cause itself: the v3 magic is "CL\x03", so the v2
        // check (third byte 0x02) misses and the v1 branch derives a key over
        // the wrong salt — an auth-tag failure indistinguishable from a typo.
        await expect(decryptBackup(new Blob([bytes as BlobPart]), 'pw')).rejects.toThrow();
    });

    it('still reads a legacy v2 full vault, so old backups keep restoring', async () => {
        const vault = { version: 4, userId: 'user-1', privateKey: 'priv', publicKey: 'pub', topics: [], history: {} };
        const blob = await encryptBackup(JSON.stringify(vault), 'pw');
        const backup = await openBackupFile(blob, 'pw');
        expect(backup.userId).toBe('user-1');
        expect(backup).not.toHaveProperty('privateKey');
    });

    it('rejects a wrong passphrase on a v3 container', async () => {
        const bytes = await makeV3Bytes();
        await expect(openBackupFile(new Blob([bytes as BlobPart]), 'wrong-pw')).rejects.toThrow();
    });

    it('apply() enforces account binding even if the caller skipped the check', async () => {
        const bytes = await makeV3Bytes();
        const backup = await openBackupFile(new Blob([bytes as BlobPart]), 'pw');
        await expect(backup.apply('someone-else')).rejects.toThrow(/different account/i);
    });

    it('reports a chunked manifest clearly instead of restoring an empty vault', async () => {
        const manifest = { v: 1, userId: 'user-1', chunks: [{ id: 'conv-a', file: 'chunk-a.enc' }] };
        const blob = await encryptBackup(JSON.stringify(manifest), 'pw');
        await expect(openBackupFile(blob, 'pw')).rejects.toThrow(/chunk files/i);
    });
});
