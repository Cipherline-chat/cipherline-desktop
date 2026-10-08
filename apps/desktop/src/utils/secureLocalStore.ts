/**
 * Encrypted-at-rest replacement for `localStorage`.
 *
 * WHY: everything the renderer decrypts (message history, conversation lists,
 * settings, identity material) was previously written to `localStorage` in
 * plaintext — readable by anyone with filesystem access to the device. This
 * module persists the same key/value data encrypted at rest, keyed by the OS
 * keystore (Electron `safeStorage`), with per-account isolation.
 *
 * HOW IT STAYS SYNCHRONOUS: `localStorage` is synchronous and the app depends on
 * that at ~200 call sites; fetching the OS master key is async. We bridge the
 * gap with an in-memory `Map` that mirrors the store. `hydrate()` runs ONCE at
 * boot (before React renders) to decrypt the on-disk records into the Map; from
 * then on `getItem`/`setItem` operate on the Map synchronously, and writes are
 * flushed back to encrypted IndexedDB on a short debounce.
 *
 * TWO KEY TIERS (see `classify`/`ownerFor`):
 *   - per-account records (anything whose key contains the active userId) are
 *     encrypted under a per-user subkey = HKDF(master, userId). Account B cannot
 *     decrypt account A's data even on the same machine.
 *   - everything else (bootstrap pointers, device-global settings) is encrypted
 *     under the master key directly, so it is readable before any userId.
 *
 * LOCKED STATE: if the master key exists but cannot be unlocked, `hydrate()`
 * marks the store locked and performs NO reads or writes — callers show a
 * recovery screen rather than overwriting unrecoverable ciphertext.
 *
 * WHERE THE CRYPTO LIVES — AND WHY THE FACADE DID NOT CHANGE
 * The records are AES-256-GCM, but this file no longer holds the key and never
 * sees it. The device master key stays in the main process; this store sends
 * ciphertext up over `securekv:open` and gets plaintext back, and sends
 * plaintext up over `securekv:seal` and gets ciphertext back. HKDF per-account
 * subkeys are derived in main too, so main exposes derive-and-use rather than
 * handing out key material. See `electron/kv-crypto.ts` for the threat model,
 * including an explicit account of what that does and does not buy.
 *
 * The SYNCHRONOUS facade is deliberately untouched. ~520 call sites across the
 * app assume `getItem`/`setItem` do not await, and they still do not: the
 * in-memory Map remains the source of truth for reads, so a read-after-write in
 * the same tick sees the new value exactly as before. Only the hydrate and
 * flush paths — which were already async — gained an IPC hop. Making the facade
 * async would have meant rewriting every one of those call sites, and a
 * hydration bug introduced that way presents to the user as data loss.
 *
 * The on-disk format and location are UNCHANGED (same `kv_enc` object store,
 * same `[tag][iv][ct||gcmTag]` record layout, same HKDF info strings), so there
 * is no migration here and nothing to half-complete. That was the deciding
 * factor over relocating the store into the main process: main cannot read the
 * renderer's IndexedDB, so owning the data there would mean migrating every
 * user's local vault, and a migration that fails lands boot on
 * StorageLockedScreen — which a user with a working account reads as having
 * lost everything.
 *
 * Backed by the shared `cipherline` IndexedDB (`kv_enc` store).
 */

import { openDb, KV_STORE } from './attachmentCache';

/**
 * Resolution state of the device master key for this session, as main reports
 * it. 'absent' also covers "there is no Electron bridge at all" — the store
 * then keeps working with unencrypted (TAG_RAW) records, which is how this
 * module behaved before the crypto moved and how it behaves under the website.
 */
export type MasterKeyStatus = 'ok' | 'absent' | 'locked';

/**
 * Record tag byte: payload is stored as-is.
 *
 * This is the only tag this file still names. Wrapped records (tag 0x01) are
 * produced and consumed entirely by `electron/kv-crypto.ts` — the renderer
 * hands their bytes through without interpreting them, which is the point.
 * TAG_RAW is still needed here for the no-Electron-bridge path below.
 */
const TAG_RAW = 0x00;

/** On-disk record: owner userId (or null for master-tier) + wrapped bytes. */
interface KvRecord {
    /** userId this record is encrypted for, or null when master-tier. */
    o: string | null;
    /** `[tag][iv][ciphertext]` bytes from wrapBlob. */
    b: Uint8Array;
}

/**
 * Keys that hold identity/session pointers — flushed immediately (no debounce)
 * because they are rare and losing one on a crash is worse than the I/O.
 */
const IMMEDIATE_KEYS = new Set<string>([
    'cipherline_token',
    'cipherline_refresh_token',
    'cipherline_user_id',
    'cipherline_device_id',
    'cipherline_is_pairing',
    'cipherline_private_key',
    'cipherline_public_key',
]);

/** Key prefixes that skip the debounce — small, rarely-written records the
 *  user notices losing (home pins) if the process dies inside the window. */
const IMMEDIATE_PREFIXES = ['cipherline_home_pins_'];

const FLUSH_DEBOUNCE_MS = 300;

/**
 * Any plaintext localStorage key under these prefixes is purged on boot. We do
 * NOT migrate old plaintext into the encrypted store — existing local sessions
 * simply re-authenticate — so this is a clean cutover that leaves no plaintext
 * copy behind. `avatar_key:*` is owned by avatarKeyStore (SecureStore-backed)
 * and left alone.
 */
