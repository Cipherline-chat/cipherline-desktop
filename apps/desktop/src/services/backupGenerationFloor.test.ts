import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Real v4 containers are written here, so every run derives PBKDF2 at 600k.
vi.setConfig({ testTimeout: 60_000 });

/**
 * MEMOISE THE KDF, and nothing else — the same trick, and the same reasoning,
 * as backupContainer.test.ts. These tests write and reopen real containers
 * across several generations; every `openContainer` re-derives the key from
 * the identical password and salt, which is pure repetition of the one thing
 * they are not about and is what made a prior round time out under load.
 * Distinct passwords/salts still derive distinct keys; every AES-GCM
 * operation and AAD binding below is real and unmocked.
 */
vi.mock('../utils/crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/crypto')>();
    const cache = new Map<string, Promise<CryptoKey>>();
    return {
        ...actual,
        deriveBackupKey: (password: string, salt: Uint8Array, iterations: number, hash: 'SHA-256' | 'SHA-512') => {
            const k = `${password}:${iterations}:${hash}:${Array.from(salt).join(',')}`;
            let hit = cache.get(k);
            if (!hit) { hit = actual.deriveBackupKey(password, salt, iterations, hash); cache.set(k, hit); }
            return hit;
        },
    };
});

/** In-memory stand-in for the encrypted KV store, with a switch for the
 *  "locked / cleared / still-cold keystore" case the real one produces by
 *  throwing out of `ensureReady()`. */
const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    let broken = false;
    return {
        map,
        break: (b: boolean) => { broken = b; },
        fake: {
            getItem: (k: string) => { if (broken) throw new Error('keystore locked'); return map.get(k) ?? null; },
            setItem: (k: string, v: string) => { if (broken) throw new Error('keystore locked'); map.set(k, v); },
            removeItem: (k: string) => { map.delete(k); },
            whenAccountReady: async () => {},
        },
    };
});
vi.mock('../utils/secureLocalStore', () => ({ default: store.fake, secureLocalStore: store.fake }));

/** applyBackupContainer writes the real vault and buildBackupPlan reads it;
 *  the tests below care only about WHETHER they ran and with what. Everything
 *  else backupRecords exports — including the real record writer — stays real,
 *  so the containers these tests produce are genuine. */
const { applyMock, buildPlanMock } = vi.hoisted(() => ({
    applyMock: vi.fn(async () => {}),
    buildPlanMock: vi.fn(),
}));
vi.mock('./backupRecords', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./backupRecords')>();
    return { ...actual, applyBackupContainer: applyMock, buildBackupPlan: buildPlanMock };
});

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

const {
    compareToFloor, describeStale, backupTarget, recordBackupFloor, checkBackupFloor,
    getBackupFloors, FLOOR_CLOCK_SKEW_MS,
} = await import('./backupGenerationFloor');
const { ContainerWriter, openContainer, MemoryContainer, memorySource, HEADER_LEN } =
    await import('../utils/backupContainer');
const { restoreFromLocalFile, runBackup } = await import('./driveBackup');
const { splitVaultForRecords, specsFromVault, fingerprintPlan } = await import('./backupRecords');

const UID = 'user-1';
const FLOOR_KEY = `cipherline_backup_gen_floor_${UID}`;
/** The commit-slot region an attacker snapshots and later writes back. */
const COMMIT_REGION = [24, HEADER_LEN] as const;

