import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * Replay-history durability for electron/e2ee-engine.ts.
 *
 * The replay cache (`__eph_replay__`) is a security control: an ephemeral key
 * it has seen before is refused, which is what stops a malicious relay from
 * re-delivering an already-processed envelope across a restart. The in-memory
 * `seenEphKeys` set starts EMPTY and is written back to SecureStore wholesale,
 * so ANY write that happens before the on-disk set has been read replaces a
 * real history with nothing — and every key that history held becomes
 * acceptable again.
 *
 * Two routes reached that write before the load-state gate existed:
 *
 *   1. `ensureReplayLoaded()` latched "loaded" BEFORE its try block and
 *      swallowed the failure with `catch {}`. A throwing or malformed read
 *      left the set empty and persisting enabled.
 *   2. `flushReplayCache()` runs on EVERY `before-quit` and never loaded at
 *      all — so quitting a session that had not decrypted anything wrote `[]`
 *      over the whole history. No error was required for that one.
 *
 * These tests assert the on-disk bytes survive, which is the property that
 * actually matters; they fail against the pre-fix engine.
 */

const REPLAY_KEY = '__eph_replay__';

interface StoreBehaviour {
    data: Map<string, string>;
    /** Keys whose get() throws — models SecureStore's read-before-init guard. */
    getThrowsFor: Set<string>;
    /** Keys present on disk whose get() returns null — models SecureStore
     *  swallowing a per-entry AES-GCM decrypt failure. */
    getNullFor: Set<string>;
    /** Runs inside get() for this key, once, to probe re-entrancy. */
    reentrantGet: Map<string, () => void>;
    getCalls: string[];
    setCalls: string[];
}

function freshStore(): StoreBehaviour {
    return {
        data: new Map(),
        getThrowsFor: new Set(),
        getNullFor: new Set(),
        reentrantGet: new Map(),
        getCalls: [],
        setCalls: [],
    };
}

let store: StoreBehaviour = freshStore();

vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => {
            store.getCalls.push(k);
            if (store.getThrowsFor.has(k)) {
                throw new Error(`SecureStore.get() called before initialize() completed — ${k}`);
            }
            const reentrant = store.reentrantGet.get(k);
            if (reentrant) {
                store.reentrantGet.delete(k); // fire once
                reentrant();
            }
            if (store.getNullFor.has(k)) return null;
            return store.data.get(k) ?? null;
        },
        set: (k: string, v: string) => { store.setCalls.push(k); store.data.set(k, v); },
        delete: (k: string) => { store.data.delete(k); },
        // Deferred writes are still writes: recorded in the same log, so the
        // "never persists" assertions below cover both paths.
        setDeferred: (k: string, v: string) => { store.setCalls.push(k); store.data.set(k, v); },
        deleteDeferred: (k: string) => { store.data.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.data.keys()],
    },
}));

type Engine = typeof import('../../electron/e2ee-engine');

/** Fresh module state (seenEphKeys, load state, timer) for every test —
 *  the engine holds all of it at module scope. */
async function loadEngine(): Promise<Engine> {
    vi.resetModules();
    return await import('../../electron/e2ee-engine');
}

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return {
        privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
        pubB64: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
    };
}

function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(pub).toString('base64') };
}

const SENDER_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RECIPIENT_DEVICE_ID = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

/** A real envelope plus the SPK candidate that opens it. */
async function makeEnvelope(engine: Engine) {
    const identitySig = ed25519Pair();
    const spk = x25519Pair();
    const sig = Buffer.from(ed25519.sign(
        Buffer.from(spk.pubB64, 'base64'),
        Buffer.from(identitySig.privHex, 'hex'),
    )).toString('base64');

    const result = await engine.encryptForDevices(
        JSON.stringify({ type: 'text', text: 'hello' }),
        SENDER_USER_ID,
        [{
            device_id: RECIPIENT_DEVICE_ID,
            spk_pub_b64: spk.pubB64,
            sig_b64: sig,
            identity_pub_b64: identitySig.pubB64,
        }],
    );
    return {
        envelope_b64: result.envelope_b64,
        candidates: [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }],
    };
}