const PURGE_PREFIXES = ['cipherline_', 'cl_hx_', 'trusted_identity_', 'sent_avatar_'];

/**
 * Message-history record prefixes, deferred out of the boot-blocking hydrate.
 *
 * These are by far the largest records in the store (one per conversation /
 * channel), and `main.tsx` gates the FIRST PAINT on hydrate() resolving — so
 * decrypting them up front meant the user stared at an empty window for as
 * long as their entire history took to decrypt, before React rendered a single
 * pixel. Nothing above the Dashboard's message panes reads them, so they move
 * to a second phase (`hydrateMessages()`) that the Dashboard awaits while the
 * shell is already on screen.
 *
 * Anything NOT listed here still hydrates in phase 1 and keeps the original
 * "fully populated before first render" guarantee.
 */
const DEFERRED_PREFIXES = ['cipherline_msgs_', 'cipherline_channel_msgs_'];

const isDeferredKey = (key: string) => DEFERRED_PREFIXES.some(p => key.startsWith(p));

/**
 * Is this key NAMED for `userId`? Delimited so a short userId can't substring-
 * match a longer one — the same test `ownerFor` applies.
 *
 * This is about the key's SHAPE, which is not the same question as the tier the
 * record was actually sealed under. The two can disagree, and that disagreement
 * was a data-integrity bug: `ownerFor` consults `activeUserId`, so a key written
 * while NO account is bound is filed master-tier (`o === null`) even though its
 * name carries a userId. Every such key exists — `cl_hx_<uid>`,
 * `cipherline_onboarded_v2_<uid>`, `cipherline_storage_policy_<uid>`,
 * `cl_referral_welcome_<uid>` are all written by AuthScreen BEFORE `login()`
 * binds the account.
 *
 * `onUserChanged` must use the SAME predicate on the way out and on the way in,
 * or it evicts records it can never restore. See the call sites.
 */
const keyIsNamedFor = (key: string, userId: string): boolean =>
    key.includes(`_${userId}_`) || key.endsWith(`_${userId}`);

/**
 * How many deferred history records `hydrateMessages()` decrypts before it
 * yields the main thread. Small enough that one batch is a short task even
 * when every record is a large conversation; large enough that the yields
 * don't dominate. See the comment at the loop for why this is batched at all.
 */
const HYDRATE_BATCH = 8;

/**
 * Hand the main thread back so queued input (the user's first click after the
 * boot animation) is serviced before the next batch starts.
 *
 * `scheduler.yield()` is the purpose-built API and re-queues at the FRONT of
 * the task queue, so yielding stays cheap; `setTimeout(0)` is the fallback
 * where it isn't available. Both are enough to break up a long task.
 */
function yieldToEventLoop(): Promise<void> {
    const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof s?.yield === 'function') return s.yield();
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/**
 * Read a TAG_RAW record without any key. Used only when there is no Electron
 * bridge at all — the website imports this graph, and before the crypto moved
 * into main that environment already ran unencrypted. A TAG_WRAPPED record is
 * unreadable here and yields null (a skipped record), never an exception.
 */
function readRaw(bytes: Uint8Array): string | null {
    if (bytes.length === 0 || bytes[0] !== TAG_RAW) return null;
    return new TextDecoder().decode(bytes.subarray(1));
}

/** Write a TAG_RAW record. Same no-bridge path as {@link readRaw}. */
function writeRaw(value: string): Uint8Array {
    const body = new TextEncoder().encode(value);
    const out = new Uint8Array(1 + body.length);
    out[0] = TAG_RAW;
    out.set(body, 1);
    return out;
}

class SecureLocalStore {
    private map = new Map<string, string>();
    private dirty = new Set<string>();
    /** Owner tier captured at setItem time, so a record written for account A
     *  is filed under A even if the active account flips before the flush. */
    private dirtyOwner = new Map<string, string | null>();
    private tombstones = new Set<string>();
    /** Resolves when the active account's records are in memory. Sign-in awaits
     *  this before mounting the app, so no component reads a cold namespace. */
    private accountReady: Promise<void> = Promise.resolve();
    private readyUserId: string | null = null;
    private hydrated = false;
    private locked = false;
    private status: MasterKeyStatus = 'absent';
    private activeUserId: string | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushChain: Promise<void> = Promise.resolve();
    /** Phase-2 records held back from hydrate(); see DEFERRED_PREFIXES. */
    private deferred: Array<[string, KvRecord]> = [];
    private messagesHydrated = false;
    private messagesHydrating: Promise<void> | null = null;
    /**
     * Bumped by anything that invalidates the account whose data is in memory:
     * a sign-out, an account switch, or a full local wipe.
     *
     * `hydrateMessages()` is the one long-running async loop that writes into
     * `map` from a snapshot taken before it started, and it now yields the main
     * thread between batches — so one of those events can land mid-loop. It
     * captures this counter at entry and stops as soon as it changes; without
     * that it keeps decrypting the departed account's ciphertext into a map
     * that was just purged. See the comment at the check itself.
     */
    private generation = 0;

