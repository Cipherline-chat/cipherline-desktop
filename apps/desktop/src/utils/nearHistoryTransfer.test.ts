import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// Memoise the PBKDF2 (600k iterations) only; every AES-GCM / AAD check stays real. Same approach as backupContainer.test.ts.
vi.mock('./crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./crypto')>();
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

beforeAll(() => {
    // crypto.ts reaches for window.crypto; alias it to Node's.
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

import { ContainerWriter, openContainer } from './backupContainer';
import type { ByteSink } from './backupContainer';
import {
    NEAR_IPC_CHUNK,
    NEAR_MAX_READ,
    NearTransferError,
    createNearFileSource,
    createNearSpoolSink,
    receiveHistoryOverNear,
    sendHistoryOverNear,
} from './nearHistoryTransfer';
import type { NearHistoryApi } from './nearHistoryTransfer';
import type { NearSnapshot, NearState } from '../types/near';

const MiB = 1024 * 1024;

/** Byte equality without vitest's slow element-wise typed-array diff on multi-MiB buffers. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
    return !!a && a.length === b.length && Buffer.compare(a, b) === 0;
}

function pattern(n: number, seed = 7): Uint8Array {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >>> 16; }
    return out;
}

interface FakeFs {
    api: NearHistoryApi;
    files: Map<string, Uint8Array>;
    sessions: Map<string, { path: string; buf: Uint8Array }>;
    payloadSizes: number[];
    aborted: string[];
    deleted: string[];
    /** When set, backupReadRange returns this many bytes fewer than asked. */
    shortBy: number;
}

function makeFs(): FakeFs {
    const files = new Map<string, Uint8Array>();
    const sessions = new Map<string, { path: string; buf: Uint8Array }>();
    const fs: FakeFs = { api: undefined as unknown as NearHistoryApi, files, sessions, payloadSizes: [], aborted: [], deleted: [], shortBy: 0 };
    let n = 0;
    const api: NearHistoryApi = {
        backupStagingDir: async () => '/stage',
        backupBeginWrite: async (dir, filename) => {
            const sessionId = `s${++n}`;
            sessions.set(sessionId, { path: `${dir}/${filename}`, buf: new Uint8Array(0) });
            return { sessionId, size: 0 };
        },
        backupAppend: async (id, data) => {
            fs.payloadSizes.push(data.length);
            const s = sessions.get(id)!;
            const next = new Uint8Array(s.buf.length + data.length);
            next.set(s.buf); next.set(data, s.buf.length);
            s.buf = next;
        },
        backupWriteAt: async (id, offset, data) => {
            fs.payloadSizes.push(data.length);
            const s = sessions.get(id)!;
            if (offset < 0 || offset + data.length > s.buf.length) throw new Error('writeAt out of range');
            s.buf.set(data, offset);
        },
        backupCommit: async (id) => {
            const s = sessions.get(id)!;
            sessions.delete(id);
            files.set(s.path, s.buf);
            return { path: s.path, size: s.buf.length };
        },
        backupAbort: async (id) => { sessions.delete(id); fs.aborted.push(id); },
        backupStat: async (p) => {
            const f = files.get(p);
            return f ? { size: f.length, mtimeMs: 0 } : null;
        },
        backupReadRange: async (p, offset, length) => {
            fs.payloadSizes.push(length);
            const f = files.get(p);
            if (!f) throw new Error('ENOENT');
            const slice = f.slice(offset, offset + length - fs.shortBy);
            return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) as ArrayBuffer;
        },
        deleteFile: async (p) => { files.delete(p); fs.deleted.push(p); },
    };
    fs.api = api;
    return fs;
}

