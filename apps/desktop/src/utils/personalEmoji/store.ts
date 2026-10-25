/**
 * Encrypted on-device store for personal-emoji images: the user's own library
 * AND the bounded cache of emojis other people sent them.
 *
 * Follows the GIF library's at-rest scheme (utils/gifStorage.ts): each image is
 * AES-256-GCM encrypted under its OWN random key; the ciphertext is a file in
 * `<userData>/cipherline-gifs/` named `emoji-<id>.enc` (that directory is the
 * renderer's one allow-listed image directory, so no main-process change is
 * needed, and the GIF backup/enumeration paths only ever touch ids the GIF
 * library owns), and the key lives in `secureLocalStore` under an
 * account-scoped name (`cipherline_emoji_key_<uid>_<id>`) so another account on
 * the same machine cannot decrypt it.
 *
 * Ids are content hashes (see token.ts), so a stored image can never be
 * replaced by a different one, and the same picture arriving twice is one file.
 *
 * Bounds: library emojis are PINNED and never evicted. Everything else is a
 * cache evicted least-recently-used once it exceeds CACHE_MAX_ENTRIES or
 * CACHE_MAX_BYTES, so a flood of senders cannot fill the disk.
 *
 * All side effects go through `StoreIO`, so the logic is unit-tested against a
 * fake; `realIO()` binds the real secureLocalStore + Electron IPC.
 */

import { PERSONAL_EMOJI_MAX_BYTES, isPersonalEmojiId, sniffImageMime, b64ToBytes, bytesToB64 } from './token';

export const CACHE_MAX_ENTRIES = 300;
export const CACHE_MAX_BYTES = 24 * 1024 * 1024;

export interface BlobMeta {
    /** Plaintext size in bytes. */
    s: number;
    /** mime */
    m: string;
    /** animated (0/1) */
    a: 0 | 1;
    /** The name the sender / owner gave it (display + autocomplete only). */
    n: string;
    /** Last time it was rendered or stored, ms (LRU). */
    t: number;
}
export type BlobIndex = Record<string, BlobMeta>;

export interface StoreIO {
    uid(): string | null;
    kvGet(key: string): string | null;
    kvSet(key: string, value: string): void;
    kvRemove(key: string): void;
    readFile(name: string): Promise<Uint8Array | null>;
    writeFile(name: string, bytes: Uint8Array): Promise<void>;
    deleteFile(name: string): Promise<void>;
    now(): number;
}

export const emojiKeyKey = (uid: string, id: string) => `cipherline_emoji_key_${uid}_${id}`;
export const emojiIndexKey = (uid: string) => `cipherline_emoji_index_${uid}`;
export const emojiFileName = (id: string) => `emoji-${id}`;

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, usage);
}

/** iv(12) || AES-256-GCM(ciphertext+tag): the same bundled-IV layout decryptBlob(…, null) reads. */
export async function sealBytes(plain: Uint8Array): Promise<{ sealed: Uint8Array; keyB64: string }> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(raw, ['encrypt']), plain as BufferSource));
    const sealed = new Uint8Array(12 + ct.length);
    sealed.set(iv, 0);
    sealed.set(ct, 12);
    return { sealed, keyB64: bytesToB64(raw) };
}

export async function openBytes(sealed: Uint8Array, keyB64: string): Promise<Uint8Array> {
    if (sealed.length < 12 + 16) throw new Error('sealed emoji too short');
    const key = await aesKey(b64ToBytes(keyB64), ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) as BufferSource }, key, sealed.subarray(12) as BufferSource);
    return new Uint8Array(pt);
}

export interface PutMeta { mime: string; animated: boolean; name: string }

export class EmojiBlobStore {
    private listeners = new Set<(id: string | null) => void>();
    private urls = new Map<string, string>();
    private inflight = new Map<string, Promise<string | null>>();

    private readonly io: StoreIO;
    /** Ids that must never be evicted (the library's). */
    private readonly pinned: () => ReadonlySet<string>;

    constructor(io: StoreIO, pinned: () => ReadonlySet<string> = () => new Set()) {
        this.io = io;
        this.pinned = pinned;
    }

    // ── index ───────────────────────────────────────────────────────────────
    index(): BlobIndex {
        const uid = this.io.uid();
        if (!uid) return {};
        try {
            const raw = this.io.kvGet(emojiIndexKey(uid));
            const v = raw ? JSON.parse(raw) : {};
            return v && typeof v === 'object' ? v : {};
        } catch { return {}; }
    }
    private saveIndex(idx: BlobIndex): void {
        const uid = this.io.uid();
        if (uid) this.io.kvSet(emojiIndexKey(uid), JSON.stringify(idx));
    }
    has(id: string): boolean { return !!this.index()[id]; }
    ids(): string[] { return Object.keys(this.index()); }
    meta(id: string): BlobMeta | undefined { return this.index()[id]; }

    // ── keys (also read by backup + sync) ───────────────────────────────────
    getKeyB64(id: string): string | null {
        const uid = this.io.uid();
        return uid ? this.io.kvGet(emojiKeyKey(uid, id)) : null;
    }
    putKeyB64(id: string, keyB64: string): void {
        const uid = this.io.uid();
        if (uid) this.io.kvSet(emojiKeyKey(uid, id), keyB64);
    }

