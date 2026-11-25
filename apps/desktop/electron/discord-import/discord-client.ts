/**
 * Minimal, polite Discord REST client for the structure importer.
 *
 * Runs in the Electron MAIN process, on the user's own machine, with the
 * user's own BOT token (`Authorization: Bot <token>`, never a user token).
 * Cipherline's servers are never involved. Pure Node (global fetch injected),
 * no electron import, so the rate-limit logic is unit-tested with mocked
 * headers and 429s.
 *
 * Rate limits follow Discord's documented behaviour:
 *   - per-route buckets: `X-RateLimit-Bucket` links a route to a bucket,
 *     `X-RateLimit-Remaining` / `X-RateLimit-Reset-After` say when the next
 *     request may go; we wait BEFORE sending rather than eating a 429;
 *   - a 429 is honoured (`retry_after` from the body, else `Retry-After`),
 *     and a `global` 429 blocks every route until it clears;
 *   - 5xx and network failures back off exponentially (GET only, bounded);
 *   - 401 / 403 / 404 are never retried (a bad token retried is how a client
 *     earns an IP ban: Discord counts invalid requests);
 *   - every request has a timeout and can be cancelled with an AbortSignal.
 */
import { redactText } from './redact';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';
export const DISCORD_CDN_BASE = 'https://cdn.discordapp.com';

export type DiscordErrorKind =
    | 'invalid_token' | 'forbidden' | 'not_found' | 'rate_limited'
    | 'server' | 'network' | 'timeout' | 'aborted' | 'invalid_response'
    /** GET /guilds/:id/members refused: the bot's Server Members Intent is off. */
    | 'members_intent'
    /** A file bigger than the byte cap we will hold (message is also 'too_large', for older callers). */
    | 'too_large';

export class DiscordApiError extends Error {
    readonly kind: DiscordErrorKind;
    readonly status?: number;
    /** Discord's own JSON error code (e.g. 50001 Missing Access), a number, never free text. */
    readonly discordCode?: number;
    readonly retryAfterMs?: number;
    // Plain fields, not constructor parameter properties: the renderer's tsconfig (erasableSyntaxOnly)
    // type-checks this file too when a renderer test drives the real handlers.
    constructor(kind: DiscordErrorKind, message: string, status?: number, discordCode?: number, retryAfterMs?: number) {
        super(message);
        this.name = 'DiscordApiError';
        this.kind = kind;
        this.status = status;
        this.discordCode = discordCode;
        this.retryAfterMs = retryAfterMs;
    }
}

export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    /** Never follow a redirect off the allow-listed host. */
    redirect?: 'error';
}) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface DiscordClientOptions {
    token: string;
    fetchFn?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    /** Retries for 429 / 5xx / network, per request. */
    maxRetries?: number;
    /** A single wait longer than this is surfaced to the caller instead of blocking. */
    maxWaitMs?: number;
    random?: () => number;
}

interface BucketState { remaining: number; resetAt: number }

const sleepReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Route key for bucket lookup: method + path with numeric ids replaced, except
 * the "major parameters" (guild / channel / webhook ids), which Discord rate
 * limits separately. We only ever call guild-scoped GETs, so the guild id is
 * kept and everything else collapsed.
 */
export function routeKey(method: string, path: string): string {
    const clean = path.split('?')[0];
    // Guild and channel ids are "major parameters": Discord limits each one separately.
    const m = /^\/(guilds|channels)\/(\d+)(.*)$/.exec(clean);
    if (m) return `${method} /${m[1]}/${m[2]}${m[3].replace(/\d{15,25}/g, ':id')}`;
    return `${method} ${clean.replace(/\d{15,25}/g, ':id')}`;
}

export class DiscordClient {
    private readonly token: string;
    private readonly fetchFn: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly maxWaitMs: number;
    private readonly random: () => number;

    /** routeKey -> bucket id (learned from X-RateLimit-Bucket). */
    private readonly routeBucket = new Map<string, string>();
    private readonly buckets = new Map<string, BucketState>();
    private globalBlockedUntil = 0;

    constructor(o: DiscordClientOptions) {
        this.token = o.token;
        this.fetchFn = o.fetchFn ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
        this.sleep = o.sleep ?? sleepReal;
        this.now = o.now ?? Date.now;
        this.timeoutMs = o.timeoutMs ?? 15_000;
        this.maxRetries = o.maxRetries ?? 5;
        this.maxWaitMs = o.maxWaitMs ?? 60_000;
        this.random = o.random ?? Math.random;
    }