describe('createNearSpoolSink', () => {
    it('splits a 3.5 MiB write and a mid-file writeAt into <= 1 MiB IPC calls and keeps the bytes', async () => {
        const fs = makeFs();
        const spool = await createNearSpoolSink(fs.api, 'h.enc');
        const data = pattern(3.5 * MiB);
        await spool.sink.write(data);
        const patch = pattern(1.8 * MiB, 99);
        const at = 1.2 * MiB;
        await spool.sink.writeAt(at, patch);
        const { path, size } = await spool.commit();

        const expected = data.slice();
        expected.set(patch, at);
        expect(size).toBe(3.5 * MiB);
        expect(sameBytes(fs.files.get(path), expected)).toBe(true);
        expect(fs.payloadSizes.length).toBeGreaterThanOrEqual(4 + 2);
        expect(Math.max(...fs.payloadSizes)).toBeLessThanOrEqual(NEAR_IPC_CHUNK);
    });

    it('control: a single un-split write would exceed the limit (the assertion can fail)', async () => {
        const fs = makeFs();
        const { sessionId } = await fs.api.backupBeginWrite('/stage', 'x', 'fresh');
        await fs.api.backupAppend(sessionId, new Uint8Array(3 * MiB));
        expect(Math.max(...fs.payloadSizes)).toBeGreaterThan(NEAR_IPC_CHUNK);
    });

    it('abort is idempotent and discards the session; abort after commit is a no-op', async () => {
        const fs = makeFs();
        const a = await createNearSpoolSink(fs.api, 'a.enc');
        await a.sink.write(new Uint8Array(10));
        await a.abort();
        await a.abort();
        expect(fs.aborted).toHaveLength(1);
        expect(fs.sessions.size).toBe(0);
        expect(fs.files.size).toBe(0);

        const b = await createNearSpoolSink(fs.api, 'b.enc');
        await b.commit();
        await b.abort();
        expect(fs.aborted).toHaveLength(1);
    });
});

describe('createNearFileSource', () => {
    async function setup(size: number) {
        const fs = makeFs();
        const data = pattern(size);
        fs.files.set('/stage/f', data);
        return { fs, data, src: createNearFileSource(fs.api, '/stage/f') };
    }

    it('returns exact bytes for ranges crossing chunk boundaries, in <= 1 MiB IPC steps', async () => {
        const { fs, data, src } = await setup(3 * MiB + 123);
        expect(await src.size()).toBe(data.length);
        for (const [off, len] of [[0, 10], [MiB - 5, 10], [MiB - 7, 2 * MiB + 20], [0, data.length], [data.length - 1, 1], [5, 0]]) {
            expect(sameBytes(await src.read(off, len), data.subarray(off, off + len))).toBe(true);
        }
        expect(Math.max(...fs.payloadSizes)).toBeLessThanOrEqual(NEAR_IPC_CHUNK);
        expect(fs.payloadSizes.some(s => s === NEAR_IPC_CHUNK)).toBe(true);
    });

    it('rejects a short read', async () => {
        const { fs, src } = await setup(2 * MiB);
        fs.shortBy = 1;
        await expect(src.read(0, 100)).rejects.toThrow(/Short read/);
        fs.shortBy = 0;
        await expect(src.read(0, 100)).resolves.toHaveLength(100);
    });

    it('never allocates from an unchecked declared length: a read above NEAR_MAX_READ is refused before any IPC', async () => {
        const fs = makeFs();
        const calls: number[] = [];
        const api = { ...fs.api, backupStat: async () => ({ size: 8 * 1024 * MiB }), backupReadRange: async (...a: unknown[]) => { calls.push(1); return (fs.api.backupReadRange as (...x: unknown[]) => Promise<ArrayBuffer>)(...a); } } as unknown as NearHistoryApi;
        const src = createNearFileSource(api, '/stage/huge');
        await expect(src.read(0, NEAR_MAX_READ + 1)).rejects.toThrow(/out of range/);
        await expect(src.read(0, 4 * 1024 * MiB)).rejects.toThrow(/out of range/);
        expect(calls.length).toBe(0);
    });

    it('rejects out-of-range reads and a missing or shrunken file', async () => {
        const { fs, src } = await setup(1000);
        await expect(src.read(990, 11)).rejects.toThrow(/out of range/);
        await expect(src.read(-1, 5)).rejects.toThrow(/out of range/);
        await expect(src.read(990, 10)).resolves.toHaveLength(10);
        fs.files.set('/stage/f', new Uint8Array(500));
        await expect(src.read(990, 10)).rejects.toThrow(/out of range/);
        fs.files.delete('/stage/f');
        await expect(src.size()).rejects.toThrow(/missing/);
    });
});

