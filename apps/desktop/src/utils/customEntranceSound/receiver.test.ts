import { describe, expect, it, vi } from 'vitest';
import { EntranceSoundReceiver, type DecodedAudio } from './receiver';
import { ReceivedSoundCache } from './receivedCache';
import { SoundAssembler, ASSEMBLY_TIMEOUT_MS, MAX_PENDING } from './assembler';
import { CHUNK_BYTES, deriveEntranceKey, sealSound } from './wire';
import { contentIdOf } from './identity';
import { MAX_ENCODED_BYTES, EBML_MAGIC } from './constants';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Bytes that pass the container check (WebM magic), with a body that varies by seed. */
function fakeWebm(n: number, seed = 1): Uint8Array {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed * 101) & 0xff);
    b.set(EBML_MAGIC, 0);
    return b;
}

const decoded: DecodedAudio = {
    channels: [Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 5))],
    sampleRate: 48_000,
};

function setup(opts: { expected?: Record<string, string | null>; key?: string | null; decodeOk?: boolean; now?: () => number } = {}) {
    const cache = new ReceivedSoundCache({ urls: { create: () => 'blob:x', revoke: () => {} } });
    const keyP = opts.key === null ? Promise.resolve(null) : deriveEntranceKey(opts.key ?? KEY);
    const decode = vi.fn(async () => (opts.decodeOk === false ? null : decoded));
    const expectedId = vi.fn(async (sender: string) => opts.expected?.[sender] ?? null);
    const rx = new EntranceSoundReceiver({ key: () => keyP, expectedId, decode, cache, now: opts.now });
    return { rx, cache, decode, expectedId };
}

async function packetsFor(bytes: Uint8Array, sender = ALICE, key = KEY) {
    const id = await contentIdOf(bytes);
    return { id, pkts: await sealSound(await deriveEntranceKey(key), id, bytes, sender) };
}

describe('EntranceSoundReceiver', () => {
    it('reassembles out-of-order chunks, ignores duplicates, verifies and caches', async () => {
        const bytes = fakeWebm(CHUNK_BYTES * 2 + 500);
        const { id, pkts } = await packetsFor(bytes);
        const { rx, cache } = setup({ expected: { [ALICE]: id } });
        expect(await rx.onPacket(ALICE, pkts[2])).toBe('pending');
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('pending');
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('duplicate');
        expect(await rx.onPacket(ALICE, pkts[1])).toBe('stored');
        expect(cache.get(id)?.bytes).toEqual(bytes);
        expect(cache.get(id)!.gain).toBeGreaterThan(0);
        expect(cache.get(id)!.gain).toBeLessThanOrEqual(1);
        // Already held: not decrypted again.
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('have');
    });

    it('accepts nothing without a call key', async () => {
        const bytes = fakeWebm(300);
        const { id, pkts } = await packetsFor(bytes);
        const { rx, cache } = setup({ expected: { [ALICE]: id }, key: null });
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('no-key');
        expect(cache.size()).toBe(0);
    });

    it('drops a packet sealed under a different call key, or tampered with', async () => {
        const bytes = fakeWebm(300);
        const { id, pkts } = await packetsFor(bytes, ALICE, OTHER_KEY);
        const { rx, cache } = setup({ expected: { [ALICE]: id } });
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('auth');
        const good = (await packetsFor(bytes)).pkts[0].slice();
        good[good.length - 5] ^= 0x80;
        expect(await rx.onPacket(ALICE, good)).toBe('auth');
        expect(cache.size()).toBe(0);
    });

    it('drops a sound whose id is not the one in the sender\'s server personalization', async () => {
        const bytes = fakeWebm(300);
        const { pkts } = await packetsFor(bytes);
        const { rx, cache } = setup({ expected: { [ALICE]: 'f'.repeat(32) } });
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('not-expected');
        expect(cache.size()).toBe(0);
        // ...and one whose sender advertises nothing at all.
        const { rx: rx2 } = setup({ expected: {} });
        expect(await rx2.onPacket(ALICE, pkts[0])).toBe('not-expected');
    });

    it('drops a sound whose bytes do not hash to the advertised id', async () => {
        const bytes = fakeWebm(300);
        const lie = 'a'.repeat(32);
        const pkts = await sealSound(await deriveEntranceKey(KEY), lie, bytes, ALICE);
        const { rx, cache } = setup({ expected: { [ALICE]: lie } });
        expect(await rx.onPacket(ALICE, pkts[0])).toBe('invalid');
        expect(cache.size()).toBe(0);
    });

    it('drops bytes that are not a WebM container, and bytes that do not decode', async () => {
        const notWebm = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
        const a = await packetsFor(notWebm);
        const s1 = setup({ expected: { [ALICE]: a.id } });
        expect(await s1.rx.onPacket(ALICE, a.pkts[0])).toBe('invalid');

        const b = await packetsFor(fakeWebm(300));
        const s2 = setup({ expected: { [ALICE]: b.id }, decodeOk: false });
        expect(await s2.rx.onPacket(ALICE, b.pkts[0])).toBe('undecodable');
        expect(s2.cache.size()).toBe(0);
    });

    it('a sender cannot replay someone else\'s chunks as their own', async () => {
        const bytes = fakeWebm(300);
        const { id, pkts } = await packetsFor(bytes, ALICE);
        const { rx, cache } = setup({ expected: { [BOB]: id } });
        expect(await rx.onPacket(BOB, pkts[0])).toBe('auth');
        expect(cache.size()).toBe(0);
    });

    it('rate-limits a flooding sender before any crypto', async () => {
        const { rx, expectedId } = setup({ now: () => 1000 });
        const junkButOurs = (await packetsFor(fakeWebm(300), ALICE, OTHER_KEY)).pkts[0];
        const outcomes: string[] = [];
        for (let i = 0; i < 40; i++) outcomes.push(await rx.onPacket(ALICE, junkButOurs));
        expect(outcomes.filter(o => o === 'rate').length).toBeGreaterThan(10);
        expect(expectedId).not.toHaveBeenCalled();
    });

    it('ignores packets that are not ours', async () => {
        const { rx } = setup();
        expect(await rx.onPacket(ALICE, new TextEncoder().encode('{"t":"snapshot.request"}'))).toBe('not-ours');
        expect(await rx.onPacket('', new Uint8Array(100))).toBe('not-ours');
    });
});

