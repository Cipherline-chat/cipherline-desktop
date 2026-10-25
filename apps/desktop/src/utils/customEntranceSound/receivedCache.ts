/**
 * Other people's custom entrance sounds that reached this device in a call,
 * VERIFIED (./receiver.ts), keyed by content id.
 *
 * In memory only, on purpose: an LRU of RECEIVED_CACHE_MAX entries (<= 64 KB
 * each, so ~2 MB at most) that dies with the app. Nothing someone else sent is
 * written to disk; the next call simply transfers it again. Each entry carries
 * the listener-side gain measured when it was decoded (./playbackGain.ts).
 *
 * `waitFor` lets the join handler give a transfer that is already under way a
 * short, bounded moment to land (it is never a queue: on timeout it resolves
 * null and nothing plays later).
 */

export const RECEIVED_CACHE_MAX = 32;

export interface ReceivedSound {
    id: string;
    bytes: Uint8Array;
    /** blob: URL for <audio>, or null where URLs are unavailable (tests). */
    url: string | null;
    /** Listener-side gain, 0..1 (see playbackGain.ts). */
    gain: number;
}

export interface UrlFactory {
    create(bytes: Uint8Array): string | null;
    revoke(url: string): void;
}

const browserUrls: UrlFactory = {
    create: bytes => (typeof URL !== 'undefined' && typeof Blob !== 'undefined'
        ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/webm' }))
        : null),
    revoke: url => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } },
};

export class ReceivedSoundCache {
    private entries = new Map<string, ReceivedSound>();
    private waiters = new Map<string, Set<(s: ReceivedSound | null) => void>>();
    private readonly max: number;
    private readonly urls: UrlFactory;

    constructor(opts: { max?: number; urls?: UrlFactory } = {}) {
        this.max = opts.max ?? RECEIVED_CACHE_MAX;
        this.urls = opts.urls ?? browserUrls;
    }

    has(id: string): boolean { return this.entries.has(id); }

    get(id: string): ReceivedSound | null {
        const e = this.entries.get(id);
        if (!e) return null;
        // LRU: re-insert at the end.
        this.entries.delete(id);
        this.entries.set(id, e);
        return e;
    }

    put(id: string, bytes: Uint8Array, gain: number): ReceivedSound {
        const had = this.entries.get(id);
        if (had) return this.get(id)!;
        const entry: ReceivedSound = { id, bytes, url: this.urls.create(bytes), gain: Math.min(1, Math.max(0, gain)) };
        this.entries.set(id, entry);
        while (this.entries.size > this.max) {
            const [oldId, old] = this.entries.entries().next().value as [string, ReceivedSound];
            this.entries.delete(oldId);
            if (old.url) this.urls.revoke(old.url);
        }
        const w = this.waiters.get(id);
        if (w) { this.waiters.delete(id); w.forEach(fn => fn(entry)); }
        return entry;
    }

    /** The sound if cached now, else whatever lands within `timeoutMs`, else null. */
    waitFor(id: string, timeoutMs: number): Promise<ReceivedSound | null> {
        const hit = this.get(id);
        if (hit || timeoutMs <= 0) return Promise.resolve(hit);
        return new Promise(resolve => {
            let set = this.waiters.get(id);
            if (!set) { set = new Set(); this.waiters.set(id, set); }
            const done = (s: ReceivedSound | null) => { clearTimeout(timer); resolve(s); };
            const timer = setTimeout(() => {
                const s2 = this.waiters.get(id);
                s2?.delete(done);
                if (s2 && s2.size === 0) this.waiters.delete(id);
                resolve(null);
            }, timeoutMs);
            set.add(done);
        });
    }

    size(): number { return this.entries.size; }

    clear(): void {
        for (const e of this.entries.values()) if (e.url) this.urls.revoke(e.url);
        this.entries.clear();
        const w = [...this.waiters.values()];
        this.waiters.clear();
        w.forEach(set => set.forEach(fn => fn(null)));
    }
}

/** The app-wide cache (the call UI and the transport share it). */
export const receivedSounds = new ReceivedSoundCache();