    /**
     * DETACHED VALUES — the plaintext of a record dropped from `map` once it is
     * on disk, because the module that owns it keeps the same data in memory in
     * PARSED form and can serialise it again on demand.
     *
     * WHY (renderer memory): message history is held twice. messageStore parses
     * every thread into the arrays React renders, and this map kept the JSON
     * text those arrays came from for the rest of the session — as a two-byte
     * string as soon as one message contains an emoji. For a 30k-message
     * history that second copy was 23 MB of the renderer's heap, measured, for
     * text nothing reads again except a few rare paths (the DM merge base, a
     * backup export), which can be served from the parsed copy instead.
     *
     * THE CONTRACT that keeps this lossless:
     *  - Only a key whose owner called {@link markDetachable} right after
     *    writing (or reading) it can be detached, and only while `map` still
     *    holds THAT exact string (any other setItem clears the mark).
     *  - A key is dropped from `map` only once it is not dirty, i.e. its newest
     *    value has been handed to a flush. If that flush then fails, the
     *    re-queued write regenerates the value from the source — see
     *    {@link valueFor} in flushOnce — so nothing that was owed to disk is
     *    lost.
     *  - Every read API (getItem, keysWithPrefix, key/length) treats a detached
     *    key as present and getItem regenerates its value, so no caller can
     *    mistake a detached record for an absent one — the confusion that
     *    would, for example, let a DM merge write a thread over its own history.
     *  - setItem/removeItem/clear/sign-out/account switch drop the detached
     *    state exactly as they drop a `map` entry.
     */
    private detached = new Set<string>();
    /** key -> the exact string the owner vouched it can regenerate. */
    private detachable = new Map<string, string>();
    private sources: Array<{ prefix: string; regenerate: (key: string) => string | null }> = [];

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Decrypt the on-disk store into memory. Must be awaited before any
     * synchronous access. Safe to call more than once (subsequent calls no-op).
     */
    async hydrate(): Promise<void> {
        if (this.hydrated) return;

        this.status = await this.resolveStatus();

        if (this.status === 'locked') {
            // Do NOT read or write — the ciphertext is preserved for recovery.
            this.locked = true;
            this.hydrated = true;
            return;
        }

        try {
            const records = [...(await this.readAllRecords())];

            // One IPC round trip per tier rather than one per record: main
            // decrypts the whole batch and returns the plaintexts together.
            // Batching is what keeps the round-trip count proportional to
            // hydrate phases instead of to the number of stored keys.
            const decryptInto = async (entries: Array<[string, KvRecord]>) => {
                for (const [k, plain] of await this.openRecords(entries)) this.map.set(k, plain);
            };

            // Tier 1 — master-tier records (owner null). These include the
            // bootstrap pointer `cipherline_user_id`, so decrypt them first.
            await decryptInto(records.filter(([, rec]) => rec.o === null));

            this.activeUserId = this.map.get('cipherline_user_id') ?? null;

            // Tier 2 — per-account records for the active user only. Message
            // history is held back for hydrateMessages() so first paint isn't
            // gated on it (see DEFERRED_PREFIXES). Main selects the per-account
            // subkey from each record's own owner field, so there is no key to
            // pass and no way for the two to disagree.
            if (this.activeUserId) {
                const mine = records.filter(([, rec]) => rec.o === this.activeUserId);
                this.deferred = mine.filter(([k]) => isDeferredKey(k));
                await decryptInto(mine.filter(([k]) => !isDeferredKey(k)));
            }
            this.readyUserId = this.activeUserId;

        } catch (e) {
            // A read/decrypt failure must not crash boot — degrade to an empty
            // in-memory store rather than blocking the app. Nothing is deleted.
            console.error('[secureLocalStore] hydrate failed — continuing with empty store', e);
        }

        this.hydrated = true;
        // Clean cutover: nuke any leftover plaintext so no unencrypted copy
        // survives. (Not done when locked — we touch nothing in that state.)
        if (!this.locked) this.purgeLegacyPlaintext();
        this.installQuitFlush();
    }

