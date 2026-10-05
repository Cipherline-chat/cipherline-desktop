/**
 * KLIPY GIF search — direct from this device.
 *
 * KLIPY's standard integration (confirmed by KLIPY in writing to the owner,
 * 2026-09): API requests come from the end-user client, and media loads
 * straight from KLIPY's CDN. So this module calls api.klipy.com with `fetch`,
 * and the picker/chat render KLIPY CDN URLs in `<img>`. There is no Cipherline
 * server route for any of it (an earlier build proxied through our API and
 * stored copies; KLIPY's rules forbid both without a custom agreement).
 *
 * Privacy posture, enforced HERE rather than trusted to callers:
 *   - Nothing is requested unless the user opted in (`isKlipyEnabled()`), and
 *     nothing at all when the build has no key. Every entry point checks both
 *     BEFORE touching the network and throws a typed error instead.
 *   - No `customer_id`, `locale` or ad parameters — every Cipherline request
 *     looks the same to KLIPY. `content_filter=high` always: accounts start at
 *     13 (COPPA hard block below that), so KLIPY's strictest level.
 *   - `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`
 *     on the API call: no cookies, no Referer, search results not written to
 *     the HTTP cache.
 *   - The API key lives in the URL path (KLIPY's scheme), so a request URL is
 *     never logged or put in an error message by this module.
 *
 * The key is a public, per-app identifier by KLIPY's design ("having the API
 * key in the client is expected"); it comes from the build-time env var
 * VITE_KLIPY_API_KEY. Missing key → `klipyConfigured()` is false and the
 * picker says "GIF search isn't available in this build".
 */

import {
    KLIPY_API_ORIGIN,
    KLIPY_TITLE_MAX_LENGTH,
    isKlipyMediaUrl,
    isKlipySlug,
    type KlipyGifMedia,
    type KlipyGifMime,
    type KlipyGifRef,
} from '@cipherline/shared';
import { isKlipyEnabled } from '../hooks/useGifSettings';

// ── User-facing copy (pinned by tests; mirrored in docs/klipy-client-contract.md) ──

/** The first-run opt-in notice, verbatim. */
export const KLIPY_NOTICE_TEXT =
    'GIF search connects your device directly to KLIPY. KLIPY will see your IP address and what you search for.';
/** REQUIRED by KLIPY's attribution guidelines — the search field placeholder. */
export const KLIPY_SEARCH_PLACEHOLDER = 'Search KLIPY';
/** Optional KLIPY attribution, shown in the picker footer. */
export const KLIPY_POWERED_BY = 'Powered by KLIPY';
export const KLIPY_NOT_AVAILABLE_TEXT = 'GIF search isn’t available in this build.';

// ── Config ──────────────────────────────────────────────────────────────────

/** KLIPY app keys are opaque tokens; anything else (a path separator, a `?`)
 *  would change which URL we call, so it is treated as "no key". */
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

function readEnvKey(): string {
    try {
        const raw = (import.meta.env.VITE_KLIPY_API_KEY as string | undefined) ?? '';
        return raw.trim();
    } catch { return ''; }
}

/** The build's KLIPY key, or null when the build has none (or a malformed one). */
export function getKlipyApiKey(raw: string = readEnvKey()): string | null {
    return KEY_RE.test(raw) ? raw : null;
}

export function klipyConfigured(raw?: string): boolean {
    return getKlipyApiKey(raw) !== null;
}

/** Items per page. KLIPY allows 8..50, default 24. */
export const KLIPY_PAGE_SIZE = 24;
/** Type-as-you-search debounce. With a testing-mode key (100 req/hour for the
 *  whole app) every avoided request matters. */
export const KLIPY_SEARCH_DEBOUNCE_MS = 400;
export const KLIPY_MAX_QUERY_LENGTH = 100;
/** KLIPY's strictest level — see the file header. */
export const KLIPY_CONTENT_FILTER = 'high';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

// ── Types ───────────────────────────────────────────────────────────────────

export interface KlipyGif {
    slug: string;
    title: string;
    /** Small rendition for the picker grid. */
    preview: KlipyGifMedia;
    /** The rendition that is SENT (as a reference) and saved (as a reference). */
    send: KlipyGifMedia;
    /** KLIPY's inline blurred placeholder (`data:image/...`), no network. */
    placeholder?: string;
}