describe('SoundAssembler bounds', () => {
    const h = (id: string, index: number, total: number) => ({ id, index, total });
    const chunk = (n = 10) => new Uint8Array(n).fill(1);

    it('a missing chunk times out: a late chunk does not complete a stale attempt', () => {
        let t = 0;
        const a = new SoundAssembler({ now: () => t });
        expect(a.push(ALICE, h('a'.repeat(32), 0, 3), chunk()).status).toBe('pending');
        expect(a.push(ALICE, h('a'.repeat(32), 2, 3), chunk()).status).toBe('pending');
        t = ASSEMBLY_TIMEOUT_MS + 1;
        expect(a.push(ALICE, h('a'.repeat(32), 1, 3), chunk()).status).toBe('pending');
        expect(a.pendingCount()).toBe(1);
    });

    it('rejects an attempt that would exceed 64 KB', () => {
        const a = new SoundAssembler();
        const big = new Uint8Array(CHUNK_BYTES);
        for (let i = 0; i < 7; i++) expect(a.push(ALICE, h('b'.repeat(32), i, 8), big).status).toBe('pending');
        expect(a.push(ALICE, h('b'.repeat(32), 7, 8), new Uint8Array(MAX_ENCODED_BYTES - 7 * CHUNK_BYTES + 1)).status).toBe('rejected');
        expect(a.pendingCount()).toBe(0);
    });

    it('rejects too many chunks, an index out of range, and a total that changes', () => {
        const a = new SoundAssembler();
        expect(a.push(ALICE, h('c'.repeat(32), 0, 9), chunk()).status).toBe('rejected');
        expect(a.push(ALICE, h('c'.repeat(32), 3, 3), chunk()).status).toBe('rejected');
        expect(a.push(ALICE, h('c'.repeat(32), 0, 3), chunk()).status).toBe('pending');
        expect(a.push(ALICE, h('c'.repeat(32), 1, 2), chunk()).status).toBe('rejected');
        expect(a.pendingCount()).toBe(0);
    });

    it('holds one attempt per sender and a bounded number overall', () => {
        const a = new SoundAssembler();
        a.push(ALICE, h('d'.repeat(32), 0, 2), chunk());
        a.push(ALICE, h('e'.repeat(32), 0, 2), chunk()); // replaces Alice's previous one
        expect(a.pendingCount()).toBe(1);
        for (let i = 0; i < MAX_PENDING + 5; i++) a.push(`sender-${i}`, h('f'.repeat(32), 0, 2), chunk());
        expect(a.pendingCount()).toBe(MAX_PENDING);
    });
});

describe('ReceivedSoundCache', () => {
    it('is an LRU that revokes evicted URLs', () => {
        const revoked: string[] = [];
        let n = 0;
        const c = new ReceivedSoundCache({ max: 2, urls: { create: () => `blob:${++n}`, revoke: u => revoked.push(u) } });
        c.put('a', new Uint8Array(1), 1);
        c.put('b', new Uint8Array(1), 1);
        c.get('a');
        c.put('c', new Uint8Array(1), 1);
        expect(c.has('a')).toBe(true);
        expect(c.has('b')).toBe(false);
        expect(revoked).toEqual(['blob:2']);
    });

    it('clamps the gain to 0..1', () => {
        const c = new ReceivedSoundCache({ urls: { create: () => null, revoke: () => {} } });
        expect(c.put('a', new Uint8Array(1), 7).gain).toBe(1);
        expect(c.put('b', new Uint8Array(1), -1).gain).toBe(0);
    });

    it('waitFor resolves when the sound lands in time, and null (never later) when it does not', async () => {
        vi.useFakeTimers();
        try {
            const c = new ReceivedSoundCache({ urls: { create: () => 'blob:1', revoke: () => {} } });
            const early = c.waitFor('x', 1000);
            setTimeout(() => c.put('x', new Uint8Array(1), 0.5), 200);
            await vi.advanceTimersByTimeAsync(200);
            expect((await early)?.id).toBe('x');

            const late = c.waitFor('y', 1000);
            await vi.advanceTimersByTimeAsync(1001);
            expect(await late).toBeNull();
            c.put('y', new Uint8Array(1), 0.5); // arrives after the deadline: nobody is waiting
            expect(await c.waitFor('z', 0)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
