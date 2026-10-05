/**
 * Local encrypted GIF storage + library management.
 *
 * Favorites are stored as AES-256-GCM encrypted files in the Electron
 * userData directory (`<userData>/cipherline-gifs/<uuid>.enc`).
 * Metadata is kept in secureLocalStore; encryption keys are kept separately
 * from the metadata so a compromised metadata key cannot decrypt the files
 * without the per-file key.
 *
 * The server NEVER sees a decrypted GIF. Cross-device sync (gifLibrarySync.ts
 * + gifLibraryTransport.ts) uploads only ciphertext plus a content key that is
 * itself ECIES-wrapped to the user's own devices.
 *
 * ── Per-account scoping (2026-09) ────────────────────────────────────────────
 * These keys used to be `cipherline_gif_favorites` and `cipherline_gif_key_<id>`
 * with no account id in them. secureLocalStore decides a record's owner by
 * looking for the active userId INSIDE the key (`ownerFor`), so those keys were
 * master-tier: every account on the same machine shared one GIF library, and
 * account B could read the GIFs account A had saved. Worse for sync — an
 * account-scoped upload would have carried another account's library with it.
 *
 * They are now `cipherline_gif_favorites_<uid>` / `cipherline_gif_key_<uid>_<id>`,
 * with the legacy keys kept as a one-way migration source (same pattern as
 * `cipherline_game_settings` → `cipherline_game_settings_{uid}`).
 *
 * The `.enc` FILES stay in one shared directory on purpose. They are named by
 * random UUID and each is encrypted under its own key, which now lives in the
 * owning account's namespace — so another account on the machine cannot
 * decrypt them, and there is no risky file migration to get wrong.
 */

import secureLocalStore from './secureLocalStore';
import {
    generateAesGcmKey,
    encryptBlob,
    decryptBlob,
    exportKeyToBase64,
    importKeyFromBase64,
} from './crypto';
import {
    applyGifOp,
    isKlipyRefEntry,
    localGifOp,
    pruneGifLedger,
    KLIPY_REF_FILENAME,
    type GifLedger,
    type GifLibraryState,
    sameKlipyGifIds,
} from './gifLibrarySync';
import { parseKlipyGifRef, type KlipyGifRef } from '@cipherline/shared';

/**
 * Where a saved GIF came from.
 *   `local` — imported from a file: encrypted bytes on disk (`<id>.enc`).
 *   `klipy` — saved from KLIPY: a REFERENCE only (`klipy` field below), no
 *             bytes, no key, no file. KLIPY's terms allow storing the asset
 *             slug / media reference and re-fetching from KLIPY, and forbid
 *             keeping copies of the media — so it is displayed by loading it
 *             from KLIPY (subject to the opt-in), and it never produces a
 *             `gif:` backup record or a synced file.
 *   `tenor` — LEGACY: nothing writes it any more; kept so an old library
 *             still parses.
 */
export type FavoriteGifSource = 'local' | 'klipy' | 'tenor';

export interface FavoriteGif {
    id: string;          // crypto.randomUUID()
    source: FavoriteGifSource;
    /** Encrypted filename inside userData/cipherline-gifs/. For a KLIPY
     *  reference this is the KLIPY_REF_FILENAME sentinel — there is no file. */
    fileName: string;
    mimeType: string;    // 'image/gif'
    addedAt: number;     // Date.now()
    tenorId?: string;    // LEGACY Tenor result ID
    label?: string;      // display name (meaningful for local imports)
    /** Present only on a KLIPY reference: what to load, from where. */
    klipy?: KlipyGifRef;
    /** Lowercase hex SHA-256 of the PLAINTEXT bytes of a local GIF. Lets a GIF
     *  seen in chat be recognised as one already in the library (so it shows
     *  as favorited and can't be saved twice). Optional: older entries and
     *  entries from older devices lack it and are filled in lazily by
     *  `backfillContentHashes`. It is a hash of content that is already
     *  encrypted at rest and in sync; it never leaves the library. */
    contentHash?: string;
}

/** Legacy device-global keys. Read once to migrate, never written again. */
const LEGACY_FAVORITES_KEY = 'cipherline_gif_favorites';
const LEGACY_KEY_PREFIX = 'cipherline_gif_key_';

/** Tombstones older than this are forgotten. Matches pin sync's window. */
export const GIF_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Dispatched on `window` whenever the library changes, so an open picker and
 *  the sync service can react without polling. */
export const GIF_LIBRARY_CHANGED = 'cipherline:gif-library-changed';