    /**
     * Phase 2 of hydration: decrypt the message-history records held back by
     * hydrate() so first paint wasn't blocked on them. Awaited by whoever is
     * about to read message caches (Dashboard's restore effect).
     *
     * Idempotent and concurrency-safe — repeat callers share the in-flight
     * promise rather than decrypting twice. A no-op when the store is locked
     * or nothing was deferred, so callers never need to branch.
     */
    async hydrateMessages(): Promise<void> {
        if (this.messagesHydrated) return;
        if (this.messagesHydrating) return this.messagesHydrating;

        const gen = this.generation;

        this.messagesHydrating = (async () => {
            try {
                if (!this.locked && this.deferred.length && this.activeUserId) {
                    // A REFERENCE to the deferred array, deliberately: the loop
                    // below is the sole owner of this snapshot for its lifetime.
                    // Everything that invalidates it (sign-out, account switch,
                    // wipe) rebinds `this.deferred` rather than mutating it, and
                    // bumps `generation` — which the check below acts on.
                    const entries = this.deferred;
                    // Decrypt in BOUNDED batches, yielding to the event loop
                    // between them, instead of one unbounded request.
                    //
                    // The AES-GCM and the UTF-8 decode of each conversation now
                    // happen in the MAIN process, which takes the bulk of this
                    // work off the renderer's thread entirely. The batching and
                    // the yield stay anyway, because what lands on this thread
                    // is still one structured-clone deserialisation per record
                    // and phase 2 still resolves just after the shell paints and
                    // the boot animation ends — the window in which the user
                    // makes their first click, and the reason the app used to
                    // appear to freeze and then recover. Batching keeps that as
                    // many short tasks rather than one long one.
                    //
                    // The per-key guard below is applied per batch rather than
                    // once at the end. That is strictly MORE correct now that
                    // we yield: a message can be written between batches, and
                    // checking immediately before each write keeps the
                    // never-clobber window as small as possible.
                    for (let i = 0; i < entries.length; i += HYDRATE_BATCH) {
                        const batch = entries.slice(i, i + HYDRATE_BATCH);
                        const plains = await this.openRecords(batch);
                        // The account we are decrypting for is gone — signed
                        // out, switched away from, or wiped — and it happened
                        // while this batch was decrypting or during the yield
                        // that preceded it. `entries` and everything still
                        // undecrypted belong to THAT account, so writing any of
                        // it into `map` now would put the previous account's
                        // plaintext back into a map that was just purged, with
                        // nothing left to prune it. Stop here and drop the
                        // rest; the new account's records are loaded by
                        // onUserChanged(), not by this loop.
                        if (this.generation !== gen) break;
                        plains.forEach(([k, plain]) => {
                            // NEVER clobber a value written since hydrate().
                            // Phase 2 resolves after first paint, so a message
                            // can arrive and be persisted in the gap — blindly
                            // applying the on-disk snapshot here would silently
                            // roll that back and lose the message (the local
                            // cache is its only copy once the server drops the
                            // ACKed envelope). A tombstone means it was deleted
                            // in the gap; don't resurrect it either.
                            if (this.map.has(k) || this.detached.has(k) || this.tombstones.has(k)) return;
                            this.map.set(k, plain);
                        });
                        if (i + HYDRATE_BATCH < entries.length) await yieldToEventLoop();
                    }
                }
            } catch (e) {
                // Same contract as hydrate(): a decrypt failure degrades to
                // "no cached history" rather than breaking the app. Nothing
                // is deleted, so a later launch can still recover it.
                console.error('[secureLocalStore] hydrateMessages failed — continuing without cached history', e);
            } finally {
                this.deferred = [];        // release the ciphertext either way
                // Only latch "phase 2 is done" when this run is still the
                // current generation. An aborted run must not report the
                // departed account's history as loaded for whatever replaced
                // it — the replacement sets its own flag (onUserChanged) or
                // clears it (wipeLocalData).
                if (this.generation === gen) this.messagesHydrated = true;
                this.messagesHydrating = null;
            }
        })();

        return this.messagesHydrating;
    }

    /**
     * Every in-memory key starting with `prefix`. Used to enumerate the
     * per-conversation message records without maintaining a separate index
     * key, which would be one more thing that can drift out of sync with
     * what's actually stored.
     */
    keysWithPrefix(prefix: string): string[] {
        this.ensureReady();
        const out: string[] = [];
        for (const k of this.map.keys()) if (k.startsWith(prefix)) out.push(k);
        for (const k of this.detached) if (k.startsWith(prefix)) out.push(k);
        return out;
    }

    // ── Detached values (see the `detached` field) ──────────────────────────

    /**
     * Declare that every key under `prefix` that its owner marks with
     * {@link markDetachable} can be serialised again by `regenerate`. It must
     * return exactly the data last written for that key (or null if it does not
     * know the key — such a key is then never detached).
     */
    registerDetachableSource(prefix: string, regenerate: (key: string) => string | null): void {
        this.sources = this.sources.filter(s => s.prefix !== prefix);
        this.sources.push({ prefix, regenerate });
    }

    /**
     * The owner of `key` holds, in memory, the parsed form of the value `map`
     * holds for it right now, and will keep it until it next writes or removes
     * the key. The plaintext is dropped from `map` as soon as it is on its way
     * to disk (immediately, when it already is).
     */
    markDetachable(key: string): void {
        if (this.locked) return;
        const v = this.map.get(key);
        if (v === undefined) return;            // already detached, or absent
        if (!this.sources.some(s => key.startsWith(s.prefix))) return;
        this.detachable.set(key, v);
        this.maybeDetach(key);
    }

    /** True when `key` is present but its plaintext lives with its owner. */
    isDetached(key: string): boolean {
        return this.detached.has(key);
    }

    /** Drop `key`'s plaintext from `map` if the contract allows it now. */
    private maybeDetach(key: string): void {
        const vouched = this.detachable.get(key);
        if (vouched === undefined) return;
        if (this.dirty.has(key) || this.tombstones.has(key)) return; // newest value not handed to a flush yet
        if (this.map.get(key) !== vouched) { this.detachable.delete(key); return; }
        this.map.delete(key);
        this.detachable.delete(key);
        this.detached.add(key);
    }

    /** Serialise a detached key again. Loud on failure: by construction it
     *  cannot fail, and a silent null would read as "no such record". */
    private regenerate(key: string): string | null {
        const src = this.sources.find(s => key.startsWith(s.prefix));
        const v = src ? src.regenerate(key) : null;
        if (v === null) console.error(`[secureLocalStore] detached record ${key} could not be regenerated by its owner`);
        return v;
    }

    /** The current value of `key`, wherever it lives. */
    private valueFor(key: string): string | undefined {
        const v = this.map.get(key);
        if (v !== undefined) return v;
        if (this.detached.has(key)) return this.regenerate(key) ?? undefined;
        return undefined;
    }

