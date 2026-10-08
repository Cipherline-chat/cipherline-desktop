import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * serverEmojiLoader — the custom-emoji image pipeline. Pinned here:
 *   - N cold emojis of one server cost ONE API request (the batched URL
 *     route), not N — the old per-emoji path spent N from the account's
 *     shared 300/min budget;
 *   - media concurrency follows the host's protocol: HTTP/2-3 (prod) is not
 *     throttled by the app, HTTP/1.1 is held to Chromium's 6 per host;
 *   - an encrypted-disk-cache hit costs zero requests, and decrypted images
 *     are persisted to that cache tagged as emojis;
 *   - the same emoji asked for twice is one download;
 *   - visible requests are downloaded before background prefetch;
 *   - an API without the batch route falls back to the per-emoji route,
 *     still bounded.
 */

const API = 'http://api.test/v1';
vi.mock('../constants', () => ({ API_BASE: 'http://api.test/v1' }));

// ── Controllable network ─────────────────────────────────────────────────────
let batchRouteMissing = false;
let mediaBase = 'https://media.test';
let postsInFlight = 0, postsPeak = 0, apiGetsInFlight = 0, apiGetsPeak = 0;
let omit = new Set<string>();
interface BatchBody { server_id: string; attachment_ids: string[] }
let posts: Array<{ url: string; body: BatchBody }> = [];
let gets: string[] = [];
let mediaInFlight = 0;
let mediaPeak = 0;
let mediaOrder: string[] = [];
const MEDIA_MS = 5;

const axiosPost = vi.fn(async (url: string, body: BatchBody) => {
    posts.push({ url, body });
    postsInFlight++; postsPeak = Math.max(postsPeak, postsInFlight);
    await new Promise(r => setTimeout(r, 2));
    postsInFlight--;
    if (batchRouteMissing) throw Object.assign(new Error('404'), { isAxiosError: true, response: { status: 404 } });
    return {
        data: {
            urls: body.attachment_ids
                .filter(id => !omit.has(id))
                .map(id => ({ attachment_id: id, download_url: `${mediaBase}/${id}`, mime_type: 'image/png' })),
        },
    };
});
const axiosGet = vi.fn(async (url: string) => {
    gets.push(url);
    if (url.startsWith(`${API}/attachments/`)) {
        const id = url.split('/attachments/')[1].split('/')[0];
        apiGetsInFlight++; apiGetsPeak = Math.max(apiGetsPeak, apiGetsInFlight);
        await new Promise(r => setTimeout(r, 2));
        apiGetsInFlight--;
        return { data: { download_url: `${mediaBase}/${id}`, mime_type: 'image/png' } };
    }
    if (url.startsWith(`${mediaBase}/`)) {
        mediaInFlight++;
        mediaPeak = Math.max(mediaPeak, mediaInFlight);
        mediaOrder.push(url.slice(mediaBase.length + 1));
        await new Promise(r => setTimeout(r, MEDIA_MS));
        mediaInFlight--;
        return { data: new Blob(['cipher']) };
    }
    throw new Error('unexpected ' + url);
});
vi.mock('axios', () => ({
    default: {
        get: (...a: unknown[]) => axiosGet(...(a as [string])),
        post: (...a: unknown[]) => axiosPost(...(a as [string, BatchBody])),
        isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean } | null)?.isAxiosError,
    },
}));

// ── Controllable encrypted disk cache ────────────────────────────────────────
const diskHits = new Set<string>();
const persisted: Array<{ id: string; kind?: string }> = [];
vi.mock('./attachmentCache', () => ({
    getAvatarBlob: async (id: string) => (diskHits.has(id) ? new Blob(['plain']) : null),
    putAvatarBlob: async (id: string, _b: Blob, opts?: { kind?: string }) => { persisted.push({ id, kind: opts?.kind }); },
    deleteAvatarBlob: async () => {},
}));
vi.mock('./crypto', () => ({
    importKeyFromBase64: async () => ({}),
    decryptBlob: async () => new Blob(['plain'], { type: 'image/png' }),
}));