    /** Errors never contain the token: this is the one place text from outside gets in. */
    private safe(text: string): string {
        return redactText(text, this.token);
    }

    private async waitForSlot(key: string, signal?: AbortSignal): Promise<void> {
        const now = this.now();
        let wait = Math.max(0, this.globalBlockedUntil - now);
        const bucketId = this.routeBucket.get(key);
        const st = bucketId ? this.buckets.get(bucketId) : undefined;
        if (st && st.remaining <= 0) wait = Math.max(wait, st.resetAt - now);
        if (wait <= 0) return;
        if (wait > this.maxWaitMs) {
            throw new DiscordApiError('rate_limited', 'Discord asked us to wait too long. Try again later.', 429, undefined, wait);
        }
        await this.pause(wait, signal);
    }

    private async pause(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw new DiscordApiError('aborted', 'Cancelled');
        await this.sleep(ms);
        if (signal?.aborted) throw new DiscordApiError('aborted', 'Cancelled');
    }

    private learn(key: string, headers: { get(n: string): string | null }): void {
        const bucket = headers.get('x-ratelimit-bucket');
        const remaining = headers.get('x-ratelimit-remaining');
        const resetAfter = headers.get('x-ratelimit-reset-after');
        if (!bucket) return;
        this.routeBucket.set(key, bucket);
        const rem = remaining === null ? NaN : Number(remaining);
        const reset = resetAfter === null ? NaN : Number(resetAfter);
        if (Number.isFinite(rem) && Number.isFinite(reset)) {
            this.buckets.set(bucket, { remaining: rem, resetAt: this.now() + Math.ceil(reset * 1000) });
        }
    }

    private backoff(attempt: number): number {
        const base = Math.min(8_000, 500 * 2 ** attempt);
        return Math.round(base / 2 + this.random() * (base / 2));
    }

    private async send(url: string, key: string, headers: Record<string, string>, signal?: AbortSignal, authorize = true) {
        let lastErr: DiscordApiError | null = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (signal?.aborted) throw new DiscordApiError('aborted', 'Cancelled');
            await this.waitForSlot(key, signal);

            const ctl = new AbortController();
            const onAbort = () => ctl.abort();
            signal?.addEventListener('abort', onAbort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, this.timeoutMs);
            let res: Awaited<ReturnType<FetchLike>>;
            try {
                res = await this.fetchFn(url, {
                    method: 'GET',
                    headers: authorize ? { ...headers, Authorization: `Bot ${this.token}` } : headers,
                    signal: ctl.signal,
                    redirect: 'error',
                });
            } catch (e) {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                if (signal?.aborted) throw new DiscordApiError('aborted', 'Cancelled');
                lastErr = timedOut
                    ? new DiscordApiError('timeout', 'Discord did not answer in time.')
                    : new DiscordApiError('network', this.safe(`Could not reach Discord (${(e as Error)?.name ?? 'error'}).`));
                if (attempt < this.maxRetries) { await this.pause(this.backoff(attempt), signal); continue; }
                throw lastErr;
            }
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);

            if (authorize) this.learn(key, res.headers);

            if (res.status === 429) {
                let retryAfterMs = 1000;
                let isGlobal = res.headers.get('x-ratelimit-global') === 'true';
                try {
                    const body = (await res.json()) as { retry_after?: unknown; global?: unknown };
                    if (typeof body.retry_after === 'number' && body.retry_after >= 0) retryAfterMs = Math.ceil(body.retry_after * 1000);
                    if (body.global === true) isGlobal = true;
                } catch {
                    const h = Number(res.headers.get('retry-after'));
                    if (Number.isFinite(h) && h >= 0) retryAfterMs = Math.ceil(h * 1000);
                }
                const until = this.now() + retryAfterMs;
                if (isGlobal) this.globalBlockedUntil = Math.max(this.globalBlockedUntil, until);
                else {
                    const bid = this.routeBucket.get(key) ?? `route:${key}`;
                    this.buckets.set(bid, { remaining: 0, resetAt: until });
                    this.routeBucket.set(key, bid);
                }
                lastErr = new DiscordApiError('rate_limited', 'Discord is rate limiting us.', 429, undefined, retryAfterMs);
                if (retryAfterMs > this.maxWaitMs || attempt >= this.maxRetries) throw lastErr;
                await this.pause(retryAfterMs + Math.round(this.random() * 100), signal);
                continue;
            }