    /** Forget detached/detachable state for keys matching `pred` (or all). */
    private forgetDetached(pred?: (k: string) => boolean): void {
        for (const k of [...this.detached]) if (!pred || pred(k)) this.detached.delete(k);
        for (const k of [...this.detachable.keys()]) if (!pred || pred(k)) this.detachable.delete(k);
    }

    /** Delete any plaintext localStorage entries under the managed prefixes. */
    private purgeLegacyPlaintext(): void {
        if (typeof localStorage === 'undefined') return;
        try {
            const toRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && PURGE_PREFIXES.some(p => key.startsWith(p))) toRemove.push(key);
            }
            if (toRemove.length) {
                for (const k of toRemove) localStorage.removeItem(k);
                console.info(`[secureLocalStore] purged ${toRemove.length} legacy plaintext key(s)`);
            }
        } catch (e) {
            console.warn('[secureLocalStore] legacy plaintext purge failed', e);
        }
    }

    /** True when the OS keystore holds a key that could not be unlocked. */
    isLocked(): boolean {
        return this.locked;
    }

    /** Resolution status of the master key for this session. */
    masterKeyStatus(): MasterKeyStatus {
        return this.status;
    }

    // ── Storage API (synchronous, post-hydrate) ──────────────────────────────

    getItem(key: string): string | null {
        this.ensureReady();
        const v = this.valueFor(key);
        return v === undefined ? null : v;
    }

    setItem(key: string, value: string): void {
        this.ensureReady();
        if (this.locked) return; // never write over preserved ciphertext
        this.map.set(key, value);
        this.detached.delete(key);
        this.detachable.delete(key);
        this.tombstones.delete(key);

        // Track the active account so per-user records route to the right subkey.
        // On a genuine switch, swap the per-account records in memory.
        if (key === 'cipherline_user_id') {
            const prev = this.activeUserId;
            const next = value || null;
            this.activeUserId = next;
            if (prev !== next) {
                this.readyUserId = null;
                this.accountReady = this.onUserChanged(prev, next);
            }
        }

        this.dirty.add(key);
        this.dirtyOwner.set(key, this.ownerFor(key));
        this.scheduleFlush(IMMEDIATE_KEYS.has(key) || IMMEDIATE_PREFIXES.some(p => key.startsWith(p)) ? 0 : FLUSH_DEBOUNCE_MS);
    }

    /**
     * Account switch within a running session: drop the previous account's
     * per-user records from memory and load the new account's. Master-tier keys
     * (session pointers, settings) are untouched. Fire-and-forget; reads settle
     * once the async decrypt completes (a re-render follows login anyway).
     */
    private async onUserChanged(prevId: string | null, nextId: string | null): Promise<void> {
        // Synchronous with the setItem/removeItem that triggered us, so an
        // in-flight hydrateMessages() sees this before its next write.
        this.generation++;
        try {
            if (prevId) {
                // Flush what the previous account still has pending BEFORE its
                // records leave memory: flush() skips keys no longer in the map,
                // so dropping first silently lost the last writes before a
                // switch (a pin added seconds before signing out, for one).
                // Owners were captured at setItem time, so they file correctly
                // even though activeUserId has already moved on.
                this.flushChain = this.flushChain.then(() => this.flush()).catch(err =>
                    console.error('[secureLocalStore] pre-switch flush failed', err),
                );
                await this.flushChain;
                for (const k of [...this.map.keys()]) {
                    if (k !== 'cipherline_user_id' && keyIsNamedFor(k, prevId)) this.map.delete(k);
                }
                // A detached record is as present as a `map` entry: it leaves
                // with its account, or the previous account's history would
                // still answer getItem() after sign-out.
                this.forgetDetached(k => k !== 'cipherline_user_id' && keyIsNamedFor(k, prevId));
            }
            // Any records still queued for phase 2 belong to the account we
            // just left — drop them before loading the new one, or a later
            // hydrateMessages() would try the previous user's ciphertext
            // against the new user's subkey. (It would fail closed and set
            // nothing, but leaving stale ciphertext queued is a trap.)
            this.deferred = [];
            if (nextId) {
                const records = [...(await this.readAllRecords())];
                // Exactly the inverse of the eviction above, by construction.
                //
                // `rec.o === nextId` alone was NOT that inverse, and the gap
                // was load-bearing: the eviction drops every key NAMED for the
                // departing account, but a key named for an account can be
                // sealed MASTER-TIER (`o === null`) when it was written before
                // `cipherline_user_id` was bound — which is exactly how
                // AuthScreen writes `cl_hx_<uid>` and friends. Such a record
                // was therefore evicted on sign-out and never restored by an
                // in-session sign-in: only a full `hydrate()` (app restart)
                // brought it back, because hydrate loads every master-tier
                // record unconditionally.
                //
                // `cl_hx_<uid>` is the marker that says "this device already
                // holds history for this account". Losing it made a signed-back-
                // in account render as "No history on this device" and offered
                // a restore-from-backup over data that was never missing.
                //
                // Restoring master-tier records here exposes nothing new: a
                // cold boot already loads all of them, so this only re-reaches
                // the state a restart would have produced.
                const mine = records.filter(
                    ([k, rec]) => rec.o === nextId || (rec.o === null && keyIsNamedFor(k, nextId)),
                );
                for (const [k, plain] of await this.openRecords(mine)) {
                    // Same rule as hydrateMessages(): never roll back a value
                    // written (or deleted) while this decrypt was in flight.
                    if (!this.map.has(k) && !this.detached.has(k) && !this.tombstones.has(k)) this.map.set(k, plain);
                }
            }
            if (this.activeUserId === nextId) this.readyUserId = nextId;
            // This path loads message history eagerly (an account switch is
            // already a full teardown/re-render, so there's no first-paint to
            // protect) — mark phase 2 satisfied so a later await is a no-op.
            this.messagesHydrated = true;
            this.messagesHydrating = null;
        } catch (e) {
            console.error('[secureLocalStore] account-switch rehydrate failed', e);
        }
    }

    /** Resolves once the active account's records are decrypted into memory
     *  (immediately if no switch is in flight). */
    whenAccountReady(): Promise<void> { return this.accountReady; }
    /** True when `userId` is the active account AND its records are loaded -
     *  the condition a persist effect must see before it may write. */
    isAccountReady(userId: string): boolean { return !!userId && this.readyUserId === userId; }

    /**
     * Destroy ALL locally stored data (the encrypted key/value store) and reset
     * in-memory state. Used by the "start fresh" recovery path. The main-process
     * SecureStore is reset separately via its own IPC.
     */
    async wipeLocalData(): Promise<void> {
        // Before the await, so a hydrateMessages() already running stops
        // writing rather than racing the clears below.
        this.generation++;
        try {
            const db = await openDb();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(KV_STORE, 'readwrite');
                tx.objectStore(KV_STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (e) {
            console.error('[secureLocalStore] wipeLocalData failed', e);
        }
        this.map.clear();
        this.forgetDetached();
        this.dirty.clear();
        this.dirtyOwner.clear();
        this.tombstones.clear();
        this.activeUserId = null;
        this.readyUserId = null;
        // Phase-2 state belongs to the account that was just wiped. Leaving it
        // set worked only by accident — hydrateMessages() short-circuits on the
        // now-null activeUserId — which is not something to rely on.
        this.deferred = [];
        this.messagesHydrated = false;
        this.messagesHydrating = null;
    }

    removeItem(key: string): void {
        this.ensureReady();
        if (this.locked) return;
        this.map.delete(key);
        this.detached.delete(key);
        this.detachable.delete(key);
        this.dirty.delete(key);
        this.dirtyOwner.delete(key);
        this.tombstones.add(key);
        if (key === 'cipherline_user_id') {
            const prev = this.activeUserId;
            this.activeUserId = null;
            this.readyUserId = null;
            // Sign-out used to leave the account's records in memory, so the
            // NEXT sign-in in the same run saw the previous account's data
            // until its own decrypt landed. Same teardown as a switch.
            if (prev) this.accountReady = this.onUserChanged(prev, null);
        }
        this.scheduleFlush(IMMEDIATE_KEYS.has(key) || IMMEDIATE_PREFIXES.some(p => key.startsWith(p)) ? 0 : FLUSH_DEBOUNCE_MS);
    }

    clear(): void {
        this.ensureReady();
        if (this.locked) return;
        for (const key of this.map.keys()) this.tombstones.add(key);
        for (const key of this.detached) this.tombstones.add(key);
        this.forgetDetached();
        this.dirtyOwner.clear();
        this.map.clear();
        this.dirty.clear();
        this.activeUserId = null;
        this.scheduleFlush(0);
    }

    key(index: number): string | null {
        this.ensureReady();
        if (index < 0) return null;
        let i = 0;
        for (const k of this.map.keys()) {
            if (i === index) return k;
            i++;
        }
        for (const k of this.detached) {
            if (i === index) return k;
            i++;
        }
        return null;
    }

    get length(): number {
        this.ensureReady();
        return this.map.size + this.detached.size;
    }

    // ── Flushing ──────────────────────────────────────────────────────────────

    /** Force any pending writes to disk now and await completion. */
    async flushNow(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }

    private scheduleFlush(delay: number): void {
        if (this.locked || this.status === 'locked') return;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            // Serialize flushes so overlapping timers can't interleave writes.
            this.flushChain = this.flushChain.then(() => this.flush()).catch(err =>
                console.error('[secureLocalStore] flush failed', err),
            );
        }, delay);
    }

    /**
     * Resolve only once every value written to `keys` before this call is on
     * disk, and THROW if that cannot be promised.
     *
     * For a caller about to do something irreversible on the strength of the
     * write — the DM pull loop ACKs an envelope, which DELETES the server's only
     * copy (Message integrity §3). flushNow() is not that promise:
     *  - a flush already in flight has taken its keys off the dirty set, so a
     *    concurrent flushNow() finds nothing to do and resolves before that
     *    write has committed (or failed);
     *  - a record main could not seal is re-queued and flushNow() still
     *    resolves;
     *  - a locked store never writes at all, and says nothing.
     * This waits for every in-flight flush, flushes what is left, and then
     * checks that none of `keys` is still waiting to be written.
     *
     * A throw means "not known to be on disk" — the caller must not act as if
     * it were. (A concurrent setItem to one of `keys` between the flush and the
     * check also reads as not-yet-durable; that errs toward the caller trying
     * again, never toward acting early.)
     */
    async flushDurable(keys: string[]): Promise<void> {
        if (this.isLockedNow()) {
            throw new Error('secure store is locked — nothing can be written, so nothing is durable');
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // Writes already on their way to disk, including any that hold `keys`.
        // allSettled: a failed one re-queued its keys, which the flush below
        // retries and the check after it catches.
        await Promise.allSettled([...this.inFlightFlushes]);
        await this.flush();
        if (this.isLockedNow()) {
            throw new Error('secure store became locked — the write was not made durable');
        }
        const pending = keys.filter(k => this.dirty.has(k) || this.tombstones.has(k));
        if (pending.length > 0) {
            throw new Error(`${pending.length} record(s) were not written to disk — not durable`);
        }
    }

    /** A method, not an inline check, so a lock that lands during an await is
     *  re-read rather than narrowed away by the check before it. */
    private isLockedNow(): boolean {
        return this.locked || this.status === 'locked';
    }

    /** Every flush() currently running — see flushDurable(). */
    private readonly inFlightFlushes = new Set<Promise<void>>();

    private flush(): Promise<void> {
        const run = this.flushOnce();
        this.inFlightFlushes.add(run);
        const done = () => { this.inFlightFlushes.delete(run); };
        run.then(done, done);
        return run;
    }

    private async flushOnce(): Promise<void> {
        if (this.dirty.size === 0 && this.tombstones.size === 0) return;

        const dirtyKeys = [...this.dirty];
        const owners = new Map(dirtyKeys.map(k => [k, this.dirtyOwner.has(k) ? this.dirtyOwner.get(k)! : this.ownerFor(k)] as const));
        const tombstoneKeys = [...this.tombstones];
        this.dirty.clear();
        this.dirtyOwner.clear();
        this.tombstones.clear();

        // Snapshot the VALUES synchronously, before any await. The previous
        // version read `this.map.get(key)` after awaiting the key material, so
        // a concurrent setItem could change a value between the moment the key
        // was chosen and the moment it was read. Collecting first removes that
        // window entirely: what gets encrypted is exactly what was in the map
        // when the flush began.
        //
        // valueFor, not map.get: a key re-queued by a FAILED flush may have
        // been detached in the meantime (its plaintext dropped because the
        // failed write had already taken it off the dirty set). Its owner
        // regenerates it, so the retry still writes it instead of reading
        // "absent" and silently dropping a value that never reached disk.
        const pending = dirtyKeys.flatMap(key => {
            const v = this.valueFor(key);
            if (v === undefined) return []; // deleted after being marked dirty
            return [{ k: key, o: owners.get(key) ?? null, v }];
        });

        // Encrypt outside the IndexedDB transaction — awaiting crypto inside a
        // txn would let the txn auto-close. Build records first, then write.
        //
        // The locked check reads the state resolved at hydrate rather than
        // asking main again. flush() runs on the QUIT path (flushNow() from
        // pagehide/beforeunload), and every extra IPC round trip there widens
        // the window in which the process can die with writes still pending.
        // It is also not the only guard: KvCrypto.seal() refuses outright while
        // locked and returns a null record for every key, which lands in the
        // re-queue below — so a store that became locked after hydrate (a
        // factory reset mid-session) still cannot overwrite preserved data.
        if (this.locked || this.status === 'locked') {
            // Never overwrite preserved ciphertext. Put the work back so a
            // later successful unlock still flushes it rather than dropping it.
            this.requeue(pending.map(p => p.k), owners, tombstoneKeys);
            return;
        }

        try {
            const sealed = await this.sealRecords(pending);
            const puts: Array<{ key: string; rec: KvRecord }> = [];
            const failed: string[] = [];
            for (const { k, b } of sealed) {
                if (b === null) { failed.push(k); continue; }
                puts.push({ key: k, rec: { o: owners.get(k) ?? null, b } });
            }
            await this.writeBatch(puts, tombstoneKeys);
            // A record main could not seal is re-queued rather than dropped —
            // otherwise a single transient encrypt failure silently loses that
            // key's newest value with nothing to retry it.
            if (failed.length) this.requeue(failed, owners, []);
            // On disk now: a vouched-for value can leave memory (maybeDetach
            // re-checks that it is still the value just written and not dirty).
            for (const { key } of puts) if (this.detachable.has(key)) this.maybeDetach(key);
        } catch (e) {
            // Re-queue so the data isn't lost; it'll retry on the next write.
            this.requeue(dirtyKeys, owners, tombstoneKeys);
            throw e;
        }
    }

    /** Put keys (and tombstones) back on the dirty set after a failed flush. */
    private requeue(keys: string[], owners: Map<string, string | null>, tombstoneKeys: string[]): void {
        for (const key of keys) {
            this.dirty.add(key);
            this.dirtyOwner.set(key, owners.get(key) ?? null);
        }
        for (const key of tombstoneKeys) this.tombstones.add(key);
    }

    private async writeBatch(puts: Array<{ key: string; rec: KvRecord }>, deletes: string[]): Promise<void> {
        if (puts.length === 0 && deletes.length === 0) return;
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readwrite');
            const store = tx.objectStore(KV_STORE);
            for (const { key, rec } of puts) store.put(rec, key);
            for (const key of deletes) store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** Decide which userId a key's record belongs to (null = master-tier). */
    private ownerFor(key: string): string | null {
        if (!this.activeUserId) return null;
        const id = this.activeUserId;
        // Delimited check: require underscore boundary so a short userId can't
        // substring-match a longer one (e.g. "abc" matching "abcdef_...").
        // NOTE the `!this.activeUserId` early return above: a key NAMED for an
        // account but written while none is bound is filed master-tier. That is
        // why onUserChanged's reload has to accept master-tier records whose
        // name matches — see `keyIsNamedFor`.
        return keyIsNamedFor(key, id) ? id : null;
    }

    // ── Main-process crypto bridge ───────────────────────────────────────────
    //
    // The device master key lives in the main process and never crosses the
    // context bridge. These three helpers are the entire renderer-side surface
    // of that arrangement. Each one degrades to the pre-existing unencrypted
    // (TAG_RAW) behaviour when there is no Electron bridge at all, which is how
    // this module has to behave when the website imports this graph.

    /** The bridge, or null when running without Electron (e.g. the website). */
    private bridge(): {
        secureKvOpen?: (r: Array<{ k: string; o: string | null; b: Uint8Array }>) => Promise<Array<{ k: string; v: string | null }>>;
        secureKvSeal?: (r: Array<{ k: string; o: string | null; v: string }>) => Promise<Array<{ k: string; b: Uint8Array | null }>>;
        getLocalMasterKeyStatus?: () => Promise<{ status: MasterKeyStatus }>;
    } | null {
        if (typeof window === 'undefined') return null;
        return (window as unknown as { electronAPI?: Record<string, never> }).electronAPI ?? null;
    }

    /**
     * Ask main for the master key's state WITHOUT moving any key material.
     * Anything unexpected is reported as 'locked', never 'ok': the conservative
     * direction here preserves unreadable ciphertext, and the optimistic one
     * overwrites it.
     */
    private async resolveStatus(): Promise<MasterKeyStatus> {
        const api = this.bridge();
        if (typeof api?.getLocalMasterKeyStatus !== 'function') return 'absent';
        try {
            const res = await api.getLocalMasterKeyStatus();
            if (res?.status === 'ok' || res?.status === 'absent' || res?.status === 'locked') return res.status;
            return 'locked';
        } catch (e) {
            console.error('[secureLocalStore] master key status check failed', e);
            return 'locked';
        }
    }

    /**
     * Decrypt stored records via main. Returns only the records that opened —
     * an unreadable one is dropped, matching the previous per-record soft
     * failure, so one bad record cannot fail hydrate for the whole store.
     */
    private async openRecords(entries: Array<[string, KvRecord]>): Promise<Array<[string, string]>> {
        if (entries.length === 0) return [];
        const api = this.bridge();
        if (typeof api?.secureKvOpen !== 'function') {
            // No bridge: only TAG_RAW records are readable, same as before.
            return entries.flatMap(([k, rec]) => {
                const v = readRaw(rec.b);
                return v === null ? [] : ([[k, v]] as Array<[string, string]>);
            });
        }
        try {
            const opened = await api.secureKvOpen(entries.map(([k, rec]) => ({ k, o: rec.o, b: rec.b })));
            return opened.flatMap(({ k, v }) => (v === null ? [] : ([[k, v]] as Array<[string, string]>)));
        } catch (e) {
            console.warn('[secureLocalStore] batch decrypt failed — skipping', e);
            return [];
        }
    }

    /** Encrypt values via main. `b: null` marks a record the caller must re-queue. */
    private async sealRecords(items: Array<{ k: string; o: string | null; v: string }>): Promise<Array<{ k: string; b: Uint8Array | null }>> {
        if (items.length === 0) return [];
        const api = this.bridge();
        if (typeof api?.secureKvSeal !== 'function') {
            return items.map(({ k, v }) => ({ k, b: writeRaw(v) }));
        }
        return api.secureKvSeal(items);
    }

    private async readAllRecords(): Promise<Map<string, KvRecord>> {
        const out = new Map<string, KvRecord>();
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readonly');
            const store = tx.objectStore(KV_STORE);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) { resolve(); return; }
                out.set(String(cursor.key), cursor.value as KvRecord);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
            tx.onerror = () => reject(tx.error);
        });
        return out;
    }

    private ensureReady(): void {
        if (!this.hydrated) {
            throw new Error('secureLocalStore accessed before hydrate() — call hydrate() during boot before render');
        }
    }

    private quitFlushInstalled = false;
    private installQuitFlush(): void {
        if (this.quitFlushInstalled || typeof window === 'undefined') return;
        this.quitFlushInstalled = true;
        const flush = () => { void this.flushNow(); };
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
    }

    // ── Test hooks ───────────────────────────────────────────────────────────
    /** @internal reset in-memory state (tests only). */
    _resetForTest(): void {
        this.map.clear();
        // Sources stay registered: they are installed once, at module load,
        // by their owners (messageStore), which a test reset does not re-run.
        this.forgetDetached();
        this.dirty.clear();
        this.tombstones.clear();
        this.hydrated = false;
        this.locked = false;
        this.status = 'absent';
        this.activeUserId = null;
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        this.flushChain = Promise.resolve();
        this.inFlightFlushes.clear();
        this.quitFlushInstalled = false;
        // Phase-2 state. Missing these left `messagesHydrated` latched true
        // across a reset, so a following hydrate()+hydrateMessages() silently
        // skipped decrypting history and every message key read back null.
        this.deferred = [];
        this.messagesHydrated = false;
        this.messagesHydrating = null;
        // Invalidate any hydrateMessages() still running from the previous
        // test, for the same reason wipeLocalData() does.
        this.generation++;
    }
}

export const secureLocalStore = new SecureLocalStore();
export default secureLocalStore;