import {
    loadEmojiUrl,
    loadEmojiUrls,
    peekEmojiUrl,
    prefetchServerEmojis,
    subscribeEmojiUrl,
    __emojiLoaderStats,
    __resetEmojiLoader,
    EMOJI_HTTP1_CONCURRENCY,
    EMOJI_MULTIPLEXED_CONCURRENCY,
    EMOJI_FALLBACK_API_CONCURRENCY,
    EMOJI_URL_BATCH,
    mediaConcurrencyFor,
} from './serverEmojiLoader';

let resourceProtocol = '';
// Resource timing as the loader reads it: only `nextHopProtocol` matters.
vi.spyOn(performance, 'getEntriesByName').mockImplementation((name: string) =>
    (resourceProtocol ? [{ name, nextHopProtocol: resourceProtocol } as unknown as PerformanceEntry] : []));

let urlSeq = 0;
URL.createObjectURL = () => `blob:test/${++urlSeq}`;
URL.revokeObjectURL = () => {};

const TOKEN = 't';
const ref = (id: string, serverId: string | null = 'srv') => ({ serverId, attachmentId: id, keyB64: 'k', nonceB64: 'n' });
const ids = (n: number, prefix = 'e') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

beforeEach(() => {
    __resetEmojiLoader();
    batchRouteMissing = false;
    mediaBase = 'https://media.test';
    postsInFlight = 0; postsPeak = 0; apiGetsInFlight = 0; apiGetsPeak = 0;
    resourceProtocol = '';
    omit = new Set();
    posts = []; gets = []; mediaOrder = [];
    mediaInFlight = 0; mediaPeak = 0;
    diskHits.clear();
    persisted.length = 0;
});

