import * as crypto from 'crypto';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { app, safeStorage, dialog } from 'electron';
import { classifyKeyProtection, type KeyProtection } from './key-protection';
import { freezeMonitor } from './freeze-monitor';

const ALG = 'aes-256-gcm';

// Legacy format: the master key was written as 64 lowercase-hex chars in
// plaintext. safeStorage-wrapped blobs are binary and will not match this.
const PLAINTEXT_HEX = /^[0-9a-f]{64}$/;

interface EncryptedEntry {
    iv: string;
    authTag: string;
    ciphertext: string;
}

function getUserDataPath(): string {
    try {
        return app.getPath('userData');
    } catch {
        return path.join(__dirname, '..');
    }
}

/**
 * Hand the Electron main process's message loop a turn.
 *
 * This is the whole point of `_doInitialize` being async, so it is worth being
 * precise about why it is `setImmediate` and not something cheaper. `await
 * Promise.resolve()` (or any already-resolved promise) only drains the
 * MICROTASK queue — it never lets libuv advance, so the window HWND's message
 * pump still does not run and the app is still "(Not Responding)". Only
 * yielding to a real event-loop phase pumps it. `setImmediate` lands in the
 * check phase, after pending I/O callbacks, which is where we want to be: it
 * lets queued window/IPC/paint work run before we take the thread back for the
 * next blocking phase.
 */