/** Decrypt one fresh envelope end to end, returning its ephemeral key. */
async function decryptOne(engine: Engine): Promise<string> {
    const { envelope_b64, candidates } = await makeEnvelope(engine);
    engine.decryptEnvelope(envelope_b64, RECIPIENT_DEVICE_ID, candidates);
    const env = JSON.parse(Buffer.from(envelope_b64, 'base64').toString('utf8'));
    return env.eph as string;
}

function onDisk(): string[] | null {
    const raw = store.data.get(REPLAY_KEY);
    return raw === undefined ? null : JSON.parse(raw);
}

const EXISTING_HISTORY = ['eph-seen-one', 'eph-seen-two', 'eph-seen-three'];

describe('e2ee replay-cache persistence', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        store = freshStore();
        const identity = ed25519Pair();
        store.data.set('identity_priv', identity.privHex);
        store.data.set('identity_pub', identity.pubB64);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        vi.useRealTimers();
    });

    /** Seed a populated on-disk replay history. */
    function seedHistory(value: unknown = EXISTING_HISTORY) {
        store.data.set(REPLAY_KEY, JSON.stringify(value));
    }

    // ---------------------------------------------------------------- the bug

    it('does NOT overwrite the on-disk history when the load throws', async () => {
        seedHistory();
        store.getThrowsFor.add(REPLAY_KEY);

        const engine = await loadEngine();
        // A full, successful decrypt — this is what admits an eph into the
        // in-memory set and arms the persist.
        await decryptOne(engine);
        engine.flushReplayCache();

        // Pre-fix this read ['<the new eph>'] — three real entries destroyed.
        expect(onDisk()).toEqual(EXISTING_HISTORY);
        expect(store.setCalls).not.toContain(REPLAY_KEY);
    });

    it('does NOT overwrite the on-disk history on a quit that decrypted nothing', async () => {
        // No throw, no malformed data, no decrypt — just open and close the
        // app. flushReplayCache() fires on every before-quit.
        seedHistory();

        const engine = await loadEngine();
        engine.flushReplayCache();

        // Pre-fix this read [] — the entire history gone, with no error raised
        // anywhere and nothing unusual having happened.
        expect(onDisk()).toEqual(EXISTING_HISTORY);
    });

    it('does NOT overwrite the on-disk history when the payload is malformed JSON', async () => {
        store.data.set(REPLAY_KEY, '{ this is not json');

        const engine = await loadEngine();
        await decryptOne(engine);
        engine.flushReplayCache();

        expect(store.data.get(REPLAY_KEY)).toBe('{ this is not json');
    });

    it('does NOT overwrite the on-disk history when the payload is the wrong shape', async () => {
        seedHistory({ notAn: 'array' });

        const engine = await loadEngine();
        await decryptOne(engine);
        engine.flushReplayCache();

        expect(onDisk()).toEqual({ notAn: 'array' });
    });

    it('does NOT overwrite an entry that exists on disk but cannot be decrypted', async () => {
        // SecureStore.get() swallows a per-entry decrypt failure and returns
        // null, which is indistinguishable from "never set" at the call site.
        seedHistory();
        store.getNullFor.add(REPLAY_KEY);

        const engine = await loadEngine();
        await decryptOne(engine);
        engine.flushReplayCache();

        expect(onDisk()).toEqual(EXISTING_HISTORY);
    });

    it('gates the DEBOUNCED writer too, not just the shutdown flush', async () => {
        seedHistory();
        store.getThrowsFor.add(REPLAY_KEY);
        vi.useFakeTimers();

        const engine = await loadEngine();
        await decryptOne(engine);
        vi.advanceTimersByTime(2_000); // well past the 500ms debounce

        expect(onDisk()).toEqual(EXISTING_HISTORY);
    });

    it('surfaces an unreadable replay set instead of swallowing it', async () => {
        seedHistory();
        store.getThrowsFor.add(REPLAY_KEY);

        const engine = await loadEngine();
        await decryptOne(engine);

        expect(errorSpy).toHaveBeenCalled();
        const logged = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(logged).toContain('[E2EE:REPLAY]');
    });

    // ------------------------------------------------- positive controls

    it('round-trips a successful load: old entries kept, new one appended', async () => {
        seedHistory();

        const engine = await loadEngine();
        const newEph = await decryptOne(engine);
        engine.flushReplayCache();

        const written = onDisk() as string[];
        expect(written).toEqual(expect.arrayContaining(EXISTING_HISTORY));
        expect(written).toContain(newEph);
        expect(written).toHaveLength(EXISTING_HISTORY.length + 1);
    });

    it('persists normally on a first run, when nothing is on disk yet', async () => {
        // Guards against "fixed" by simply never writing: a genuinely absent
        // entry is a successful load and must still persist.
        const engine = await loadEngine();
        const newEph = await decryptOne(engine);
        engine.flushReplayCache();

        expect(onDisk()).toEqual([newEph]);
    });

    it('still blocks a replayed envelope across a simulated restart', async () => {
        // The end-to-end property all of the above exists to protect.
        seedHistory([]);
        const first = await loadEngine();
        const { envelope_b64, candidates } = await makeEnvelope(first);
        first.decryptEnvelope(envelope_b64, RECIPIENT_DEVICE_ID, candidates);
        first.flushReplayCache();

        // New process, same store.
        const second = await loadEngine();
        expect(() => second.decryptEnvelope(envelope_b64, RECIPIENT_DEVICE_ID, candidates))
            .toThrow(/\[E2EE:REPLAY\]/);
    });

    // ------------------------------------------- what the latch protected

    it('reads the persisted set at most once across many decrypts', async () => {
        // The load is an AES-GCM decrypt plus a JSON parse of up to 50k
        // entries, sitting on the per-message decrypt path. The original
        // latch-before-try bought this; splitting it must not give it away.
        seedHistory();

        const engine = await loadEngine();
        for (let i = 0; i < 5; i++) await decryptOne(engine);

        expect(store.getCalls.filter(k => k === REPLAY_KEY)).toHaveLength(1);
    });

    it('does not re-read after a PERMANENT failure', async () => {
        // Malformed bytes cannot parse differently on a retry, and re-reading
        // them per message would be the expensive half of the load for nothing.
        seedHistory({ notAn: 'array' });

        const engine = await loadEngine();
        await decryptOne(engine);
        await decryptOne(engine);

        expect(store.getCalls.filter(k => k === REPLAY_KEY)).toHaveLength(1);
    });

    it('DOES retry after a transient failure, and persists once it succeeds', async () => {
        // "Attempted" must not be treated as "succeeded": a store that was not
        // ready yet has to be picked up on a later decrypt.
        seedHistory();
        store.getThrowsFor.add(REPLAY_KEY);

        const engine = await loadEngine();
        await decryptOne(engine);
        expect(store.setCalls).not.toContain(REPLAY_KEY); // still not persisting

        store.getThrowsFor.delete(REPLAY_KEY); // store finished initialising
        const newEph = await decryptOne(engine);
        engine.flushReplayCache();

        expect(store.getCalls.filter(k => k === REPLAY_KEY)).toHaveLength(2);
        const written = onDisk() as string[];
        expect(written).toEqual(expect.arrayContaining(EXISTING_HISTORY));
        expect(written).toContain(newEph);
    });

    it('does not recurse when the store read re-enters the engine', async () => {
        // The re-entrancy property the old latch-before-try provided: a nested
        // ensureReplayLoaded() must return immediately rather than starting a
        // second read (or recursing without bound).
        seedHistory();

        const engine = await loadEngine();
        const nested = await makeEnvelope(engine);
        store.reentrantGet.set(REPLAY_KEY, () => {
            engine.decryptEnvelope(nested.envelope_b64, RECIPIENT_DEVICE_ID, nested.candidates);
        });

        const outerEph = await decryptOne(engine);

        expect(store.getCalls.filter(k => k === REPLAY_KEY)).toHaveLength(1);
        engine.flushReplayCache();
        const written = onDisk() as string[];
        expect(written).toEqual(expect.arrayContaining(EXISTING_HISTORY));
        expect(written).toContain(outerEph);
    });
});