beforeEach(() => { store.map.clear(); store.break(false); applyMock.mockClear(); buildPlanMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * A real v4 container advanced in place to generation `n`, plus — for each
 * generation — a snapshot of the 88-byte commit region as it stood right
 * after that generation committed. That snapshot IS the attacker's asset in
 * the residual this module closes: bytes kept from an earlier run, correctly
 * sealed under this file's own key, that can simply be written back later.
 */
async function v4To(n: number, password = 'pw') {
    const mem = new MemoryContainer();
    const commits: Uint8Array[] = []; // commits[g - 1] === the region after generation g
    const snap = () => { commits.push(mem.bytes().slice(COMMIT_REGION[0], COMMIT_REGION[1])); };

    const w1 = await ContainerWriter.create(password, mem);
    await w1.addJson('meta', { userId: UID });
    await w1.addJson('dm:c', { a: 1 });
    const gens = [await w1.finish({ userId: UID, fingerprint: 'fp-1' })];
    snap();
    for (let g = 2; g <= n; g++) {
        const w = ContainerWriter.resume(await openContainer(mem, password), mem);
        w.carry('meta');
        await w.addJson('dm:c', { a: g });
        gens.push(await w.finish({ userId: UID, fingerprint: `fp-${g}` }));
        snap();
    }
    return { mem, gens, commits };
}

/** Write a kept commit region back over the current header — no key needed,
 *  nothing forged, every byte a real seal this file once carried. */
function replayCommits(file: Uint8Array, commits: Uint8Array): Uint8Array {
    const out = file.slice();
    out.set(commits, COMMIT_REGION[0]);
    return out;
}

const markOf = (index: { generation: number; createdAt: string }) =>
    ({ generation: index.generation, createdAt: index.createdAt });

// ── The pure comparison ─────────────────────────────────────────────────────

describe('compareToFloor — what counts as older', () => {
    const at = (iso: string, generation = 1) => ({ generation, createdAt: iso });
    const floor = (iso: string, generation = 1) => ({ target: 't', generation, createdAt: iso });

    it('no floor is no opinion, never a warning', () => {
        expect(compareToFloor(null, at('2026-09-14T10:00:00Z'))).toBeNull();
        expect(compareToFloor(undefined, at('2026-09-14T10:00:00Z'))).toBeNull();
    });

    it('a decisively older timestamp is stale, regardless of generation', () => {
        // Drive's case: every upload is a fresh generation-1 container, so the
        // timestamp is the ONLY axis that can see an old revision at all.
        expect(compareToFloor(floor('2026-09-14T10:00:00Z'), at('2026-08-14T10:00:00Z'))).toBe('older-timestamp');
    });

    it('a lower generation within the skew window is stale', () => {
        const t = '2026-09-14T10:00:00Z';
        expect(compareToFloor(floor(t, 6), at(t, 2))).toBe('older-generation');
    });

    it('a decisively NEWER timestamp silences the generation axis', () => {
        // A local compaction, or any run whose floor write failed, leaves a
        // lower generation behind a genuinely newer file. Warning there would
        // be a pure false positive, and the authenticated createdAt proves it.
        const floorAt = Date.parse('2026-09-14T10:00:00Z');
        const newer = new Date(floorAt + FLOOR_CLOCK_SKEW_MS + 60_000).toISOString();
        expect(compareToFloor(floor('2026-09-14T10:00:00Z', 12), at(newer, 1))).toBeNull();
    });

    it('ordinary clock skew is absorbed', () => {
        const floorAt = Date.parse('2026-09-14T10:00:00Z');
        const slightlyEarlier = new Date(floorAt - (FLOOR_CLOCK_SKEW_MS - 1000)).toISOString();
        expect(compareToFloor(floor('2026-09-14T10:00:00Z'), at(slightlyEarlier))).toBeNull();
    });

    it('unparseable timestamps fall back to the generation axis alone', () => {
        expect(compareToFloor(floor('not-a-date', 5), at('also-not', 2))).toBe('older-generation');
        expect(compareToFloor(floor('not-a-date', 5), at('also-not', 9))).toBeNull();
    });

    it('the same or a newer state is never stale', () => {
        const t = '2026-09-14T10:00:00Z';
        expect(compareToFloor(floor(t, 4), at(t, 4))).toBeNull();
        expect(compareToFloor(floor(t, 4), at(t, 5))).toBeNull();
    });
});

describe('describeStale — copy for a real person', () => {
    const floor = { target: 't', generation: 6, createdAt: '2026-09-01T10:00:00Z' };

    it('reports what was observed and names the innocent explanation first', () => {
        const w = describeStale('older-timestamp', { generation: 6, createdAt: '2026-08-01T10:00:00Z' }, floor);
        expect(w.title).toBe('This backup is older than the last one');
        expect(w.message).toMatch(/was saved on .+\. The last backup this device saved here was /);
        expect(w.message).toContain("If you went back to an earlier version on purpose, that's expected");
        // Not a threat accusation.
        expect(w.message).not.toMatch(/attack|tamper|malicious|compromis/i);
    });

    it('the generation wording does not talk about dates that are the same', () => {
        const w = describeStale('older-generation', { generation: 2, createdAt: floor.createdAt }, floor);
        expect(w.message).toContain('is an earlier version than the last one this device saved here (version 2, not 6)');
        expect(w.message).not.toMatch(/saved on/);
    });
});

// ── The silent paths ────────────────────────────────────────────────────────

describe('a floor that says nothing must produce NO warning', () => {
    it('NEW DEVICE: nothing recorded at all is completely silent', async () => {
        expect(store.map.size).toBe(0);
        const w = await checkBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 1, createdAt: '2020-01-01T00:00:00Z' });
        expect(w).toBeNull();
    });

    it('UNREADABLE FLOOR: a locked keystore fails open, silently', async () => {
        recordBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 9, createdAt: '2026-09-14T10:00:00Z' });
        store.break(true);
        const w = await checkBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 1, createdAt: '2020-01-01T00:00:00Z' });
        expect(w).toBeNull();
    });

    it('a floor recorded for a DIFFERENT file is not evidence about this one', async () => {
        recordBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 9, createdAt: '2026-09-14T10:00:00Z' });
        const w = await checkBackupFloor(UID, 'local', backupTarget('/elsewhere', 'x.enc'), { generation: 1, createdAt: '2020-01-01T00:00:00Z' });
        expect(w).toBeNull();
    });

    it("a floor for the OTHER destination is not evidence either", async () => {
        recordBackupFloor(UID, 'drive', backupTarget('folder-1', 'x.enc'), { generation: 9, createdAt: '2026-09-14T10:00:00Z' });
        const w = await checkBackupFloor(UID, 'local', backupTarget('folder-1', 'x.enc'), { generation: 1, createdAt: '2020-01-01T00:00:00Z' });
        expect(w).toBeNull();
    });

    it('a locked keystore also never fails a BACKUP', () => {
        store.break(true);
        expect(() => recordBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 3, createdAt: '2026-09-14T10:00:00Z' })).not.toThrow();
    });

    it('trailing separators on the configured folder still match', async () => {
        recordBackupFloor(UID, 'local', backupTarget('/b/', 'x.enc'), { generation: 9, createdAt: '2026-09-14T10:00:00Z' });
        const w = await checkBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 2, createdAt: '2026-09-14T10:00:00Z' });
        expect(w?.reason).toBe('older-generation');
    });
});

