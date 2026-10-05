import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

/**
 * MEMOISE THE KDF, and nothing else.
 *
 * The rollback tests are search loops: they aim a forged pointer at every
 * frame in the file and open the container once per candidate. Every
 * `openContainer` re-derives the key with PBKDF2 at 600k iterations, so an
 * exhaustive search costs (frames x slots) full derivations of identical
 * input — the same password and the same salt every time. That is pure
 * repetition of the one thing these tests are not about, and it made them
 * load-sensitive: they passed at load 2.7 and timed out at load 7.3, which
 * is the rnnoise trap wearing a different hat.
 *
 * So: cache on (password, iterations, hash, salt) and call the REAL
 * derivation on a miss. Distinct passwords and distinct salts still derive
 * distinct keys, so wrong-passphrase rejection and per-file key separation
 * are tested exactly as before; every AES-GCM operation, AAD binding and
 * authentication check below is real and unmocked.
 */
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
    // crypto.ts's deriveBackupKey reaches for window.crypto; alias it to Node's.
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

const {
    ContainerWriter, openContainer, MemoryContainer, memorySource, teeSink,
    isContainerFile, HEADER_LEN, sha256Hex, IMMUTABLE_HASH, CONTAINER_VERSION,
} = await import('./backupContainer');

// The v3 writer exactly as shipped — see the fixture's header for why a
// frozen copy rather than a reimplementation.
const {
    ContainerWriterV3, openContainerV3, MemoryContainerV3, memorySourceV3, IMMUTABLE_HASH_V3,
} = await import('./__fixtures__/backupContainerV3');

/** Offsets of every frame in a container, walked from the header without a
 *  key — exactly the reconnaissance an attacker does before rolling a file
 *  back: append-only means every byte after the header belongs to some frame,
 *  live or superseded. */
function walkFrames(all: Uint8Array, headerLen: number): number[] {
    const offsets: number[] = [];
    const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
    let at = headerLen;
    while (at + 4 <= all.length) {
        const len = dv.getUint32(at, false);
        if (len <= 0 || at + 4 + len > all.length) break;
        offsets.push(at);
        at += 4 + len;
    }
    return offsets;
}

const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), false); return b; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function writeSample(password = 'pw', sink?: InstanceType<typeof MemoryContainer>) {
    const mem = sink ?? new MemoryContainer();
    const w = await ContainerWriter.create(password, mem);
    await w.addJson('meta', { userId: 'u1', topics: [1, 2, 3] });
    await w.addJson('dm:conv-a', [{ id: 'm1', text: 'hi' }]);
    await w.addBytes('att:file-1', new Uint8Array([9, 8, 7, 6, 5]), IMMUTABLE_HASH);
    const { index, bytes } = await w.finish({ userId: 'u1', fingerprint: 'fp-1' });
    return { mem, index, bytes };
}