describe('serverEmojiLoader', () => {
    it('100 cold emojis of one server = ONE API request, 100 media GETs, none held back on HTTP/2', async () => {
        const urls = await loadEmojiUrls(ids(100).map(id => ref(id)), TOKEN);
        expect(urls.every(u => typeof u === 'string')).toBe(true);
        expect(posts).toHaveLength(1);
        expect(posts[0].url).toBe(`${API}/attachments/emoji-downloads`);
        expect(posts[0].body).toEqual({ server_id: 'srv', attachment_ids: ids(100) });
        expect(gets.filter(g => g.startsWith(API))).toHaveLength(0); // no per-emoji route
        expect(__emojiLoaderStats()).toMatchObject({ apiRequests: 1, mediaRequests: 100 });
        // A multiplexed (https) media host: all 100 go out together, like the
        // old unbounded path — an app cap would only add round-trips.
        expect(mediaPeak).toBe(100);
        expect(mediaPeak).toBeLessThanOrEqual(EMOJI_MULTIPLEXED_CONCURRENCY);
    });

    it('a plain-http media host (HTTP/1.1) is held to 6 at once, matching Chromium', async () => {
        mediaBase = 'http://media.test';
        await loadEmojiUrls(ids(40).map(id => ref(id)), TOKEN);
        expect(mediaPeak).toBe(EMOJI_HTTP1_CONCURRENCY);
    });

    it('an https host whose resource timing says http/1.1 drops to 6 after its first response', async () => {
        resourceProtocol = 'http/1.1';
        await loadEmojiUrl(ref('first'), TOKEN);          // learns the protocol
        expect(mediaConcurrencyFor('https://media.test/x')).toBe(EMOJI_HTTP1_CONCURRENCY);
        mediaPeak = 0;
        await loadEmojiUrls(ids(30).map(id => ref(id)), TOKEN);
        expect(mediaPeak).toBe(EMOJI_HTTP1_CONCURRENCY);
    });

    it('h2 / h3 in resource timing keep the multiplexed cap', async () => {
        resourceProtocol = 'h3';
        await loadEmojiUrl(ref('first'), TOKEN);
        expect(mediaConcurrencyFor('https://media.test/x')).toBe(EMOJI_MULTIPLEXED_CONCURRENCY);
    });

    it('requests from separate components in the same tick join one batch', async () => {
        const all = ids(30).map(id => loadEmojiUrl(ref(id), TOKEN)); // 30 separate callers
        await Promise.all(all);
        expect(posts).toHaveLength(1);
    });

    it(`chunks a big server into ${EMOJI_URL_BATCH}-emoji URL requests, sent in parallel`, async () => {
        await loadEmojiUrls(ids(250).map(id => ref(id)), TOKEN);
        expect(posts.map(p => p.body.attachment_ids.length)).toEqual([100, 100, 50]);
        expect(postsPeak).toBe(3); // not three serial round-trips
    });

    it('an encrypted-disk-cache hit costs zero requests and is then synchronous', async () => {
        ids(10).forEach(id => diskHits.add(id));
        await loadEmojiUrls(ids(10).map(id => ref(id)), TOKEN);
        expect(posts).toHaveLength(0);
        expect(gets).toHaveLength(0);
        expect(peekEmojiUrl('e3')).toMatch(/^blob:/);
    });

    it('persists downloaded images to the encrypted disk cache, tagged as emojis', async () => {
        await loadEmojiUrls([ref('a'), ref('b')], TOKEN);
        expect(persisted).toEqual(expect.arrayContaining([{ id: 'a', kind: 'emoji' }, { id: 'b', kind: 'emoji' }]));
    });

    it('the same emoji requested twice is one download', async () => {
        const [a, b] = await Promise.all([loadEmojiUrl(ref('x'), TOKEN), loadEmojiUrl(ref('x'), TOKEN)]);
        expect(a).toBe(b);
        expect(mediaOrder).toEqual(['x']);
        // And a later request is a memory hit.
        await loadEmojiUrl(ref('x'), TOKEN);
        expect(mediaOrder).toEqual(['x']);
    });

    it('notifies subscribers when an emoji resolves', async () => {
        const seen: string[] = [];
        const off = subscribeEmojiUrl('s1', u => seen.push(u));
        await loadEmojiUrl(ref('s1'), TOKEN);
        off();
        expect(seen).toHaveLength(1);
    });

    it('visible emojis download before queued background prefetch (saturated HTTP/1.1 pool)', async () => {
        mediaBase = 'http://media.test';
        prefetchServerEmojis('srv', ids(200, 'bg').map(id => ({ attachment_id: id, key_b64: 'k', nonce_b64: 'n' })), TOKEN);
        await new Promise(r => setTimeout(r, MEDIA_MS + 2)); // prefetch is under way
        await loadEmojiUrls(ids(5, 'fg').map(id => ref(id)), TOKEN, 'visible');
        const fgPositions = mediaOrder.map((id, i) => (id.startsWith('fg') ? i : -1)).filter(i => i >= 0);
        expect(fgPositions).toHaveLength(5);
        // They jumped the ~170 prefetch downloads still queued: each started
        // within a couple of pool-widths of being asked for.
        expect(Math.max(...fgPositions)).toBeLessThan(4 * EMOJI_HTTP1_CONCURRENCY);
        expect(mediaOrder.length).toBeGreaterThan(Math.max(...fgPositions)); // prefetch still ran
    });

    it('an emoji the server omits (deleted / not a member) resolves to null, no media request', async () => {
        omit = new Set(['gone']);
        const [gone, ok] = await loadEmojiUrls([ref('gone'), ref('ok')], TOKEN);
        expect(gone).toBeNull();
        expect(ok).toMatch(/^blob:/);
        expect(mediaOrder).toEqual(['ok']);
    });

    it('falls back to the per-emoji route on an API without the batch route — still bounded', async () => {
        batchRouteMissing = true;
        const urls = await loadEmojiUrls(ids(20).map(id => ref(id)), TOKEN);
        expect(urls.every(Boolean)).toBe(true);
        expect(gets.filter(g => g.startsWith(`${API}/attachments/`))).toHaveLength(20);
        // These ARE throttle-budget requests, so they stay bounded.
        expect(apiGetsPeak).toBeLessThanOrEqual(EMOJI_FALLBACK_API_CONCURRENCY);
    });

    it('an emoji with no server id uses the per-emoji route', async () => {
        await loadEmojiUrl(ref('lonely', null), TOKEN);
        expect(posts).toHaveLength(0);
        expect(gets[0]).toBe(`${API}/attachments/lonely/download`);
    });
});