describe('real container round trip', () => {
    it('ContainerWriter -> spool sink -> file source -> openContainer', async () => {
        const fs = makeFs();
        const km = await ContainerWriter.newKey('correct horse battery');
        const spool = await createNearSpoolSink(fs.api, 'rt.enc');
        const w = await ContainerWriter.create('correct horse battery', spool.sink, { keyMaterial: km });
        const big = pattern(2 * MiB + 17, 3);
        await w.addBytes('att:big', big);
        await w.addJson('meta', { hello: 'world' });
        await w.finish({ userId: 'u1', fingerprint: 'fp' });
        const { path, size } = await spool.commit();
        expect(Math.max(...fs.payloadSizes)).toBeLessThanOrEqual(NEAR_IPC_CHUNK);

        // "network": the file moves to the other device's staging area unchanged.
        const received = new Map<string, Uint8Array>([['/recv/h.enc', fs.files.get(path)!.slice()]]);
        const fs2 = makeFs();
        for (const [k, v] of received) fs2.files.set(k, v);
        const src = createNearFileSource(fs2.api, '/recv/h.enc');
        expect(await src.size()).toBe(size);
        const opened = await openContainer(src, 'correct horse battery');
        expect(await opened.readJson('meta')).toEqual({ hello: 'world' });
        expect(sameBytes(await opened.readBytes('att:big'), big)).toBe(true);

        // control: a flipped byte inside the `att:big` record body. The container must still OPEN (the index
        // and header are untouched, so a failure here would mean the test no longer exercises the record) and
        // that one record must fail its AES-GCM tag check (WebCrypto's OperationError), while the untouched
        // `meta` record still decrypts. Asserting the exact failure keeps this from passing vacuously.
        const bad = fs2.files.get('/recv/h.enc')!;
        bad[200] ^= 0xff;
        const reopened = await openContainer(createNearFileSource(fs2.api, '/recv/h.enc'), 'correct horse battery');
        const failure = await reopened.readBytes('att:big').then(() => null, (e: unknown) => e);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).name).toBe('OperationError');
        expect(await reopened.readJson('meta')).toEqual({ hello: 'world' });
    }, 60_000);
});

// ── Fake host bridge ───────────────────────────────────────────────────────

function snap(seq: number, state: NearState, extra: Partial<NearSnapshot> = {}): NearSnapshot {
    return { seq, role: 'approver', state, ...extra };
}

interface FakeBridge {
    api: NearHistoryApi;
    fs: FakeFs;
    emit: (s: NearSnapshot) => void;
    listeners: Set<(s: NearSnapshot) => void>;
    cancel: Mock<() => Promise<void>>;
    discard: Mock<() => Promise<void>>;
    sentPaths: string[];
    current: NearSnapshot;
    result: { path: string; size: number } | null;
    /** Run when send/receive is called (like the host starting work). */
    onStart: (b: FakeBridge) => void;
}