// ── Replay detection, against real sealed bytes ─────────────────────────────

describe('the floor detects the replay v4 cannot', () => {
    it('REPLAYING the 88 bytes of commit slots kept from an earlier run is caught', async () => {
        const { mem, gens, commits } = await v4To(6);
        const target = backupTarget('/backups', 'cipherline-backup.enc');

        // The file v4 alone still opens as generation 2 — every byte is a real
        // seal, so nothing fails authentication and the reader has no in-band
        // reason to object. This is the residual, reproduced.
        const rolled = await openContainer(memorySource(replayCommits(mem.bytes(), commits[1])), 'pw');
        expect(rolled.index.generation).toBe(2);
        expect(await rolled.readJson('dm:c')).toEqual({ a: 2 });

        // With the out-of-file mark, it is caught: this device wrote 6 here.
        recordBackupFloor(UID, 'local', target, markOf(gens[5].index));
        const warning = await checkBackupFloor(UID, 'local', target, markOf(rolled.index));
        expect(warning).not.toBeNull();
        expect(warning!.reason).toBe('older-generation');
        expect(warning!.observed.generation).toBe(2);
        expect(warning!.floor.generation).toBe(6);
    });

    it('a one-generation fallback (the newer commit slot destroyed) is caught too', async () => {
        const { mem, gens } = await v4To(4);
        const target = backupTarget('/backups', 'cipherline-backup.enc');
        const wiped = mem.bytes();
        wiped.fill(0, COMMIT_REGION[0] + (4 % 2) * 44, COMMIT_REGION[0] + (4 % 2) * 44 + 44);
        const back = await openContainer(memorySource(wiped), 'pw');
        expect(back.index.generation).toBe(3);

        recordBackupFloor(UID, 'local', target, markOf(gens[3].index));
        const warning = await checkBackupFloor(UID, 'local', target, markOf(back.index));
        expect(warning?.reason).toBe('older-generation');
    });

    it('the un-tampered current file is silent', async () => {
        const { mem, gens } = await v4To(6);
        const target = backupTarget('/backups', 'cipherline-backup.enc');
        recordBackupFloor(UID, 'local', target, markOf(gens[5].index));
        const live = await openContainer(memorySource(mem.bytes()), 'pw');
        expect(await checkBackupFloor(UID, 'local', target, markOf(live.index))).toBeNull();
    });

    it('DRIVE: every upload is generation 1, so only the timestamp can see an old revision', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        // Drive cannot update in place; each run writes a whole fresh file.
        vi.setSystemTime(new Date('2026-08-01T10:00:00Z'));
        const august = new MemoryContainer();
        const wA = await ContainerWriter.create('pw', august);
        await wA.addJson('meta', { userId: UID });
        const genA = await wA.finish({ userId: UID, fingerprint: 'fp-aug' });

        vi.setSystemTime(new Date('2026-09-14T10:00:00Z'));
        const september = new MemoryContainer();
        const wS = await ContainerWriter.create('pw', september);
        await wS.addJson('meta', { userId: UID });
        const genS = await wS.finish({ userId: UID, fingerprint: 'fp-sep' });

        // This is the load-bearing fact: a generation-only floor would compare
        // 1 against 1 and see nothing at all on the destination whose revision
        // history the threat model actually names.
        expect(genA.index.generation).toBe(1);
        expect(genS.index.generation).toBe(1);

        const target = backupTarget('drive-folder-id', 'cipherline-backup.enc');
        recordBackupFloor(UID, 'drive', target, markOf(genS.index));

        const rolledBack = await checkBackupFloor(UID, 'drive', target, markOf(genA.index));
        expect(rolledBack).not.toBeNull();
        expect(rolledBack!.reason).toBe('older-timestamp');

        // …and the current revision stays silent.
        expect(await checkBackupFloor(UID, 'drive', target, markOf(genS.index))).toBeNull();
    });
});

