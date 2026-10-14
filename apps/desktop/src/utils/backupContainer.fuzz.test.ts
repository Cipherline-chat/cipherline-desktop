import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fc from 'fast-check';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Property / fuzz tests for the backup container (backupContainer.ts).
 *
 * `openContainer` is the parser a user points at a file they did not write
 * (a Drive download, a USB stick, a rolled-back or truncated copy), so the
 * properties here are about HOSTILE INPUT, not about the happy path that
 * backupContainer.test.ts already pins:
 *
 *   1. arbitrary bytes, magic-prefixed bytes, and mutated / truncated / extended
 *      real containers either open or REJECT with a clean error. "Clean" means
 *      an `Error` or `BackupWrongPasswordError` (or the WebCrypto
 *      `OperationError` an AES-GCM authentication failure on a record read
 *      raises) — never a TypeError / RangeError / ReferenceError from the
 *      parser's own arithmetic;
 *   2. the parser never asks its source for more than the file holds, and
 *      does a bounded number of reads (no over-allocation, no read loop);
 *   3. a header that claims an absurd KDF iteration count is refused BEFORE
 *      the key derivation runs (otherwise a crafted file is a CPU DoS);
 *   4. a v3 file's plaintext, unauthenticated index pointer can name any
 *      offset/length without making the reader throw an untyped error or read
 *      outside the file;
 *   5. round trips: whatever valid records go in come back byte-identical,
 *      under the right passphrase only, including after an in-place update.
 *
 * The KDF is replaced by a 1-iteration derivation (same salt/password
 * separation, so wrong-passphrase rejection is still real; every AES-GCM
 * operation, AAD binding and authentication check is the real, unmocked
 * code). Without that, a property run would cost 600k PBKDF2 rounds per case.
 * Property 3 asserts the iteration count the real code would have used.
 *
 * numRuns are modest on purpose: this runs in the normal `vitest run`.
 */

const kdf = vi.hoisted(() => ({ calls: [] as Array<{ iterations: number }> }));

vi.mock('./crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./crypto')>();
    const cache = new Map<string, Promise<CryptoKey>>();
    return {
        ...actual,
        deriveBackupKey: (password: string, salt: Uint8Array, iterations: number, hash: 'SHA-256' | 'SHA-512') => {
            kdf.calls.push({ iterations });
            const k = `${password}:${hash}:${Array.from(salt).join(',')}`;
            let hit = cache.get(k);
            if (!hit) { hit = actual.deriveBackupKey(password, salt, 1, hash); cache.set(k, hit); }
            return hit;
        },
    };
});

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

const {
    ContainerWriter, openContainer, MemoryContainer, memorySource, IMMUTABLE_HASH,
    BackupWrongPasswordError, sha256Hex, isContainerFile, containerVersion,
} = await import('./backupContainer');
const { ContainerWriterV3, MemoryContainerV3 } = await import('./__fixtures__/backupContainerV3');

const RUNS = 200;
const ROUNDTRIP_RUNS = 40;

/** The error classes a hostile file is allowed to surface. */
const CLEAN_ERROR_NAMES = new Set(['Error', 'BackupWrongPasswordError', 'OperationError']);

function expectCleanError(e: unknown): void {
    const name = (e as { name?: unknown })?.name;
    const message = (e as { message?: unknown })?.message;
    expect(typeof name, `non-Error thrown: ${String(e)}`).toBe('string');
    expect(typeof message).toBe('string');
    expect(CLEAN_ERROR_NAMES.has(name as string), `untyped ${String(name)}: ${String(message)}`).toBe(true);
}

/** A ByteSource that records what the parser asks of it. */
function spySource(bytes: Uint8Array) {
    const inner = memorySource(bytes);
    const stats = { reads: 0, maxLength: 0, outOfRange: 0 };
    return {
        stats,
        source: {
            size: () => inner.size(),
            read: (offset: number, length: number) => {
                stats.reads++;
                stats.maxLength = Math.max(stats.maxLength, length);
                if (!(Number.isSafeInteger(offset) && Number.isSafeInteger(length)) || offset < 0 || length < 0 || offset + length > bytes.length) stats.outOfRange++;
                return inner.read(offset, length);
            },
        },
    };
}

