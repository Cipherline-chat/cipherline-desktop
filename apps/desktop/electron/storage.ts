import * as crypto from 'crypto';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
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

/**
 * Envelopes at least this large are parsed in a worker thread (see
 * parseEnvelope). Below it a main-thread JSON.parse costs a few ms and a
 * worker's start-up would cost more than it saves.
 */
export const OFF_THREAD_PARSE_MIN_BYTES = 1024 * 1024;

/** Entries per message the parse worker hands back. */
const PARSE_CHUNK_ENTRIES = 2000;

/**
 * The parse worker. Plain CommonJS, run with `eval: true` so it needs no file
 * of its own inside the asar. It receives the envelope BYTES (ciphertext
 * values, nothing secret in the clear), runs the very same JSON.parse and
 * plain-object check the main thread used to, and streams the entries back as
 * small JSON arrays of [key, entry] pairs — each cheap for the main thread to
 * parse between turns of its event loop. It never sees a key.
 */
const PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
try {
    const parsed = JSON.parse(Buffer.from(workerData.bytes).toString('utf8'));
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) throw new Error('not a plain object');
    const entries = Object.entries(parsed);
    for (let i = 0; i < entries.length; i += workerData.chunk) {
        parentPort.postMessage({ type: 'chunk', json: JSON.stringify(entries.slice(i, i + workerData.chunk)) });
    }
    parentPort.postMessage({ type: 'done', count: entries.length });
} catch (e) {
    parentPort.postMessage({ type: 'invalid', message: String(e && e.message) });
}
`;

/** Thrown for an envelope that is not valid JSON / not a plain object. */
class InvalidEnvelopeError extends Error {}

/** Own-property assignment that is safe for a '__proto__' key too. */
function putOwn(target: Record<string, EncryptedEntry>, key: string, value: EncryptedEntry): void {
    if (key === '__proto__') Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    else target[key] = value;
}

function parseEnvelopeOnThisThread(raw: Buffer): Record<string, EncryptedEntry> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { throw new InvalidEnvelopeError((e as Error).message); }
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) throw new InvalidEnvelopeError('not a plain object');
    return parsed as Record<string, EncryptedEntry>;
}

/**
 * Parse the vault envelope without one long block of the main thread.
 *
 * `JSON.parse` of the whole vault cannot be sliced, and on a long-lived
 * install it is the largest single block left at start-up (13-22 MB measured
 * for a device whose prekey top-ups had been failing). So for a large
 * envelope the parse runs in a worker and the entries come back in chunks.
 *
 * SAME OUTCOMES as the main-thread parse, which is the identity-critical part:
 *   - invalid JSON or a non-object → InvalidEnvelopeError (the caller's
 *     existing corrupt-envelope path: move aside, flag for the boot gate);
 *   - the worker failing for any OTHER reason (could not start, crashed,
 *     exited early) is NOT treated as corruption: the bytes are parsed on
 *     this thread instead, exactly as before.
 */
async function parseEnvelope(raw: Buffer, stats: { offThread: boolean }): Promise<Record<string, EncryptedEntry>> {
    stats.offThread = false;
    if (raw.length < OFF_THREAD_PARSE_MIN_BYTES) return parseEnvelopeOnThisThread(raw);
    let worker: Worker;
    try {
        // workerData is copied (structured clone), so `raw` stays usable for
        // the fallback.
        worker = new Worker(PARSE_WORKER_SOURCE, { eval: true, workerData: { bytes: raw, chunk: PARSE_CHUNK_ENTRIES } });
    } catch (err) {
        console.warn('[SecureStore] envelope parse worker unavailable — parsing on the main thread', err);
        return parseEnvelopeOnThisThread(raw);
    }
    const outcome = await new Promise<{ data: Record<string, EncryptedEntry> } | { invalid: string } | { failed: unknown }>((resolve) => {
        const data: Record<string, EncryptedEntry> = {};
        let received = 0;
        let settled = false;
        const settle = (v: { data: Record<string, EncryptedEntry> } | { invalid: string } | { failed: unknown }) => {
            if (settled) return;
            settled = true;
            resolve(v);
            void worker.terminate().catch(() => {});
        };
        worker.on('message', (msg: { type: string; json?: string; count?: number; message?: string }) => {
            try {
                if (msg.type === 'chunk' && typeof msg.json === 'string') {
                    for (const [k, v] of JSON.parse(msg.json) as [string, EncryptedEntry][]) { putOwn(data, k, v); received++; }
                } else if (msg.type === 'done') {
                    if (received !== msg.count) settle({ failed: new Error('entry count mismatch') });
                    else settle({ data });
                } else if (msg.type === 'invalid') {
                    settle({ invalid: String(msg.message) });
                }
            } catch (err) {
                settle({ failed: err });
            }
        });
        worker.on('error', (err) => settle({ failed: err }));
        worker.on('exit', (code) => settle({ failed: new Error(`parse worker exited (${code})`) }));
    });
    if ('data' in outcome) { stats.offThread = true; return outcome.data; }
    if ('invalid' in outcome) throw new InvalidEnvelopeError(outcome.invalid);
    console.warn('[SecureStore] envelope parse worker failed — parsing on the main thread', outcome.failed);
    return parseEnvelopeOnThisThread(raw);
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

    /** How the last envelope load went (tests + diagnostics). */
    private _loadStats = { offThread: false };
    loadStats(): { offThread: boolean } { return { ...this._loadStats }; }

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
        // The prefix indexes the hot paths use (keysWithPrefix), built here in
        // slices — so no IPC call later pays a whole-vault scan on the
        // window's thread the first time it asks.
        await this.buildHotIndexes();

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
        // Awaited so a fresh store has its canary ON DISK once initialize()
        // resolves (the vault write itself is asynchronous now). Cheap: this
        // branch only runs when the vault is EMPTY.
        if (Object.keys(this.data).length === 0) {
            await yieldToLoop();
            this.set('__canary__', 'cipherline-keycheck-v1');
            await this.whenDurable();
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
        this.indexes.clear();
        try {
            const raw = await readFileIfPresent(this.dbPath);
            // Genuinely absent (ENOENT) — a fresh install. Not corruption, and
            // it must NOT set _corruptBackupFile, or every first launch would
            // greet the user with a data-loss warning.
            if (raw === null) { this.data = {}; return; }

            // Same parse and plain-object check as ever; large envelopes are
            // parsed off this thread (see parseEnvelope).
            this.data = await parseEnvelope(raw, this._loadStats);
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
        // wipe: drop the scheduled write and invalidate any write in flight.
        this.clearWriteTimer();
        this.saveGen++;
        try { if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath); } catch {}
        try { if (fs.existsSync(this.keyPath)) fs.unlinkSync(this.keyPath); } catch {}
        this.data = {};
        this.indexes.clear();
        // Nothing of the old vault is owed to disk any more — it was deleted on
        // purpose. Anyone awaiting durability of an old change is released.
        this.durableSeq = this.seq;
        this.pendingSoon = false;
        this.settleWaiters();
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

    // ── Persistence: asynchronous, coalesced, crash-safe ─────────────────
    //
    // WHY THIS IS ASYNC NOW. Every set()/delete() used to rewrite the WHOLE
    // vault synchronously on the main thread: JSON.stringify of every entry +
    // writeFileSync + renameSync. The main thread owns every window; while it
    // writes, the app cannot repaint, restore, or answer the renderer. A
    // long-lived vault is not small (the DM replay set, the channel replay
    // ledger, every one-time prekey this device still holds — measured 5.5 MB
    // for a healthy 6-month install and 13-22 MB for one whose prekey top-ups
    // had been failing), and at those sizes ONE save blocked the thread for
    // 70-380 ms. `batch()` and the earlier write-behind cut the NUMBER of saves;
    // this cuts what each one costs the thread:
    //
    //   1. A change marks the store dirty and schedules ONE write (next turn for
    //      set()/delete(), DEFER_MS-debounced for setDeferred()/deleteDeferred()).
    //      Any number of changes before it starts ride the same write. A set()
    //      of the value already stored, or a delete() of an absent key, is not
    //      a change and writes nothing.
    //   2. The write takes a point-in-time snapshot of the entry REFERENCES
    //      (entries are immutable — encrypt() makes a new one per set — so the
    //      snapshot cannot tear), then serialises it in slices of at most
    //      SLICE_MS, yielding the loop between slices, and streams it to a temp
    //      file with async fs, fsync, then an atomic rename on this thread so
    //      commits stay strictly ordered with flush().
    //   3. `whenDurable()` resolves once every change made before the call is
    //      on disk, and REJECTS if the write covering it failed. This is the
    //      durability contract that `set()` returning used to provide: callers
    //      whose next step publishes something (the public half of a prekey,
    //      a channel key handed to other members) await it first.
    //   4. `flush()` still writes synchronously — before-quit and suspend use
    //      it, and a newer synchronous write always wins over an older async
    //      one in flight (saveGen).
    //
    // What did NOT change: values are AES-256-GCM encrypted under the master
    // key exactly as before; the file format is the same flat JSON object; a
    // crash mid-write leaves a stale temp file and the previous vault intact.
    private seq = 0;
    private durableSeq = 0;
    private pendingSoon = false;
    private writeTimer: ReturnType<typeof setTimeout> | null = null;
    private writeTimerDue = 0;
    private writeTimerDeferred = false;
    private deferFirstAt = 0;
    private inFlight: Promise<void> | null = null;
    private retryDelayMs = 0;
    private waiters: { target: number; resolve: () => void; reject: (e: unknown) => void }[] = [];
    /** Bumped by every write; a write that finishes after a newer one started
     *  must not rename its (older) snapshot over the newer file. */
    private saveGen = 0;
    /** prefix → keys currently stored under it (see keysWithPrefix). */
    private indexes = new Map<string, Set<string>>();
    static readonly DEFER_MS = 250;
    static readonly DEFER_MAX_MS = 1000;
    static readonly RETRY_MIN_MS = 1000;
    static readonly RETRY_MAX_MS = 30_000;
    /** Longest the serialiser holds the thread before yielding. */
    static readonly SLICE_MS = 8;
    /** Serialised text buffered before it is handed to the (async) file write. */
    static readonly CHUNK_CHARS = 512 * 1024;
    /** set() compares against the stored plaintext only for values this small,
     *  so the no-change check never costs a large decrypt. */
    static readonly NOOP_CHECK_MAX_CHARS = 4096;

    /** How many whole-vault writes have started (tests + perf log). */
    writeCount = 0;

    /**
     * Run `fn` (synchronous). Every change inside it lands in the same
     * coalesced write, as before. It no longer writes synchronously when it
     * returns — `await whenDurable()` for that (ensureSignalIdentity and
     * generateRotationBundle do, before anything they made can be uploaded).
     */
    batch<T>(fn: () => T): T {
        return fn();
    }

    /** set(), written behind on the debounce (high-frequency state). */
    setDeferred(key: string, value: string): void {
        this.put(key, value, true);
    }

    /** delete(), written behind on the debounce. */
    deleteDeferred(key: string): void {
        this.remove(key, true);
    }

    /** True while any change has not reached disk yet. */
    hasPendingWrites(): boolean {
        return this.seq > this.durableSeq;
    }

    /**
     * Resolves once every change made BEFORE this call is on disk; rejects with
     * the write error if the write that covered it failed (the store keeps
     * retrying in the background). Never resolves early: a change counts as
     * durable only after the rename of a snapshot taken after the change.
     */
    whenDurable(): Promise<void> {
        const target = this.seq;
        if (this.durableSeq >= target) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            this.waiters.push({ target, resolve, reject });
            this.pendingSoon = true;
            this.scheduleWrite('soon');
        });
    }

    /** Test hook: resolves once nothing is pending or in flight. */
    async whenWritesSettled(): Promise<void> {
        for (let i = 0; i < 50; i++) {
            if (this.inFlight) { await this.inFlight; continue; }
            if (this.seq <= this.durableSeq && !this.writeTimer) return;
            try { await this.whenDurable(); } catch { /* reported by the store */ }
        }
    }

    /** Write every pending change synchronously, now (before-quit, suspend). */
    flush(): void {
        this.clearWriteTimer();
        if (this.seq <= this.durableSeq) return;
        const target = this.seq;
        if (process.env.CIPHERLINE_SMOKE_TEST) { this.markDurable(target); return; }
        // Any async snapshot still in flight is older than this one.
        this.saveGen++;
        this.writeCount++;
        try {
            // P2-ELEC-2: atomic write — crash mid-write yields a stale tmp, not
            // a corrupt db. tmp is on the same filesystem so renameSync is atomic.
            const tmp = this.dbPath + '.tmp';
            freezeMonitor.track('securestore:save', () => {
                fs.writeFileSync(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
                fs.renameSync(tmp, this.dbPath);
            });
        } catch (e) {
            this.failWaiters(target, e);
            this.retryDelayMs = this.nextRetryDelay();
            this.scheduleWrite('retry');
            throw e;
        }
        this.retryDelayMs = 0;
        this.markDurable(target);
    }

    /** Prefixes the hot paths look up by; indexed during initialize(). */
    static readonly PREINDEXED_PREFIXES: readonly string[] = ['otp_priv_', 'otp_mint_', 'signed_prekey_priv_', 'channel_keys:'];

    private async buildHotIndexes(): Promise<void> {
        const keys = Object.keys(this.data);
        const built = SecureStore.PREINDEXED_PREFIXES.map((p) => [p, new Set<string>()] as const);
        let sliceStart = performance.now();
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            for (const [p, set] of built) if (k.startsWith(p)) set.add(k);
            if ((i & 1023) === 1023 && performance.now() - sliceStart > SecureStore.SLICE_MS) {
                await yieldToLoop();
                sliceStart = performance.now();
            }
        }
        // Nothing can have changed meanwhile: the store refuses reads and
        // writes until initialize() completes.
        for (const [p, set] of built) this.indexes.set(p, set);
    }

    /** Every key currently stored under `prefix`, without scanning the whole
     *  vault. The first call for a prefix builds its index (one scan); after
     *  that every change keeps it current. Same read guard as keys(). */
    keysWithPrefix(prefix: string): string[] {
        this.assertReadable('keysWithPrefix');
        let idx = this.indexes.get(prefix);
        if (!idx) {
            idx = new Set<string>();
            for (const k of Object.keys(this.data)) if (k.startsWith(prefix)) idx.add(k);
            this.indexes.set(prefix, idx);
        }
        return [...idx];
    }

    private has(key: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.data, key);
    }

    /** True when `key` already holds exactly `value` (small values only). */
    private holds(key: string, value: string): boolean {
        if (!this.has(key) || value.length > SecureStore.NOOP_CHECK_MAX_CHARS) return false;
        try { return this.decrypt(this.data[key]) === value; } catch { return false; }
    }

    private put(key: string, value: string, deferred: boolean): void {
        // No change, no write. Settings re-saved with the same value, the
        // hourly protected-epochs refresh, a re-derived pub that was already
        // stored: each of these used to cost a whole-vault rewrite.
        if (this.holds(key, value)) return;
        const isNew = !this.has(key);
        this.data[key] = this.encrypt(value);
        if (isNew) for (const [p, idx] of this.indexes) if (key.startsWith(p)) idx.add(key);
        this.changed(deferred);
    }

    private remove(key: string, deferred: boolean): void {
        if (!this.has(key)) return;
        delete this.data[key];
        for (const [p, idx] of this.indexes) if (key.startsWith(p)) idx.delete(key);
        this.changed(deferred);
    }

    private changed(deferred: boolean): void {
        this.seq++;
        if (!deferred) this.pendingSoon = true;
        this.scheduleWrite(deferred ? 'deferred' : 'soon');
    }

    private nextRetryDelay(): number {
        return Math.min(SecureStore.RETRY_MAX_MS, Math.max(SecureStore.RETRY_MIN_MS, this.retryDelayMs * 2));
    }

    private clearWriteTimer(): void {
        if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
        this.writeTimerDeferred = false;
    }

    private scheduleWrite(mode: 'soon' | 'deferred' | 'retry'): void {
        // The in-flight write's completion reschedules whatever is left.
        if (this.inFlight) return;
        if (this.seq <= this.durableSeq) { this.clearWriteTimer(); this.settleWaiters(); return; }
        const now = Date.now();
        let due: number;
        if (mode === 'soon') {
            due = now;
        } else if (mode === 'retry') {
            due = now + this.retryDelayMs;
        } else {
            // Debounce, but never past DEFER_MAX_MS after the first deferred
            // change: a steady trickle must not postpone the write forever.
            if (!(this.writeTimer && this.writeTimerDeferred)) this.deferFirstAt = now;
            due = Math.min(now + SecureStore.DEFER_MS, this.deferFirstAt + SecureStore.DEFER_MAX_MS);
        }
        if (this.writeTimer) {
            // A sooner write already scheduled covers this change too. A
            // deferred timer is a debounce: a newer deferred change moves it.
            const debounce = mode === 'deferred' && this.writeTimerDeferred;
            if (!debounce && this.writeTimerDue <= due) return;
            clearTimeout(this.writeTimer);
        }
        this.writeTimerDue = due;
        this.writeTimerDeferred = mode === 'deferred';
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.writeTimerDeferred = false;
            this.startWrite();
        }, Math.max(0, due - now));
        // A pending write must not be what keeps a quitting process alive;
        // before-quit flushes it synchronously instead.
        (this.writeTimer as { unref?: () => void }).unref?.();
    }

    private markDurable(target: number): void {
        if (target > this.durableSeq) this.durableSeq = target;
        this.settleWaiters();
    }

    private settleWaiters(): void {
        if (this.waiters.length === 0) return;
        const left: typeof this.waiters = [];
        for (const w of this.waiters) {
            if (w.target <= this.durableSeq) w.resolve();
            else left.push(w);
        }
        this.waiters = left;
    }

    private failWaiters(target: number, err: unknown): void {
        if (this.waiters.length === 0) return;
        const left: typeof this.waiters = [];
        for (const w of this.waiters) {
            if (w.target <= target) w.reject(err);
            else left.push(w);
        }
        this.waiters = left;
    }

    private startWrite(): void {
        this.clearWriteTimer();
        if (this.inFlight) return;
        if (this.seq <= this.durableSeq) { this.settleWaiters(); return; }
        const target = this.seq;
        this.pendingSoon = false;
        // Under the CI smoke test, initialize() deliberately never assigns
        // dbPath (the test only needs the window to paint). Values have
        // already landed in this.data, so the store keeps working in-process
        // for the run; just don't touch disk.
        if (process.env.CIPHERLINE_SMOKE_TEST) { this.markDurable(target); return; }
        if (!this.dbPath) {
            // A write before initialize() is a real bug and stays loud.
            const err = new Error('SecureStore write before initialize() — no vault path');
            console.error('[SecureStore]', err.message);
            this.failWaiters(target, err);
            return;
        }
        const gen = ++this.saveGen;
        this.writeCount++;
        // Point-in-time snapshot of entry references: O(entries) pointer
        // copies, the one step that is not sliced.
        const snapshot = freezeMonitor.track('securestore:snapshot', () => {
            const keys = Object.keys(this.data);
            const out: [string, EncryptedEntry][] = new Array(keys.length);
            for (let i = 0; i < keys.length; i++) out[i] = [keys[i], this.data[keys[i]]];
            return out;
        });
        this.inFlight = this.writeSnapshot(snapshot, gen).then(
            (committed) => {
                this.retryDelayMs = 0;
                if (committed) this.markDurable(target);
                else this.settleWaiters();
            },
            (err) => {
                console.error('[SecureStore] vault write failed — previous vault left intact, will retry', err);
                this.retryDelayMs = this.nextRetryDelay();
                this.failWaiters(target, err);
            },
        ).finally(() => {
            this.inFlight = null;
            if (this.seq > this.durableSeq) {
                this.scheduleWrite(this.retryDelayMs > 0 ? 'retry' : this.pendingSoon ? 'soon' : 'deferred');
            }
        });
    }

    /**
     * Serialise `snapshot` and atomically replace the vault with it. Resolves
     * true when committed, false when a newer write superseded it (its temp
     * file is removed and the newer vault is left alone). Rejects on any I/O
     * error, leaving the previous vault file untouched.
     */
    private async writeSnapshot(snapshot: [string, EncryptedEntry][], gen: number): Promise<boolean> {
        const tmp = this.dbPath + '.wb.tmp';
        const fh = await fsp.open(tmp, 'w', 0o600);
        let complete = false;
        try {
            let buf = '{';
            let sliceStart = performance.now();
            for (let i = 0; i < snapshot.length; i++) {
                const [k, e] = snapshot[i];
                buf += (i === 0 ? '' : ',') + JSON.stringify(k) + ':' + JSON.stringify(e);
                if (buf.length >= SecureStore.CHUNK_CHARS) {
                    await fh.writeFile(buf, 'utf8');
                    buf = '';
                    sliceStart = performance.now();
                } else if ((i & 31) === 31 && performance.now() - sliceStart > SecureStore.SLICE_MS) {
                    await yieldToLoop();
                    sliceStart = performance.now();
                }
            }
            buf += '}';
            await fh.writeFile(buf, 'utf8');
            // Off-thread fsync, so the rename below never publishes a file
            // whose bytes are still only in the page cache.
            await fh.datasync();
            complete = true;
        } finally {
            await fh.close().catch(() => {});
            if (!complete) await fsp.unlink(tmp).catch(() => {});
        }
        // A synchronous flush() (or factoryReset) ran while we were writing:
        // the file on disk is already newer than this snapshot. Drop ours.
        if (gen !== this.saveGen) { await fsp.unlink(tmp).catch(() => {}); return false; }
        // Commit on the main thread, so commits are strictly ordered with the
        // synchronous flush() path. A rename is a metadata operation.
        freezeMonitor.track('securestore:commit', () => fs.renameSync(tmp, this.dbPath));
        return true;
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

    /** Store `value` under `key`. In memory at once; on disk shortly after —
     *  `await whenDurable()` when the next step depends on it being there. */
    set(key: string, value: string) {
        this.put(key, value, false);
    }

    /** Encrypt and store multiple entries; they reach disk in the same write
     *  (P2-ELEC-10: never half-applied on disk). */
    setMany(entries: Record<string, string>) {
        for (const [k, v] of Object.entries(entries)) this.put(k, v, false);
    }

    /**
     * Fail loudly on a read that happens before initialize() has finished.
     *
     * A write-before-init has always been refused loudly as "a real bug". A
     * READ before init was the asymmetric, and far more dangerous, half:
     * `this.data` is still `{}`, so `get()` returned a perfectly
     * ordinary-looking `null` — indistinguishable from "this key has never been
     * set". Callers act on that. `ensureSignalIdentity()` reads `identity_priv`,
     * sees null, and MINTS A NEW IDENTITY over the real one; `pruneOldKeys()`
     * sees no channel keys and skips silently; the game ignore-list comes back
     * empty. Every one of those is a silent wrong answer where a crash would
     * have been recoverable.
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
        const entry = this.has(key) ? this.data[key] : undefined;
        if (!entry) return null;
        try {
            return this.decrypt(entry);
        } catch (err) {
            console.error('[SecureStore] Failed to decrypt key:', key, err);
            return null;
        }
    }

    delete(key: string) {
        this.remove(key, false);
    }

    /** Iterate over all stored keys. Used by the backup exporter to scoop up
     *  prefix-scoped entries (e.g. `avatar_key:*`).
     *
     *  Guarded for the same reason as get(): before init this returns `[]`,
     *  and callers read an empty list as "nothing stored". Prefer
     *  keysWithPrefix() on hot paths — this one is O(vault). */
    keys(): string[] {
        this.assertReadable('keys');
        return Object.keys(this.data);
    }
}

export const secureStore = new SecureStore();