describe('backupContainer — fresh write + read', () => {
    it('writes a header, records and index; reads every record back', async () => {
        const { mem, index, bytes } = await writeSample();
        const all = mem.bytes();
        expect(all.length).toBe(bytes);
        expect(isContainerFile(all)).toBe(true);
        expect(all[2]).toBe(CONTAINER_VERSION);
        expect(index.records.map(r => r.id)).toEqual(['meta', 'dm:conv-a', 'att:file-1']);
        expect(index.generation).toBe(1);

        const c = await openContainer(mem, 'pw');
        expect(c.index.userId).toBe('u1');
        expect(c.index.fingerprint).toBe('fp-1');
        expect(c.size).toBe(bytes);
        expect(c.deadBytes).toBe(0);
        expect(await c.readJson('meta')).toEqual({ userId: 'u1', topics: [1, 2, 3] });
        expect(await c.readJson('dm:conv-a')).toEqual([{ id: 'm1', text: 'hi' }]);
        expect(Array.from(await c.readBytes('att:file-1'))).toEqual([9, 8, 7, 6, 5]);
        expect(c.has('att:file-1')).toBe(true);
        expect(c.has('nope')).toBe(false);
    });

    it('records carry a content hash (sha256 for JSON, the immutable marker for blobs)', async () => {
        const { index } = await writeSample();
        const meta = index.records.find(r => r.id === 'meta')!;
        expect(meta.hash).toBe(await sha256Hex(JSON.stringify({ userId: 'u1', topics: [1, 2, 3] })));
        expect(index.records.find(r => r.id === 'att:file-1')!.hash).toBe(IMMUTABLE_HASH);
    });

    it('reads identically through a plain memory source', async () => {
        const { mem } = await writeSample();
        const c = await openContainer(memorySource(mem.bytes()), 'pw');
        expect(await c.readJson('meta')).toEqual({ userId: 'u1', topics: [1, 2, 3] });
    });

    it('record offsets/lengths locate the frames exactly', async () => {
        const { mem, index } = await writeSample();
        const all = mem.bytes();
        let expected = HEADER_LEN;
        for (const r of index.records) {
            expect(r.offset).toBe(expected);
            const declared = new DataView(all.buffer, all.byteOffset + r.offset, 4).getUint32(0, false);
            expect(declared).toBe(r.len - 4);
            expected += r.len;
        }
    });

    it('rejects the wrong passphrase with a clear message', async () => {
        const { mem } = await writeSample('right');
        await expect(openContainer(mem, 'wrong')).rejects.toThrow(/passphrase/i);
    });

    it('rejects a never-finished file (pointer unset) and a truncated one', async () => {
        const mem = new MemoryContainer();
        const w = await ContainerWriter.create('pw', mem);
        await w.addJson('meta', {});
        await expect(openContainer(mem, 'pw')).rejects.toThrow(/incomplete|corrupt/i);
        const { mem: full } = await writeSample();
        await expect(openContainer(memorySource(full.bytes().slice(0, -3)), 'pw')).rejects.toThrow(/incomplete|corrupt/i);
    });

    it('rejects a file that is not a readable container version', async () => {
        const junk = new Uint8Array(128);
        junk.set([0x43, 0x4c, 0x02], 0); // v2 magic
        await expect(openContainer(memorySource(junk), 'pw')).rejects.toThrow(/container/i);
        expect(isContainerFile(junk)).toBe(false);
        const future = new Uint8Array(128);
        future.set([0x43, 0x4c, 0x09], 0); // a version this build can't read
        expect(isContainerFile(future)).toBe(false);
    });

    it('detects a corrupted record byte (auth tag) without affecting others', async () => {
        const { mem, index } = await writeSample();
        const all = mem.bytes();
        const a = index.records.find(r => r.id === 'meta')!;
        all[a.offset + 4 + 12 + 1] ^= 0xff;
        const c = await openContainer(memorySource(all), 'pw');
        await expect(c.readJson('meta')).rejects.toThrow();
        expect(await c.readJson('dm:conv-a')).toEqual([{ id: 'm1', text: 'hi' }]);
    });

    it('refuses a record moved to another id, even with intact bytes (AAD binding)', async () => {
        const mem = new MemoryContainer();
        const w = await ContainerWriter.create('pw', mem);
        await w.addBytes('x', new Uint8Array([1, 2, 3, 4]));
        await w.addBytes('y', new Uint8Array([5, 6, 7, 8]));
        const { index } = await w.finish({ userId: 'u', fingerprint: 'f' });
        const all = mem.bytes();
        const [rx, ry] = index.records;
        expect(rx.len).toBe(ry.len);
        const fx = all.slice(rx.offset, rx.offset + rx.len);
        const fy = all.slice(ry.offset, ry.offset + ry.len);
        all.set(fy, rx.offset);
        all.set(fx, ry.offset);
        const c = await openContainer(memorySource(all), 'pw');
        await expect(c.readBytes('x')).rejects.toThrow();
        await expect(c.readBytes('y')).rejects.toThrow();
    });

    it('rejects duplicate ids and writes after finish', async () => {
        const mem = new MemoryContainer();
        const w = await ContainerWriter.create('pw', mem);
        await w.addJson('meta', {});
        await expect(w.addJson('meta', {})).rejects.toThrow(/duplicate/i);
        await w.finish({ userId: 'u', fingerprint: 'f' });
        await expect(w.addJson('later', {})).rejects.toThrow(/finished/i);
    });

    it('produces different bytes each run for the same input (fresh salt + IVs)', async () => {
        expect(sameBytes((await writeSample()).mem.bytes(), (await writeSample()).mem.bytes())).toBe(false);
    });

    it('teeSink lands identical bytes in every sink', async () => {
        const s1 = new MemoryContainer();
        const s2 = new MemoryContainer();
        const w = await ContainerWriter.create('pw', teeSink([s1, s2]));
        await w.addJson('meta', { a: 1 });
        await w.finish({ userId: 'u', fingerprint: 'f' });
        expect(sameBytes(s1.bytes(), s2.bytes())).toBe(true);
        expect((await openContainer(s2, 'pw')).index.records).toHaveLength(1);
    });
});