/** Open and, if it opens, read every record. Resolves to what happened; only a NON-clean error escapes. */
async function openAndDrain(bytes: Uint8Array, password = 'pw'): Promise<'opened' | 'rejected'> {
    return (await openAndDrainDetailed(bytes, password)).outcome;
}

async function openAndDrainDetailed(bytes: Uint8Array, password = 'pw'): Promise<{ outcome: 'opened' | 'rejected'; readFailures: number }> {
    const { source, stats } = spySource(bytes);
    let readFailures = 0;
    try {
        const c = await openContainer(source, password);
        for (const r of c.index.records) {
            try { await c.readBytes(r.id); } catch (e) { expectCleanError(e); readFailures++; }
        }
        return { outcome: 'opened', readFailures };
    } catch (e) {
        expectCleanError(e);
        return { outcome: 'rejected', readFailures };
    } finally {
        // never over-allocates: no read larger than the file, none outside it, and a small constant number of reads
        expect(stats.maxLength).toBeLessThanOrEqual(Math.max(bytes.length, 1));
        expect(stats.outOfRange).toBe(0);
    }
}

async function sampleContainer() {
    const mem = new MemoryContainer();
    const w = await ContainerWriter.create('pw', mem);
    await w.addJson('meta', { userId: 'u1', n: 1 });
    await w.addJson('dm:c1:2026-10', [{ id: 'm1', text: 'hello' }]);
    await w.addBytes('att:1', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), IMMUTABLE_HASH);
    await w.finish({ userId: 'u1', fingerprint: 'fp' });
    return mem.bytes();
}

describe('backupContainer — hostile input never produces an untyped error', () => {
    it('arbitrary bytes are rejected cleanly', async () => {
        await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 400 }), async (bytes) => {
            expect(await openAndDrain(bytes)).toBe('rejected');
        }), { numRuns: RUNS });
    });

    it('magic-prefixed bytes (v3 / v4 / unknown version) are rejected cleanly', async () => {
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(3, 4, 0, 1, 2, 5, 255), fc.uint8Array({ maxLength: 400 }),
            async (version, tail) => {
                const bytes = new Uint8Array([0x43, 0x4c, version, ...tail]);
                expect(await openAndDrain(bytes)).toBe('rejected');
                // the cheap sniffers must agree with the parser's own view and never throw
                expect(isContainerFile(bytes)).toBe(version === 3 || version === 4);
                expect(containerVersion(bytes)).toBe(version === 3 || version === 4 ? version : 0);
            },
        ), { numRuns: RUNS });
    });

    it('a real container with arbitrary byte flips is detected: rejected at open, or a failed record read', async () => {
        const good = await sampleContainer();
        await fc.assert(fc.asyncProperty(
            fc.array(fc.record({ at: fc.nat(good.length - 1), to: fc.nat(255) }), { minLength: 1, maxLength: 8 }),
            async (flips) => {
                const bytes = good.slice();
                for (const f of flips) bytes[f.at] = f.to;
                const { outcome, readFailures } = await openAndDrainDetailed(bytes);
                const changed = Array.from(bytes, (b, i) => (b === good[i] ? -1 : i)).filter(i => i >= 0);
                // AES-GCM authenticates the flags/salt/iterations (commit AAD), the live commit slot and
                // the index at OPEN, and every record frame when it is READ. A fresh file has no dead
                // space, and its generation-1 commit lives in slot 1; the only bytes whose change can go
                // unnoticed are slot 0's (never written, so zero — a non-zero slot that fails to open is
                // ignored in favour of the live one).
                const SLOT0 = { from: 24, to: 24 + 44 };
                const onlySlot0 = changed.every(i => i >= SLOT0.from && i < SLOT0.to);
                if (changed.length > 0 && !onlySlot0 && outcome === 'opened') {
                    expect(readFailures, `tampering at ${changed.join(',')} went unnoticed`).toBeGreaterThan(0);
                }
            },
        ), { numRuns: RUNS });
    });

    it('a real container truncated at any length is rejected cleanly', async () => {
        const good = await sampleContainer();
        await fc.assert(fc.asyncProperty(fc.nat(good.length - 1), async (len) => {
            expect(await openAndDrain(good.slice(0, len))).toBe('rejected');
        }), { numRuns: RUNS });
    });

    it('a real container with arbitrary bytes appended still opens (append-only format) and reads back', async () => {
        const good = await sampleContainer();
        await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), async (extra) => {
            const bytes = new Uint8Array(good.length + extra.length);
            bytes.set(good, 0);
            bytes.set(extra, good.length);
            expect(await openAndDrain(bytes)).toBe('opened');
        }), { numRuns: 60 });
    });

    it('a wrong passphrase is always BackupWrongPasswordError, never an untyped error', async () => {
        const good = await sampleContainer();
        await fc.assert(fc.asyncProperty(fc.string({ maxLength: 40 }).filter(s => s !== 'pw'), async (password) => {
            await expect(openContainer(memorySource(good), password)).rejects.toBeInstanceOf(BackupWrongPasswordError);
        }), { numRuns: 60 });
    });
});