function yieldToLoop(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * Read a file, distinguishing "it is not there" (null) from every other
 * failure (throws).
 *
 * IDENTITY-CRITICAL: the caller uses a null return to decide whether to
 * GENERATE A FRESH MASTER KEY. Collapsing EACCES / EIO / EISDIR / EMFILE into
 * "absent" would mint a new key over a master key file that is merely
 * temporarily unreadable — and that permanently destroys the Signal identity,
 * every channel key and every backup the device has written. ENOENT is the one
 * and only error that means absence; everything else must propagate and leave
 * the store uninitialized so the user can retry rather than lose the vault.
 * This mirrors the old `fs.existsSync(p) && fs.readFileSync(p)` shape, where a
 * non-ENOENT failure likewise threw out of init instead of falling through to
 * key generation.
 */
async function readFileIfPresent(p: string): Promise<Buffer | null> {
    try {
        return await fsp.readFile(p);
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
    }
}

export type SecureStoreStatus = 'uninitialized' | 'ok' | 'locked';

/** Linux only; null elsewhere or when the API is missing / throws. */
function selectedLinuxBackend(): string | null {
    if (process.platform !== 'linux') return null;
    try {
        const fn = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
        return typeof fn === 'function' ? fn.call(safeStorage) : null;
    } catch {
        return null;
    }
}

export class SecureStore {
    private data: Record<string, EncryptedEntry> = {};
    private masterKey: Buffer | null = null;
    private dbPath = '';
    private keyPath = '';
    private _status: SecureStoreStatus = 'uninitialized';
    // Promise-cached so concurrent callers (main.ts + signal-identity.ts) all
    // share the same in-flight init instead of racing to run the body twice.
    private _initPromise: Promise<void> | null = null;
    // Phase 7 / device sprawl: set when loadEnvelope() had to move an
    // unparseable secure-store.json aside and start with an empty in-memory
    // store. Distinct from `_status === 'locked'` — the master key unwrapped
    // fine here, only the DATA envelope was corrupt, so this doesn't block
    // init the way 'locked' does. Left for the renderer boot gate to notice
    // and surface, instead of silently minting a brand-new identity with no
    // one ever told what happened (the pre-Phase-7 behavior).
    private _corruptBackupFile: string | null = null;
    // G8: how the master key is actually protected on this machine. Set once
    // per init; 'unknown' until then (and for the whole smoke-test run).
    private _keyProtection: KeyProtection = { level: 'unknown', reason: null, backend: null, platform: process.platform };

    // Constructor does nothing heavy — safe to call at module load time
    constructor() {}

    initialize(): Promise<void> {
        if (!this._initPromise) this._initPromise = this._doInitialize();
        return this._initPromise;
    }

    /** 'locked' means a wrapped key file exists but couldn't be unlocked — the
     *  user must recover (enter their recovery key / restore / start fresh). */
    status(): SecureStoreStatus { return this._status; }
    isLocked(): boolean { return this._status === 'locked'; }

    /** Non-null when this session's secure-store.json was corrupt and moved
     *  aside on load — see loadEnvelope(). */
    corruptionInfo(): { backupFileName: string } | null {
        return this._corruptBackupFile ? { backupFileName: this._corruptBackupFile } : null;
    }

    /** G8: the strength of the master key's at-rest wrapping — see
     *  electron/key-protection.ts. Read-only; never blocks anything. */
    keyProtection(): KeyProtection {
        return { ...this._keyProtection };
    }

    /** The device master key as base64, or null when locked/uninitialized.
     *  This single key now protects BOTH this store (Signal identity, avatar &
     *  backup keys) and the renderer's encrypted key/value store, so revealing
     *  it gives the user one recovery key for everything at rest. */
    getMasterKeyB64(): string | null {
        return this.masterKey ? this.masterKey.toString('base64') : null;
    }

    /**
     * Initialize the store WITHOUT holding the Electron main-process message
     * loop for the whole of it.
     *
     * This function used to be `async` with no `await` anywhere in its body,
     * which means it ran start-to-finish SYNCHRONOUSLY on the caller's stack
     * and only handed back an already-settled promise. main.ts calls it as
     * `const storeReady = secureStore.initialize()` with a comment saying the
     * work happens "in the background so window creation is not gated on
     * safeStorage.encryptString()" — that comment described an intention the
     * code did not implement. The thread it actually blocked is the one that
     * owns the window HWND, which is exactly what Windows reports as
     * "(Not Responding)", and on first launch after an install the installer
     * splash is already up, so the user watches the splash freeze.
     *
     * The remedy is real yield points, NOT less work: every `await` below is
     * load-bearing and none of the security properties moved. `safeStorage` is
     * main-process-only (there is no utilityProcess/worker equivalent), so the
     * DPAPI/Keychain/libsecret round-trip genuinely cannot leave this thread —
     * it stays as ONE atomic blocking call with the loop pumped either side of
     * it. Everything around it (mkdir, the envelope read + JSON.parse of the
     * whole vault, the key-file read, the atomic key write) is now async I/O.
     *
     * Pinned by the "must not block the main-process event loop" block in
     * src/utils/secureStore.smoke.test.ts — the "async function that never
     * yields" defect is invisible to the type system and to any test that
     * merely awaits the result, so it needs an explicit behavioural guard.
     */
    private async _doInitialize() {
        // In CI smoke test mode skip DPAPI/safeStorage entirely — the smoke
        // test only needs the window to appear; it doesn't exercise the store.
        if (process.env.CIPHERLINE_SMOKE_TEST) {
            this.masterKey = crypto.randomBytes(32);
            this._status = 'ok';
            // Yield even here. If the smoke-test path were the one shape of
            // this function that still completed synchronously, a future edit
            // could reintroduce the freeze on the real path while every test
            // that runs under CIPHERLINE_SMOKE_TEST stayed green.
            await yieldToLoop();
            return;
        }

        const userDataPath = getUserDataPath();
        await fsp.mkdir(userDataPath, { recursive: true });

        this.keyPath = path.join(userDataPath, 'store.key');
        this.dbPath  = path.join(userDataPath, 'secure-store.json');

        // Load the (value-encrypted) envelope JSON regardless of key state — the
        // outer structure isn't encrypted, only the values are. Having it loaded
        // lets recovery validate a candidate key against an existing entry.
        //
        // This is the single biggest movable block: the read plus a JSON.parse
        // of the ENTIRE vault (Signal identity, every channel key, every avatar
        // key, Drive tokens — unbounded, it grows with use). Measured on a
        // 2.4 GHz i7 at ~1.5 ms for a fresh install, ~22 ms for a year-old
        // vault and ~87 ms for a pathological one; all of it used to land on
        // the UI thread in one go.
        await this.loadEnvelope();
        await yieldToLoop();

        // The master key is wrapped with Electron's safeStorage (DPAPI on
        // Windows, Keychain on macOS, libsecret/kwallet on Linux) so a simple
        // "copy the file" attack yields opaque bytes instead of our AES key.
        // Older builds wrote it as plaintext hex; we migrate those forward on
        // first launch without wiping identity.
        const canWrap = safeStorage.isEncryptionAvailable();
        let keyHex: string | null = null;

        // ENOENT (and ONLY ENOENT) means "no key file yet". See
        // readFileIfPresent: treating any other error as absence would
        // regenerate the master key over a readable-but-not-right-now vault.
        const raw = await readFileIfPresent(this.keyPath);

        // G8: `isEncryptionAvailable()` alone cannot tell a real keyring from
        // Linux's `basic_text` fallback, which "wraps" with a key hard-coded in
        // Chromium. Classify it so the renderer can show a one-time notice.
        // Detection only — nothing below branches on it, so no device that
        // worked before can be locked out by it.
        this._keyProtection = classifyKeyProtection({
            platform: process.platform,
            encryptionAvailable: canWrap,
            backend: selectedLinuxBackend(),
            wrappedPrefix: raw !== null && process.platform === 'linux' ? raw.subarray(0, 3).toString('latin1') : null,
        });
        if (this._keyProtection.level === 'obfuscated') {
            console.warn(
                `[SecureStore] master key is protected by safeStorage's obfuscation fallback ` +
                `(backend=${this._keyProtection.backend ?? 'unknown'}, reason=${this._keyProtection.reason}), not an OS keyring`,
            );
        }

        if (raw !== null) {
            const asText = raw.toString('utf8').trim();

            if (PLAINTEXT_HEX.test(asText)) {
                // Legacy plaintext — accept it, then upgrade the file on disk
                // if safeStorage is available. Identity preserved either way.
                keyHex = asText;
                if (canWrap) {
                    try {
                        const wrapped = safeStorage.encryptString(keyHex);
                        const tmp = this.keyPath + '.tmp';
                        await fsp.writeFile(tmp, wrapped, { mode: 0o600 });
                        await fsp.rename(tmp, this.keyPath);
                        console.log('[SecureStore] migrated master key to safeStorage-wrapped form');
                    } catch (err) {
                        console.error('[SecureStore] safeStorage wrap failed during migration; leaving plaintext in place', err);
                    }
                } else {
                    console.warn('[SecureStore] safeStorage unavailable — master key stays in plaintext on disk');
                    // M7: warn the user visibly — same dialog as the first-launch plaintext path.
                    await this.warnEncryptionAtRestDisabled();
                }
            } else if (canWrap) {
                // Wrapped form — decrypt. P2-ELEC-1 / P2-ELEC-5: on failure do NOT
                // regenerate (that destroys identity) — report 'locked' and leave
                // the file intact so the user can recover with their key.
                //
                // THIS is the call that cannot be moved off the thread. Pump the
                // loop immediately before it so the blocking window is exactly
                // one keystore round-trip and nothing else.
                await yieldToLoop();
                try {
                    const decrypted = safeStorage.decryptString(raw);
                    if (!PLAINTEXT_HEX.test(decrypted)) throw new Error('decrypted master key malformed');
                    keyHex = decrypted;
                } catch (e) {
                    console.error('[SecureStore] master key could not be unlocked — entering locked state', e);
                    this.masterKey = null;
                    this._status = 'locked';
                    return;
                }
            } else {
                // Binary file but no keystore — can't read it. This is data-loss
                // territory; report locked rather than silently wiping identity.
                console.error('[SecureStore] stored key is wrapped but safeStorage is unavailable — locked');
                this.masterKey = null;
                this._status = 'locked';
                return;
            }
        }

        if (!keyHex) {
            // First launch (key file genuinely absent — ENOENT above, never a
            // read error) — generate a new key atomically.
            keyHex = crypto.randomBytes(32).toString('hex');
            const tmp = this.keyPath + '.tmp';
            if (canWrap) {
                await yieldToLoop();
                const wrapped = safeStorage.encryptString(keyHex);
                await fsp.writeFile(tmp, wrapped, { mode: 0o600 });
            } else {
                // safeStorage unavailable (Linux without a keyring daemon).
                // The master key will be stored in plaintext — warn the user visibly.
                await fsp.writeFile(tmp, keyHex, { mode: 0o600 });
                await this.warnEncryptionAtRestDisabled();
            }
            await fsp.rename(tmp, this.keyPath);
        }
        this.masterKey = Buffer.from(keyHex, 'hex');
        this._status = 'ok';
        // Write a canary on first launch so recoverWithKey always has an entry
        // to validate a candidate key against (prevents silent mis-keying).
        // `set()` stays synchronous — 50 call sites across electron/ and src/
        // assume that, and making it async is a separate change. It costs
        // nothing here: this branch only runs when the vault is EMPTY, so the
        // save() it triggers serialises one entry.
        if (Object.keys(this.data).length === 0) {
            await yieldToLoop();
            this.set('__canary__', 'cipherline-keycheck-v1');
        }
    }

    /**
     * The "your keychain is unavailable" warning, shared by the legacy-plaintext
     * and first-launch paths.
     *
     * This was `dialog.showMessageBoxSync()`, which blocks the main thread until
     * the human clicks OK — for an unbounded time, with no window yet painted,
     * inside an init the rest of startup is waiting on. That is the most severe
     * instance of the freeze this whole change is about: not tens of
     * milliseconds but potentially forever.
     *
     * The async form shows the SAME dialog with the same title, message, detail
     * and buttons, and init still awaits its dismissal before continuing — so
     * the flow (warn, then proceed with a plaintext key on disk) is preserved
     * exactly. The only difference is that the message loop keeps pumping while
     * the dialog is up, which is the entire point.
     */
    private async warnEncryptionAtRestDisabled(): Promise<void> {
        await yieldToLoop();
        await dialog.showMessageBox({
            type: 'warning',
            title: 'Encryption at rest disabled',
            message: 'Your system keychain is unavailable (no libsecret / KWallet / GNOME Keyring running).',
            detail: 'Cipherline will still work, but your local encryption key will be stored in plaintext. Install and start a system keychain, then restart the app to enable encryption at rest.',
            buttons: ['OK'],
        });
    }

    /** Load the value-encrypted envelope JSON (safe to read without the key).
     *
     *  Async only in its I/O — the corrupt-envelope semantics are unchanged:
     *  a missing file starts empty, and ANY failure to read or parse an
     *  existing one moves it aside and records the backup name for the boot
     *  gate (Phase 7), rather than silently minting a fresh identity. */
    private async loadEnvelope() {
        try {
            const raw = await readFileIfPresent(this.dbPath);
            // Genuinely absent (ENOENT) — a fresh install. Not corruption, and
            // it must NOT set _corruptBackupFile, or every first launch would
            // greet the user with a data-loss warning.
            if (raw === null) { this.data = {}; return; }

            const parsed = JSON.parse(raw.toString('utf8'));
            if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
                throw new Error('not a plain object');
            }
            this.data = parsed;
        } catch {
            // Present but unreadable (EACCES/EIO/...) or unparseable. Both land
            // here, which matches the old behaviour exactly: existsSync() would
            // pass and readFileSync()/JSON.parse() would throw into this catch.
            const bakPath = `${this.dbPath}.corrupt-${Date.now()}`;
            try { fs.renameSync(this.dbPath, bakPath); } catch {}
            console.warn(`[SecureStore] Corrupt store moved to ${path.basename(bakPath)} — starting fresh`);
            this.data = {};
            this._corruptBackupFile = path.basename(bakPath);
        }
    }

    /**
     * Recovery: adopt a user-supplied master key (base64, 32 bytes). Validates
     * it against an existing encrypted entry (so a wrong key is rejected), then
     * re-wraps it with THIS device's keystore so future launches unlock normally.
     * Returns true on success. Used when the store is 'locked'.
     */
    recoverWithKey(keyB64: string): boolean {
        let key: Buffer;
        try {
            key = Buffer.from(keyB64, 'base64');
        } catch { return false; }
        if (key.length !== 32) return false;

        // Validate against any existing entry.
        const entries = Object.values(this.data);
        if (entries.length > 0) {
            const probe = entries[0];
            try {
                const iv = Buffer.from(probe.iv, 'base64');
                const authTag = Buffer.from(probe.authTag, 'base64');
                const decipher = crypto.createDecipheriv(ALG, key, iv);
                decipher.setAuthTag(authTag);
                decipher.update(probe.ciphertext, 'base64', 'utf8');
                decipher.final('utf8');
            } catch {
                return false; // wrong key
            }
        }

        // Re-wrap with this device's keystore (atomic).
        try {
            const keyHex = key.toString('hex');
            const tmp = this.keyPath + '.tmp';
            if (safeStorage.isEncryptionAvailable()) {
                fs.writeFileSync(tmp, safeStorage.encryptString(keyHex), { mode: 0o600 });
            } else {
                fs.writeFileSync(tmp, keyHex, { mode: 0o600 });
            }
            fs.renameSync(tmp, this.keyPath);
        } catch (e) {
            console.error('[SecureStore] failed to persist recovered key', e);
            return false;
        }

        this.masterKey = key;
        this._status = 'ok';
        // Same reload-survival reasoning as factoryReset() — a successful
        // recovery resolves the corrupt-envelope state too (the store was
        // empty either way, so there's nothing left to be "still corrupt").
        this._corruptBackupFile = null;
        // If the store was empty we couldn't validate the key above — write a
        // canary now so future recoverWithKey calls can validate against it.
        if (Object.keys(this.data).length === 0) {
            this.set('__canary__', 'cipherline-keycheck-v1');
        }
        return true;
    }

    /**
     * Destroy all local secrets and re-key from scratch ("start fresh"). Used
     * when the user has no recovery key and no backup. The renderer separately
     * wipes its encrypted IndexedDB store.
     */
    factoryReset(): void {
        // A written-behind snapshot of the OLD vault must never land after the
        // wipe: drop the pending one and invalidate any write in flight.
        if (this.deferTimer) { clearTimeout(this.deferTimer); this.deferTimer = null; }
        this.deferredDirty = false;
        this.asyncWriteAgain = false;
        this.saveGen++;
        try { if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath); } catch {}
        try { if (fs.existsSync(this.keyPath)) fs.unlinkSync(this.keyPath); } catch {}
        this.data = {};
        const keyHex = crypto.randomBytes(32).toString('hex');
        try {
            const tmp = this.keyPath + '.tmp';
            if (safeStorage.isEncryptionAvailable()) {
                fs.writeFileSync(tmp, safeStorage.encryptString(keyHex), { mode: 0o600 });
            } else {
                fs.writeFileSync(tmp, keyHex, { mode: 0o600 });
            }
            fs.renameSync(tmp, this.keyPath);
        } catch (e) {
            console.error('[SecureStore] factoryReset key write failed', e);
        }
        this.masterKey = Buffer.from(keyHex, 'hex');
        this._status = 'ok';
        // The main process singleton survives a renderer window.location.reload()
        // — without clearing this, the boot gate would keep reporting corruption
        // forever after the user explicitly chose to start fresh.
        this._corruptBackupFile = null;
    }

    // ── Write coalescing ─────────────────────────────────────────────────
    //
    // Every set()/delete() used to rewrite the WHOLE vault synchronously on the
    // main thread: JSON.stringify of every entry + writeFileSync + renameSync.
    // The vault is not small — it holds the DM replay set (up to 50k
    // ephemeral keys) and the channel replay ledger (up to 30k entries), each
    // one encrypted value, so a long-used install carries megabytes — and the
    // write counts were large:
    //   • every DM that used a one-time prekey deleted two entries → 2 full
    //     rewrites per message, so a wake-up catch-up of N messages cost 2N;
    //   • a prekey top-up minted 100 prekeys → 200+ full rewrites in one
    //     synchronous loop (and the top-up is triggered by the post-wake
    //     WebSocket reconnect).
    // The main thread owns every window; while it writes, the app cannot
    // repaint, restore, or answer the renderer. That is the "(Not Responding)
    // after waking the PC" shape. Two tools, both opt-in per call site so no
    // existing caller's durability changes silently:
    //   • batch(fn): mutations inside fn are written ONCE, synchronously, when
    //     the outermost batch ends — same durability as before (on disk before
    //     batch() returns, errors still throw), N× fewer writes.
    //   • setDeferred()/deleteDeferred(): write-behind for high-frequency state
    //     where a sub-second window is already accepted (the replay sets were
    //     already persisted on a 500 ms debounce). Coalesced over
    //     DEFER_MS (at most DEFER_MAX_MS after the first change), serialized
    //     on the main thread but WRITTEN off it (async fs), committed with an
    //     ordered rename. flush() writes synchronously; main.ts calls it on
    //     quit.
    private batchDepth = 0;
    private batchDirty = false;
    private deferredDirty = false;
    private deferTimer: ReturnType<typeof setTimeout> | null = null;
    private deferFirstAt = 0;
    private asyncWrite: Promise<void> | null = null;
    private asyncWriteAgain = false;
    /** Bumped by every write; an async write that finishes after a newer one
     *  started must not rename its (older) snapshot over the newer file. */
    private saveGen = 0;
    static readonly DEFER_MS = 250;
    static readonly DEFER_MAX_MS = 1000;

    /** How many whole-vault writes have started (tests + perf log). */
    writeCount = 0;

    /**
     * Run `fn` with the store's disk writes coalesced into ONE synchronous save
     * at the end of the outermost batch. `fn` must be synchronous. Nested
     * batches join the outer one. If `fn` throws, what it already changed is
     * still written (matching the old per-call behaviour, where every
     * completed set() had already reached disk) and the error propagates.
     */
    batch<T>(fn: () => T): T {
        this.batchDepth++;
        try {
            return fn();
        } finally {
            this.batchDepth--;
            if (this.batchDepth === 0 && this.batchDirty) {
                this.batchDirty = false;
                this.save();
            }
        }
    }

    /** set(), written behind (see the coalescing note above). */
    setDeferred(key: string, value: string): void {
        this.data[key] = this.encrypt(value);
        this.scheduleDeferredSave();
    }

    /** delete(), written behind (see the coalescing note above). */
    deleteDeferred(key: string): void {
        if (!(key in this.data)) return;
        delete this.data[key];
        this.scheduleDeferredSave();
    }

    /** Write any pending deferred change synchronously, now. */
    flush(): void {
        if (this.deferTimer) { clearTimeout(this.deferTimer); this.deferTimer = null; }
        if (this.deferredDirty || this.asyncWriteAgain) {
            this.asyncWriteAgain = false;
            this.save();
        }
    }

    /** True while a deferred change has not reached disk yet. */
    hasPendingWrites(): boolean {
        return this.deferredDirty || this.asyncWriteAgain || this.batchDirty;
    }

    private scheduleDeferredSave(): void {
        if (this.batchDepth > 0) { this.batchDirty = true; return; }
        this.deferredDirty = true;
        const now = Date.now();
        if (!this.deferTimer) this.deferFirstAt = now;
        else clearTimeout(this.deferTimer);
        const wait = Math.max(0, Math.min(SecureStore.DEFER_MS, this.deferFirstAt + SecureStore.DEFER_MAX_MS - now));
        this.deferTimer = setTimeout(() => this.writeBehind(), wait);
        // A pending write must not be what keeps a quitting process alive;
        // before-quit flushes it synchronously instead.
        (this.deferTimer as { unref?: () => void }).unref?.();
    }

    private writeBehind(): void {
        this.deferTimer = null;
        if (!this.deferredDirty) return;
        if (process.env.CIPHERLINE_SMOKE_TEST) { this.deferredDirty = false; return; }
        if (this.asyncWrite) { this.asyncWriteAgain = true; return; }
        this.deferredDirty = false;
        const gen = ++this.saveGen;
        this.writeCount++;
        const json = freezeMonitor.track('securestore:serialize', () => JSON.stringify(this.data));
        const tmp = this.dbPath + '.wb.tmp';
        const done = fsp.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 })
            .then(async () => {
                // A synchronous save() started after this snapshot: the file
                // on disk is already newer. Drop ours.
                if (gen !== this.saveGen) { await fsp.unlink(tmp).catch(() => {}); return; }
                // Commit on the main thread, so commits are strictly ordered
                // with the synchronous save() path.
                fs.renameSync(tmp, this.dbPath);
            })
            .catch((err) => {
                console.error('[SecureStore] deferred write failed — will retry', err);
                this.deferredDirty = true;
            })
            .finally(() => {
                this.asyncWrite = null;
                if (this.asyncWriteAgain || this.deferredDirty) {
                    this.asyncWriteAgain = false;
                    this.deferredDirty = true;
                    this.scheduleDeferredSave();
                }
            });
        this.asyncWrite = done;
    }

    /** Test hook: resolves once no deferred write is pending or in flight. */
    async whenWritesSettled(): Promise<void> {
        for (let i = 0; i < 50; i++) {
            if (this.deferTimer) { clearTimeout(this.deferTimer); this.writeBehind(); }
            if (this.asyncWrite) { await this.asyncWrite; continue; }
            if (!this.deferredDirty && !this.deferTimer) return;
        }
    }

    private save() {
        // Inside batch(): the outermost batch writes once when it ends.
        if (this.batchDepth > 0) { this.batchDirty = true; return; }
        // A whole-vault write supersedes any pending write-behind.
        const hadDeferred = this.deferredDirty || this.deferTimer !== null;
        if (this.deferTimer) { clearTimeout(this.deferTimer); this.deferTimer = null; }
        this.deferredDirty = false;
        this.saveGen++;
        try {
            this.writeNow();
        } catch (e) {
            // Keep the write-behind obligation alive: a failed synchronous save
            // must not silently drop deferred changes that rode on it.
            if (hadDeferred) this.scheduleDeferredSave();
            throw e;
        }
    }

    private writeNow() {
        // Under the CI smoke test, initialize() deliberately never assigns
        // dbPath (the test only needs the window to paint), so a disk write
        // here is rename('.tmp', '') → ENOENT → a failed build the moment any
        // startup code calls set(). Values have already landed in this.data,
        // so the store keeps working in-process for the run; just don't touch
        // disk. Outside the smoke test an empty dbPath still throws — that is
        // a real "written before initialize()" bug and should stay loud.
        if (process.env.CIPHERLINE_SMOKE_TEST) return;
        this.writeCount++;
        // P2-ELEC-2: atomic write — crash mid-write yields a stale tmp, not a
        // corrupt db. tmp is on the same filesystem so renameSync is atomic.
        const tmp = this.dbPath + '.tmp';
        // Synchronous whole-file write on the main thread — labelled so a
        // stall it causes shows up as such in the freeze log.
        freezeMonitor.track('securestore:save', () => {
            fs.writeFileSync(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, this.dbPath);
        });
    }

    private encrypt(plaintext: string): EncryptedEntry {
        if (!this.masterKey) throw new Error('SecureStore not initialized');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALG, this.masterKey, iv);
        let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
        ciphertext += cipher.final('base64');
        const authTag = cipher.getAuthTag().toString('base64');
        return { iv: iv.toString('base64'), authTag, ciphertext };
    }

    private decrypt(entry: EncryptedEntry): string {
        if (!this.masterKey) throw new Error('SecureStore not initialized');
        const iv      = Buffer.from(entry.iv, 'base64');
        const authTag = Buffer.from(entry.authTag, 'base64');
        const decipher = crypto.createDecipheriv(ALG, this.masterKey, iv);
        decipher.setAuthTag(authTag);
        let plaintext = decipher.update(entry.ciphertext, 'base64', 'utf8');
        plaintext += decipher.final('utf8');
        return plaintext;
    }

    set(key: string, value: string) {
        this.data[key] = this.encrypt(value);
        this.save();
    }

    /** Encrypt and persist multiple entries in a single atomic save (P2-ELEC-10).
     *  A crash between individual `set()` calls would leave a half-applied state;
     *  this mutates all entries then calls `save()` once. */
    setMany(entries: Record<string, string>) {
        for (const [k, v] of Object.entries(entries)) {
            this.data[k] = this.encrypt(v);
        }
        this.save();
    }

    /**
     * Fail loudly on a read that happens before initialize() has finished.
     *
     * `save()` already refuses a write-before-init on the grounds that it is "a
     * real bug and should stay loud". A READ before init was the asymmetric,
     * and far more dangerous, half: `this.data` is still `{}`, so `get()`
     * returned a perfectly ordinary-looking `null` — indistinguishable from
     * "this key has never been set". Callers act on that. `ensureSignalIdentity()`
     * reads `identity_priv`, sees null, and MINTS A NEW IDENTITY over the real
     * one; `pruneOldKeys()` sees no channel keys and skips silently; the game
     * ignore-list comes back empty. Every one of those is a silent wrong answer
     * where a crash would have been recoverable.
     *
     * That hazard was masked only by _doInitialize() running synchronously.
     * Now that it genuinely yields, the window is real, so the guard is real.
     *
     * Scoped to 'uninitialized' ON PURPOSE. 'locked' is a legitimate steady
     * state with the envelope loaded and no master key: `get()` must keep
     * returning null there, because StorageLockedScreen's recovery flow depends
     * on it.
     */
    private assertReadable(op: string): void {
        if (this._status === 'uninitialized') {
            throw new Error(
                `SecureStore.${op}() called before initialize() completed — ` +
                'await secureStore.initialize() (or the storeReady promise in main.ts) first. ' +
                'Reading an uninitialized store returns null for every key, which callers ' +
                'cannot tell apart from "never set" and which can regenerate device identity.',
            );
        }
    }

    get(key: string): string | null {
        this.assertReadable('get');
        const entry = this.data[key];
        if (!entry) return null;
        try {
            return this.decrypt(entry);
        } catch (err) {
            console.error('[SecureStore] Failed to decrypt key:', key, err);
            return null;
        }
    }

    delete(key: string) {
        delete this.data[key];
        this.save();
    }

    /** Iterate over all stored keys. Used by the backup exporter to scoop up
     *  prefix-scoped entries (e.g. `avatar_key:*`).
     *
     *  Guarded for the same reason as get(): before init this returns `[]`,
     *  and callers read an empty list as "nothing stored". pruneOldKeys() and
     *  the SPK/OTP enumeration in signal-identity.ts both iterate this. */
    keys(): string[] {
        this.assertReadable('keys');
        return Object.keys(this.data);
    }
}

export const secureStore = new SecureStore();
