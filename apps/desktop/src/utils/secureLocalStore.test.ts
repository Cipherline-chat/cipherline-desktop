import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import { KvCrypto } from '../../electron/kv-crypto';

// A fixed 32-byte AES key (base64) so encryption is deterministic across tests.
const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const TEST_KEY_B64_ALT = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

type ExResult = { status: 'ok'; keyB64: string } | { status: 'absent' } | { status: 'locked' };

/**
 * Install the renderer's view of the main process.
 *
 * The bridge is backed by the REAL `KvCrypto` from `electron/kv-crypto.ts`,
 * not a mock of it. That matters: the master key no longer crosses the context
 * bridge, so "does the store still work" and "does main's crypto match the
 * format the store expects" are the same question, and a mocked bridge would
 * answer neither. Every test below therefore exercises the full path —
 * renderer facade → IPC shape → main's Node crypto → IndexedDB → back.
 *
 * `absent` is modelled the way the real system produces it: the keystore is
 * reachable but has no key, so records are written TAG_RAW.
 */
function setMasterKey(result: ExResult) {
    const keyBytes = result.status === 'ok' ? Buffer.from(result.keyB64, 'base64') : null;
    const kv = new KvCrypto({
        status: () => (result.status === 'locked' ? 'locked' : 'ok'),
        keyBytes: () => keyBytes,
    });
    (globalThis as any).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: result.status })),
        secureKvOpen: vi.fn(async (recs: Array<{ k: string; o: string | null; b: Uint8Array }>) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Array<{ k: string; o: string | null; v: string }>) => kv.seal(recs)),
    };
}

/** The store must never be handed the master key. Asserted in its own test. */
function bridgeExposesMasterKey(): boolean {
    const api = (globalThis as any).window.electronAPI ?? {};
    return typeof api.getLocalMasterKeyEx === 'function';
}

/** Wipe IndexedDB between tests so each starts from a clean store. */
async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

/** Reset all singletons so a fresh hydrate re-reads from disk. */
function resetSingletons() {
    secureLocalStore._resetForTest();
    // Nothing else to reset: the renderer no longer memoizes any key material
    // for this store. setMasterKey() builds a fresh KvCrypto each time.
}

/** Minimal synchronous in-memory localStorage for migration tests. */
function installFakeLocalStorage(seed: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(seed));
    (globalThis as any).localStorage = {
        get length() { return m.size; },
        key: (i: number) => [...m.keys()][i] ?? null,
        getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
        setItem: (k: string, v: string) => { m.set(k, String(v)); },
        removeItem: (k: string) => { m.delete(k); },
        clear: () => m.clear(),
    };
    return m;
}

function clearFakeLocalStorage() {
    delete (globalThis as any).localStorage;
}

beforeEach(async () => {
    await wipeDb();
    resetSingletons();
    setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
});

afterEach(() => {
    vi.restoreAllMocks();
    clearFakeLocalStorage();
});

describe('secureLocalStore — basics', () => {
    it('throws if accessed before hydrate()', () => {
        expect(() => secureLocalStore.getItem('x')).toThrow(/before hydrate/);
        expect(() => secureLocalStore.setItem('x', 'y')).toThrow(/before hydrate/);
    });

    it('round-trips values and persists across re-hydrate', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_voice_settings', '{"vol":1}');
        secureLocalStore.setItem('cipherline_device_id', 'dev-123');
        await secureLocalStore.flushNow();

        // Re-hydrate from disk with the same master key.
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        expect(secureLocalStore.getItem('cipherline_voice_settings')).toBe('{"vol":1}');
        expect(secureLocalStore.getItem('cipherline_device_id')).toBe('dev-123');
        expect(secureLocalStore.getItem('missing')).toBeNull();
    });

    it('removeItem persists as a deletion', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_keybinds', 'a');
        await secureLocalStore.flushNow();
        secureLocalStore.removeItem('cipherline_keybinds');
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBeNull();
    });

    it('length and key(i) reflect the store', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('a', '1');
        secureLocalStore.setItem('b', '2');
        expect(secureLocalStore.length).toBe(2);
        const keys = [secureLocalStore.key(0), secureLocalStore.key(1)];
        expect(keys).toContain('a');
        expect(keys).toContain('b');
        expect(secureLocalStore.key(5)).toBeNull();
    });

    it('coalesces multiple writes to one key (debounced)', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_status_text_x', 'one');
        secureLocalStore.setItem('cipherline_status_text_x', 'two');
        secureLocalStore.setItem('cipherline_status_text_x', 'three');
        await secureLocalStore.flushNow();
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_status_text_x')).toBe('three');
    });
});