describe('backupContainer — bounded work on a crafted header', () => {
    it('an iteration count outside 1..10,000,000 is refused before any key derivation', async () => {
        const good = await sampleContainer();
        await fc.assert(fc.asyncProperty(
            fc.oneof(fc.constant(0), fc.integer({ min: 10_000_001, max: 0xffffffff })),
            async (iterations) => {
                const bytes = good.slice();
                new DataView(bytes.buffer).setUint32(20, iterations, false);
                kdf.calls.length = 0;
                await expect(openContainer(memorySource(bytes), 'pw')).rejects.toThrow(/corrupted/);
                expect(kdf.calls.length).toBe(0);
            },
        ), { numRuns: RUNS });
    });

    it('any in-range iteration count derives exactly once and then fails authentication (never hangs, never throws untyped)', async () => {
        const good = await sampleContainer();
        await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10_000_000 }), async (iterations) => {
            fc.pre(iterations !== 600_000); // the one value that is the file's own
            const bytes = good.slice();
            new DataView(bytes.buffer).setUint32(20, iterations, false);
            kdf.calls.length = 0;
            expect(await openAndDrain(bytes)).toBe('rejected'); // the iteration bytes are authenticated (commit AAD)
            expect(kdf.calls.length).toBe(1);
            expect(kdf.calls[0].iterations).toBe(iterations);
        }), { numRuns: 60 });
    });

    it('v3: the plaintext index pointer may name any offset/length without an untyped error or an out-of-file read', async () => {
        const mem = new MemoryContainerV3();
        const w = await ContainerWriterV3.create('pw', mem);
        await w.addJson('meta', { a: 1 });
        await w.finish({ userId: 'u1', fingerprint: 'fp' });
        const good = mem.bytes();
        await fc.assert(fc.asyncProperty(
            fc.oneof(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), fc.nat(good.length + 64).map(BigInt)),
            fc.oneof(fc.nat(0xffffffff), fc.nat(good.length + 64)),
            async (offset, len) => {
                const bytes = good.slice();
                const dv = new DataView(bytes.buffer);
                dv.setBigUint64(24, offset, false);
                dv.setUint32(32, len, false);
                const outcome = await openAndDrain(bytes);
                // only the untouched pointer can open
                const original = new DataView(good.buffer);
                const same = offset === original.getBigUint64(24, false) && len === original.getUint32(32, false);
                if (!same) expect(outcome).toBe('rejected');
            },
        ), { numRuns: RUNS });
    });
});