export interface KlipyPage {
    results: KlipyGif[];
    page: number;
    hasNext: boolean;
}

export type KlipyErrorKind =
    | 'disabled'
    | 'not_configured'
    | 'offline'
    | 'rate_limited'
    | 'auth'
    | 'unavailable'
    | 'bad_response';

export class KlipyError extends Error {
    readonly kind: KlipyErrorKind;
    readonly status?: number;
    constructor(kind: KlipyErrorKind, status?: number) {
        // The message is the kind only — never a URL (the key is in the path).
        super(`klipy:${kind}${status ? `:${status}` : ''}`);
        this.name = 'KlipyError';
        this.kind = kind;
        this.status = status;
    }
}

export interface KlipyDeps {
    fetch?: typeof fetch;
    /** Defaults to the persisted opt-in. */
    enabled?: () => boolean;
    /** Defaults to VITE_KLIPY_API_KEY. */
    apiKey?: string;
    online?: () => boolean;
}

// ── Normalisation (pure, exported for tests) ────────────────────────────────

type Order = Array<[size: string, format: 'gif' | 'webp']>;
/** Grid preview: small animated WebP first — a fraction of the GIF's bytes. */
const PREVIEW_ORDER: Order = [['sm', 'webp'], ['sm', 'gif'], ['xs', 'webp'], ['xs', 'gif'], ['md', 'webp']];
/** What recipients load. `md` looks right at chat size (max 300px tall);
 *  WebP is ~4-5x smaller than the GIF of the same frames, and every recipient
 *  pays for it on their own connection. */
const SEND_ORDER: Order = [['md', 'webp'], ['md', 'gif'], ['sm', 'webp'], ['sm', 'gif'], ['hd', 'webp'], ['hd', 'gif']];
const MIME: Record<'gif' | 'webp', KlipyGifMime> = { gif: 'image/gif', webp: 'image/webp' };

/** Largest rendition we will offer, by KLIPY's own reported `size`. */
const MAX_SEND_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const PLACEHOLDER_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PLACEHOLDER_LENGTH = 8192;

const isDim = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 8192;

function pick(file: Record<string, unknown>, order: Order, maxBytes: number): KlipyGifMedia | null {
    for (const [size, format] of order) {
        const bucket = file[size];
        if (!bucket || typeof bucket !== 'object') continue;
        const r = (bucket as Record<string, unknown>)[format];
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        // The URL is passed through byte-for-byte (KLIPY: "preserve KLIPY URLs
        // and delivery data") — but only if it is on the exact CDN allowlist.
        if (!isKlipyMediaUrl(o.url) || !isDim(o.width) || !isDim(o.height)) continue;
        if (typeof o.size === 'number' && o.size > maxBytes) continue;
        return { url: o.url, width: o.width, height: o.height, mime: MIME[format] };
    }
    return null;
}

/**
 * One KLIPY item → what the picker needs, or null if it is not a usable GIF.
 * Items with `type` other than `gif` (KLIPY's ad units are `type: 'ad'`; we
 * request none, so none are expected) are dropped.
 */
export function normalizeKlipyItem(raw: unknown): KlipyGif | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.type !== undefined && o.type !== 'gif') return null;
    if (!isKlipySlug(o.slug)) return null;
    if (!o.file || typeof o.file !== 'object') return null;
    const file = o.file as Record<string, unknown>;
    const preview = pick(file, PREVIEW_ORDER, MAX_PREVIEW_BYTES);
    const send = pick(file, SEND_ORDER, MAX_SEND_BYTES);
    if (!preview || !send) return null;
    const gif: KlipyGif = {
        slug: o.slug,
        title: typeof o.title === 'string' ? o.title.slice(0, KLIPY_TITLE_MAX_LENGTH) : '',
        preview,
        send,
    };
    if (typeof o.blur_preview === 'string' && o.blur_preview.length <= MAX_PLACEHOLDER_LENGTH
        && PLACEHOLDER_RE.test(o.blur_preview)) {
        gif.placeholder = o.blur_preview;
    }
    return gif;
}