function makeBridge(): FakeBridge {
    const fs = makeFs();
    const listeners = new Set<(s: NearSnapshot) => void>();
    const b: FakeBridge = {
        api: fs.api, fs, listeners,
        cancel: vi.fn<() => Promise<void>>(async () => {}),
        discard: vi.fn<() => Promise<void>>(async () => {}),
        sentPaths: [],
        current: snap(1, 'approved'),
        result: null,
        onStart: () => {},
        emit: (s) => { b.current = s; for (const l of [...listeners]) l(s); },
    };
    b.api = {
        ...fs.api,
        onNearState: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        nearGetState: async () => b.current,
        nearCancel: b.cancel,
        nearTransferSend: async ({ path }) => { b.sentPaths.push(path); b.onStart(b); },
        nearTransferReceive: async () => { b.onStart(b); },
        nearTransferResult: async () => b.result,
        nearTransferDiscard: b.discard,
    };
    return b;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

const writeSome = async (sink: ByteSink): Promise<void> => { await sink.write(pattern(2.5 * MiB)); };

describe('sendHistoryOverNear', () => {
    it('spools, sends the committed path, forwards progress, resolves on done, deletes the file', async () => {
        const b = makeBridge();
        const progress: number[] = [];
        b.onStart = (x) => {
            x.emit(snap(2, 'transferring', { transfer: { direction: 'send', bytesDone: 10, bytesTotal: 100, recordsDone: 1, recordsTotal: 4, attempt: 1, paused: false, interrupted: false } }));
            x.emit(snap(3, 'done'));
        };
        await sendHistoryOverNear({ api: b.api, writeContainer: writeSome, onProgress: t => progress.push(t.bytesDone) });
        expect(b.sentPaths).toHaveLength(1);
        expect(progress).toEqual([10]);
        expect(b.fs.deleted).toEqual(b.sentPaths);
        expect(b.fs.files.size).toBe(0);
        expect(b.listeners.size).toBe(0);
    });

    it('L4: the sender discards K_xfer as soon as the transfer is done, stopped, or aborted (and not before)', async () => {
        const done = makeBridge();
        done.onStart = (x) => { expect(done.discard).not.toHaveBeenCalled(); x.emit(snap(2, 'done')); };
        await sendHistoryOverNear({ api: done.api, writeContainer: writeSome });
        expect(done.discard).toHaveBeenCalledTimes(1);
        const failed = makeBridge();
        failed.onStart = (x) => x.emit(snap(2, 'cancelled', { error: { code: 'peer_gone', message: 'bye' } }));
        await sendHistoryOverNear({ api: failed.api, writeContainer: writeSome }).catch(() => undefined);
        expect(failed.discard).toHaveBeenCalledTimes(1);
        const ac = new AbortController();
        const aborted = makeBridge();
        const p = sendHistoryOverNear({ api: aborted.api, writeContainer: writeSome, signal: ac.signal }).catch(() => undefined);
        await flush(); await flush();
        expect(aborted.discard).not.toHaveBeenCalled();
        ac.abort();
        await p;
        expect(aborted.discard).toHaveBeenCalledTimes(1);
        const writeFails = makeBridge();
        await sendHistoryOverNear({ api: writeFails.api, writeContainer: async () => { throw new Error('disk'); } }).catch(() => undefined);
        expect(writeFails.discard).toHaveBeenCalledTimes(1);
    });

    it('control: stays pending until a terminal snapshot arrives', async () => {
        const b = makeBridge();
        let settled = false;
        const p = sendHistoryOverNear({ api: b.api, writeContainer: writeSome }).then(() => { settled = true; });
        await flush(); await flush();
        expect(settled).toBe(false);
        b.emit(snap(5, 'done'));
        await p;
        expect(settled).toBe(true);
    });

    it('a completion already reported by nearGetState is not missed', async () => {
        const b = makeBridge();
        b.current = snap(9, 'done');
        await expect(sendHistoryOverNear({ api: b.api, writeContainer: writeSome })).resolves.toBeUndefined();
    });

    it.each(['failed', 'refused', 'cancelled', 'expired'] as const)('rejects on %s with the error code', async (state) => {
        const b = makeBridge();
        b.onStart = (x) => x.emit(snap(2, state, { error: { code: 'peer_gone', message: 'bye' } }));
        const err = await sendHistoryOverNear({ api: b.api, writeContainer: writeSome }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NearTransferError);
        expect((err as NearTransferError).code).toBe('peer_gone');
        expect(b.fs.deleted).toHaveLength(1);
    });

    it('survives a drop: transfer_paused -> transferring -> done resolves', async () => {
        const b = makeBridge();
        b.onStart = (x) => {
            x.emit(snap(2, 'transferring'));
            x.emit(snap(3, 'transfer_paused'));
            x.emit(snap(4, 'transferring'));
            x.emit(snap(5, 'done'));
        };
        await expect(sendHistoryOverNear({ api: b.api, writeContainer: writeSome })).resolves.toBeUndefined();
    });

    it('ignores a snapshot with a lower seq than one already applied', async () => {
        const b = makeBridge();
        let settled: 'no' | 'ok' | 'err' = 'no';
        const p = sendHistoryOverNear({ api: b.api, writeContainer: writeSome })
            .then(() => { settled = 'ok'; }, () => { settled = 'err'; });
        await flush(); await flush();
        b.emit(snap(10, 'transferring'));
        b.emit(snap(4, 'failed', { error: { code: 'stale', message: 'old' } }));
        await flush();
        expect(settled).toBe('no');
        b.emit(snap(11, 'done'));
        await p;
        expect(settled).toBe('ok');
    });

    it('abort calls nearCancel, rejects with AbortError and deletes the spooled file', async () => {
        const b = makeBridge();
        const ac = new AbortController();
        const p = sendHistoryOverNear({ api: b.api, writeContainer: writeSome, signal: ac.signal });
        const caught = p.catch((e: unknown) => e);
        await flush(); await flush();
        expect(b.sentPaths).toHaveLength(1);
        ac.abort();
        const err = await caught;
        expect((err as Error).name).toBe('AbortError');
        expect(b.cancel).toHaveBeenCalledTimes(1);
        expect(b.fs.deleted).toEqual(b.sentPaths);
        expect(b.listeners.size).toBe(0);
    });

    it('a failing writeContainer aborts the spool, never sends, and rethrows', async () => {
        const b = makeBridge();
        await expect(sendHistoryOverNear({
            api: b.api,
            writeContainer: async (sink) => { await sink.write(new Uint8Array(5)); throw new Error('disk full'); },
        })).rejects.toThrow('disk full');
        expect(b.fs.aborted).toHaveLength(1);
        expect(b.sentPaths).toHaveLength(0);
        expect(b.fs.sessions.size).toBe(0);
    });
});

describe('receiveHistoryOverNear', () => {
    function receiverWith(data: Uint8Array): FakeBridge {
        const b = makeBridge();
        b.fs.files.set('/recv/h.enc', data);
        b.result = { path: '/recv/h.enc', size: data.length };
        b.onStart = (x) => x.emit(snap(2, 'done'));
        return b;
    }

    it('imports through a file source and discards on success', async () => {
        const data = pattern(1.5 * MiB);
        const b = receiverWith(data);
        let got: Uint8Array | null = null;
        let gotSize = 0;
        await receiveHistoryOverNear({
            api: b.api,
            importContainer: async (src, size) => { gotSize = size; got = await src.read(MiB - 3, 100); },
        });
        expect(gotSize).toBe(data.length);
        expect(sameBytes(got ?? undefined, data.subarray(MiB - 3, MiB + 97))).toBe(true);
        expect(b.discard).toHaveBeenCalledTimes(1);
    });

    it('control: discard is not called before the work finished', async () => {
        const b = receiverWith(pattern(10));
        b.onStart = () => {};
        const p = receiveHistoryOverNear({ api: b.api, importContainer: async () => {} });
        await flush(); await flush();
        expect(b.discard).not.toHaveBeenCalled();
        b.emit(snap(3, 'done'));
        await p;
        expect(b.discard).toHaveBeenCalledTimes(1);
    });

    it('discards when importContainer throws', async () => {
        const b = receiverWith(pattern(10));
        await expect(receiveHistoryOverNear({
            api: b.api,
            importContainer: async () => { throw new Error('bad passphrase'); },
        })).rejects.toThrow('bad passphrase');
        expect(b.discard).toHaveBeenCalledTimes(1);
    });

    it('discards on a failed transfer and does not import', async () => {
        const b = receiverWith(pattern(10));
        b.onStart = (x) => x.emit(snap(2, 'failed', { error: { code: 'hash_mismatch', message: 'x' } }));
        const importContainer = vi.fn(async () => {});
        const err = await receiveHistoryOverNear({ api: b.api, importContainer }).catch((e: unknown) => e);
        expect((err as NearTransferError).code).toBe('hash_mismatch');
        expect(importContainer).not.toHaveBeenCalled();
        expect(b.discard).toHaveBeenCalledTimes(1);
    });

    it('rejects when the host reports done but has no result, and still discards', async () => {
        const b = receiverWith(pattern(10));
        b.result = null;
        const importContainer = vi.fn(async () => {});
        await expect(receiveHistoryOverNear({ api: b.api, importContainer })).rejects.toThrow(/no history file/);
        expect(importContainer).not.toHaveBeenCalled();
        expect(b.discard).toHaveBeenCalledTimes(1);
    });

    it('discards on abort and calls nearCancel', async () => {
        const b = receiverWith(pattern(10));
        b.onStart = () => {};
        const ac = new AbortController();
        const caught = receiveHistoryOverNear({ api: b.api, importContainer: async () => {}, signal: ac.signal })
            .catch((e: unknown) => e);
        await flush(); await flush();
        ac.abort();
        expect(((await caught) as Error).name).toBe('AbortError');
        expect(b.cancel).toHaveBeenCalledTimes(1);
        expect(b.discard).toHaveBeenCalledTimes(1);
    });

    describe('keep what arrived (contract 11.10)', () => {
        const partialFile = (b: FakeBridge, data: Uint8Array) => {
            b.fs.files.set('/recv/partial.enc', data);
            return vi.fn(async () => ({ path: '/recv/partial.enc', size: data.length, ranges: [[0, 100], [900, 100]] as [number, number][], partsHeld: 2, partsTotal: 5 }));
        };
        // the host reaches `cancelled` only once the page cancels it (that is what the user's Cancel does)
        const stopped = (b: FakeBridge) => { b.onStart = () => {}; b.current = snap(2, 'transferring'); b.cancel.mockImplementation(async () => { b.current = snap(5, 'cancelled'); }); };

        it('a stop with "keep" asks the host for the partial file, applies only through importPartial, then discards', async () => {
            const b = receiverWith(pattern(10)); stopped(b);
            const keep = partialFile(b, pattern(1000));
            b.api = { ...b.api, nearTransferKeepPartial: keep };
            const ac = new AbortController();
            let got: { size: number; ranges: readonly (readonly [number, number])[]; first: number } | null = null;
            const importContainer = vi.fn(async () => {});
            const caught = receiveHistoryOverNear({
                api: b.api, signal: ac.signal, importContainer, keepOnStop: () => true,
                importPartial: async (src, size, ranges) => { got = { size, ranges, first: (await src.read(0, 1))[0] }; },
            }).catch((e: unknown) => e);
            await flush(); await flush();
            ac.abort();
            expect(((await caught) as Error).name).toBe('AbortError');
            expect(keep).toHaveBeenCalledTimes(1);
            expect(got).toMatchObject({ size: 1000, ranges: [[0, 100], [900, 100]] });
            expect(importContainer).not.toHaveBeenCalled();
            expect(b.discard).toHaveBeenCalledTimes(1);
            expect(b.fs.deleted).toContain('/recv/partial.enc');
        });
        it('control: a stop WITHOUT keep never asks for the partial file', async () => {
            const b = receiverWith(pattern(10)); stopped(b);
            const keep = partialFile(b, pattern(1000));
            b.api = { ...b.api, nearTransferKeepPartial: keep };
            const ac = new AbortController();
            const importPartial = vi.fn(async () => {});
            const caught = receiveHistoryOverNear({ api: b.api, signal: ac.signal, importContainer: async () => {}, keepOnStop: () => false, importPartial }).catch((e: unknown) => e);
            await flush(); await flush();
            ac.abort(); await caught;
            expect(keep).not.toHaveBeenCalled(); expect(importPartial).not.toHaveBeenCalled();
            expect(b.discard).toHaveBeenCalledTimes(1);
        });
        it('a keep that finds nothing usable (host refuses) is still a clean stop that discards', async () => {
            const b = receiverWith(pattern(10)); stopped(b);
            b.api = { ...b.api, nearTransferKeepPartial: vi.fn(async () => { throw new Error('nothing arrived'); }) };
            const ac = new AbortController();
            const caught = receiveHistoryOverNear({ api: b.api, signal: ac.signal, importContainer: async () => {}, keepOnStop: () => true, importPartial: async () => { throw new Error('not reached'); } }).catch((e: unknown) => e);
            await flush(); await flush();
            ac.abort();
            expect(((await caught) as Error).name).toBe('AbortError');
            expect(b.discard).toHaveBeenCalledTimes(1);
        });
        it('a failed transfer (not a user stop) can keep too, once the host is terminal', async () => {
            const b = receiverWith(pattern(10));
            b.onStart = (x) => x.emit(snap(2, 'failed', { error: { code: 'transfer_unreachable', message: 'x' } }));
            const keep = partialFile(b, pattern(1000));
            b.api = { ...b.api, nearTransferKeepPartial: keep };
            const importPartial = vi.fn(async () => {});
            const err = await receiveHistoryOverNear({ api: b.api, importContainer: async () => {}, keepOnStop: () => true, importPartial }).catch((e: unknown) => e);
            expect((err as NearTransferError).code).toBe('transfer_unreachable');
            expect(importPartial).toHaveBeenCalledTimes(1);
        });
    });
});
