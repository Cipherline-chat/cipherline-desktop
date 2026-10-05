import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCallsChannelKey, type CallsChannelKeySource } from './useCallsChannelKey';
import { deriveVoiceChannelKeyFromB64 } from '../utils/voiceChannelKey';

const CHANNEL = '3f9d2c1e-7b4a-4c8e-9a1d-5e6f7a8b9c0d';
/** 32-byte Sender Keys, base64 — one per epoch. */
const KEY_E1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_E2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

const toB64 = (buf: ArrayBuffer) => {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s);
};

/** A fake of the main-process channel-key store. */
function source(epoch: number | null, keys: Record<number, string | null>): CallsChannelKeySource {
    return {
        getLatestChannelEpoch: vi.fn(async () => epoch),
        getChannelKey: vi.fn(async (_c: string, e: number) => keys[e] ?? null),
    };
}

describe('resolveCallsChannelKey — "no key → do not connect"', () => {
    // The single most important client-side guarantee: there is NO plaintext
    // fallback. Every failure path must resolve to 'waiting', which is what
    // stops Dashboard mounting CallPane and connecting to the LiveKit room.
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('waits when this device holds no epoch at all', async () => {
        expect(await resolveCallsChannelKey(source(null, {}), CHANNEL, null))
            .toEqual({ status: 'waiting' });
    });

    it('waits on a nonsense epoch rather than deriving from it', async () => {
        expect(await resolveCallsChannelKey(source(0, {}), CHANNEL, null))
            .toEqual({ status: 'waiting' });
    });

    it('waits when the epoch is known but its key bytes are not held', async () => {
        expect(await resolveCallsChannelKey(source(4, { 4: null }), CHANNEL, null))
            .toEqual({ status: 'waiting' });
    });

    it('fails CLOSED to waiting when the key store throws (e.g. locked keystore)', async () => {
        const throwing: CallsChannelKeySource = {
            getLatestChannelEpoch: async () => { throw new Error('keystore locked'); },
            getChannelKey: async () => null,
        };
        expect(await resolveCallsChannelKey(throwing, CHANNEL, null))
            .toEqual({ status: 'waiting' });
    });

    it('fails CLOSED when the stored Sender Key is the wrong size', async () => {
        const short = btoa(String.fromCharCode(...new Uint8Array(16)));
        expect(await resolveCallsChannelKey(source(1, { 1: short }), CHANNEL, null))
            .toEqual({ status: 'waiting' });
    });

    it('fails CLOSED on a malformed channel id rather than deriving a divergent key', async () => {
        expect(await resolveCallsChannelKey(source(1, { 1: KEY_E1 }), 'general', null))
            .toEqual({ status: 'waiting' });
    });
});

describe('resolveCallsChannelKey — ready path', () => {
    it('derives the room key for the current epoch', async () => {
        const out = await resolveCallsChannelKey(source(1, { 1: KEY_E1 }), CHANNEL, null);
        expect(out).toEqual({
            status: 'ready',
            epoch: 1,
            channelId: CHANNEL,
            keyB64: toB64(await deriveVoiceChannelKeyFromB64(KEY_E1, CHANNEL, 1)),
        });
    });

    it('never hands LiveKit the channel Sender Key itself', async () => {
        const out = await resolveCallsChannelKey(source(1, { 1: KEY_E1 }), CHANNEL, null);
        expect((out as any).keyB64).not.toBe(KEY_E1);
    });

    it('binds the key to the epoch — the same Sender Key yields a different room key', async () => {
        const a = await resolveCallsChannelKey(source(1, { 1: KEY_E1 }), CHANNEL, null);
        const b = await resolveCallsChannelKey(source(2, { 2: KEY_E1 }), CHANNEL, null);
        expect((a as any).keyB64).not.toBe((b as any).keyB64);
    });

    it('reports which channel the key is for, so a stale render cannot reuse it', async () => {
        // useCallsChannelKey's reset to 'waiting' lands in an effect, one render
        // AFTER channelId changes — so the consumer needs the key to say what it
        // belongs to. Without this, moving between two Calls channels (force-move
        // or hopping calls) would take channel A's room key into channel B's room
        // for one commit, which is enough for CallPane to mount and connect.
        const out = await resolveCallsChannelKey(source(1, { 1: KEY_E1 }), CHANNEL, null);
        expect((out as any).channelId).toBe(CHANNEL);
    });
});

describe('resolveCallsChannelKey — epoch-advance ordering (rotation on a live call)', () => {
    it('does no work while the epoch is unchanged, so the live key is not churned', async () => {
        // Returning null means "keep current state". If this re-derived every
        // poll it would hand CallPane a fresh identity and re-run setKey on
        // the live room every couple of seconds.
        const src = source(1, { 1: KEY_E1 });
        expect(await resolveCallsChannelKey(src, CHANNEL, 1)).toBeNull();
        expect(src.getChannelKey).not.toHaveBeenCalled();
    });

    it('switches the publishing key immediately when a higher epoch arrives', async () => {
        const out = await resolveCallsChannelKey(source(2, { 1: KEY_E1, 2: KEY_E2 }), CHANNEL, 1);
        expect(out).toEqual({
            status: 'ready',
            epoch: 2,
            channelId: CHANNEL,
            keyB64: toB64(await deriveVoiceChannelKeyFromB64(KEY_E2, CHANNEL, 2)),
        });
    });

    it('reports waiting — not a stale key — when the new epoch is announced but undelivered', async () => {
        // The caller keeps decrypting with the epoch it still holds; this only
        // says "epoch 2's key is not installable yet". It must never fall back
        // to publishing under epoch 1 as if nothing had changed, and must
        // never emit a key it does not have.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const out = await resolveCallsChannelKey(source(2, { 1: KEY_E1, 2: null }), CHANNEL, 1);
        expect(out).toEqual({ status: 'waiting' });
        vi.restoreAllMocks();
    });

    it('derives for the CURRENT epoch, never an older one it still holds', async () => {
        const out = await resolveCallsChannelKey(source(2, { 1: KEY_E1, 2: KEY_E2 }), CHANNEL, null);
        expect((out as any).epoch).toBe(2);
        const epoch1 = toB64(await deriveVoiceChannelKeyFromB64(KEY_E1, CHANNEL, 1));
        expect((out as any).keyB64).not.toBe(epoch1);
    });
});