    // ── bytes ───────────────────────────────────────────────────────────────
    /** The raw ciphertext file, for backup. */
    readSealed(id: string): Promise<Uint8Array | null> { return this.io.readFile(emojiFileName(id)); }

    /** Write already-sealed bytes + their key (backup restore). */
    async putSealed(id: string, sealed: Uint8Array, keyB64: string, meta: PutMeta, size: number): Promise<void> {
        if (!isPersonalEmojiId(id) || !this.io.uid()) return;
        await this.io.writeFile(emojiFileName(id), sealed);
        this.putKeyB64(id, keyB64);
        this.record(id, meta, size);
    }

    /**
     * Store plaintext bytes for `id`. The CALLER has already verified that the
     * bytes hash to `id` (token.ts validateWireEmoji) or produced them itself.
     * Idempotent: an id already stored is only touched.
     */
    async put(id: string, bytes: Uint8Array, meta: PutMeta): Promise<void> {
        if (!isPersonalEmojiId(id) || !this.io.uid()) return;
        if (bytes.length === 0 || bytes.length > PERSONAL_EMOJI_MAX_BYTES || !sniffImageMime(bytes)) return;
        if (this.has(id) && this.getKeyB64(id)) { this.touch(id); return; }
        const { sealed, keyB64 } = await sealBytes(bytes);
        await this.io.writeFile(emojiFileName(id), sealed);
        this.putKeyB64(id, keyB64);
        this.record(id, meta, bytes.length);
        await this.evict();
        this.emit(id);
    }

    private record(id: string, meta: PutMeta, size: number): void {
        const idx = this.index();
        idx[id] = { s: size, m: meta.mime, a: meta.animated ? 1 : 0, n: meta.name, t: this.io.now() };
        this.saveIndex(idx);
    }

    /** Decrypted bytes, or null if absent / unreadable (a missing file is dropped from the index). */
    async read(id: string): Promise<Uint8Array | null> {
        if (!this.has(id)) return null;
        const keyB64 = this.getKeyB64(id);
        if (!keyB64) return null;
        let sealed: Uint8Array | null = null;
        try { sealed = await this.io.readFile(emojiFileName(id)); } catch { sealed = null; }
        if (!sealed) { await this.remove(id); return null; }
        try { return await openBytes(sealed, keyB64); } catch { return null; }
    }

    touch(id: string): void {
        const idx = this.index();
        const m = idx[id];
        if (!m) return;
        const now = this.io.now();
        // Bound the write rate: an emoji on screen is touched on every render.
        if (now - m.t < 60_000) return;
        idx[id] = { ...m, t: now };
        this.saveIndex(idx);
    }

    async remove(id: string): Promise<void> {
        const uid = this.io.uid();
        if (!uid) return;
        const idx = this.index();
        if (idx[id]) { delete idx[id]; this.saveIndex(idx); }
        this.io.kvRemove(emojiKeyKey(uid, id));
        const url = this.urls.get(id);
        if (url) { URL.revokeObjectURL(url); this.urls.delete(id); }
        try { await this.io.deleteFile(emojiFileName(id)); } catch { /* already gone */ }
    }

    /** Evict least-recently-used NON-pinned entries past the bounds. */
    async evict(): Promise<string[]> {
        const pinned = this.pinned();
        const idx = this.index();
        const cache = Object.entries(idx).filter(([id]) => !pinned.has(id)).sort((a, b) => a[1].t - b[1].t);
        let bytes = cache.reduce((n, [, m]) => n + m.s, 0);
        let count = cache.length;
        const dropped: string[] = [];
        for (const [id, m] of cache) {
            if (count <= CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_BYTES) break;
            dropped.push(id);
            count--; bytes -= m.s;
        }
        for (const id of dropped) await this.remove(id);
        return dropped;
    }

    // ── object URLs for <img> ───────────────────────────────────────────────
    peekUrl(id: string): string | null { return this.urls.get(id) ?? null; }

    /** A blob: URL for the emoji, decrypted once per session and shared by
     *  every <img> showing it. Null when the image is not on this device. */
    getUrl(id: string): Promise<string | null> {
        const hit = this.urls.get(id);
        if (hit) { this.touch(id); return Promise.resolve(hit); }
        const pending = this.inflight.get(id);
        if (pending) return pending;
        const p = (async () => {
            const bytes = await this.read(id);
            if (!bytes) return null;
            const mime = sniffImageMime(bytes) ?? 'application/octet-stream';
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
            this.urls.set(id, url);
            this.touch(id);
            return url;
        })().finally(() => { this.inflight.delete(id); });
        this.inflight.set(id, p);
        return p;
    }

    // ── change notification ─────────────────────────────────────────────────
    subscribe(cb: (id: string | null) => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }
    emit(id: string | null): void { for (const cb of this.listeners) { try { cb(id); } catch { /* listener bug */ } } }

    /** Drop session state when the account changes. */
    resetSession(): void {
        for (const u of this.urls.values()) URL.revokeObjectURL(u);
        this.urls.clear();
        this.inflight.clear();
        this.emit(null);
    }
}
