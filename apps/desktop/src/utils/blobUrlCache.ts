/**
 * A bounded, reference-counted cache of `blob:` object URLs.
 *
 * Entries a caller holds (acquire/put without a matching release) are never
 * evicted; released entries stay for instant reuse until the byte or entry
 * budget pushes them out, least recently used first, and are REVOKED then.
 * Used for decrypted attachment media (utils/decryptedMediaCache) and for
 * remote images fetched through the main process (utils/remoteImageCache).
 */
export interface BlobUrlEntry {
    url: string;
    size: number;
    refs: number;
    /** Optional payload kept alongside (e.g. the Blob, for "save GIF"). */
    blob?: Blob;
    /** Intrinsic size once known, so a remount can reserve the exact box. */
    width?: number;
    height?: number;
}

export class BlobUrlCache {
    private entries = new Map<string, BlobUrlEntry>();
    private bytes = 0;
    private readonly maxBytes: number;
    private readonly maxEntries: number;
    constructor(maxBytes: number, maxEntries: number) {
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
    }

    private touch(key: string, e: BlobUrlEntry): void {
        this.entries.delete(key);
        this.entries.set(key, e);
    }

    private evict(): void {
        if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) return;
        for (const [key, e] of this.entries) {
            if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
            if (e.refs > 0) continue;
            this.entries.delete(key);
            this.bytes -= e.size;
            try { URL.revokeObjectURL(e.url); } catch { /* already gone */ }
        }
    }

    /** Entry without taking a hold (marks it recently used). */
    peek(key: string): BlobUrlEntry | null {
        const e = this.entries.get(key);
        if (!e) return null;
        this.touch(key, e);
        return e;
    }

    /** Entry, now held by the caller (release it later), or null. */
    acquire(key: string): BlobUrlEntry | null {
        const e = this.entries.get(key);
        if (!e) return null;
        this.touch(key, e);
        e.refs++;
        return e;
    }

    /**
     * Adds a URL, held by the caller. If the key is already cached (a parallel
     * load finished first) the existing entry wins, `url` is revoked, and the
     * existing entry is what's returned.
     */
    put(key: string, url: string, size: number, extra?: Pick<BlobUrlEntry, 'blob' | 'width' | 'height'>): BlobUrlEntry {
        const existing = this.entries.get(key);
        if (existing) {
            if (existing.url !== url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
            existing.refs++;
            this.touch(key, existing);
            return existing;
        }
        const s = Math.max(0, size || 0);
        const e: BlobUrlEntry = { url, size: s, refs: 1, ...extra };
        this.entries.set(key, e);
        this.bytes += s;
        this.evict();
        return e;
    }

    release(key: string): void {
        const e = this.entries.get(key);
        if (!e) return;
        e.refs = Math.max(0, e.refs - 1);
        this.evict();
    }

    /** Record intrinsic dimensions learned after the image decoded. */
    setSize(key: string, width: number, height: number): void {
        const e = this.entries.get(key);
        if (e && width > 0 && height > 0) { e.width = width; e.height = height; }
    }

    clear(): void {
        for (const e of this.entries.values()) { try { URL.revokeObjectURL(e.url); } catch { /* ignore */ } }
        this.entries.clear();
        this.bytes = 0;
    }

    stats(): { entries: number; bytes: number; held: number } {
        let held = 0;
        for (const e of this.entries.values()) if (e.refs > 0) held++;
        return { entries: this.entries.size, bytes: this.bytes, held };
    }
}