describe('secureLocalStore — per-account isolation', () => {
    it('hydrating as one user does not load another user\'s records', async () => {
        // Log in as A and write A's history.
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_msgs_${USER_A}`, 'secret-A');
        await secureLocalStore.flushNow();

        // B logs in on the same device (overwrites the pointer, writes B's data).
        secureLocalStore.setItem('cipherline_user_id', USER_B);
        secureLocalStore.setItem(`cipherline_msgs_${USER_B}`, 'secret-B');
        await secureLocalStore.flushNow();

        // Fresh hydrate: active user is B (last written pointer) → only B's data.
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        // Message history hydrates in the SECOND phase (it's deferred so it
        // can't block first paint), so isolation is asserted after that phase
        // — which is also the only point any real caller reads these keys.
        await secureLocalStore.hydrateMessages();
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_B}`)).toBe('secret-B');
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}`)).toBeNull();

        // Switch the pointer back to A and re-hydrate → A's data returns.
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.flushNow();
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        await secureLocalStore.hydrateMessages();
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}`)).toBe('secret-A');
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_B}`)).toBeNull();
    });

    it('user A ciphertext does not decrypt under user B subkey', async () => {
        // Independent of owner-metadata filtering — prove the crypto itself.
        // The subkeys are derived inside main now, so this drives KvCrypto
        // directly rather than a renderer-side derivation that no longer exists.
        const kv = new KvCrypto({
            status: () => 'ok',
            keyBytes: () => Buffer.from(TEST_KEY_B64, 'base64'),
        });
        const [sealed] = kv.seal([{ k: 'k', o: USER_A, v: 'top-secret' }]);
        expect(sealed.b).not.toBeNull();
        // Correct owner → correct subkey → opens.
        expect(kv.open([{ k: 'k', o: USER_A, b: sealed.b! }])).toEqual([{ k: 'k', v: 'top-secret' }]);
        // Wrong owner → wrong subkey → GCM auth failure, reported as a skip.
        expect(kv.open([{ k: 'k', o: USER_B, b: sealed.b! }])).toEqual([{ k: 'k', v: null }]);
    });
});

/**
 * The point of the whole change: the device master key does not cross the
 * context bridge.
 *
 * These are the tests that would catch a regression reintroducing it — whether
 * by restoring the `-ex` channel or by adding some new "just give me the key"
 * accessor. They assert on the BRIDGE SURFACE the store is given, because that
 * is the actual boundary; asserting on internals would pass just as happily
 * against a store that fetched the key and kept it in a private field.
 */
describe('secureLocalStore — the master key never reaches the renderer', () => {
    it('works with a bridge that exposes no master-key channel at all', async () => {
        // setMasterKey() installs exactly three channels, none of which return
        // key material: a status query, and the two crypto round-trips.
        expect(bridgeExposesMasterKey()).toBe(false);
        const api = (globalThis as any).window.electronAPI;
        expect(Object.keys(api).sort()).toEqual(['getLocalMasterKeyStatus', 'secureKvOpen', 'secureKvSeal']);

        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_device_id', 'dev-xyz');
        await secureLocalStore.flushNow();
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_device_id')).toBe('dev-xyz');
    });

    it('never asks the bridge for raw key bytes, only for status and crypto', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, '[]');
        await secureLocalStore.flushNow();
        await secureLocalStore.hydrateMessages();

        const api = (globalThis as any).window.electronAPI;
        // The status channel is allowed — it answers a yes/no question and
        // moves no key material. The other two carry ciphertext and plaintext.
        expect(api.secureKvSeal).toHaveBeenCalled();
        // Whatever crossed the bridge, none of it was a key: the only values
        // sent up are store keys, owner ids and the user's own plaintext.
        for (const call of api.secureKvSeal.mock.calls) {
            for (const rec of call[0]) {
                expect(Object.keys(rec).sort()).toEqual(['k', 'o', 'v']);
            }
        }
    });

    it('a record sealed by main is opaque to the renderer', async () => {
        // The renderer holds no key, so the bytes it writes to IndexedDB are
        // bytes it cannot itself interpret. Pin that they are really encrypted
        // rather than, say, base64 of the plaintext.
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_device_id', 'plaintext-marker');
        await secureLocalStore.flushNow();

        const db = await (await import('./attachmentCache')).openDb();
        const rec = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction('kv_enc', 'readonly');
            const req = tx.objectStore('kv_enc').get('cipherline_device_id');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        expect(rec).toBeTruthy();
        const bytes: Uint8Array = rec.b;
        expect(bytes[0]).toBe(0x01); // TAG_WRAPPED — main encrypted it
        expect(new TextDecoder().decode(bytes)).not.toContain('plaintext-marker');
    });
});

describe('secureLocalStore — clean cutover (no migration)', () => {
    it('purges legacy plaintext on hydrate and does NOT import it', async () => {
        const ls = installFakeLocalStorage({
            cipherline_user_id: USER_A,
            cipherline_voice_settings: '{"vol":0.5}',
            [`cipherline_msgs_${USER_A}`]: 'hello-A',
            cl_hx_abc: '1',
            unrelated_key: 'keep-me',
        });

        await secureLocalStore.hydrate();

        // Managed plaintext is deleted; nothing is migrated into the store.
        expect(ls.has('cipherline_voice_settings')).toBe(false);
        expect(ls.has(`cipherline_msgs_${USER_A}`)).toBe(false);
        expect(ls.has('cl_hx_abc')).toBe(false);
        expect(secureLocalStore.getItem('cipherline_voice_settings')).toBeNull();
        // Unmanaged keys are left untouched.
        expect(ls.get('unrelated_key')).toBe('keep-me');
    });
});

describe('secureLocalStore — degraded states', () => {
    it('absent keystore still round-trips (unencrypted fallback)', async () => {
        setMasterKey({ status: 'absent' });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.isLocked()).toBe(false);
        expect(secureLocalStore.masterKeyStatus()).toBe('absent');
        secureLocalStore.setItem('cipherline_keybinds', 'plain');
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'absent' });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_keybinds')).toBe('plain');
    });

    it('locked keystore performs no reads or writes', async () => {
        // First, write some encrypted data with a real key.
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_device_id', 'preserved');
        await secureLocalStore.flushNow();

        // Now the key is locked: hydrate must not load, and writes are no-ops.
        resetSingletons();
        setMasterKey({ status: 'locked' });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.isLocked()).toBe(true);
        expect(secureLocalStore.getItem('cipherline_device_id')).toBeNull();

        secureLocalStore.setItem('cipherline_device_id', 'overwrite-attempt');
        await secureLocalStore.flushNow();

        // Recover with the real key — original data is intact (never overwritten).
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_device_id')).toBe('preserved');
    });

    it('wrong master key cannot read another key\'s records', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_device_id', 'k7-data');
        await secureLocalStore.flushNow();

        // Different master key → master-tier records fail to decrypt → skipped.
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64_ALT });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_device_id')).toBeNull();
    });
});

// ── Home-screen state across restarts ────────────────────────────────────────
// The home screen's pins and last-activity clock are per-user records
// (`cipherline_home_pins_<userId>`), and losing them is user-visible: the
// screen comes back blank. These pin the round-trip and the two orderings that
// look most likely to break it, because ownerFor() decides a record's
// encryption tier at FLUSH time from whatever activeUserId is *then* — not
// when setItem was called.
describe('secureLocalStore — home-screen records survive a restart', () => {
    const pins = JSON.stringify([
        { type: 'server', serverId: 'srv-1' },
        { type: 'channel', channelId: 'chn-1', serverId: 'srv-1' },
        { type: 'conversation', id: 'conv-1' },
    ]);

    it('round-trips home pins written after the session pointer', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pins);
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pins);
    });

    it('round-trips pins flushed BEFORE the session pointer exists', async () => {
        // Filed master-tier (activeUserId still null at flush) — must still be
        // readable, since hydrate decrypts master-tier records first.
        await secureLocalStore.hydrate();
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pins);
        await secureLocalStore.flushNow();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pins);
    });

    it('round-trips pins flushed AFTER a refresh failure clears the session pointer', async () => {
        // AuthContext removes cipherline_user_id when a refresh is rejected,
        // which nulls activeUserId; a pin write flushing in that window changes
        // tier. It must still come back on the next launch.
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.flushNow();
        secureLocalStore.removeItem('cipherline_user_id');
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pins);
        await secureLocalStore.flushNow();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pins);
    });

    it('an empty pin list persists — clearing every pin is a real state', async () => {
        // '[]' must be storable, which is why the persist effect can't use the
        // "skip empty" guard its sibling message caches use.
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pins);
        await secureLocalStore.flushNow();
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, '[]');
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe('[]');
    });

    it("does not leak one account's pins into another's session", async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pins);
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_B);
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBeNull();
    });
});

/**
 * Deferred (phase-2) hydration of message history.
 *
 * main.tsx gates FIRST PAINT on hydrate() resolving, so the largest records in
 * the store — message history — are held back and decrypted by
 * hydrateMessages() once the shell is already on screen. The contract these
 * tests pin down: phase 1 must not expose them, phase 2 must, and phase 2 must
 * be safely repeatable (a latched flag previously made a second run a silent
 * no-op, which read back as "this device has no history").
 */
describe('secureLocalStore — deferred message hydration', () => {
    it('does not expose message history after phase 1, but does after phase 2', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_msgs_${USER_A}`, 'history-A');
        secureLocalStore.setItem(`cipherline_convs_${USER_A}`, 'convs-A');
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        // Non-deferred per-account data is available immediately — the
        // "populated before first render" guarantee still holds for it.
        expect(secureLocalStore.getItem(`cipherline_convs_${USER_A}`)).toBe('convs-A');
        // History is not, by design.
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}`)).toBeNull();

        await secureLocalStore.hydrateMessages();
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}`)).toBe('history-A');
    });

    it('hydrateMessages() is idempotent and safe to call concurrently', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_channel_msgs_${USER_A}`, 'ch-A');
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        // Two racing callers (Dashboard's restore effect and HistorySyncBanner
        // both await this on boot) must not decrypt twice or clobber the map.
        await Promise.all([
            secureLocalStore.hydrateMessages(),
            secureLocalStore.hydrateMessages(),
        ]);
        expect(secureLocalStore.getItem(`cipherline_channel_msgs_${USER_A}`)).toBe('ch-A');

        // A third, later call is a no-op that must not wipe what's loaded.
        await secureLocalStore.hydrateMessages();
        expect(secureLocalStore.getItem(`cipherline_channel_msgs_${USER_A}`)).toBe('ch-A');
    });

    it('writes made before phase 2 survive it — hydration must not clobber newer state', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_msgs_${USER_A}`, 'on-disk');
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        // Something writes before the deferred decrypt lands (a message
        // arriving during boot). Phase 2 must not resurrect the stale value.
        secureLocalStore.setItem(`cipherline_msgs_${USER_A}`, 'newer');
        await secureLocalStore.hydrateMessages();
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}`)).toBe('newer');
    });
});

describe('signing in within a running session (the account rebind)', () => {
    const pinsA = JSON.stringify([{ kind: 'conversation', id: 'a-conv' }]);
    const pinsB = JSON.stringify([{ kind: 'server', id: 'b-server' }]);

    /** Boot signed OUT, so no per-account records are in memory - exactly the
     *  state of a device where the user signed out and is now signing back in. */
    async function bootSignedOut() {
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        expect(secureLocalStore.getItem('cipherline_user_id')).toBeNull();
    }
    async function signIn(userId: string) {
        secureLocalStore.setItem('cipherline_user_id', userId);
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isAccountReady(userId)).toBe(true);
    }
    async function signOut() {
        secureLocalStore.removeItem('cipherline_user_id');
        await secureLocalStore.flushNow();
    }

    it("a read straight after sign-in is cold until whenAccountReady resolves - and then it is the saved value", async () => {
        await secureLocalStore.hydrate();
        await signIn(USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pinsA);
        await secureLocalStore.flushNow();
        await signOut();

        await bootSignedOut();
        secureLocalStore.setItem('cipherline_user_id', USER_A);   // the sign-in click
        // This is the window the Dashboard used to mount into: cold namespace,
        // so a persist effect would have written '[]' over the real pins.
        expect(secureLocalStore.isAccountReady(USER_A)).toBe(false);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBeNull();
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isAccountReady(USER_A)).toBe(true);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pinsA);
    });

    it('sign in as A, out, in as B, out, in as A: both accounts keep their own pins', async () => {
        await secureLocalStore.hydrate();
        await signIn(USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pinsA);
        await secureLocalStore.flushNow();
        await signOut();

        await bootSignedOut();
        await signIn(USER_B);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBeNull(); // no leak
        secureLocalStore.setItem(`cipherline_home_pins_${USER_B}`, pinsB);
        await secureLocalStore.flushNow();
        await signOut();

        await signIn(USER_A);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pinsA);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_B}`)).toBeNull();
        await signOut();
        await signIn(USER_B);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_B}`)).toBe(pinsB);
    });

    it('a value written while the rebind is in flight wins over the older one on disk', async () => {
        await secureLocalStore.hydrate();
        await signIn(USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pinsA);
        await secureLocalStore.flushNow();
        await signOut();

        await bootSignedOut();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pinsB); // user acts before the decrypt lands
        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pinsB);
    });

    it("a per-account write still pending when the active account flips is filed under the account that wrote it", async () => {
        await secureLocalStore.hydrate();
        await signIn(USER_A);
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, pinsA); // dirty, not flushed
        secureLocalStore.setItem('cipherline_user_id', USER_B);             // switch before the flush
        await secureLocalStore.whenAccountReady();
        await secureLocalStore.flushNow();

        // Boot as A: the record must be there, under A's subkey.
        resetSingletons(); setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A); await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe(pinsA);
        // Boot as B: A's record must NOT be visible (it was not filed master-tier).
        resetSingletons(); setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_B); await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBeNull();
    });
});

/**
 * Batched phase-2 hydration.
 *
 * hydrateMessages() used to start every deferred decrypt in one unbounded
 * Promise.all. Each record ends in a main-thread `blob.text()` decode, so all
 * of them landed in a single task — one long block arriving just as the boot
 * animation finished and the user made their first click. It now decrypts in
 * bounded batches and yields between them. These pin the behaviour that must
 * survive that change: batching is an internal detail, so nothing about WHAT
 * ends up in the store may differ.
 */
describe('secureLocalStore — batched deferred hydration', () => {
    it('loads every record when there are far more than one batch', async () => {
        // HYDRATE_BATCH is 8; 30 records exercises several batches plus a
        // partial final one (the off-by-one the slice() bound could get wrong).
        const N = 30;
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        for (let i = 0; i < N; i++) {
            secureLocalStore.setItem(`cipherline_msgs_${USER_A}_conv${i}`, `history-${i}`);
        }
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        await secureLocalStore.hydrateMessages();

        for (let i = 0; i < N; i++) {
            expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv${i}`))
                .toBe(`history-${i}`);
        }
    });

    it('still refuses to clobber a value written before phase 2 ran', async () => {
        // The never-clobber guard now runs per batch rather than once at the
        // end. A message persisted in the gap between first paint and phase 2
        // is the only copy that exists — the server drops the envelope once
        // ACKed — so the on-disk snapshot must never roll it back.
        const N = 20;
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        for (let i = 0; i < N; i++) {
            secureLocalStore.setItem(`cipherline_msgs_${USER_A}_conv${i}`, `on-disk-${i}`);
        }
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();

        // Arrives after first paint, before phase 2 — in a LATE batch, so the
        // guard has to hold all the way through the loop, not just batch 1.
        secureLocalStore.setItem(`cipherline_msgs_${USER_A}_conv17`, 'newer-live-message');

        await secureLocalStore.hydrateMessages();

        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv17`))
            .toBe('newer-live-message');
        // Its neighbours in the same batch still loaded normally.
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv16`)).toBe('on-disk-16');
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv18`)).toBe('on-disk-18');
    });

});

/**
 * Phase 2 must ABORT when the account it is decrypting for goes away.
 *
 * hydrateMessages() takes its work list, its subkey and its target account
 * once, at loop entry, and then hands the main thread back between batches.
 * A sign-out, an account switch or a wipeLocalData() landing in one of those
 * yields leaves the remaining batches decrypting the DEPARTED account's
 * ciphertext and writing the plaintext into a map that was just purged.
 *
 * What this is and isn't: keys are userId-embedded and callers enumerate under
 * the active userId, so this is not a cross-account UI leak, and `map.set`
 * bypasses the dirty/dirtyOwner tracking so nothing is re-persisted. What it
 * is: a signed-out account's decrypted history resident in renderer memory
 * with nothing left that would prune it, and a wipeLocalData() whose
 * in-memory clear is partly undone right after it returns.
 *
 * NOTE the shape of these tests. The existing "written before phase 2" tests
 * above put their value in `map` before hydrateMessages() is ever called, so
 * they pass against any implementation, batched or not. These instead drive an
 * event that arrives *during* a yield, which is the only window the bug lives
 * in — they fail against the unguarded loop.
 */
describe('secureLocalStore — phase 2 aborts when the account goes away mid-flight', () => {
    /**
     * Park hydrateMessages() on its FIRST inter-batch yield and hand back a
     * release handle, so the test acts at an exact batch boundary instead of
     * racing real timers. Later yields resolve normally, so the loop can still
     * run to completion once released — an unfixed loop finishes and fails the
     * assertion rather than hanging on a gate nobody opens.
     */
    function installYieldGate() {
        const prev = (globalThis as any).scheduler;
        let openFirstGate: (() => void) | null = null;
        let seen = 0;
        (globalThis as any).scheduler = {
            yield: () => {
                if (seen++ === 0) return new Promise<void>(res => { openFirstGate = res; });
                return new Promise<void>(res => setTimeout(res, 0));
            },
        };
        return {
            async waitForFirstYield() {
                for (let i = 0; i < 200 && !openFirstGate; i++) {
                    await new Promise(res => setTimeout(res, 0));
                }
                if (!openFirstGate) throw new Error('hydrateMessages() never yielded — the gate was not exercised');
            },
            release() { openFirstGate!(); },
            restore() {
                if (prev === undefined) delete (globalThis as any).scheduler;
                else (globalThis as any).scheduler = prev;
            },
        };
    }

    /** 24 history records for A on disk (3 batches of 8 → 2 yields), then a
     *  fresh boot as A with phase 2 not yet run. */
    const N = 24;
    async function bootWithDeferredHistory() {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        for (let i = 0; i < N; i++) {
            secureLocalStore.setItem(`cipherline_msgs_${USER_A}_conv${i}`, `history-${i}`);
        }
        await secureLocalStore.flushNow();

        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        // Deferred, so none of it is in memory yet.
        expect(secureLocalStore.keysWithPrefix('cipherline_msgs_')).toHaveLength(0);
    }

    it('a sign-out during a yield stops the remaining batches decrypting into memory', async () => {
        await bootWithDeferredHistory();

        const gate = installYieldGate();
        try {
            const phase2 = secureLocalStore.hydrateMessages();
            await gate.waitForFirstYield();

            // The user signs out between batches. This purges A's records from
            // the map — and the purge must STAY purged.
            secureLocalStore.removeItem('cipherline_user_id');
            await secureLocalStore.whenAccountReady();   // teardown fully settled
            expect(secureLocalStore.keysWithPrefix('cipherline_msgs_')).toHaveLength(0);

            gate.release();
            await phase2;
        } finally {
            gate.restore();
        }

        // Without the generation guard, batches 2 and 3 decrypt A's ciphertext
        // under A's subkey and put 16 records back after the purge.
        expect(secureLocalStore.keysWithPrefix('cipherline_msgs_')).toEqual([]);
    });

    it('an account switch during a yield does not leave the previous account decrypted in memory', async () => {
        await bootWithDeferredHistory();

        const gate = installYieldGate();
        try {
            const phase2 = secureLocalStore.hydrateMessages();
            await gate.waitForFirstYield();

            // B signs in on the same device while A's history is mid-decrypt.
            secureLocalStore.setItem('cipherline_user_id', USER_B);
            await secureLocalStore.whenAccountReady();
            expect(secureLocalStore.isAccountReady(USER_B)).toBe(true);

            gate.release();
            await phase2;
        } finally {
            gate.restore();
        }

        // Nothing of A's survives into B's session — including the records the
        // in-flight loop had not reached at the moment of the switch.
        expect(secureLocalStore.keysWithPrefix(`cipherline_msgs_${USER_A}`)).toEqual([]);
    });

    it('a message written during a yield is not rolled back by a later batch', async () => {
        // The never-clobber guard is checked per batch, immediately before each
        // write — the source says so, but the existing "late batch" test writes
        // its value BEFORE hydrateMessages() is called, so the value is already
        // in `map` at loop entry and any implementation passes it. This one
        // writes inside a yield, which is the window the per-batch check exists
        // for — conv17 is not in the first batch, so it is still undecrypted
        // when the write lands. (Records are keyed in the store's lexicographic
        // cursor order, not conv0..conv23; only "after batch 1" matters here.)
        await bootWithDeferredHistory();

        const gate = installYieldGate();
        try {
            const phase2 = secureLocalStore.hydrateMessages();
            await gate.waitForFirstYield();

            // A message arrives and is persisted between batches. The local
            // cache is its only copy — the server drops the ACKed envelope.
            secureLocalStore.setItem(`cipherline_msgs_${USER_A}_conv17`, 'arrived-mid-hydration');

            gate.release();
            await phase2;
        } finally {
            gate.restore();
        }

        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv17`)).toBe('arrived-mid-hydration');
        // Its batch-mates still loaded from disk normally.
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv16`)).toBe('history-16');
        expect(secureLocalStore.getItem(`cipherline_msgs_${USER_A}_conv18`)).toBe('history-18');
    });

    it('wipeLocalData() during a yield is not partly undone by the remaining batches', async () => {
        await bootWithDeferredHistory();

        const gate = installYieldGate();
        try {
            const phase2 = secureLocalStore.hydrateMessages();
            await gate.waitForFirstYield();

            // "Start fresh" recovery lands between batches.
            await secureLocalStore.wipeLocalData();
            expect(secureLocalStore.length).toBe(0);

            gate.release();
            await phase2;
        } finally {
            gate.restore();
        }

        // The wipe's in-memory clear must still hold once phase 2 unwinds.
        expect(secureLocalStore.keysWithPrefix('cipherline_msgs_')).toEqual([]);
        expect(secureLocalStore.length).toBe(0);
    });
});

/**
 * Message integrity §3 (mobile handoff, 2026-09-24). The DM pull loop ACKs an
 * envelope — a hard DELETE of the server's only copy — so it must first know
 * the message is ON DISK, not merely in this store's memory. flushNow() cannot
 * promise that: a flush already in flight has taken its keys off the dirty set,
 * so a concurrent flushNow() finds nothing to do and resolves before that write
 * commits; and a write that could not be sealed is silently re-queued.
 * flushDurable() is the promise the ACK needs.
 */
describe('secureLocalStore — flushDurable (persist before an irreversible remote action)', () => {
    const KEY = `cipherline_msgs_${USER_A}_conv1`;

    type SealRecs = Array<{ k: string; o: string | null; v: string }>;
    type SealBridge = { secureKvSeal: (recs: SealRecs) => Promise<Array<{ k: string; b: Uint8Array | null }>> };
    const bridge = () => (globalThis as unknown as { window: { electronAPI: SealBridge } }).window.electronAPI;

    /** Hold every secureKvSeal call until released. */
    function holdSeals() {
        const api = bridge();
        const real = api.secureKvSeal;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let calls = 0;
        api.secureKvSeal = vi.fn(async (recs: SealRecs) => { calls++; await gate; return real(recs); });
        return { release, calls: () => calls };
    }

    async function onDisk(key: string): Promise<string | null> {
        resetSingletons();
        setMasterKey({ status: 'ok', keyB64: TEST_KEY_B64 });
        await secureLocalStore.hydrate();
        await secureLocalStore.hydrateMessages();
        return secureLocalStore.getItem(key);
    }

    it('does not resolve until a flush ALREADY IN FLIGHT for the key has committed', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.whenAccountReady();
        await secureLocalStore.flushNow();

        const seals = holdSeals();
        secureLocalStore.setItem(KEY, 'the only copy');
        const inFlight = secureLocalStore.flushNow();          // takes KEY off the dirty set, then blocks
        await vi.waitFor(() => expect(seals.calls()).toBe(1));

        let durable = false;
        const p = secureLocalStore.flushDurable([KEY]).then(() => { durable = true; });
        await new Promise(r => setTimeout(r, 30));
        expect(durable).toBe(false);                           // the write it depends on has not landed

        seals.release();
        await Promise.all([inFlight, p]);
        expect(durable).toBe(true);
        expect(await onDisk(KEY)).toBe('the only copy');
    });

    it('throws when a key could not be sealed, instead of resolving as if it were written', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.whenAccountReady();
        await secureLocalStore.flushNow();

        bridge().secureKvSeal = vi.fn(async (recs: SealRecs) => recs.map(r => ({ k: r.k, b: null })));
        secureLocalStore.setItem(KEY, 'unsealable');
        await expect(secureLocalStore.flushDurable([KEY])).rejects.toThrow(/not.*written|durabl/i);
    });

    it('throws on a locked store, which never writes', async () => {
        setMasterKey({ status: 'locked' });
        await secureLocalStore.hydrate();
        await expect(secureLocalStore.flushDurable([KEY])).rejects.toThrow(/locked/i);
    });

    it('resolves once the keys are on disk (the ordinary case)', async () => {
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', USER_A);
        await secureLocalStore.whenAccountReady();
        secureLocalStore.setItem(KEY, 'stored');
        await secureLocalStore.flushDurable([KEY]);
        expect(await onDisk(KEY)).toBe('stored');
    });
});