            if (res.status >= 500) {
                lastErr = new DiscordApiError('server', `Discord had a problem (${res.status}).`, res.status);
                if (attempt < this.maxRetries) { await this.pause(this.backoff(attempt), signal); continue; }
                throw lastErr;
            }
            return res;
        }
        throw lastErr ?? new DiscordApiError('network', 'Could not reach Discord.');
    }

    /** GET a JSON resource under the API base. `path` must start with "/". */
    async getJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
        if (!path.startsWith('/') || path.includes('..') || path.includes('//')) {
            throw new DiscordApiError('invalid_response', 'Bad request path.');
        }
        const res = await this.send(`${DISCORD_API_BASE}${path}`, routeKey('GET', path), { Accept: 'application/json' }, signal);
        if (res.status === 401) throw new DiscordApiError('invalid_token', 'Discord rejected the bot token.', 401);
        if (res.status === 403) {
            const code = await discordCodeOf(res);
            throw new DiscordApiError('forbidden', 'The bot is not allowed to read that.', 403, code);
        }
        if (res.status === 404) {
            throw new DiscordApiError('not_found', 'Discord could not find that.', 404, await discordCodeOf(res));
        }
        if (res.status < 200 || res.status >= 300) {
            throw new DiscordApiError('invalid_response', `Unexpected answer from Discord (${res.status}).`, res.status);
        }
        try {
            return (await res.json()) as T;
        } catch {
            throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
        }
    }

    /**
     * GET raw bytes from Discord's public CDN. No Authorization header is sent
     * (the CDN is public; the token must not leave for another host), the host
     * is fixed, and the size is capped.
     */
    async getCdn(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
        if (!/^\/(icons|banners|emojis|role-icons)\/[0-9A-Za-z_./-]+(\?size=\d{2,4})?$/.test(path) || path.includes('..')) {
            throw new DiscordApiError('invalid_response', 'Bad image path.');
        }
        const res = await this.send(`${DISCORD_CDN_BASE}${path}`, `CDN ${path.split('/')[1]}`, { Accept: 'image/*' }, signal, false);
        if (res.status === 404) throw new DiscordApiError('not_found', 'Image not found.', 404);
        if (res.status < 200 || res.status >= 300) {
            throw new DiscordApiError('invalid_response', `Image fetch failed (${res.status}).`, res.status);
        }
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            throw new DiscordApiError('invalid_response', 'Image is too large.');
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) throw new DiscordApiError('invalid_response', 'Image is too large.');
        return { bytes: buf, contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
    }

    /**
     * GET a message attachment / avatar / sticker from Discord's media hosts.
     * The URL came from a message object Discord returned (attachment URLs are
     * SIGNED and expire: `ex`, `is`, `hm`). Only https on the two Discord media
     * hosts, only the media paths, no credentials, no redirects, no token, and
     * a hard byte cap (declared length first, then the real body).
     */
    async getMedia(rawUrl: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
        const url = checkMediaUrl(rawUrl) ?? checkEmbedProxyUrl(rawUrl);
        if (!url) throw new DiscordApiError('invalid_response', 'Bad media address.');
        const res = await this.send(url.toString(), `MEDIA ${url.hostname}`, { Accept: '*/*' }, signal, false);
        if (res.status === 403 || res.status === 404 || res.status === 410) {
            throw new DiscordApiError('not_found', 'That file has expired or is gone.', res.status);
        }
        if (res.status < 200 || res.status >= 300) {
            throw new DiscordApiError('invalid_response', `File fetch failed (${res.status}).`, res.status);
        }
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) throw new DiscordApiError('too_large', 'too_large', res.status);
        // The request timeout covers the answer's headers only: the body of a big video can take minutes, and a
        // stalled one used to hang the import forever. Deadline = 60 s + 4 s per MiB (≥ 256 KiB/s), at most 15 min.
        // An interrupted body (undici "terminated", an allocation failure) used to escape as a plain Error, which
        // the IPC layer could only describe as "Something went wrong talking to Discord".
        const size = Number.isFinite(declared) && declared > 0 ? declared : maxBytes;
        const deadlineMs = Math.min(15 * 60_000, 60_000 + Math.ceil(size / (256 * 1024)) * 1000);
        let buf: Uint8Array;
        try {
            buf = new Uint8Array(await withDeadline(res.arrayBuffer(), deadlineMs));
        } catch (e) {
            if (e instanceof DiscordApiError) throw e;
            throw new DiscordApiError('network', 'The download from Discord was interrupted.');
        }
        if (buf.byteLength > maxBytes) throw new DiscordApiError('too_large', 'too_large', res.status);
        return { bytes: buf, contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
    }

    /**
     * Follow Discord's `after`-cursor pagination (used by GET /users/@me/guilds)
     * until a short page. `pageLimit` bounds runaway loops.
     */
    async paginateAfter<T extends { id: string }>(path: string, pageSize: number, signal?: AbortSignal, pageLimit = 50): Promise<T[]> {
        const all: T[] = [];
        let after: string | null = null;
        for (let page = 0; page < pageLimit; page++) {
            const sep = path.includes('?') ? '&' : '?';
            const q: string = `${path}${sep}limit=${pageSize}${after ? `&after=${after}` : ''}`;
            const rows: T[] = await this.getJson<T[]>(q, signal);
            if (!Array.isArray(rows)) throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
            all.push(...rows);
            if (rows.length < pageSize) return all;
            after = rows[rows.length - 1].id;
            if (typeof after !== 'string') throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
        }
        return all;
    }
}

