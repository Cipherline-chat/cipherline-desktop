import { describe, expect, it } from 'vitest';
import {
    CHUNK_BYTES, HEADER_BYTES, MAX_CHUNKS, MAX_PACKET_BYTES, deriveEntranceKey, openPacket, parseHeader, sealSound,
} from './wire';
import { MAX_ENCODED_BYTES } from './constants';

const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const ID = '0123456789abcdef0123456789abcdef';
const ALICE = '11111111-1111-4111-8111-111111111111';
const MALLORY = '22222222-2222-4222-8222-222222222222';

const sound = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

async function openAll(key: CryptoKey, pkts: Uint8Array[], sender: string) {
    const out: Uint8Array[] = [];
    for (const p of pkts) {
        const r = await openPacket(key, p, sender);
        if (!r) return null;
        out.push(r.chunk);
    }
    const total = out.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const c of out) { joined.set(c, o); o += c.length; }
    return joined;
}

describe('entrance-sound wire encryption', () => {
    it('round-trips a sound split into chunks that each fit a reliable data packet', async () => {
        const key = await deriveEntranceKey(KEY_A);
        const bytes = sound(20_000);
        const pkts = await sealSound(key, ID, bytes, ALICE);
        expect(pkts.length).toBe(3);
        for (const p of pkts) expect(p.length).toBeLessThanOrEqual(MAX_PACKET_BYTES);
        expect(MAX_PACKET_BYTES).toBeLessThan(15 * 1024);
        expect(await openAll(key, pkts, ALICE)).toEqual(bytes);
    });

    it('a maximum-size sound is at most MAX_CHUNKS packets', async () => {
        const key = await deriveEntranceKey(KEY_A);
        const pkts = await sealSound(key, ID, sound(MAX_ENCODED_BYTES), ALICE);
        expect(pkts.length).toBe(MAX_CHUNKS);
        await expect(sealSound(key, ID, sound(MAX_ENCODED_BYTES + 1), ALICE)).rejects.toThrow('bad size');
    });

    it('never sends plaintext: the chunk bytes do not appear in the packet', async () => {
        const key = await deriveEntranceKey(KEY_A);
        const bytes = new TextEncoder().encode('PLAINTEXT-MARKER-'.repeat(20));
        const [pkt] = await sealSound(key, ID, bytes, ALICE);
        const hay = Array.from(pkt).join(',');
        expect(hay.includes(Array.from(bytes.subarray(0, 16)).join(','))).toBe(false);
    });

    it('uses a fresh nonce per packet (same input, different ciphertext)', async () => {
        const key = await deriveEntranceKey(KEY_A);
        const a = await sealSound(key, ID, sound(100), ALICE);
        const b = await sealSound(key, ID, sound(100), ALICE);
        expect(Array.from(a[0].subarray(HEADER_BYTES, HEADER_BYTES + 12))).not.toEqual(Array.from(b[0].subarray(HEADER_BYTES, HEADER_BYTES + 12)));
    });

    it('rejects a flipped ciphertext byte, a flipped nonce byte, and a flipped tag byte', async () => {
        const key = await deriveEntranceKey(KEY_A);
        const [pkt] = await sealSound(key, ID, sound(500), ALICE);
        for (const at of [HEADER_BYTES + 12 + 3, HEADER_BYTES + 2, pkt.length - 1]) {
            const bad = pkt.slice();
            bad[at] ^= 0x01;
            expect(await openPacket(key, bad, ALICE)).toBeNull();
        }
        expect(await openPacket(key, pkt, ALICE)).not.toBeNull(); // positive control
    });

    it('rejects the wrong call key', async () => {
        const [pkt] = await sealSound(await deriveEntranceKey(KEY_A), ID, sound(500), ALICE);
        expect(await openPacket(await deriveEntranceKey(KEY_B), pkt, ALICE)).toBeNull();
    });

    it('binds the id, chunk index, total and sender (AAD)', async () => {
        const key = await deriveEntranceKey(KEY_A);
        const pkts = await sealSound(key, ID, sound(CHUNK_BYTES * 2 + 10), ALICE);
        // Moved to another position.
        const moved = pkts[0].slice(); moved[21] = 1;
        expect(await openPacket(key, moved, ALICE)).toBeNull();
        // Claimed a different total.
        const total = pkts[2].slice(); total[22] = 4;
        expect(await openPacket(key, total, ALICE)).toBeNull();
        // Re-labelled with another id.
        const relabel = pkts[0].slice(); relabel[5] ^= 0xff;
        expect(await openPacket(key, relabel, ALICE)).toBeNull();
        // Replayed as someone else's.
        expect(await openPacket(key, pkts[0], MALLORY)).toBeNull();
        expect(await openPacket(key, pkts[0], ALICE)).not.toBeNull();
    });

    it('the key is domain-separated from the raw call key (it is not the call key itself)', async () => {
        const derived = await deriveEntranceKey(KEY_A);
        const raw = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['decrypt']);
        const [pkt] = await sealSound(derived, ID, sound(64), ALICE);
        expect(await openPacket(raw, pkt, ALICE)).toBeNull();
    });

    it('refuses to derive without a well-formed 32-byte call key', async () => {
        await expect(deriveEntranceKey('')).rejects.toThrow('no call key');
        await expect(deriveEntranceKey('short')).rejects.toThrow('no call key');
    });

    it('parseHeader drops foreign / malformed packets before any crypto', () => {
        expect(parseHeader(new Uint8Array(10))).toBeNull();
        expect(parseHeader(new TextEncoder().encode('{"t":"stroke.begin"}'.padEnd(80, ' ')))).toBeNull();
        const fake = new Uint8Array(HEADER_BYTES + 12 + 17);
        fake.set([0x43, 0x4c, 0x45, 0x53, 1]);
        fake[21] = 0; fake[22] = MAX_CHUNKS + 1;
        expect(parseHeader(fake)).toBeNull();
        fake[22] = 2; fake[21] = 2;
        expect(parseHeader(fake)).toBeNull();
        fake[21] = 1;
        expect(parseHeader(fake)).toEqual({ id: '0'.repeat(32), index: 1, total: 2 });
        expect(parseHeader(new Uint8Array(MAX_PACKET_BYTES + 1))).toBeNull();
    });
});