/** KLIPY's envelope: `{ result: true, data: { data: [item], current_page, has_next } }`. */
export function normalizeKlipyPage(body: unknown, requestedPage: number): KlipyPage {
    if (!body || typeof body !== 'object') throw new KlipyError('bad_response');
    const b = body as Record<string, unknown>;
    if (b.result !== true || !b.data || typeof b.data !== 'object') throw new KlipyError('bad_response');
    const d = b.data as Record<string, unknown>;
    const items = Array.isArray(d.data) ? d.data : [];
    const results: KlipyGif[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const g = normalizeKlipyItem(item);
        if (g && !seen.has(g.slug)) { seen.add(g.slug); results.push(g); }
    }
    const page = typeof d.current_page === 'number' && d.current_page >= 1 ? d.current_page : requestedPage;
    return { results, page, hasNext: d.has_next === true && results.length > 0 };
}

/** The reference that goes on the wire / into the saved library. */
export function klipyRefOf(gif: KlipyGif): KlipyGifRef {
    const ref: KlipyGifRef = { slug: gif.slug, media: { ...gif.send } };
    if (gif.title) ref.title = gif.title;
    return ref;
}

// ── Requests ────────────────────────────────────────────────────────────────

/**
 * Build a request URL. Only ever `https://api.klipy.com/api/v1/<key>/gifs/...`
 * with the fixed parameter set below — callers cannot add parameters.
 */
export function buildKlipyUrl(
    key: string,
    endpoint: 'trending' | 'search' | 'items',
    params: { q?: string; page?: number; slugs?: string[] },
): string {
    const u = new URL(`${KLIPY_API_ORIGIN}/api/v1/${encodeURIComponent(key)}/gifs/${endpoint}`);
    if (endpoint === 'items') {
        u.searchParams.set('slugs', (params.slugs ?? []).join(','));
    } else {
        u.searchParams.set('page', String(Math.max(1, Math.floor(params.page ?? 1))));
        u.searchParams.set('per_page', String(KLIPY_PAGE_SIZE));
        if (endpoint === 'search') u.searchParams.set('q', params.q ?? '');
    }
    u.searchParams.set('content_filter', KLIPY_CONTENT_FILTER);
    u.searchParams.set('format_filter', 'gif,webp');
    return u.toString();
}

function navigatorOnline(): boolean {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

async function klipyGet(url: string, deps: KlipyDeps, signal?: AbortSignal): Promise<unknown> {
    const f = deps.fetch ?? globalThis.fetch.bind(globalThis);
    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
        res = await f(url, {
            method: 'GET',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: timeout.signal,
        });
    } catch (err) {
        if (signal?.aborted) throw err;             // superseded — caller ignores
        throw new KlipyError((deps.online ?? navigatorOnline)() ? 'unavailable' : 'offline');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
    if (res.status === 429) throw new KlipyError('rate_limited', 429);
    if (res.status === 401 || res.status === 403) throw new KlipyError('auth', res.status);
    if (!res.ok) throw new KlipyError('unavailable', res.status);
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) throw new KlipyError('bad_response');
    try { return JSON.parse(text); } catch { throw new KlipyError('bad_response'); }
}

/** The gate every request passes. Throws BEFORE any network activity. */
function requireReady(deps: KlipyDeps): string {
    const key = getKlipyApiKey(deps.apiKey ?? readEnvKey());
    if (!key) throw new KlipyError('not_configured');
    if (!(deps.enabled ?? isKlipyEnabled)()) throw new KlipyError('disabled');
    return key;
}

export async function fetchKlipyTrending(page: number, signal?: AbortSignal, deps: KlipyDeps = {}): Promise<KlipyPage> {
    const key = requireReady(deps);
    return normalizeKlipyPage(await klipyGet(buildKlipyUrl(key, 'trending', { page }), deps, signal), page);
}

export async function searchKlipy(q: string, page: number, signal?: AbortSignal, deps: KlipyDeps = {}): Promise<KlipyPage> {
    const key = requireReady(deps);
    const query = q.trim().slice(0, KLIPY_MAX_QUERY_LENGTH);
    if (!query) return fetchKlipyTrending(page, signal, deps);
    return normalizeKlipyPage(await klipyGet(buildKlipyUrl(key, 'search', { q: query, page }), deps, signal), page);
}