/** Resolves with `p`, or rejects with a timeout DiscordApiError after `ms`. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DiscordApiError('timeout', 'The download from Discord took too long.')), ms); });
    return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

export const DISCORD_MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
/**
 * The media paths, with any RFC 3986 path character after the prefix (a file name Discord kept with
 * `(`, `)`, `!`, `~`, `+`, `,` or `'`, or percent-encoded unicode). The host is fixed and https, so the
 * characters themselves cannot reach anything else; `..` is still refused below.
 */
const MEDIA_PATH = /^\/(attachments|ephemeral-attachments|avatars|embed\/avatars|stickers)\/[0-9A-Za-z_.~!$&'()*+,;=:@%/-]+$/;
/** Query keys Discord puts on media URLs: the signature (ex / is / hm) and the proxy's resize options. */
const MEDIA_QUERY_KEYS = new Set(['ex', 'is', 'hm', 'size', 'format', 'quality', 'width', 'height', 'animated']);

/**
 * Discord's EXTERNAL image proxy (images-ext-N.discordapp.net/external/…): the
 * copy Discord's own servers made of a linked page's preview picture when the
 * message was posted. Used only for a link preview's thumbnail (link embeds
 * phase 4, history.ts collectLinkEmbeds), so importing it contacts Discord,
 * never the linked site. Strict: https, these hosts, the /external/ path.
 */
export const DISCORD_EMBED_PROXY_HOSTS = new Set(['images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);
export function checkEmbedProxyUrl(raw: unknown): URL | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (!DISCORD_EMBED_PROXY_HOSTS.has(u.hostname)) return null;
    if (!/^\/external\/[0-9A-Za-z_.~!$&'()*+,;=:@%/-]+$/.test(u.pathname) || u.pathname.includes('..')) return null;
    for (const [k, v] of u.searchParams) if (!MEDIA_QUERY_KEYS.has(k) && !(k === '' && v === '')) return null;
    return u;
}

/** A Discord media URL we will fetch, or null. Strict: https, fixed hosts, media paths, no credentials or port. */
export function checkMediaUrl(raw: unknown): URL | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (!DISCORD_MEDIA_HOSTS.has(u.hostname)) return null;
    if (!MEDIA_PATH.test(u.pathname) || u.pathname.includes('..')) return null;
    // Discord's proxy URLs carry an empty `&=&` pair; an empty key with an empty value names nothing.
    for (const [k, v] of u.searchParams) if (!MEDIA_QUERY_KEYS.has(k) && !(k === '' && v === '')) return null;
    return u;
}

async function discordCodeOf(res: { json(): Promise<unknown> }): Promise<number | undefined> {
    try {
        const b = (await res.json()) as { code?: unknown };
        return typeof b.code === 'number' ? b.code : undefined;
    } catch {
        return undefined;
    }
}