describe('backupContainer — in-place update', () => {
    it('appends only the changed record + a new index; unchanged records keep their bytes and offsets', async () => {
        const { mem, index: idx1, bytes: size1 } = await writeSample();
        const before = mem.bytes();

        const existing = await openContainer(mem, 'pw');
        const w = ContainerWriter.resume(existing, mem);
        expect(w.has('meta')).toBe(true);
        expect(w.hashOf('att:file-1')).toBe(IMMUTABLE_HASH);
        w.carry('meta');
        await w.addJson('dm:conv-a', [{ id: 'm1', text: 'hi' }, { id: 'm2', text: 'again' }]);
        w.carry('att:file-1');
        const { index: idx2, bytes: size2, deadBytes } = await w.finish({ userId: 'u1', fingerprint: 'fp-2' });

        // Grew by exactly: one new dm record + one new index. Old bytes untouched
        // except the 12-byte header pointer.
        const newDm = idx2.records.find(r => r.id === 'dm:conv-a')!;
        const after = mem.bytes();
        expect(size2).toBe(after.length);
        expect(newDm.offset).toBe(size1);
        expect(sameBytes(after.slice(0, 24), before.slice(0, 24))).toBe(true);                    // plaintext header prefix
        expect(sameBytes(after.slice(HEADER_LEN, size1), before.slice(HEADER_LEN, size1))).toBe(true); // every old byte incl. old index
        // Generation 2 commits into slot 0; generation 1's slot 1 is untouched,
        // which is what makes a torn commit write survivable.
        expect(sameBytes(after.slice(68, 112), before.slice(68, 112))).toBe(true);
        expect(sameBytes(after.slice(24, 68), before.slice(24, 68))).toBe(false);
        expect(idx2.records.find(r => r.id === 'meta')).toEqual(idx1.records.find(r => r.id === 'meta'));
        expect(idx2.records.find(r => r.id === 'att:file-1')).toEqual(idx1.records.find(r => r.id === 'att:file-1'));
        expect(idx2.generation).toBe(2);
        // Dead space = the superseded dm record + the old index.
        const oldDm = idx1.records.find(r => r.id === 'dm:conv-a')!;
        expect(deadBytes).toBe(oldDm.len + (size1 - HEADER_LEN - idx1.records.reduce((n, r) => n + r.len, 0)));

        const c = await openContainer(mem, 'pw');
        expect(c.index.fingerprint).toBe('fp-2');
        expect(c.deadBytes).toBe(deadBytes);
        expect(await c.readJson('dm:conv-a')).toEqual([{ id: 'm1', text: 'hi' }, { id: 'm2', text: 'again' }]);
        expect(await c.readJson('meta')).toEqual({ userId: 'u1', topics: [1, 2, 3] });
        expect(Array.from(await c.readBytes('att:file-1'))).toEqual([9, 8, 7, 6, 5]);
    });

    it('drops a record by not carrying it', async () => {
        const { mem } = await writeSample();
        const w = ContainerWriter.resume(await openContainer(mem, 'pw'), mem);
        w.carry('meta');
        w.carry('att:file-1');
        await w.finish({ userId: 'u1', fingerprint: 'fp-3' });
        const c = await openContainer(mem, 'pw');
        expect(c.has('dm:conv-a')).toBe(false);
        expect(c.index.records.map(r => r.id).sort()).toEqual(['att:file-1', 'meta']);
    });

    it('a crash before the commit leaves the previous generation fully readable', async () => {
        const { mem } = await writeSample();
        // Sink that appends normally but never patches the header — simulates
        // dying after the new records/index were written, before the commit.
        const noFlip = { write: (b: Uint8Array) => mem.write(b), writeAt: async () => { throw new Error('power cut'); } };
        const w = ContainerWriter.resume(await openContainer(mem, 'pw'), noFlip);
        w.carry('meta'); w.carry('att:file-1');
        await w.addJson('dm:conv-a', [{ id: 'm1', text: 'changed' }]);
        await expect(w.finish({ userId: 'u1', fingerprint: 'fp-x' })).rejects.toThrow(/power cut/);

        const c = await openContainer(mem, 'pw');
        expect(c.index.fingerprint).toBe('fp-1');
        expect(await c.readJson('dm:conv-a')).toEqual([{ id: 'm1', text: 'hi' }]);
        // The orphaned tail just counts as dead space.
        expect(c.deadBytes).toBeGreaterThan(0);
    });

    it('cannot carry an id the file does not have, or carry and add the same id', async () => {
        const { mem } = await writeSample();
        const w = ContainerWriter.resume(await openContainer(mem, 'pw'), mem);
        expect(() => w.carry('missing')).toThrow(/no existing record/i);
        w.carry('meta');
        await expect(w.addJson('meta', {})).rejects.toThrow(/duplicate/i);
    });

    it('sha256Hex is stable', async () => {
        expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C3 — header authentication.
//
// Each block below runs the SAME attack twice: once against the v3 writer
// exactly as shipped (the fixture), to show it works, and once against the
// current format, to show it doesn't. A "blocked" assertion that was never
// shown to succeed somewhere proves nothing about the fix.
// ───────────────────────────────────────────────────────────────────────────

/** `n` generations of the same vault, written in place, v3 — every
 *  superseded record and index still sitting in the file. */
async function v3Generations(n: number, password = 'pw') {
    const mem = new MemoryContainerV3();
    const w1 = await ContainerWriterV3.create(password, mem);
    await w1.addJson('meta', { userId: 'u1' });
    await w1.addJson('dm:c', { a: 1 });
    await w1.addBytes('att:1', new Uint8Array([9, 9, 9]), IMMUTABLE_HASH_V3);
    const gens = [await w1.finish({ userId: 'u1', fingerprint: 'fp-1' })];
    for (let g = 2; g <= n; g++) {
        const w = ContainerWriterV3.resume(await openContainerV3(mem, password), mem);
        w.carry('meta'); w.carry('att:1');
        await w.addJson('dm:c', { a: g });
        gens.push(await w.finish({ userId: 'u1', fingerprint: 'fp-' + g }));
    }
    return { mem, gens };
}

/** Same, current format. */
async function v4Generations(n: number, password = 'pw') {
    const mem = new MemoryContainer();
    const w1 = await ContainerWriter.create(password, mem);
    await w1.addJson('meta', { userId: 'u1' });
    await w1.addJson('dm:c', { a: 1 });
    await w1.addBytes('att:1', new Uint8Array([9, 9, 9]), IMMUTABLE_HASH);
    const gens = [await w1.finish({ userId: 'u1', fingerprint: 'fp-1' })];
    for (let g = 2; g <= n; g++) {
        const w = ContainerWriter.resume(await openContainer(mem, password), mem);
        w.carry('meta'); w.carry('att:1');
        await w.addJson('dm:c', { a: g });
        gens.push(await w.finish({ userId: 'u1', fingerprint: 'fp-' + g }));
    }
    return { mem, gens };
}

const v3TwoGenerations = async (password = 'pw') => {
    const { mem, gens } = await v3Generations(2, password);
    return { mem, g1: gens[0], g2: gens[1] };
};
const v4TwoGenerations = async (password = 'pw') => {
    const { mem, gens } = await v4Generations(2, password);
    return { mem, g1: gens[0], g2: gens[1] };
};

/**
 * Every generation an attacker WITHOUT the passphrase can make the reader
 * return, by patching only the header's pointer/commit region. They walk the
 * frame chain (append-only, so every superseded index is still there) and aim
 * the pointer at each frame in turn, then try simply wiping each slot.
 */
async function reachableGenerations(
    all: Uint8Array, headerLen: number, slotOffsets: number[],
    probe: (bytes: Uint8Array) => Promise<number>,
): Promise<Set<number>> {
    const found = new Set<number>();
    const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
    for (const off of walkFrames(all, headerLen)) {
        const len = dv.getUint32(off, false) + 4;
        for (const slotAt of slotOffsets) {
            const tampered = all.slice();
            tampered.set(u64(off), slotAt);
            tampered.set(u32(len), slotAt + 8);
            try { found.add(await probe(tampered)); } catch { /* didn't open */ }
        }
    }
    for (const slotAt of slotOffsets) {
        const wiped = all.slice();
        wiped.fill(0, slotAt, slotAt + 44);
        try { found.add(await probe(wiped)); } catch { /* didn't open */ }
    }
    return found;
}

describe('C3 — rolling a vault back by patching the header', () => {
    it('REPRODUCES on v3: 12 keyless bytes reach ANY earlier generation in the file', async () => {
        const { mem } = await v3Generations(4);
        const current = await openContainerV3(mem, 'pw');
        expect(current.index.generation).toBe(4);
        expect(await current.readJson('dm:c')).toEqual({ a: 4 });

        const all = mem.bytes();
        const reachable = await reachableGenerations(
            all, 36, [24],
            async (bytes) => (await openContainerV3(memorySourceV3(bytes), 'pw')).index.generation,
        );
        // The whole history is one 12-byte patch away — no key, no prior copy
        // of the file, nothing but write access.
        expect([...reachable].sort()).toEqual([1, 2, 3, 4]);   // the vulnerability

        // And a rolled-back file reads as a perfectly valid older vault.
        const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
        let sawOldest = false;
        for (const off of walkFrames(all, 36)) {
            const tampered = all.slice();
            tampered.set(u64(off), 24);
            tampered.set(u32(dv.getUint32(off, false) + 4), 32);
            try {
                const c = await openContainerV3(memorySourceV3(tampered), 'pw');
                if (c.index.generation !== 1) continue;
                expect(await c.readJson('dm:c')).toEqual({ a: 1 });
                expect(await c.readJson('meta')).toEqual({ userId: 'u1' });
                sawOldest = true;
            } catch { /* not an index frame */ }
        }
        expect(sawOldest).toBe(true);
    });

    it('is BLOCKED on v4: patching the header cannot reach an arbitrary older generation', async () => {
        const { mem } = await v4Generations(4);
        expect((await openContainer(mem, 'pw')).index.generation).toBe(4);

        const reachable = await reachableGenerations(
            mem.bytes(), HEADER_LEN, [24, 68],
            async (bytes) => (await openContainer(memorySource(bytes), 'pw')).index.generation,
        );
        // Only what the two commit slots actually hold: the current
        // generation and the one before it (see the residual test below).
        // Generations 1 and 2 are unreachable although their indexes are
        // still sitting in the file — that is the point of sealing the pointer.
        expect([...reachable].sort()).toEqual([3, 4]);
    });

    it('DOCUMENTED RESIDUAL: an attacker can fall back one generation, not further', async () => {
        // Two routes to the same place, both needing write access (and the
        // second, prior read access too) — and anyone with write access can
        // equally just delete the backup. Closing this needs a generation
        // floor remembered OUTSIDE the file; there is no in-band answer.
        //
        // This test stays exactly as it is now that the out-of-file floor
        // exists (services/backupGenerationFloor.ts, covered by its own
        // tests). What it pins is a property of the FORMAT — that the rolled
        // back file still opens, because every byte in it is honestly sealed
        // — and the floor does not and must not change that. It is advisory:
        // it warns the user, it does not make openContainer reject.
        const { mem } = await v4Generations(4);
        const atGen4 = mem.bytes();

        // (a) Destroy the newest commit slot. Generation 4 used slot 0.
        const wiped = atGen4.slice();
        wiped.fill(0, 24, 68);
        const back = await openContainer(memorySource(wiped), 'pw');
        expect(back.index.generation).toBe(3);
        expect(await back.readJson('dm:c')).toEqual({ a: 3 });

        // (b) Replay a header kept from an earlier run: reaches whatever THAT
        // header committed — equivalent to having kept a copy of the whole
        // file, which is not a capability this format can take away.
        const { mem: m2 } = await v4Generations(2);
        const replayed = m2.bytes();
        replayed.fill(0, 24, 68); // generation 2's slot
        expect((await openContainer(memorySource(replayed), 'pw')).index.generation).toBe(1);

        // Destroying BOTH slots is denial of service, not a rollback: the
        // vault is not silently older, it simply does not open.
        const dead = atGen4.slice();
        dead.fill(0, 24, HEADER_LEN);
        await expect(openContainer(memorySource(dead), 'pw')).rejects.toThrow(/incomplete|corrupt/i);
    });
});

describe('C3 — splicing one record back to an older generation', () => {
    it("REPRODUCES on v3: a same-length frame from generation 1 authenticates in generation 2's slot", async () => {
        const { mem, g1, g2 } = await v3TwoGenerations();
        const oldRef = g1.index.records.find(r => r.id === 'dm:c')!;
        const newRef = g2.index.records.find(r => r.id === 'dm:c')!;
        expect(oldRef.len).toBe(newRef.len);

        const all = mem.bytes();
        all.set(all.slice(oldRef.offset, oldRef.offset + oldRef.len), newRef.offset);
        const c = await openContainerV3(memorySourceV3(all), 'pw');
        expect(c.index.generation).toBe(2);
        expect(await c.readJson('dm:c')).toEqual({ a: 1 });   // ← the vulnerability
        expect(await c.readJson('meta')).toEqual({ userId: 'u1' }); // rest of the vault intact
    });

    it('is BLOCKED on v4: the record AAD binds the generation that wrote it', async () => {
        const { mem, g1, g2 } = await v4TwoGenerations();
        const oldRef = g1.index.records.find(r => r.id === 'dm:c')!;
        const newRef = g2.index.records.find(r => r.id === 'dm:c')!;
        expect(oldRef.len).toBe(newRef.len);
        expect(oldRef.gen).toBe(1);
        expect(newRef.gen).toBe(2);

        const all = mem.bytes();
        all.set(all.slice(oldRef.offset, oldRef.offset + oldRef.len), newRef.offset);
        const c = await openContainer(memorySource(all), 'pw');
        await expect(c.readJson('dm:c')).rejects.toThrow();
        // Only the spliced record is affected; carried records still read.
        expect(await c.readJson('meta')).toEqual({ userId: 'u1' });
    });

    it('carried records keep the generation that wrote them, not the carrying one', async () => {
        const { g1, g2 } = await v4TwoGenerations();
        expect(g2.index.records.find(r => r.id === 'meta')!.gen).toBe(1);
        expect(g2.index.records.find(r => r.id === 'meta')).toEqual(g1.index.records.find(r => r.id === 'meta'));
    });
});

describe('C3 — version downgrade', () => {
    // Measured by positive control: TWO independent mechanisms block this,
    // and either alone is sufficient — the version-tagged index AAD
    // (`cl4:index` never opens as `cl3:index`) and the `index.v === version`
    // check. Breaking just one leaves this test green; it only goes red when
    // both are gone. That is defence in depth working as intended, but it
    // does mean this test is not a regression alarm for either mechanism on
    // its own — read it as "downgrade is closed", not "the AAD is tagged".
    it('a v4 file relabelled as v3 cannot be read as v3, with or without a forged pointer', async () => {
        const { mem } = await v4TwoGenerations();
        const all = mem.bytes();
        all[2] = 3; // claim to be v3: same salt, same iterations, same key
        // With whatever happens to sit at v3's pointer offset.
        await expect(openContainer(memorySource(all.slice()), 'pw')).rejects.toThrow();
        // And with a pointer the attacker aims at every real frame: the AADs
        // are version-tagged, so a `cl4:index` frame never opens as `cl3:index`.
        for (const off of walkFrames(mem.bytes(), HEADER_LEN)) {
            const len = new DataView(all.buffer, all.byteOffset, all.byteLength).getUint32(off, false) + 4;
            const tampered = all.slice();
            tampered.set(u64(off), 24);
            tampered.set(u32(len), 32);
            await expect(openContainer(memorySource(tampered), 'pw')).rejects.toThrow();
        }
    });
});

describe('C3 — v3 files stay readable (no vault is lost to the format bump)', () => {
    it('reads a real v3 vault written by the shipped v3 writer, record for record', async () => {
        const { mem, g2 } = await v3TwoGenerations();
        const v3Bytes = mem.bytes();

        const c = await openContainer(memorySource(v3Bytes), 'pw');
        expect(c.version).toBe(3);
        expect(c.index.generation).toBe(2);
        expect(c.index.fingerprint).toBe('fp-2');
        expect(c.index.records.map(r => r.id).sort()).toEqual(['att:1', 'dm:c', 'meta']);
        expect(await c.readJson('meta')).toEqual({ userId: 'u1' });
        expect(await c.readJson('dm:c')).toEqual({ a: 2 });
        expect(Array.from(await c.readBytes('att:1'))).toEqual([9, 9, 9]);
        expect(c.size).toBe(v3Bytes.length);
        expect(c.deadBytes).toBe(g2.deadBytes);
        // Not one byte of the file was touched by reading it.
        expect(sameBytes(mem.bytes(), v3Bytes)).toBe(true);
    });

    it('reads a single-generation v3 vault, and still rejects the wrong passphrase', async () => {
        const mem = new MemoryContainerV3();
        const w = await ContainerWriterV3.create('right', mem);
        await w.addJson('meta', { userId: 'u1', n: 7 });
        await w.finish({ userId: 'u1', fingerprint: 'fp' });
        const c = await openContainer(memorySource(mem.bytes()), 'right');
        expect(await c.readJson('meta')).toEqual({ userId: 'u1', n: 7 });
        await expect(openContainer(memorySource(mem.bytes()), 'wrong')).rejects.toThrow(/passphrase/i);
    });

    it('refuses to update a v3 file in place — it must be rewritten fresh', async () => {
        const { mem } = await v3TwoGenerations();
        const opened = await openContainer(memorySource(mem.bytes()), 'pw');
        expect(() => ContainerWriter.resume(opened, new MemoryContainer())).toThrow(/v3|fresh/i);
    });

    it('a fresh write over a v3 vault produces a v4 file with the same content', async () => {
        const { mem } = await v3TwoGenerations();
        const legacy = await openContainer(memorySource(mem.bytes()), 'pw');
        const out = new MemoryContainer();
        const w = await ContainerWriter.create('pw', out);
        for (const r of legacy.index.records) await w.addBytes(r.id, await legacy.readBytes(r.id), r.hash);
        await w.finish({ userId: 'u1', fingerprint: 'fp-2' });

        const c = await openContainer(out, 'pw');
        expect(c.version).toBe(CONTAINER_VERSION);
        expect(await c.readJson('dm:c')).toEqual({ a: 2 });
        expect(Array.from(await c.readBytes('att:1'))).toEqual([9, 9, 9]);
    });
});

describe('C3 — a torn commit write is survivable (why there are two slots)', () => {
    /** A sink that appends normally but dies PART WAY THROUGH the 44-byte
     *  commit — the case a single pointer slot cannot survive, and the reason
     *  generation G commits into slot G % 2 rather than a fixed one. */
    function tearingSink(mem: InstanceType<typeof MemoryContainer>, after: number) {
        return {
            write: (b: Uint8Array) => mem.write(b),
            writeAt: async (offset: number, bytes: Uint8Array) => {
                await mem.writeAt(offset, bytes.subarray(0, after));
                throw new Error('power cut mid-commit');
            },
        };
    }

    for (const torn of [0, 1, 12, 20, 43]) {
        it(`survives losing the commit after ${torn} of 44 bytes`, async () => {
            const { mem } = await v4Generations(3);
            const before = mem.bytes();
            const w = ContainerWriter.resume(await openContainer(mem, 'pw'), tearingSink(mem, torn));
            w.carry('meta'); w.carry('att:1');
            await w.addJson('dm:c', { a: 99 });
            await expect(w.finish({ userId: 'u1', fingerprint: 'fp-torn' })).rejects.toThrow(/power cut/);

            // The half-written commit landed in slot 0 (generation 4). Slot 1
            // still holds generation 3, so the vault opens exactly as it did
            // before the interrupted run — no content silently changed.
            const c = await openContainer(mem, 'pw');
            expect(c.index.generation).toBe(3);
            expect(c.index.fingerprint).toBe('fp-3');
            expect(await c.readJson('dm:c')).toEqual({ a: 3 });
            expect(await c.readJson('meta')).toEqual({ userId: 'u1' });
            expect(Array.from(await c.readBytes('att:1'))).toEqual([9, 9, 9]);
            // Everything the old index points at is byte-identical.
            for (const r of c.index.records) {
                expect(sameBytes(
                    mem.bytes().slice(r.offset, r.offset + r.len),
                    before.slice(r.offset, r.offset + r.len),
                )).toBe(true);
            }
        });
    }

    it('a torn commit never yields a readable-but-wrong vault', async () => {
        // Exhaustive over the tear point: every prefix length of the commit
        // write either leaves the previous generation intact, or fails to
        // open. It must never open at generation 4 with partial content.
        const { mem } = await v4Generations(2);
        for (let torn = 0; torn <= 44; torn++) {
            const copy = new MemoryContainer(mem.bytes());
            const w = ContainerWriter.resume(await openContainer(copy, 'pw'), tearingSink(copy, torn));
            w.carry('meta'); w.carry('att:1');
            await w.addJson('dm:c', { a: 99 });
            await w.finish({ userId: 'u1', fingerprint: 'fp-torn' }).catch(() => {});
            let seen: { gen: number; dm: unknown } | null = null;
            try {
                const c = await openContainer(copy, 'pw');
                seen = { gen: c.index.generation, dm: await c.readJson('dm:c') };
            } catch { /* refusing to open is an acceptable outcome */ }
            if (seen) {
                // Either the old generation, or the new one COMPLETE (a full
                // 44-byte write is not torn at all).
                expect(torn === 44 ? seen : { gen: 2, dm: { a: 2 } }).toEqual(seen);
            }
        }
    });
});
