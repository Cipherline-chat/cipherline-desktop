/**
 * The URLs clmedia:// will stream (docs/plans/embeds.md §6).
 *
 * clmedia:// never takes a URL from the request. The renderer registers the
 * media URL of an embed it is SHOWING (validated IPC, ipc.ts), and gets back
 * `clmedia://media/<token>`: 128 random bits naming one registry entry. The
 * protocol handler only ever looks the token up, so an unregistered URL, a
 * guessed token or an evicted entry is a 404 with no network request at all.
 *
 * Bounded (LRU): the oldest registration is forgotten once more than
 * `capacity` embeds have been played. Per app run only; nothing persists.
 */
import { randomBytes } from 'crypto';
import { assertHttpsUrlShape } from './pinned-fetch';

export type MediaKind = 'video' | 'image';

export interface MediaEntry {
    url: string;
    kind: MediaKind;
    /** Video file hosts the entry may START on (clip pages: the provider's CDN). */
    hostAllowed?: (hostname: string) => boolean;
    /**
     * A SENDER's frame grab (2026-11-24, embeds-always-thumb): the bytes this
     * entry may still stream, across all its requests. Once spent, a stream
     * is cut (the grab only needs the file's index and a few frames).
     */
    budget?: { left: number };
}

export interface RegisterOptions {
    /** A fresh token every time (never shared with the player's entry), with this many bytes to spend. */
    budgetBytes?: number;
}

export const CLMEDIA_SCHEME = 'clmedia';
export const CLMEDIA_HOST = 'media';
const TOKEN_RE = /^[0-9a-f]{32}$/;

export class MediaRegistry {
    private readonly byToken = new Map<string, MediaEntry>();
    private readonly tokenByKey = new Map<string, string>();
    private readonly keyByToken = new Map<string, string>();
    private grabSeq = 0;

    constructor(
        private readonly capacity = 64,
        private readonly newToken: () => string = () => randomBytes(16).toString('hex'),
    ) {}

    /** Registers (or refreshes) `url`; returns its clmedia:// URL. Throws on a bad URL/kind. */
    register(url: unknown, kind: unknown, hostAllowed?: (hostname: string) => boolean, opts: RegisterOptions = {}): string {
        if (kind !== 'video' && kind !== 'image') throw new Error('Invalid media kind');
        const href = assertHttpsUrlShape(url);
        if (hostAllowed && !hostAllowed(new URL(href).hostname)) throw new Error('Host not allowed');
        const budgeted = opts.budgetBytes !== undefined;
        if (budgeted && !(Number.isInteger(opts.budgetBytes) && opts.budgetBytes! > 0)) throw new Error('Bad budget');
        // A budgeted entry is its own (a fresh token, its own budget); never reused.
        const key = budgeted ? `grab ${this.grabSeq++} ${kind} ${href}` : `${kind} ${href}`;
        let token = budgeted ? undefined : this.tokenByKey.get(key);
        if (token) {
            const e = this.byToken.get(token)!;
            this.byToken.delete(token);
            this.byToken.set(token, e); // LRU touch
        } else {
            token = this.newToken();
            if (!TOKEN_RE.test(token)) throw new Error('Bad token');
            this.byToken.set(token, { url: href, kind, hostAllowed, ...(budgeted ? { budget: { left: opts.budgetBytes! } } : {}) });
            this.tokenByKey.set(key, token);
            this.keyByToken.set(token, key);
            while (this.byToken.size > this.capacity) {
                const [oldest] = this.byToken.entries().next().value as [string, MediaEntry];
                this.byToken.delete(oldest);
                const k = this.keyByToken.get(oldest);
                this.keyByToken.delete(oldest);
                if (k) this.tokenByKey.delete(k);
            }
        }
        return `${CLMEDIA_SCHEME}://${CLMEDIA_HOST}/${token}`;
    }

    /** The entry a clmedia:// request URL names, or null. */
    lookup(requestUrl: string): MediaEntry | null {
        let u: URL;
        try { u = new URL(requestUrl); } catch { return null; }
        if (u.protocol !== `${CLMEDIA_SCHEME}:` || u.hostname !== CLMEDIA_HOST) return null;
        const token = u.pathname.replace(/^\//, '');
        if (!TOKEN_RE.test(token)) return null;
        return this.byToken.get(token) ?? null;
    }

    get size(): number { return this.byToken.size; }
}
