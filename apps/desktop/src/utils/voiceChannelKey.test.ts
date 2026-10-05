import { describe, it, expect } from 'vitest';
import {
    deriveVoiceChannelKey,
    deriveVoiceChannelKeyFromB64,
    buildVoiceKeyInfo,
    VOICE_KEY_INFO_PREFIX,
} from './voiceChannelKey';

const toHex = (buf: ArrayBuffer) =>
    [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const toB64 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
};
const fromHex = (hex: string) =>
    new Uint8Array(hex.match(/../g)!.map(h => parseInt(h, 16)));

/**
 * ── THE CROSS-PLATFORM TEST VECTOR ─────────────────────────────────────────
 *
 * This vector is the contract between apps/desktop and apps/mobile. Both
 * clients derive a Calls-channel LiveKit room key from the channel Sender Key
 * this way; if their outputs differ by a single byte, participants connect to
 * the room and then cannot hear each other — a failure that looks like a
 * network problem, not a crypto one.
 *
 * THE VECTOR IS AUTHORITATIVE. If this test fails, the implementation is
 * wrong. Never edit the expected values to match the code.
 */
const VECTOR = {
    ikmHex: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    channelId: '3f9d2c1e-7b4a-4c8e-9a1d-5e6f7a8b9c0d',
    epochs: [
        {
            epoch: 1,
            hex: 'c097b32b57995718219c5cc8fa9169039ae7b4917c1023c4303807a2247212a5',
            b64: 'wJezK1eZVxghnFzI+pFpA5rntJF8ECPEMDgHoiRyEqU=',
        },
        {
            epoch: 2,
            hex: '99ea6712ae0fc8e5df30dc51d84d7d6df605882f95c776fcac5ea2403b2d0a15',
            b64: 'mepnEq4PyOXfMNxR2E19bfYFiC+Vx3b8rF6iQDstChU=',
        },
        {
            epoch: 17,
            hex: 'ced1f18b10d4fc4474a3efd75345811be8fe182f0c3c70f2d5e5cc98c2844c69',
            b64: 'ztHxixDU/ER0o+/XU0WBG+j+GC8MPHDy1eXMmMKETGk=',
        },
    ],
};

describe('deriveVoiceChannelKey — cross-platform test vector', () => {
    for (const { epoch, hex, b64 } of VECTOR.epochs) {
        it(`reproduces the shared vector for epoch ${epoch}`, async () => {
            const out = await deriveVoiceChannelKey(
                fromHex(VECTOR.ikmHex),
                VECTOR.channelId,
                epoch,
            );
            expect(toHex(out)).toBe(hex);
            expect(toB64(out)).toBe(b64);
            expect(out.byteLength).toBe(32);
        });
    }

    it('derives the same bytes from the base64 wire form', async () => {
        const ikmB64 = toB64(fromHex(VECTOR.ikmHex).buffer as ArrayBuffer);
        for (const { epoch, hex } of VECTOR.epochs) {
            const out = await deriveVoiceChannelKeyFromB64(ikmB64, VECTOR.channelId, epoch);
            expect(toHex(out)).toBe(hex);
        }
    });
});

describe('voice key domain separation', () => {
    const ikm = fromHex(VECTOR.ikmHex);

    it('builds the exact info string both platforms must agree on', () => {
        expect(buildVoiceKeyInfo(VECTOR.channelId, 1))
            .toBe(`${VOICE_KEY_INFO_PREFIX}${VECTOR.channelId}/1`);
        expect(VOICE_KEY_INFO_PREFIX).toBe('cipherline/voice-key/v1/');
    });

    it('gives a different key per epoch, so a rotation is unpredictable from the old room key', async () => {
        const a = toHex(await deriveVoiceChannelKey(ikm, VECTOR.channelId, 1));
        const b = toHex(await deriveVoiceChannelKey(ikm, VECTOR.channelId, 2));
        expect(a).not.toBe(b);
    });

    it('gives a different key per channel, so one channel key never opens another room', async () => {
        const other = '00000000-0000-4000-8000-000000000001';
        const a = toHex(await deriveVoiceChannelKey(ikm, VECTOR.channelId, 1));
        const b = toHex(await deriveVoiceChannelKey(ikm, other, 1));
        expect(a).not.toBe(b);
    });

    it('never returns the Sender Key itself — the room key must not be the message key', async () => {
        const out = toHex(await deriveVoiceChannelKey(ikm, VECTOR.channelId, 1));
        expect(out).not.toBe(VECTOR.ikmHex);
    });
});

describe('voice key input normalization (interop safety)', () => {
    const ikm = fromHex(VECTOR.ikmHex);

    it('normalizes an uppercase UUID to the canonical lowercase form', async () => {
        const upper = await deriveVoiceChannelKey(ikm, VECTOR.channelId.toUpperCase(), 1);
        expect(toHex(upper)).toBe(VECTOR.epochs[0].hex);
    });

    it('accepts a byte-offset view of a larger buffer without deriving from the wrong region', async () => {
        const backing = new Uint8Array(64);
        backing.set(ikm, 16);
        const view = backing.subarray(16, 48);
        expect(view.byteLength).toBe(32);
        expect(toHex(await deriveVoiceChannelKey(view, VECTOR.channelId, 1)))
            .toBe(VECTOR.epochs[0].hex);
    });

    it.each([
        ['a braced UUID', '{3f9d2c1e-7b4a-4c8e-9a1d-5e6f7a8b9c0d}'],
        ['a UUID without dashes', '3f9d2c1e7b4a4c8e9a1d5e6f7a8b9c0d'],
        ['an empty string', ''],
        ['a non-UUID id', 'general'],
    ])('rejects %s rather than deriving a divergent key', async (_label, id) => {
        await expect(deriveVoiceChannelKey(ikm, id, 1)).rejects.toThrow(/canonical UUID/);
    });

    it.each([
        ['a non-integer epoch', 1.5],
        ['epoch 0', 0],
        ['a negative epoch', -1],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects %s rather than deriving a divergent key', async (_label, epoch) => {
        await expect(deriveVoiceChannelKey(ikm, VECTOR.channelId, epoch as number))
            .rejects.toThrow(/positive integer/);
    });

    it.each([
        ['a short key', 16],
        ['a long key', 33],
        ['an empty key', 0],
    ])('rejects %s — Sender Keys are always 32 bytes', async (_label, len) => {
        await expect(deriveVoiceChannelKey(new Uint8Array(len), VECTOR.channelId, 1))
            .rejects.toThrow(/32 bytes/);
    });
});