/**
 * Re-fetch one GIF by slug (KLIPY's Items API — "ideal for restoring saved
 * content, displaying favorites"). Used when a saved reference's stored URL
 * stops loading. Returns null when KLIPY no longer has it.
 */
export async function fetchKlipyBySlug(slug: string, signal?: AbortSignal, deps: KlipyDeps = {}): Promise<KlipyGif | null> {
    if (!isKlipySlug(slug)) return null;
    const key = requireReady(deps);
    const page = normalizeKlipyPage(await klipyGet(buildKlipyUrl(key, 'items', { slugs: [slug] }), deps, signal), 1);
    return page.results.find(g => g.slug === slug) ?? null;
}

// ── UI helpers ──────────────────────────────────────────────────────────────

export function klipyErrorKind(err: unknown): KlipyErrorKind {
    return err instanceof KlipyError ? err.kind : 'unavailable';
}

/**
 * A short, secret-free hint for the picker's error line so a tester (and us)
 * can tell "the request never left / was blocked" from "KLIPY answered with an
 * error". Never contains a URL — the API key is part of the path.
 */
export function klipyErrorDetail(err: unknown): string {
    if (!(err instanceof KlipyError)) return 'unexpected error';
    if (err.status) return err.status === 404 ? 'HTTP 404 (KLIPY rejected the key?)' : `HTTP ${err.status}`;
    if (err.kind === 'bad_response') return 'unreadable response';
    if (err.kind === 'unavailable') return 'request failed before reaching KLIPY (network or blocked)';
    return err.kind;
}

export function klipyErrorMessage(kind: KlipyErrorKind): string {
    switch (kind) {
        case 'disabled': return 'GIF search is turned off.';
        case 'not_configured': return KLIPY_NOT_AVAILABLE_TEXT;
        case 'offline': return 'You’re offline. Your saved GIFs still work.';
        case 'rate_limited': return 'GIF search is busy. Give it a few seconds.';
        case 'auth': return 'GIF search isn’t available right now.';
        case 'bad_response':
        case 'unavailable':
        default: return 'Couldn’t reach KLIPY. Try again in a moment.';
    }
}

/** True for an abort — a superseded request, not an error. */
export function isAbort(err: unknown): boolean {
    const e = err as { name?: string } | null;
    return e?.name === 'AbortError';
}

// ── Picker / embed decisions (pure, so they are testable without a DOM) ─────

export type GifPickerTab = 'klipy' | 'saved';

/**
 * Which tab the picker opens on. KLIPY when the user uses it, or when they
 * have not yet answered the first-run notice (so they see it once); otherwise
 * their saved GIFs. A build without a key never opens on KLIPY.
 */
export function initialGifTab(opts: {
    configured: boolean; enabled: boolean; noticeDismissed: boolean; last: GifPickerTab | null;
}): GifPickerTab {
    if (!opts.configured) return 'saved';
    if (opts.last) return opts.last;
    return opts.enabled || !opts.noticeDismissed ? 'klipy' : 'saved';
}

export const KLIPY_TAP_TO_LOAD_TEXT = 'GIF from KLIPY — tap to load';
export const KLIPY_ALWAYS_LOAD_TEXT = 'Always load KLIPY GIFs';

export type KlipyEmbedMode = 'invalid' | 'placeholder' | 'load';

/**
 * What a received `klipy_gif` shows: invalid payload → never load; not opted
 * in and not tapped → placeholder; otherwise load.
 */
export function klipyEmbedMode(ref: KlipyGifRef | null, enabled: boolean, tappedOnce: boolean): KlipyEmbedMode {
    if (!ref) return 'invalid';
    return enabled || tappedOnce ? 'load' : 'placeholder';
}

/** Display box for a rendition: fit within max x max keeping aspect ratio. */
export function klipyDisplaySize(w: number, h: number, max = 300): { width: number; height: number } {
    const scale = Math.min(1, max / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Attributes for an `<img>` that loads KLIPY media. `no-referrer` so KLIPY
 * never learns which page/conversation embedded it; `anonymous` CORS mode is
 * NOT used — GifPlayer's frozen-frame canvas only needs drawImage, which works
 * on an opaque image.
 */
export const KLIPY_IMG_ATTRS = {
    referrerPolicy: 'no-referrer' as const,
    decoding: 'async' as const,
};