// ── The post-older-restore write ────────────────────────────────────────────

describe('after a deliberate older-revision restore, the next write re-anchors', () => {
    it('the floor becomes what was just written, so the user is not warned forever', async () => {
        const target = backupTarget('drive-folder-id', 'cipherline-backup.enc');
        vi.useFakeTimers({ toFake: ['Date'] });

        // Backed up in September.
        vi.setSystemTime(new Date('2026-09-14T10:00:00Z'));
        const sep = new MemoryContainer();
        const wS = await ContainerWriter.create('pw', sep);
        await wS.addJson('meta', { userId: UID });
        const genSep = await wS.finish({ userId: UID, fingerprint: 'fp-sep' });
        recordBackupFloor(UID, 'drive', target, markOf(genSep.index));

        // The user deliberately restores August's Drive revision and is warned
        // once — the honest signal.
        vi.setSystemTime(new Date('2026-08-01T10:00:00Z'));
        const aug = new MemoryContainer();
        const wA = await ContainerWriter.create('pw', aug);
        await wA.addJson('meta', { userId: UID });
        const genAug = await wA.finish({ userId: UID, fingerprint: 'fp-aug' });
        expect(await checkBackupFloor(UID, 'drive', target, markOf(genAug.index))).not.toBeNull();

        // Then they back up again. LAST-WRITE, not max(): the mark becomes the
        // container this device just authored and verified.
        vi.setSystemTime(new Date('2026-08-01T11:00:00Z'));
        const after = new MemoryContainer();
        const wAfter = await ContainerWriter.create('pw', after);
        await wAfter.addJson('meta', { userId: UID });
        const genAfter = await wAfter.finish({ userId: UID, fingerprint: 'fp-after' });
        recordBackupFloor(UID, 'drive', target, markOf(genAfter.index));

        expect(getBackupFloors(UID).drive).toMatchObject({ target, createdAt: genAfter.index.createdAt });
        // No permanent false alarm: the file that is actually there restores
        // silently from here on.
        expect(await checkBackupFloor(UID, 'drive', target, markOf(genAfter.index))).toBeNull();
        // And the protection is still live — anything older than the new mark
        // is still caught.
        expect(await checkBackupFloor(UID, 'drive', target, markOf(genSep.index))).toBeNull(); // September is NEWER than the mark
        expect(await checkBackupFloor(UID, 'drive', target, markOf(genAug.index))).not.toBeNull(); // 10:00 against an 11:00 mark
    });

    it('a LOCAL compaction resets the generation to 1 without warning', async () => {
        // The same last-write rule is what keeps routine compaction quiet: a
        // high-water mark would flag every compacted file as a rollback.
        const target = backupTarget('/backups', 'cipherline-backup.enc');
        const { gens } = await v4To(6);
        recordBackupFloor(UID, 'local', target, markOf(gens[5].index));

        const compacted = new MemoryContainer();
        const w = await ContainerWriter.create('pw', compacted);
        await w.addJson('meta', { userId: UID });
        const fresh = await w.finish({ userId: UID, fingerprint: 'fp-compact' });
        expect(fresh.index.generation).toBe(1);

        recordBackupFloor(UID, 'local', target, markOf(fresh.index));
        expect(await checkBackupFloor(UID, 'local', target, markOf(fresh.index))).toBeNull();
    });
});

