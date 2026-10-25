import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';

/**
 * F6 — a received channel key is validated before it is installed, in the
 * renderer (shape + server epoch registry) AND at main's IPC boundary
 * (electron/channel-keys.ts), because getLatestEpoch is a max over held epochs
 * and posts go out under it: one absurd epoch used to make a device post under
 * a key no other member holds, permanently.
 */

const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        setMany: (entries: Record<string, string>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
        keysWithPrefix: (p: string) => [...store.keys()].filter(k => k.startsWith(p)),
        whenDurable: async () => {},
    },
}));

const keys = await import('../../electron/channel-keys');
const { channelKeyInstallProblem, needsRegistryEpochCheck, epochWithinRegistry, MAX_CHANNEL_EPOCH } =
    await import('./channelKeyDistribution');

const ROTATES = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const key32 = () => randomBytes(32).toString('base64');

beforeEach(() => store.clear());

describe('main: setChannelKey refuses malformed installs (IPC boundary)', () => {
    it('positive control: a well-formed key installs and becomes the latest epoch', () => {
        const ch = randomUUID();
        expect(keys.setChannelKey(ch, 3, key32(), ROTATES)).toBe('stored');
        expect(keys.getLatestEpoch(ch)).toBe(3);
        // Unpadded standard base64 (another client's encoder) is accepted too.
        expect(keys.setChannelKey(ch, 4, key32().replace(/=$/, ''), ROTATES)).toBe('stored');
    });

    it.each([
        ['epoch 1e9', 1e9],
        ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
        ['zero', 0],
        ['negative', -1],
        ['fractional', 1.5],
        ['NaN', NaN],
        ['string', '2' as unknown as number],
    ])('refuses epoch %s and leaves the latest epoch untouched', (_l, epoch) => {
        const ch = randomUUID();
        keys.setChannelKey(ch, 2, key32(), ROTATES);
        expect(() => keys.setChannelKey(ch, epoch, key32(), ROTATES)).toThrow(/invalid epoch/);
        expect(keys.getLatestEpoch(ch)).toBe(2);
    });

    it.each([
        ['1 byte', Buffer.from([1]).toString('base64')],
        ['31 bytes', randomBytes(31).toString('base64')],
        ['33 bytes', randomBytes(33).toString('base64')],
        ['not base64', '!'.repeat(44)],
        ['non-string', 42 as unknown as string],
    ])('refuses a %s key', (_l, k) => {
        expect(() => keys.setChannelKey(randomUUID(), 1, k, ROTATES)).toThrow(/32-byte/);
    });

    it('refuses a non-UUID channel id', () => {
        expect(() => keys.setChannelKey('../../etc', 1, key32(), ROTATES)).toThrow(/channel id/);
        expect(() => keys.setChannelKey('', 1, key32(), ROTATES)).toThrow(/channel id/);
    });

    it('refuses an invalid rotatesAt', () => {
        expect(() => keys.setChannelKey(randomUUID(), 1, key32(), new Date('garbage'))).toThrow(/rotatesAt/);
    });

    it('rotateChannelKey refuses an out-of-range target epoch', () => {
        expect(() => keys.rotateChannelKey(randomUUID(), MAX_CHANNEL_EPOCH + 1)).toThrow(/invalid epoch/);
        const ch = randomUUID();
        expect(keys.rotateChannelKey(ch, 5).epoch).toBe(5);
    });

    it('heals a store that was poisoned before validation existed', () => {
        const ch = randomUUID();
        const good = Buffer.alloc(32, 1).toString('hex');
        store.set(`channel_keys:${ch}`, JSON.stringify({
            1: { keyHex: good, rotatesAt: ROTATES.toISOString() },
            1000000000: { keyHex: Buffer.alloc(32, 2).toString('hex'), rotatesAt: ROTATES.toISOString() },
            2: { keyHex: '01', rotatesAt: ROTATES.toISOString() },
        }));
        expect(keys.getLatestEpoch(ch)).toBe(1);
        expect(keys.listChannelEpochs(ch)).toEqual([1]);
    });
});

describe('renderer: channelKeyInstallProblem / registry bound', () => {
    const ch = '11111111-2222-4333-8444-555555555555';
    it('accepts a sound key', () => {
        expect(channelKeyInstallProblem({ key_b64: key32() }, { channel_id: ch, epoch: 7 })).toBeNull();
    });
    it.each([
        [{ key_b64: key32() }, { channel_id: ch, epoch: 1e9 }, /epoch/],
        [{ key_b64: key32() }, { channel_id: ch, epoch: 0 }, /epoch/],
        [{ key_b64: Buffer.from([1]).toString('base64') }, { channel_id: ch, epoch: 1 }, /32 bytes/],
        [{ key_b64: key32() }, { channel_id: 'nope', epoch: 1 }, /channel id/],
    ])('refuses %j / %j', (content, env, re) => {
        expect(channelKeyInstallProblem(content, env)).toMatch(re);
    });
    it('only an epoch more than one past the cached latest triggers the registry check', () => {
        expect(needsRegistryEpochCheck(5, 5)).toBe(false); // historical/current
        expect(needsRegistryEpochCheck(6, 5)).toBe(false); // a fresh mint
        expect(needsRegistryEpochCheck(7, 5)).toBe(true);
        expect(needsRegistryEpochCheck(1, undefined)).toBe(false); // bootstrap of a new channel
        expect(needsRegistryEpochCheck(2, undefined)).toBe(true);
    });
    it('the registry bound allows the registered latest and one ahead, nothing further', () => {
        expect(epochWithinRegistry(9, 9)).toBe(true);
        expect(epochWithinRegistry(10, 9)).toBe(true);
        expect(epochWithinRegistry(11, 9)).toBe(false);
        expect(epochWithinRegistry(1_000_000, 9)).toBe(false);
    });
});
