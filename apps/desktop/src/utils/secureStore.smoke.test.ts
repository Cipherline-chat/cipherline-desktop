import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Direct coverage of electron/storage.ts's corrupt-envelope detection
 * (Phase 7 / device sprawl) — real filesystem I/O against a temp userData
 * dir, only the `electron` module itself mocked (app.getPath, safeStorage,
 * dialog), same approach as e2eeEngine.smoke.test.ts / channelKeys.smoke.test.ts
 * mocking exactly the one dependency unavailable outside a real Electron
 * process.
 */

let tmpDir = '';
vi.mock('electron', () => ({
    app: { getPath: () => tmpDir },
    // Encryption "available" and a no-op reversible wrap so key load/save
    // round-trips without needing the real OS keystore.
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`WRAPPED:${s}`, 'utf8'),
        decryptString: (buf: Buffer) => {
            const s = buf.toString('utf8');
            if (!s.startsWith('WRAPPED:')) throw new Error('not wrapped');
            return s.slice('WRAPPED:'.length);
        },
    },
    dialog: { showMessageBoxSync: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));

const { SecureStore } = await import('../../electron/storage');

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-securestore-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SecureStore corrupt-envelope detection (Phase 7)', () => {
    it('reports no corruption on a normal first launch (no file yet)', async () => {
        const store = new SecureStore();
        await store.initialize();
        expect(store.status()).toBe('ok');
        expect(store.corruptionInfo()).toBeNull();
    });

    it('reports no corruption when the envelope parses fine', async () => {
        fs.writeFileSync(path.join(tmpDir, 'secure-store.json'), JSON.stringify({}), 'utf8');
        const store = new SecureStore();
        await store.initialize();
        expect(store.corruptionInfo()).toBeNull();
    });

    it('detects a corrupt (unparseable) envelope, moves it aside, and stays unlocked', async () => {
        const dbPath = path.join(tmpDir, 'secure-store.json');
        fs.writeFileSync(dbPath, '{ this is not valid json', 'utf8');

        const store = new SecureStore();
        await store.initialize();

        // Master key still loads fine (this is NOT the 'locked' case) — the
        // renderer boot gate must be able to tell these two apart.
        expect(store.status()).toBe('ok');
        expect(store.isLocked()).toBe(false);

        const info = store.corruptionInfo();
        expect(info).not.toBeNull();
        expect(info!.backupFileName).toMatch(/^secure-store\.json\.corrupt-\d+$/);

        // Original corrupt content preserved verbatim under the backup name —
        // dbPath itself gets a FRESH file moments later (init writes a canary
        // entry into the now-empty store), so what matters is the backup, not
        // whether dbPath is momentarily absent.
        const backedUp = fs.readFileSync(path.join(tmpDir, info!.backupFileName), 'utf8');
        expect(backedUp).toBe('{ this is not valid json');
        expect(fs.readFileSync(dbPath, 'utf8')).not.toBe('{ this is not valid json');
    });

    it('detects a well-formed-JSON-but-wrong-shape envelope (array, not object) as corrupt too', async () => {
        fs.writeFileSync(path.join(tmpDir, 'secure-store.json'), JSON.stringify([1, 2, 3]), 'utf8');
        const store = new SecureStore();
        await store.initialize();
        expect(store.corruptionInfo()).not.toBeNull();
    });

    // Phase 7: the main-process SecureStore singleton survives a renderer
    // window.location.reload() — if these didn't clear the flag, the boot
    // gate would keep reporting corruption forever after the user explicitly
    // resolved it.
    it('clears corruption state after factoryReset (user chose "start fresh")', async () => {
        fs.writeFileSync(path.join(tmpDir, 'secure-store.json'), 'not json', 'utf8');
        const store = new SecureStore();
        await store.initialize();
        expect(store.corruptionInfo()).not.toBeNull();

        store.factoryReset();
        expect(store.corruptionInfo()).toBeNull();
    });

    it('clears corruption state after a successful recoverWithKey', async () => {
        fs.writeFileSync(path.join(tmpDir, 'secure-store.json'), 'not json', 'utf8');
        const store = new SecureStore();
        await store.initialize();
        expect(store.corruptionInfo()).not.toBeNull();

        // The master key itself was fine (status stayed 'ok') — init already
        // wrote a canary under it by this point, so recoverWithKey's
        // validate-against-existing-entry check is live. Re-supplying THIS
        // device's own current key is the realistic "recovery key matches"
        // case; recoverWithKey resolving the corruption state doesn't
        // require the supplied key to differ from what's already active.
        const ok = store.recoverWithKey(store.getMasterKeyB64()!);
        expect(ok).toBe(true);
        expect(store.corruptionInfo()).toBeNull();
    });

    it('a WRONG recovery key is rejected and does NOT clear corruption state', async () => {
        fs.writeFileSync(path.join(tmpDir, 'secure-store.json'), 'not json', 'utf8');
        const store = new SecureStore();
        await store.initialize();

        const ok = store.recoverWithKey(Buffer.alloc(32, 9).toString('base64')); // not this device's key
        expect(ok).toBe(false);
        expect(store.corruptionInfo()).not.toBeNull();
    });
});