// ── Storage shape ───────────────────────────────────────────────────────────

describe('storage', () => {
    it('lives under its own key, not inside the fingerprint map', () => {
        recordBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 3, createdAt: '2026-09-14T10:00:00Z' });
        expect([...store.map.keys()]).toEqual([FLOOR_KEY]);
        expect(JSON.parse(store.map.get(FLOOR_KEY)!)).toEqual({
            local: { target: '/b/x.enc', generation: 3, createdAt: '2026-09-14T10:00:00Z' },
        });
    });

    it('keeps the two destinations independent', () => {
        recordBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 3, createdAt: '2026-09-14T10:00:00Z' });
        recordBackupFloor(UID, 'drive', backupTarget('fid', 'x.enc'), { generation: 1, createdAt: '2026-09-14T10:05:00Z' });
        expect(Object.keys(getBackupFloors(UID)).sort()).toEqual(['drive', 'local']);
    });

    it('a corrupt record reads as "nothing remembered", not as a warning', async () => {
        store.map.set(FLOOR_KEY, 'not json');
        expect(getBackupFloors(UID)).toEqual({});
        expect(await checkBackupFloor(UID, 'local', backupTarget('/b', 'x.enc'), { generation: 1, createdAt: '2020-01-01T00:00:00Z' })).toBeNull();
    });
});

// ── The advisory gate, end to end through restoreFromLocalFile ──────────────

