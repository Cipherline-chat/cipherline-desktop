import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * `crypto:decrypt-message` with many retained signed prekeys.
 *
 * An envelope does not name the signed prekey it was wrapped to, so the
 * decrypt path tries the retained ones until one unwraps it. When a device's
 * server-side bundle was stale (its uploads were failing) and it had rotated
 * locally every 15 minutes, that walk was hundreds of misses for every inbound
 * DM, all on the Electron main thread. These pin the fix: the walk is sliced
 * (the thread gets turns), the key that opened the last envelope is tried next
 * time, and NOTHING about which envelopes are accepted changed.
 *
 * Only SecureStore is mocked (it imports `electron`); the crypto is real.
 */

const store = new Map<string, string>();
let getCalls: string[] = [];
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => { getCalls.push(k); return store.get(k) ?? null; },
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
        keysWithPrefix: (p: string) => [...store.keys()].filter(k => k.startsWith(p)),
        whenDurable: async () => {},
        initialize: async () => {},
    },
}));

const { encryptForDevices, decryptWithRetainedSpks } = await import('../../electron/e2ee-engine');
const { SpkCandidateOrder } = await import('../../electron/spk-candidates');

const SENDER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

function x25519Pair() {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    const j = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    return { privHex: Buffer.from(j.d, 'base64url').toString('hex'), pubB64: Buffer.from(j.x, 'base64url').toString('base64') };
}
function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(ed25519.getPublicKey(priv)).toString('base64') };
}

/** Retain `n` signed prekeys (ids 1..n, n active); return a device record for `wrapTo`. */
function retainSpks(n: number, wrapTo: number) {
    const recip = ed25519Pair();
    let target: { device_id: string; spk_pub_b64: string; sig_b64: string; identity_pub_b64: string } | null = null;
    for (let id = 1; id <= n; id++) {
        const spk = x25519Pair();
        store.set(`signed_prekey_priv_${id}`, spk.privHex);
        store.set(`signed_prekey_pub_${id}`, spk.pubB64);
        if (id === wrapTo) {
            const sig = Buffer.from(ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(recip.privHex, 'hex'))).toString('base64');
            target = { device_id: DEVICE, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: recip.pubB64 };
        }
    }
    store.set('signed_prekey_active_id', String(n));
    return target!;
}

async function envelopeTo(device: ReturnType<typeof retainSpks>, body: string) {
    const { envelope_b64 } = await encryptForDevices(JSON.stringify({ type: 'text', body }), SENDER, [device], DEVICE);
    return envelope_b64;
}

/** Event-loop turns that elapse while `p` is pending. */
async function turnsDuring<T>(p: Promise<T>): Promise<{ turns: number; value: T }> {
    let turns = 0;
    let stop = false;
    const tick = () => { if (stop) return; turns++; setImmediate(tick); };
    setImmediate(tick);
    try { const value = await p; return { turns, value }; } finally { stop = true; }
}

const triedSpkPrivs = () => getCalls.filter(k => k.startsWith('signed_prekey_priv_')).length;

beforeEach(() => {
    store.clear();
    getCalls = [];
    const sender = ed25519Pair();
    store.set('identity_priv', sender.privHex);
    store.set('identity_pub', sender.pubB64);
});

describe('SpkCandidateOrder', () => {
    it('active first, then most-recently successful, then id descending — each id once, only ids that exist', () => {
        const order = new SpkCandidateOrder(2);
        expect(order.order([1, 2, 3, 4, 5], 5)).toEqual([5, 4, 3, 2, 1]);
        order.noteSuccess(2);
        order.noteSuccess(1);
        expect(order.order([1, 2, 3, 4, 5], 5)).toEqual([5, 1, 2, 4, 3]);
        order.noteSuccess(3);                     // bounded: 2 forgotten
        expect(order.order([1, 2, 3, 4, 5], 5)).toEqual([5, 3, 1, 4, 2]);
        expect(order.order([4, 5], 5)).toEqual([5, 4]);   // pruned ids never appear
        expect(order.order([4, 5], null)).toEqual([5, 4]);
    });
});

describe('decryptWithRetainedSpks', () => {
    it('opens an envelope wrapped to the OLDEST of 300 retained keys, yielding the event loop during the walk', async () => {
        const device = retainSpks(300, 1);
        const env = await envelopeTo(device, 'from a stale bundle');
        const order = new SpkCandidateOrder();
        const { turns, value } = await turnsDuring(decryptWithRetainedSpks(env, DEVICE, order));
        expect(JSON.parse(value.contentJson).body).toBe('from a stale bundle');
        expect(turns).toBeGreaterThan(0);          // the walk did not hold the thread end to end
    });

    it('the next envelope to the same key is opened on the SECOND try, not after another full walk', async () => {
        const device = retainSpks(300, 1);
        const order = new SpkCandidateOrder();
        await decryptWithRetainedSpks(await envelopeTo(device, 'one'), DEVICE, order);
        getCalls = [];
        const r = await decryptWithRetainedSpks(await envelopeTo(device, 'two'), DEVICE, order);
        expect(JSON.parse(r.contentJson).body).toBe('two');
        expect(triedSpkPrivs()).toBe(2);           // active (miss), then the remembered one (hit)
    });

    it('the active key still opens on the first try, without touching any other private', async () => {
        const device = retainSpks(50, 50);
        await decryptWithRetainedSpks(await envelopeTo(device, 'hi'), DEVICE, new SpkCandidateOrder());
        expect(triedSpkPrivs()).toBe(1);
    });

    it('same acceptance as before: a replay is refused even when found deep in a sliced walk', async () => {
        const device = retainSpks(300, 1);
        const env = await envelopeTo(device, 'once');
        await decryptWithRetainedSpks(env, DEVICE, new SpkCandidateOrder());
        // A fresh order (as after a restart) forces the long walk again; the
        // replay guard must still fire, not a generic wrap failure.
        await expect(decryptWithRetainedSpks(env, DEVICE, new SpkCandidateOrder())).rejects.toThrow(/REPLAY/);
    });

    it('an envelope no retained key can open fails with the wrap error after trying every key', async () => {
        retainSpks(40, 40);
        const stranger = (() => {
            const recip = ed25519Pair();
            const spk = x25519Pair();
            const sig = Buffer.from(ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(recip.privHex, 'hex'))).toString('base64');
            return { device_id: DEVICE, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: recip.pubB64 };
        })();
        const env = await envelopeTo(stranger, 'not for us');
        getCalls = [];
        await expect(decryptWithRetainedSpks(env, DEVICE, new SpkCandidateOrder())).rejects.toThrow(/WRAP_AUTH_FAILED/);
        expect(triedSpkPrivs()).toBe(40);
    });

    it('no signed prekeys at all → NO_SPK, as before', async () => {
        await expect(decryptWithRetainedSpks('e30=', DEVICE, new SpkCandidateOrder())).rejects.toThrow(/NO_SPK/);
    });
});