/**
 * `_doInitialize()` was declared `async` and contained ZERO `await`. An async
 * function with no internal await runs its whole body synchronously and only
 * hands back an already-settled promise — so main.ts's
 * `const storeReady = secureStore.initialize()`, commented as running "in the
 * background", in fact blocked the Electron main-process thread that owns the
 * window HWND through an mkdir, a full read + JSON.parse of the vault, a cold
 * safeStorage round-trip, an atomic key write and (on some paths) a modal
 * dialog. Windows renders that as "(Not Responding)".
 *
 * The defect is invisible to the type system (the signature is identical) and
 * to any test that merely awaits the result (it resolves either way), which is
 * why it survived. It is also invisible to CI: `_doInitialize()` short-circuits
 * on CIPHERLINE_SMOKE_TEST, so the 30s desktop smoke gate never runs the path.
 * Hence an explicit behavioural pin on the one property that distinguishes the
 * two: did the event loop get a turn?
 */
describe('SecureStore.initialize() must not block the main-process event loop', () => {
    /**
     * Counts event-loop turns that elapse while a promise is pending.
     *
     * A self-rescheduling `setImmediate` is the measuring instrument rather
     * than a single one-shot immediate, and that detail is load-bearing: Node
     * drains the microtask queue after EVERY macrotask callback, so with a
     * one-shot immediate a body whose final `await` completes the function
     * would resolve during that drain and the flag would still read false.
     * Counting turns is insensitive to how many yield points the
     * implementation happens to have, so this pins the CONTRACT ("the loop
     * runs") and not the current shape of the code.
     */
    async function loopTurnsDuring<T>(work: () => Promise<T>): Promise<{ turns: number; result: T }> {
        let turns = 0;
        let stop = false;
        const tick = () => { if (stop) return; turns++; setImmediate(tick); };
        setImmediate(tick);
        try {
            const result = await work();
            return { turns, result };
        } finally {
            stop = true;
        }
    }

    it('POSITIVE CONTROL: the meter reports zero turns for a synchronous body', async () => {
        // This is what the pre-fix _doInitialize() looked like from the
        // outside: `async` in signature, synchronous in fact. If this ever
        // reports a nonzero count the meter is broken and the real assertion
        // below is worthless.
        const syntheticallySynchronous = async () => { /* no await anywhere */ return 42; };
        const { turns, result } = await loopTurnsDuring(syntheticallySynchronous);
        expect(result).toBe(42);
        expect(turns).toBe(0);
    });

    it('yields to the event loop at least once before resolving', async () => {
        const store = new SecureStore();
        const { turns } = await loopTurnsDuring(() => store.initialize());
        expect(store.status()).toBe('ok');
        expect(turns).toBeGreaterThan(0);
    });

    it('yields on an EXISTING vault too, not only on the first-launch path', async () => {
        // First launch writes the key file and a canary; the second open takes
        // the read-and-unwrap branch, which is the one real users hit on every
        // launch after the first and the one that carries the DPAPI decrypt.
        await new SecureStore().initialize();
        const reopened = new SecureStore();
        const { turns } = await loopTurnsDuring(() => reopened.initialize());
        expect(reopened.status()).toBe('ok');
        expect(turns).toBeGreaterThan(0);
    });

    it('yields under CIPHERLINE_SMOKE_TEST as well', async () => {
        // The smoke-test path short-circuits the real work. If it were the one
        // shape of this function that still completed synchronously, a future
        // edit could reintroduce the freeze on the real path while everything
        // running under the smoke flag stayed green.
        vi.stubEnv('CIPHERLINE_SMOKE_TEST', '1');
        try {
            const store = new SecureStore();
            const { turns } = await loopTurnsDuring(() => store.initialize());
            expect(store.status()).toBe('ok');
            expect(turns).toBeGreaterThan(0);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

/**
 * Reads before init used to be the silent half of the initialization contract.
 * `save()` has always thrown loudly on a write-before-init ("a real bug and
 * should stay loud"), but `get()` just returned `null` off an empty `this.data`
 * — indistinguishable from "this key was never set". That is the dangerous
 * direction: `ensureSignalIdentity()` reads `identity_priv`, sees null, and
 * mints a NEW identity over the real one. Widening the async window made the
 * hazard reachable, so the guard has to exist.
 */
describe('SecureStore read-before-initialize fails loudly', () => {
    it('get() throws instead of reporting every key as absent', () => {
        const store = new SecureStore();
        expect(store.status()).toBe('uninitialized');
        expect(() => store.get('identity_priv')).toThrow(/before initialize/i);
    });

    it('keys() throws instead of reporting an empty keystore', () => {
        const store = new SecureStore();
        expect(() => store.keys()).toThrow(/before initialize/i);
    });

    it('set() before initialize still throws (the existing loud guard is intact)', () => {
        const store = new SecureStore();
        expect(() => store.set('identity_priv', 'deadbeef')).toThrow();
    });

    it('a LOCKED store still reads as null rather than throwing', async () => {
        // 'locked' is a legitimate steady state: envelope loaded, master key
        // not unwrappable. StorageLockedScreen's recovery flow depends on
        // get() returning null there, so the guard must be scoped to
        // 'uninitialized' and must not catch this case.
        await new SecureStore().initialize();          // creates a wrapped key file
        fs.writeFileSync(path.join(tmpDir, 'store.key'), Buffer.from('NOT-WRAPPED-GIBBERISH'));

        const locked = new SecureStore();
        await locked.initialize();
        expect(locked.status()).toBe('locked');
        expect(() => locked.get('identity_priv')).not.toThrow();
        expect(locked.get('identity_priv')).toBeNull();
    });
});

/**
 * The async conversion's sharpest edge. The old code was
 * `if (fs.existsSync(keyPath)) { readFileSync(...) }`, where a non-ENOENT read
 * failure threw out of init. The naive async port is
 * `try { await readFile(p) } catch { return null }`, which folds EVERY error
 * into "no key file yet" — and the branch that consumes that answer GENERATES A
 * FRESH MASTER KEY and writes it over the existing one. A transient EACCES or
 * EIO would then permanently destroy the Signal identity, every channel key and
 * the ability to read every backup the device has ever written.
 */
describe('SecureStore never regenerates the master key over an unreadable one', () => {
    it('a key path that exists but cannot be read fails init instead of re-keying', async () => {
        // A directory at store.key makes readFile fail with EISDIR — a
        // deterministic, non-ENOENT read error that needs no permission games
        // (and so behaves the same whether or not the suite runs as root).
        const keyPath = path.join(tmpDir, 'store.key');
        fs.mkdirSync(keyPath);

        const store = new SecureStore();
        await expect(store.initialize()).rejects.toThrow();

        // Not 'ok': nothing may act as though there is a usable key.
        expect(store.status()).toBe('uninitialized');
        // And the existing path is untouched — no fresh key was written over it.
        expect(fs.statSync(keyPath).isDirectory()).toBe(true);
    });
});

/**
 * Write coalescing (desktop performance push). Every set()/delete() used to
 * rewrite the whole vault synchronously on the main thread; a 100-prekey
 * top-up was 200+ full rewrites and every DM that used a one-time prekey was
 * two. batch() and the deferred writers cut that to one write per batch /
 * per burst without weakening when data is durable.
 */
describe('SecureStore write coalescing', () => {
    const diskKeys = () => Object.keys(JSON.parse(fs.readFileSync(path.join(tmpDir, 'secure-store.json'), 'utf8')));

    it('batch(): 200 sets are ONE vault write, and all of them are on disk when batch() returns', async () => {
        const store = new SecureStore();
        await store.initialize();
        const before = store.writeCount;
        store.batch(() => {
            for (let i = 0; i < 100; i++) {
                store.set(`otp_priv_${i}`, 'aa'.repeat(32));
                store.set(`otp_pub_${i}`, 'bb');
            }
        });
        expect(store.writeCount - before).toBe(1);
        const keys = diskKeys();
        expect(keys.filter(k => k.startsWith('otp_priv_')).length).toBe(100);
        expect(keys.filter(k => k.startsWith('otp_pub_')).length).toBe(100);
    });

    it('batch(): nested batches join the outer one; a throw still persists what changed, then propagates', async () => {
        const store = new SecureStore();
        await store.initialize();
        const before = store.writeCount;
        expect(() => store.batch(() => {
            store.set('a', '1');
            store.batch(() => { store.set('b', '2'); });
            expect(store.writeCount - before).toBe(0); // inner batch did not write
            throw new Error('boom');
        })).toThrow('boom');
        expect(store.writeCount - before).toBe(1);
        expect(diskKeys()).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('deleteDeferred(): gone from memory at once, coalesced to disk shortly after', async () => {
        const store = new SecureStore();
        await store.initialize();
        store.batch(() => { for (let i = 0; i < 50; i++) store.set(`otp_priv_${i}`, 'cc'); });
        const before = store.writeCount;
        for (let i = 0; i < 50; i++) store.deleteDeferred(`otp_priv_${i}`);
        // In memory: unusable immediately.
        expect(store.get('otp_priv_0')).toBeNull();
        expect(store.hasPendingWrites()).toBe(true);
        // On disk: not yet (no synchronous write happened)...
        expect(store.writeCount - before).toBe(0);
        expect(diskKeys()).toContain('otp_priv_0');
        await store.whenWritesSettled();
        // ...then all 50 deletions in ONE write.
        expect(store.writeCount - before).toBe(1);
        expect(diskKeys().some(k => k.startsWith('otp_priv_'))).toBe(false);
        expect(store.hasPendingWrites()).toBe(false);
    });

    it('the deferred write lands within DEFER_MAX_MS even while changes keep arriving', async () => {
        const store = new SecureStore();
        await store.initialize();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        try {
            const before = store.writeCount;
            // A change every 100 ms would postpone a plain trailing debounce forever.
            for (let t = 0; t < SecureStore.DEFER_MAX_MS + 100; t += 100) {
                store.setDeferred('__eph_replay__', String(t));
                vi.advanceTimersByTime(100);
            }
            expect(store.writeCount - before).toBeGreaterThanOrEqual(1);
        } finally {
            vi.useRealTimers();
        }
        await store.whenWritesSettled();
    });

    it('flush() writes pending deferred changes synchronously', async () => {
        const store = new SecureStore();
        await store.initialize();
        store.setDeferred('k', 'v1');
        store.flush();
        expect(store.hasPendingWrites()).toBe(false);
        expect(diskKeys()).toContain('k');
    });

    it('an async write that finishes after a newer synchronous save never rolls the file back', async () => {
        const store = new SecureStore();
        await store.initialize();
        store.setDeferred('k', 'old');
        // Start the async write-behind now, then immediately write synchronously.
        const settling = store.whenWritesSettled();
        store.set('k2', 'new');
        await settling;
        await store.whenWritesSettled();
        const reread = new SecureStore();
        await reread.initialize();
        expect(reread.get('k')).toBe('old');   // carried by the newer sync save
        expect(reread.get('k2')).toBe('new');  // and not rolled back by the older async one
    });

    it('factoryReset() during an in-flight deferred write never resurrects the old vault', async () => {
        const store = new SecureStore();
        await store.initialize();
        store.set('identity_priv', 'old-identity');
        store.setDeferred('__eph_replay__', '["x"]');
        const settling = store.whenWritesSettled();   // old snapshot now being written
        store.factoryReset();
        await settling;
        await store.whenWritesSettled();
        const onDisk = fs.existsSync(path.join(tmpDir, 'secure-store.json')) ? diskKeys() : [];
        expect(onDisk).not.toContain('identity_priv');
        expect(onDisk).not.toContain('__eph_replay__');
    });

    it('a deferred write survives a reload (round-trips through the real envelope)', async () => {
        const store = new SecureStore();
        await store.initialize();
        store.setDeferred('__ledger__', JSON.stringify([['c:n', 't']]));
        await store.whenWritesSettled();
        const reread = new SecureStore();
        await reread.initialize();
        expect(reread.get('__ledger__')).toBe(JSON.stringify([['c:n', 't']]));
    });
});