describe('restoreFromLocalFile — advisory, never blocking', () => {
    const DIR = '/backups';
    const NAME = 'cipherline-backup.enc';
    const PATH = `${DIR}/${NAME}`;

    function mountFile(bytes: Uint8Array) {
        Object.assign(window, {
            electronAPI: {
                backupStat: async (p: string) => (p === PATH ? { size: bytes.length, mtimeMs: 0 } : null),
                backupReadRange: async (_p: string, off: number, len: number) => bytes.slice(off, off + len).buffer,
            },
        });
    }
    afterEach(() => { Object.assign(window, { electronAPI: undefined }); });

    /** A file replayed back to generation 2 while the device last wrote 6. */
    async function staleOnDisk() {
        const { mem, gens, commits } = await v4To(6);
        recordBackupFloor(UID, 'local', backupTarget(DIR, NAME), markOf(gens[5].index));
        return replayCommits(mem.bytes(), commits[1]);
    }

    it('warns and then restores when the user says go ahead — one click', async () => {
        mountFile(await staleOnDisk());
        const seen: string[] = [];
        const res = await restoreFromLocalFile({
            userId: UID, filePath: PATH, password: 'pw',
            onStaleBackup: (w) => { seen.push(w.reason); return true; },
        });
        expect(seen).toEqual(['older-generation']);
        expect(res.restored).toBe(true);
        expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the device untouched when the user backs out', async () => {
        mountFile(await staleOnDisk());
        const res = await restoreFromLocalFile({
            userId: UID, filePath: PATH, password: 'pw',
            onStaleBackup: () => false,
        });
        expect(res.restored).toBe(false);
        expect(res.staleWarning?.reason).toBe('older-generation');
        expect(applyMock).not.toHaveBeenCalled();
    });

    it('restores anyway when no handler is wired — the check can only advise', async () => {
        mountFile(await staleOnDisk());
        const res = await restoreFromLocalFile({ userId: UID, filePath: PATH, password: 'pw' });
        expect(res.restored).toBe(true);
        expect(res.staleWarning?.reason).toBe('older-generation');
        expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('a throwing handler must not block a restore', async () => {
        mountFile(await staleOnDisk());
        const res = await restoreFromLocalFile({
            userId: UID, filePath: PATH, password: 'pw',
            onStaleBackup: () => { throw new Error('UI blew up'); },
        });
        expect(res.restored).toBe(true);
        expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('NEW DEVICE: no floor, no prompt, no notice of any kind', async () => {
        const { mem } = await v4To(6);
        mountFile(mem.bytes());
        const onStaleBackup = vi.fn(() => false);
        const res = await restoreFromLocalFile({ userId: UID, filePath: PATH, password: 'pw', onStaleBackup });
        expect(onStaleBackup).not.toHaveBeenCalled();
        expect(res.staleWarning).toBeUndefined();
        expect(res.restored).toBe(true);
        expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('UNREADABLE FLOOR: a locked keystore prompts nobody', async () => {
        const bytes = await staleOnDisk();
        store.break(true);
        mountFile(bytes);
        const onStaleBackup = vi.fn(() => false);
        const res = await restoreFromLocalFile({ userId: UID, filePath: PATH, password: 'pw', onStaleBackup });
        expect(onStaleBackup).not.toHaveBeenCalled();
        expect(res.staleWarning).toBeUndefined();
        expect(res.restored).toBe(true);
    });

    it('a file picked from somewhere else entirely is not compared', async () => {
        const bytes = await staleOnDisk();
        const other = '/downloads/cipherline-backup.enc';
        Object.assign(window, {
            electronAPI: {
                backupStat: async (p: string) => (p === other ? { size: bytes.length, mtimeMs: 0 } : null),
                backupReadRange: async (_p: string, off: number, len: number) => bytes.slice(off, off + len).buffer,
            },
        });
        const onStaleBackup = vi.fn(() => false);
        const res = await restoreFromLocalFile({ userId: UID, filePath: other, password: 'pw', onStaleBackup });
        expect(onStaleBackup).not.toHaveBeenCalled();
        expect(res.restored).toBe(true);
    });
});

// ── The write side: runBackup records the floor for real ────────────────────

/** Minimal in-memory stand-in for the main-process backup file IPC, enough to
 *  drive the REAL localDestination end to end: begin/append/writeAt/commit,
 *  plus the ranged reads `verify` and the in-place update path use. */
function makeLocalFsApi(files = new Map<string, Uint8Array>()) {
    const sessions = new Map<string, { path: string; buf: InstanceType<typeof MemoryContainer> }>();
    let n = 0;
    return {
        files,
        backupStat: async (p: string) => { const f = files.get(p); return f ? { size: f.length, mtimeMs: 0 } : null; },
        backupReadRange: async (p: string, off: number, len: number) => files.get(p)!.slice(off, off + len).buffer,
        backupBeginWrite: async (dir: string, name: string, mode: 'update' | 'fresh') => {
            const path = `${dir}/${name}`;
            const sessionId = `s${++n}`;
            sessions.set(sessionId, { path, buf: new MemoryContainer(mode === 'update' ? files.get(path) : undefined) });
            return { sessionId };
        },
        backupAppend: async (id: string, bytes: Uint8Array) => { await sessions.get(id)!.buf.write(bytes); },
        backupWriteAt: async (id: string, off: number, bytes: Uint8Array) => { await sessions.get(id)!.buf.writeAt(off, bytes); },
        backupCommit: async (id: string) => {
            const s = sessions.get(id)!;
            const bytes = s.buf.bytes();
            files.set(s.path, bytes);
            return { size: bytes.length, path: s.path };
        },
        backupAbort: async (id: string) => { sessions.delete(id); },
        readDir: async () => [...files.keys()].map(p => p.slice(p.lastIndexOf('/') + 1)),
        deleteFile: async (p: string) => { files.delete(p); },
    };
}

async function plan(history: Record<string, unknown[]>) {
    const vault = {
        version: 4, userId: UID, deviceId: 'device-1', privateKey: 'priv', publicKey: 'pub',
        topics: [{ id: 'conv-a', type: 'dm' }], history,
    };
    const split = splitVaultForRecords(vault as unknown as Parameters<typeof splitVaultForRecords>[0]);
    return {
        userId: UID,
        fingerprint: await fingerprintPlan({ ...split, gifIds: [], attachmentIds: [] }),
        records: await specsFromVault({ ...split, attachmentIds: [], loaders: { attachment: async () => new Uint8Array() } }),
        attachmentIds: [] as string[],
        attachmentSizeHints: {} as Record<string, number>,
    };
}

describe('runBackup — the floor moves only when this device actually wrote', () => {
    const DIR = '/backups';
    const NAME = 'cipherline-backup.enc';

    afterEach(() => { Object.assign(window, { electronAPI: undefined }); });

    const run = () => runBackup({
        userId: UID, token: 't', password: 'pw', includeAttachments: false,
        destinations: { localDir: DIR },
    });

    it('records the container it just wrote, and advances it on the next run', async () => {
        Object.assign(window, { electronAPI: makeLocalFsApi() });

        buildPlanMock.mockResolvedValue(await plan({ 'conv-a': [{ id: 'm1', text: 'hi', timestamp: '2026-01-01T00:00:00Z' }] }));
        const first = await run();
        expect(first.local?.skipped).toBe(false);
        expect(first.local?.mark?.generation).toBe(1);
        expect(getBackupFloors(UID).local).toMatchObject({ target: `${DIR}/${NAME}`, generation: 1 });

        // Content changed → a real in-place update, generation 2.
        buildPlanMock.mockResolvedValue(await plan({ 'conv-a': [{ id: 'm2', text: 'again', timestamp: '2026-02-01T00:00:00Z' }] }));
        const second = await run();
        expect(second.local?.mode).toBe('update');
        expect(second.local?.mark?.generation).toBe(2);
        expect(getBackupFloors(UID).local?.generation).toBe(2);

        // …and the file on disk restores silently, as it must.
        expect(await checkBackupFloor(UID, 'local', backupTarget(DIR, NAME), second.local!.mark!)).toBeNull();
    });

    it('a SKIPPED destination wrote nothing, so it carries no mark and must not re-stamp the floor', async () => {
        Object.assign(window, { electronAPI: makeLocalFsApi() });
        const same = await plan({ 'conv-a': [{ id: 'm1', text: 'hi', timestamp: '2026-01-01T00:00:00Z' }] });

        buildPlanMock.mockResolvedValue(same);
        await run();
        buildPlanMock.mockResolvedValue(same);
        const second = await run();

        expect(second.local?.skipped).toBe(true);
        expect(second.local?.mark).toBeUndefined();
        // Still the generation-1 mark from the run that actually wrote it —
        // a skip opens no file and so has seen nothing to claim.
        expect(getBackupFloors(UID).local).toMatchObject({ generation: 1 });
    });

    it('a locked keystore during the backup leaves no floor, and does not fail the run', async () => {
        Object.assign(window, { electronAPI: makeLocalFsApi() });
        buildPlanMock.mockResolvedValue(await plan({ 'conv-a': [{ id: 'm1', text: 'hi', timestamp: '2026-01-01T00:00:00Z' }] }));
        store.break(true);
        const res = await run();
        expect(res.local?.skipped).toBe(false);
        store.break(false);
        expect(getBackupFloors(UID)).toEqual({});
    });
});