// ── Key naming ────────────────────────────────────────────────────────────────

export const favoritesKey = (uid: string) => `cipherline_gif_favorites_${uid}`;
export const ledgerKey = (uid: string) => `cipherline_gif_ledger_${uid}`;
/** `_<uid>_` in the middle is what makes secureLocalStore file this per account. */
export const gifKeyKey = (uid: string, gifId: string) => `cipherline_gif_key_${uid}_${gifId}`;

/** The signed-in account. Read from the master-tier session key so the module
 *  keeps a userId-free public API and every call site stays unchanged. */
export function activeUserId(): string | null {
    try { return secureLocalStore.getItem('cipherline_user_id') || null; } catch { return null; }
}

function parseOr<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ── Legacy migration ──────────────────────────────────────────────────────────

/**
 * Copy a pre-scoping device-global library into the active account's namespace,
 * once. Runs only when the account has no library of its own — a second account
 * on the same machine that has already saved something is left alone.
 *
 * The legacy records are deliberately NOT deleted: another account on this
 * machine may still need to migrate from them, and they are the only copy of
 * the keys until it does.
 */
export function migrateLegacyLibrary(uid: string): void {
    if (!uid) return;
    try {
        if (secureLocalStore.getItem(favoritesKey(uid)) !== null) return;
        const legacy = parseOr<FavoriteGif[]>(secureLocalStore.getItem(LEGACY_FAVORITES_KEY), []);
        if (!Array.isArray(legacy) || legacy.length === 0) return;

        for (const fav of legacy) {
            if (!fav?.id) continue;
            const k = secureLocalStore.getItem(LEGACY_KEY_PREFIX + fav.id);
            if (k !== null) secureLocalStore.setItem(gifKeyKey(uid, fav.id), k);
        }
        secureLocalStore.setItem(favoritesKey(uid), JSON.stringify(legacy));
    } catch (e) {
        console.warn('[gifStorage] legacy library migration failed', e);
    }
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

export function loadFavorites(): FavoriteGif[] {
    const uid = activeUserId();
    if (!uid) return [];
    migrateLegacyLibrary(uid);
    const favs = parseOr<FavoriteGif[]>(secureLocalStore.getItem(favoritesKey(uid)), []);
    return Array.isArray(favs) ? favs : [];
}

export function loadLedger(): GifLedger {
    const uid = activeUserId();
    if (!uid) return {};
    const led = parseOr<GifLedger>(secureLocalStore.getItem(ledgerKey(uid)), {});
    return led && typeof led === 'object' ? led : {};
}

/** The full state the sync layer merges over. */
export function loadLibraryState(): GifLibraryState {
    return { entries: loadFavorites(), ledger: loadLedger() };
}

function persist(uid: string, state: GifLibraryState): void {
    const pruned = pruneGifLedger(state, Date.now(), GIF_LEDGER_TTL_MS);
    secureLocalStore.setItem(favoritesKey(uid), JSON.stringify(pruned.entries));
    secureLocalStore.setItem(ledgerKey(uid), JSON.stringify(pruned.ledger));
}

/** Persist a merged state and announce it. Used by the sync service. */
export function saveLibraryState(state: GifLibraryState): void {
    const uid = activeUserId();
    if (!uid) return;
    persist(uid, state);
    notifyLibraryChanged('sync');
}

/**
 * `origin: 'sync'` marks a change that CAME FROM the slot (a merged pull).
 * Listeners that redraw take every change; the publisher must ignore these —
 * treating a pull as a local edit re-uploaded the whole library (and spent a
 * one-time prekey per device) after every remote change.
 */
export function notifyLibraryChanged(origin: 'local' | 'sync' = 'local'): void {
    try { window.dispatchEvent(new CustomEvent(GIF_LIBRARY_CHANGED, { detail: { origin } })); } catch { /* no DOM in tests */ }
}

/** True for a GIF_LIBRARY_CHANGED event that a merged pull fired. */
export function isSyncOriginChange(ev: Event): boolean {
    const d = (ev as CustomEvent<{ origin?: string } | undefined>).detail;
    return !!d && d.origin === 'sync';
}

async function getGifDir(): Promise<string> {
    const userData: string = await (window as any).electronAPI.getUserDataPath();
    return `${userData}/cipherline-gifs`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encrypt a GIF blob and write it to the local store.
 * Returns the new FavoriteGif metadata entry (already persisted).
 */
export async function addFavorite(
    gifBlob: Blob,
    source: 'local',
    opts: { label?: string } = {},
): Promise<FavoriteGif> {
    const uid = activeUserId();
    if (!uid) throw new Error('Cannot save a GIF while signed out');

    // Already in the library? Return that entry instead of storing a second
    // copy — a GIF re-saved from chat (or re-imported) used to pile up.
    const contentHash = await hashBlob(gifBlob);
    const dup = await findFavoriteByHash(contentHash);
    if (dup) return dup;

    const id = crypto.randomUUID();
    const fileName = `${id}.enc`;
    const mimeType = gifBlob.type || 'image/gif';

    // Encrypt with a fresh AES-256-GCM key, bundling the IV into the ciphertext blob.
    const key = await generateAesGcmKey();
    const { encryptedBlob } = await encryptBlob(gifBlob, key, /* bundleIv= */ true);
    const keyB64 = await exportKeyToBase64(key);

    // Write the encrypted file — the main-process fs:write-file handler
    // auto-creates parent directories, so the cipherline-gifs dir is created
    // on first use without any explicit mkdir call.
    const gifDir = await getGifDir();
    const filePath = `${gifDir}/${fileName}`;
    const buf = await encryptedBlob.arrayBuffer();
    await (window as any).electronAPI.writeFile(filePath, new Uint8Array(buf));

    // Persist key and metadata independently.
    secureLocalStore.setItem(gifKeyKey(uid, id), keyB64);

    const entry: FavoriteGif = {
        id,
        source,
        fileName,
        mimeType,
        addedAt: Date.now(),
        label: opts.label,
        contentHash,
    };

    // Route the local change through the same resolver a remote snapshot uses,
    // so the ledger records it and a stale remote tombstone can't undo it.
    const current = loadLibraryState();
    persist(uid, applyGifOp(current, localGifOp(entry.id, 'add', entry.addedAt, entry, current.ledger)));
    notifyLibraryChanged();
    return entry;
}

// ── Content identity (dedupe + "already favorited") ──────────────────────────

/** Hex SHA-256 of a blob's bytes. */
export async function hashBlob(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** A local (file-backed) entry with this content hash. Pure over a list. */
export function findLocalByHash(favorites: readonly FavoriteGif[], hash: string): FavoriteGif | undefined {
    if (!hash) return undefined;
    return favorites.find(f => f.source !== 'klipy' && f.contentHash === hash);
}

const backfillRuns = new Map<string, Promise<void>>();

/**
 * Give every local favorite that lacks a `contentHash` one, by decrypting it
 * once and hashing the plaintext. One run at a time per account, sequential
 * with a yield between files so a big library never stalls the UI. Writes the
 * metadata directly WITHOUT a ledger op and without announcing a change: the
 * hash is derived data, so it must neither churn sync nor look like an edit.
 * A file that can't be read (missing key, missing file) is skipped.
 */
export function backfillContentHashes(): Promise<void> {
    const uid = activeUserId();
    if (!uid) return Promise.resolve();
    const running = backfillRuns.get(uid);
    if (running) return running;
    const run = (async () => {
        const pending = loadFavorites().filter(f => f.source !== 'klipy' && !f.contentHash);
        for (const fav of pending) {
            try {
                const hash = await hashBlob(await loadGifFile(fav));
                // Re-read: the library may have changed while we decrypted.
                const state = loadLibraryState();
                const idx = state.entries.findIndex(e => e.id === fav.id);
                if (idx === -1) continue;
                const entries = state.entries.slice();
                entries[idx] = { ...entries[idx], contentHash: hash };
                persist(uid, { entries, ledger: state.ledger });
            } catch { /* unreadable favorite — leave it unhashed */ }
            await new Promise(r => setTimeout(r, 0));
        }
    })().finally(() => { backfillRuns.delete(uid); });
    backfillRuns.set(uid, run);
    return run;
}

/**
 * The library entry holding exactly these bytes, if any. Checks the hashes we
 * have, and only if that misses AND some entries are still unhashed, finishes
 * the backfill and checks again — so the common case costs no decryption.
 */
export async function findFavoriteByHash(hash: string): Promise<FavoriteGif | undefined> {
    const hit = findLocalByHash(loadFavorites(), hash);
    if (hit) return hit;
    if (!loadFavorites().some(f => f.source !== 'klipy' && !f.contentHash)) return undefined;
    await backfillContentHashes();
    return findLocalByHash(loadFavorites(), hash);
}

/**
 * Save a KLIPY GIF as a REFERENCE. Writes metadata only — no bytes are
 * downloaded, nothing is written under `cipherline-gifs/`, no key is minted.
 * Saving the same slug twice returns the existing entry.
 */
export function addKlipyFavorite(ref: KlipyGifRef): FavoriteGif {
    const uid = activeUserId();
    if (!uid) throw new Error('Cannot save a GIF while signed out');
    const clean = parseKlipyGifRef(ref);
    if (!clean) throw new Error('Not a valid KLIPY GIF reference');

    const state = loadLibraryState();
    const existing = findKlipyFavorite(state.entries, clean.slug);
    if (existing) return existing;

    const entry: FavoriteGif = {
        id: crypto.randomUUID(),
        source: 'klipy',
        fileName: KLIPY_REF_FILENAME,
        mimeType: clean.media.mime,
        addedAt: Date.now(),
        klipy: clean,
    };
    if (clean.title) entry.label = clean.title;
    persist(uid, applyGifOp(state, localGifOp(entry.id, 'add', entry.addedAt, entry, state.ledger)));
    notifyLibraryChanged();
    return entry;
}

/** The saved reference for a KLIPY slug, if any. Pure over a list. */
export function findKlipyFavorite(favorites: readonly FavoriteGif[], slug: string): FavoriteGif | undefined {
    if (!slug) return undefined;
    return favorites.find(f => isKlipyRefEntry(f) && f.klipy!.slug === slug);
}

/**
 * Read and decrypt a GIF blob from the local store. A KLIPY reference has no
 * local bytes by design — callers load it from KLIPY instead.
 */
export async function loadGifFile(fav: FavoriteGif): Promise<Blob> {
    const uid = activeUserId();
    if (!uid) throw new Error('Cannot read a GIF while signed out');
    if (fav.source === 'klipy') throw new Error('A KLIPY GIF is a reference; it has no local file');

    const gifDir = await getGifDir();
    const filePath = `${gifDir}/${fav.fileName}`;
    const keyB64 = secureLocalStore.getItem(gifKeyKey(uid, fav.id));
    if (!keyB64) throw new Error(`GIF decryption key not found for id=${fav.id}`);

    const ab = await (window as any).electronAPI.readFile(filePath) as ArrayBuffer;
    const encBlob = new Blob([ab]);
    const key = await importKeyFromBase64(keyB64);
    // ivB64=null → IV is bundled as the first 12 bytes of the encrypted blob.
    return decryptBlob(encBlob, key, null, fav.mimeType);
}

/** The base64 AES key for one GIF, for the sync layer to ship to your other
 *  devices inside the (encrypted) snapshot. Never leaves the device unwrapped. */
export function getGifKeyB64(gifId: string): string | null {
    const uid = activeUserId();
    return uid ? secureLocalStore.getItem(gifKeyKey(uid, gifId)) : null;
}

/** Store a key that arrived in a synced snapshot. */
export function putGifKeyB64(gifId: string, keyB64: string): void {
    const uid = activeUserId();
    if (uid) secureLocalStore.setItem(gifKeyKey(uid, gifId), keyB64);
}

/**
 * Delete a favorite: removes the encrypted file, the key, and the metadata
 * entry, leaving a tombstone in the ledger so the deletion survives a sync
 * from a device that still has the GIF.
 */
export async function removeFavorite(id: string): Promise<void> {
    const uid = activeUserId();
    if (!uid) return;

    const state = loadLibraryState();
    const entry = state.entries.find(f => f.id === id);
    if (!entry) return;

    // A KLIPY reference has no file and no key — only metadata to drop.
    if (!isKlipyRefEntry(entry)) {
        const gifDir = await getGifDir();
        try {
            await (window as any).electronAPI.deleteFile(`${gifDir}/${entry.fileName}`);
        } catch {
            // File may already be gone — continue cleaning up metadata.
        }
    }

    secureLocalStore.removeItem(gifKeyKey(uid, id));
    // A KLIPY favorite saved on two devices synced as two entries for one
    // slug; removing it must remove every copy, or the heart stays on. Each
    // gets its own tombstone so the removal reaches the other devices too.
    const now = Date.now();
    let next = state;
    for (const dupId of sameKlipyGifIds(state.entries, id)) {
        next = applyGifOp(next, localGifOp(dupId, 'remove', now, undefined, next.ledger));
    }
    persist(uid, next);
    notifyLibraryChanged();
}

/** Drop a GIF's AES key. The sync layer calls this when a merge removed the
 *  GIF, so a deletion on another device does not leave key material behind. */
export function deleteGifKey(gifId: string): void {
    const uid = activeUserId();
    if (uid) secureLocalStore.removeItem(gifKeyKey(uid, gifId));
}