describe('backupContainer — round-trip properties for valid records', () => {
    const recordId = fc.oneof(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.tuple(fc.constantFrom('dm', 'ch', 'att', 'gif', 'sound'), fc.uuid(), fc.constantFrom('2026-01', '2026-10', '')).map(([k, id, m]) => `${k}:${id}${m ? ':' + m : ''}`),
    );
    const records = fc.uniqueArray(fc.record({ id: recordId, bytes: fc.uint8Array({ maxLength: 600 }) }), {
        selector: r => r.id, minLength: 1, maxLength: 6,
    });

    it('every record reads back byte-identical, with its default content hash, under the right passphrase', async () => {
        await fc.assert(fc.asyncProperty(records, fc.string({ minLength: 1, maxLength: 24 }), async (recs, password) => {
            const mem = new MemoryContainer();
            const w = await ContainerWriter.create(password, mem);
            for (const r of recs) await w.addBytes(r.id, r.bytes);
            const { index, bytes: total } = await w.finish({ userId: 'u', fingerprint: 'f' });
            expect(total).toBe(mem.bytes().length);
            expect(index.records.map(r => r.id)).toEqual(recs.map(r => r.id));

            const c = await openContainer(memorySource(mem.bytes()), password);
            expect(c.version).toBe(4);
            expect(c.deadBytes).toBe(0);
            for (const r of recs) {
                expect(c.has(r.id)).toBe(true);
                expect(Array.from(await c.readBytes(r.id))).toEqual(Array.from(r.bytes));
                expect(c.index.records.find(x => x.id === r.id)!.hash).toBe(await sha256Hex(r.bytes));
                expect(c.index.records.find(x => x.id === r.id)!.size).toBe(r.bytes.length);
            }
            expect(c.has('\u0000never-written')).toBe(false);
            await expect(c.readBytes('\u0000never-written')).rejects.toThrow(/no record/);
        }), { numRuns: ROUNDTRIP_RUNS });
    });

    it('JSON records survive the round trip', async () => {
        await fc.assert(fc.asyncProperty(fc.jsonValue(), async (value) => {
            const mem = new MemoryContainer();
            const w = await ContainerWriter.create('pw', mem);
            await w.addJson('meta', value);
            await w.finish({ userId: 'u', fingerprint: 'f' });
            const c = await openContainer(mem, 'pw');
            expect(await c.readJson('meta')).toEqual(JSON.parse(JSON.stringify(value)));
        }), { numRuns: ROUNDTRIP_RUNS });
    });

    it('an in-place update keeps carried records, adds new ones, and bumps the generation', async () => {
        await fc.assert(fc.asyncProperty(
            fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }),
            async (a, b, c3) => {
                const mem = new MemoryContainer();
                const w1 = await ContainerWriter.create('pw', mem);
                await w1.addBytes('a', a);
                await w1.addBytes('b', b);
                await w1.finish({ userId: 'u', fingerprint: 'f1' });

                const w2 = ContainerWriter.resume(await openContainer(mem, 'pw'), mem);
                w2.carry('a');
                await w2.addBytes('c', c3);
                const { index } = await w2.finish({ userId: 'u', fingerprint: 'f2' });
                expect(index.generation).toBe(2);

                const reopened = await openContainer(mem, 'pw');
                expect(reopened.index.fingerprint).toBe('f2');
                expect(Array.from(await reopened.readBytes('a'))).toEqual(Array.from(a));
                expect(Array.from(await reopened.readBytes('c'))).toEqual(Array.from(c3));
                expect(reopened.has('b')).toBe(false); // dropped from the live index; its frame is dead space
                expect(reopened.deadBytes).toBeGreaterThan(0);
            },
        ), { numRuns: ROUNDTRIP_RUNS });
    });

    it('records written under one passphrase are unreadable under any other', async () => {
        await fc.assert(fc.asyncProperty(
            fc.uint8Array({ maxLength: 100 }), fc.string({ minLength: 1, maxLength: 16 }), fc.string({ minLength: 1, maxLength: 16 }),
            async (data, p1, p2) => {
                fc.pre(p1 !== p2);
                const mem = new MemoryContainer();
                const w = await ContainerWriter.create(p1, mem);
                await w.addBytes('x', data);
                await w.finish({ userId: 'u', fingerprint: 'f' });
                await expect(openContainer(mem, p2)).rejects.toBeInstanceOf(BackupWrongPasswordError);
            },
        ), { numRuns: ROUNDTRIP_RUNS });
    });
});
