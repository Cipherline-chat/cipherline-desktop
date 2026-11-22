import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * The second safety net (backupShrinkGuard.ts): a backup never replaces one
 * holding far more conversations unless the user explicitly says so — and a
 * "no" (or no one to ask: the scheduler) leaves the existing file byte-for-byte
 * as it was. Real container writer/reader, in-memory destinations.
 */
vi.setConfig({ testTimeout: 60_000 });
vi.mock('../utils/betaDiagnostics/reporter', () => ({ reportBeta: vi.fn() }));

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined });
});

const { runSingleFileBackup, AllDestinationsFailedError } = await import('./driveBackup');
const { openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { fingerprintPlan, splitVaultForRecords, specsFromVault, writeBackupRecords } = await import('./backupRecords');
const {
    countConversations, isDrasticShrink, describeShrink, SHRINK_UNKNOWN_MIN_BYTES,
} = await import('./backupShrinkGuard');
import type { SingleFileDestination, DestinationSink, WriteMode, BackupShrinkWarning } from './driveBackup';
import type { BackupPlan } from './backupRecords';

describe('countConversations', () => {
    it('counts distinct conversations and channels, not month buckets or other records', () => {
        expect(countConversations([
            'meta', 'dm:a:2026-01', 'dm:a:2026-02', 'dm:b:2026-01', 'ch:c:2026-01', 'ch:c', 'dm:legacy',
            'gif:x', 'att:y', 'sound:z',
        ])).toBe(4);
        expect(countConversations(['meta'])).toBe(0);
    });
});

describe('isDrasticShrink — boundaries', () => {
    const known = (n: number) => ({ conversations: n, bytes: 1 });
    it('below 3 existing conversations nothing is drastic', () => {
        expect(isDrasticShrink(known(2), 0)).toBe(false);
    });
    it('3 existing: only 0 is drastic', () => {
        expect(isDrasticShrink(known(3), 0)).toBe(true);
        expect(isDrasticShrink(known(3), 1)).toBe(false);
    });
    it('50 existing: 10 or fewer (≤ 20%) is drastic, 11 is not', () => {
        expect(isDrasticShrink(known(50), 10)).toBe(true);
        expect(isDrasticShrink(known(50), 11)).toBe(false);
    });
    it('growth or a small drop is never drastic', () => {
        expect(isDrasticShrink(known(10), 9)).toBe(false);
        expect(isDrasticShrink(known(10), 40)).toBe(false);
    });
    it('count unknown: only an EMPTY vault over a file of real size', () => {
        expect(isDrasticShrink({ conversations: null, bytes: SHRINK_UNKNOWN_MIN_BYTES }, 0)).toBe(true);
        expect(isDrasticShrink({ conversations: null, bytes: SHRINK_UNKNOWN_MIN_BYTES - 1 }, 0)).toBe(false);
        expect(isDrasticShrink({ conversations: null, bytes: 10 * SHRINK_UNKNOWN_MIN_BYTES }, 1)).toBe(false);
        expect(isDrasticShrink({ conversations: null, bytes: null }, 0)).toBe(false);
    });
    it('describes the loss in plain words', () => {
        const w = describeShrink([{ label: 'local', conversations: 12, bytes: 1 }], 0);
        expect(w.message).toContain('0 conversations');
        expect(w.message).toContain('12 conversations');
    });
});

// ── runSingleFileBackup ─────────────────────────────────────────────────────

function makeDest(label: 'local' | 'drive', seed: Record<string, Uint8Array> = {}) {
    const files = new Map<string, Uint8Array>(Object.entries(seed));
    const log: string[] = [];
    const dest: SingleFileDestination = {
        label,
        supportsUpdate: label === 'local',
        stat: async (name) => { const f = files.get(name); return f ? { size: f.length } : null; },
        openSink: async (name, mode: WriteMode) => {
            log.push(`open:${mode}`);
            const buf = mode === 'update' ? new MemoryContainer(files.get(name)) : new MemoryContainer();
            const sink: DestinationSink = {
                write: (b) => buf.write(b),
                writeAt: (o, b) => buf.writeAt(o, b),
                commit: async () => { const bytes = buf.bytes(); files.set(name, bytes); log.push('commit'); return { size: bytes.length }; },
                abort: async () => { log.push('abort'); },
            };
            return sink;
        },
        openSource: async (name) => { const f = files.get(name); return f ? memorySource(f) : null; },
        verify: async () => {},
        listFiles: async () => [...files.keys()],
        deleteFiles: async () => {},
    };
    return { dest, files, log };
}

const MSG = (i: number) => [{ id: `m${i}`, text: 'hi', timestamp: '2026-01-10T10:00:00Z' }];
async function planWith(conversations: number, extraPadding = 0): Promise<BackupPlan> {
    const history: Record<string, unknown[]> = {};
    for (let i = 0; i < conversations; i++) history[`conv-${i}`] = MSG(i);
    const vault = { version: 4, userId: 'user-1', deviceId: 'd', privateKey: 'p', publicKey: 'q', topics: [], history, padding: 'x'.repeat(extraPadding) };
    const { meta, history: h, channelHistory } = splitVaultForRecords(vault as unknown as Parameters<typeof splitVaultForRecords>[0]);
    const records = await specsFromVault({ meta, history: h, channelHistory, attachmentIds: [], loaders: { attachment: async () => null } });
    return { userId: 'user-1', fingerprint: await fingerprintPlan({ meta, history: h, channelHistory, gifIds: [], attachmentIds: [] }), records, attachmentIds: [], attachmentSizeHints: {} };
}

const FILE = 'cipherline-backup.enc';
const run = (dests: SingleFileDestination[], plan: BackupPlan, extra: Record<string, unknown> = {}) =>
    runSingleFileBackup({
        destinations: dests, plan, password: 'pw', fileName: FILE, basePattern: 'cipherline-backup',
        lastFingerprints: {}, writeRecords: (w) => writeBackupRecords(plan, w), ...extra,
    });

/** A destination already holding a backup of `n` conversations. */
async function seeded(label: 'local' | 'drive', n: number, padding = 0) {
    const d = makeDest(label);
    await run([d.dest], await planWith(n, padding));
    d.log.length = 0;
    return d;
}

describe('runSingleFileBackup — a drastically emptier vault', () => {
    it('control: a normal run over an existing backup is not asked about and writes', async () => {
        const d = await seeded('local', 10);
        const confirm = vi.fn(async () => true);
        const { results } = await run([d.dest], await planWith(9), { confirmShrink: confirm });
        expect(confirm).not.toHaveBeenCalled();
        expect(results.local?.skipped).toBe(false);
    });

    it('scheduler (no one to ask): the existing local backup is kept byte-for-byte, nothing opened', async () => {
        const d = await seeded('local', 10);
        const before = d.files.get(FILE)!.slice();
        const err = await run([d.dest], await planWith(0)).catch(e => e);
        expect(err).toBeInstanceOf(AllDestinationsFailedError);
        expect(err.destinationErrors.local).toMatch(/Kept your existing backup/);
        expect(d.log).toEqual([]); // no sink opened, nothing committed
        expect(d.files.get(FILE)).toEqual(before);
        const c = await openContainer(memorySource(d.files.get(FILE)!), 'pw');
        expect(countConversations(c.index.records.map(r => r.id))).toBe(10);
    });

    it('the user says keep: same — nothing written', async () => {
        const d = await seeded('local', 10);
        const before = d.files.get(FILE)!.slice();
        let asked: BackupShrinkWarning | null = null;
        await run([d.dest], await planWith(1), { confirmShrink: async (w: BackupShrinkWarning) => { asked = w; return false; } }).catch(() => undefined);
        expect(asked!.destinations).toEqual([{ label: 'local', conversations: 10, bytes: before.length }]);
        expect(asked!.nextConversations).toBe(1);
        expect(d.files.get(FILE)).toEqual(before);
        expect(d.log).toEqual([]);
    });

    it('the user explicitly says replace: written', async () => {
        const d = await seeded('local', 10);
        const { results } = await run([d.dest], await planWith(0), { confirmShrink: async () => true });
        expect(results.local?.skipped).toBe(false);
        const c = await openContainer(memorySource(d.files.get(FILE)!), 'pw');
        expect(countConversations(c.index.records.map(r => r.id))).toBe(0);
    });

    it('a confirm callback that throws counts as "keep"', async () => {
        const d = await seeded('local', 10);
        const before = d.files.get(FILE)!.slice();
        await run([d.dest], await planWith(0), { confirmShrink: async () => { throw new Error('modal gone'); } }).catch(() => undefined);
        expect(d.files.get(FILE)).toEqual(before);
    });

    it('Google Drive (index not read): uses the count this device recorded for it', async () => {
        const d = await seeded('drive', 10);
        const before = d.files.get(FILE)!.slice();
        await run([d.dest], await planWith(0), { knownConversations: { drive: 10 } }).catch(() => undefined);
        expect(d.files.get(FILE)).toEqual(before);
        expect(d.log).toEqual([]);
    });

    it('Google Drive with no record: an empty vault over a sizeable file is still caught', async () => {
        const d = await seeded('drive', 3, SHRINK_UNKNOWN_MIN_BYTES);
        const before = d.files.get(FILE)!.slice();
        expect(before.length).toBeGreaterThanOrEqual(SHRINK_UNKNOWN_MIN_BYTES);
        await run([d.dest], await planWith(0)).catch(() => undefined);
        expect(d.files.get(FILE)).toEqual(before);
    });

    it('one destination kept, the other still backed up', async () => {
        const local = await seeded('local', 10);
        const drive = makeDest('drive'); // nothing there yet
        const before = local.files.get(FILE)!.slice();
        const { results, errors } = await run([local.dest, drive.dest], await planWith(0));
        expect(errors?.local).toMatch(/Kept your existing backup/);
        expect(results.drive?.skipped).toBe(false);
        expect(local.files.get(FILE)).toEqual(before);
    });

    it('a first backup (nothing there yet) is never asked about', async () => {
        const d = makeDest('local');
        const confirm = vi.fn(async () => false);
        const { results } = await run([d.dest], await planWith(0), { confirmShrink: confirm });
        expect(confirm).not.toHaveBeenCalled();
        expect(results.local?.skipped).toBe(false);
    });
});
