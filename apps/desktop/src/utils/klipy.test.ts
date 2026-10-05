import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The KLIPY client (src/utils/klipy.ts) talks to a third party straight from
 * the user's device. What must hold:
 *   - NO request of any kind unless the user opted in AND the build has a key;
 *   - no identifying/personalising parameters, strictest content filter;
 *   - only ever api.klipy.com, no cookies, no referrer;
 *   - results whose media is not on the exact CDN allowlist are dropped.
 */

const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const klipy = await import('./klipy');
const { loadGifSettings, isKlipyEnabled, updateGifSettings } = await import('../hooks/useGifSettings');

const KEY = 'not_a_real_klipy_key';

const media = (host = 'static.klipy.com', fmt = 'webp') => ({
    url: `https://${host}/ii/x/${fmt}/a.${fmt}`, width: 200, height: 150, size: 1000,
});
const item = (slug: string, over: Record<string, unknown> = {}) => ({
    id: 1234567, slug, title: `t-${slug}`, type: 'gif',
    blur_preview: 'data:image/jpeg;base64,AAAA',
    file: {
        sm: { webp: media(), gif: media('static.klipy.com', 'gif') },
        md: { webp: media('static1.klipy.com'), gif: media('static1.klipy.com', 'gif') },
    },
    ...over,
});
const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
    ({ result: true, data: { data: items, current_page: 1, per_page: 24, has_next: true, ...extra } });

function okFetch(body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

beforeEach(() => { mem.clear(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('opt-in gate — nothing is requested unless the user turned KLIPY on', () => {
    it('defaults to OFF', () => {
        expect(loadGifSettings().klipyEnabled).toBe(false);
        expect(isKlipyEnabled()).toBe(false);
    });

    it('trending, search and by-slug all refuse WITHOUT calling fetch while off', async () => {
        const fetch = okFetch(page([item('a')]));
        const deps = { fetch: fetch as unknown as typeof globalThis.fetch, apiKey: KEY };
        await expect(klipy.fetchKlipyTrending(1, undefined, deps)).rejects.toMatchObject({ kind: 'disabled' });
        await expect(klipy.searchKlipy('cats', 1, undefined, deps)).rejects.toMatchObject({ kind: 'disabled' });
        await expect(klipy.fetchKlipyBySlug('a', undefined, deps)).rejects.toMatchObject({ kind: 'disabled' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses the PERSISTED setting by default, and requests once it is turned on', async () => {
        const fetch = okFetch(page([item('a')]));
        const deps = { fetch: fetch as unknown as typeof globalThis.fetch, apiKey: KEY };
        await expect(klipy.fetchKlipyTrending(1, undefined, deps)).rejects.toMatchObject({ kind: 'disabled' });
        expect(fetch).not.toHaveBeenCalled();
        updateGifSettings({ klipyEnabled: true });
        const res = await klipy.fetchKlipyTrending(1, undefined, deps);
        expect(res.results.map(g => g.slug)).toEqual(['a']);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('a malformed stored value never opts anyone in', () => {
        mem.set('cipherline_gif_settings', JSON.stringify({ klipyEnabled: 'yes', autoPlayGifs: false }));
        expect(loadGifSettings()).toMatchObject({ klipyEnabled: false, autoPlayGifs: false });
        mem.set('cipherline_gif_settings', '[true]');
        expect(isKlipyEnabled()).toBe(false);
        mem.set('cipherline_gif_settings', '{not json');
        expect(isKlipyEnabled()).toBe(false);
    });
});

describe('missing key — "not available in this build", no network', () => {
    it('no env key → not configured', () => {
        vi.stubEnv('VITE_KLIPY_API_KEY', '');
        expect(klipy.getKlipyApiKey()).toBeNull();
        expect(klipy.klipyConfigured()).toBe(false);
    });

    it('a key from the env is picked up', () => {
        vi.stubEnv('VITE_KLIPY_API_KEY', KEY);
        expect(klipy.klipyConfigured()).toBe(true);
    });

    it.each(['', 'short', 'has/slash_0123456', 'has?query=1234567', 'white space 12345'])(
        'malformed key %j counts as no key', (k) => {
            expect(klipy.getKlipyApiKey(k)).toBeNull();
        });

    it('refuses before fetch even when opted in', async () => {
        updateGifSettings({ klipyEnabled: true });
        const fetch = okFetch(page([]));
        await expect(klipy.fetchKlipyTrending(1, undefined, { fetch: fetch as never, apiKey: '' }))
            .rejects.toMatchObject({ kind: 'not_configured' });
        expect(fetch).not.toHaveBeenCalled();
        expect(klipy.klipyErrorMessage('not_configured')).toBe('GIF search isn’t available in this build.');
    });
});

describe('request shape', () => {
    const on = { enabled: () => true, apiKey: KEY };

    it('search: api.klipy.com only, strictest filter, no customer_id / locale / ad params', async () => {
        const fetch = okFetch(page([item('a')]));
        await klipy.searchKlipy('  happy cats  ', 2, undefined, { ...on, fetch: fetch as never });
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        const u = new URL(url);
        expect(u.origin).toBe('https://api.klipy.com');
        expect(u.pathname).toBe(`/api/v1/${KEY}/gifs/search`);
        expect(Object.fromEntries(u.searchParams)).toEqual({
            q: 'happy cats', page: '2', per_page: '24', content_filter: 'high', format_filter: 'gif,webp',
        });
        for (const p of ['customer_id', 'locale', 'ad-min-width', 'ad-max-width', 'ad-device', 'ad-language'])
            expect(u.searchParams.has(p)).toBe(false);
        expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
        expect(JSON.stringify(init.headers ?? {})).not.toMatch(/cookie|authorization/i);
    });

    it('trending uses the same fixed parameter set, minus q', async () => {
        const fetch = okFetch(page([]));
        await klipy.fetchKlipyTrending(1, undefined, { ...on, fetch: fetch as never });
        const u = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
        expect(u.pathname).toBe(`/api/v1/${KEY}/gifs/trending`);
        expect([...u.searchParams.keys()].sort()).toEqual(['content_filter', 'format_filter', 'page', 'per_page']);
    });

    it('an empty search is trending, and a query is capped at 100 chars', async () => {
        const fetch = okFetch(page([]));
        await klipy.searchKlipy('   ', 1, undefined, { ...on, fetch: fetch as never });
        expect(new URL((fetch.mock.calls[0] as unknown as [string])[0]).pathname).toMatch(/\/trending$/);
        await klipy.searchKlipy('x'.repeat(300), 1, undefined, { ...on, fetch: fetch as never });
        expect(new URL((fetch.mock.calls[1] as unknown as [string])[0]).searchParams.get('q')).toHaveLength(100);
    });

    it('by-slug uses the Items API and refuses a bad slug without a request', async () => {
        const fetch = okFetch({ result: true, data: { data: [item('abc')] } });
        expect(await klipy.fetchKlipyBySlug('../x', undefined, { ...on, fetch: fetch as never })).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        const g = await klipy.fetchKlipyBySlug('abc', undefined, { ...on, fetch: fetch as never });
        expect(g?.slug).toBe('abc');
        const u = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
        expect(u.pathname).toBe(`/api/v1/${KEY}/gifs/items`);
        expect(u.searchParams.get('slugs')).toBe('abc');
    });

    it('errors are classified and never carry the request URL (it contains the key)', async () => {
        for (const [status, kind] of [[429, 'rate_limited'], [401, 'auth'], [403, 'auth'], [500, 'unavailable'], [404, 'unavailable']] as const) {
            const f = vi.fn(async () => new Response('x', { status }));
            const err = await klipy.fetchKlipyTrending(1, undefined, { ...on, fetch: f as never }).catch(e => e);
            expect(err).toBeInstanceOf(klipy.KlipyError);
            expect(err.kind).toBe(kind);
            expect(String(err.message)).not.toContain(KEY);
        }
        const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        const e1 = await klipy.fetchKlipyTrending(1, undefined, { ...on, fetch: offline as never, online: () => false }).catch(e => e);
        expect(e1.kind).toBe('offline');
        const e2 = await klipy.fetchKlipyTrending(1, undefined, { ...on, fetch: offline as never, online: () => true }).catch(e => e);
        expect(e2.kind).toBe('unavailable');
        const junk = vi.fn(async () => new Response('<html>', { status: 200 }));
        expect((await klipy.fetchKlipyTrending(1, undefined, { ...on, fetch: junk as never }).catch(e => e)).kind).toBe('bad_response');
    });
});

describe('normalisation', () => {
    it('picks a small preview and an md rendition to send, preferring WebP', () => {
        const g = klipy.normalizeKlipyItem(item('a'))!;
        expect(g.preview).toEqual({ url: media().url, width: 200, height: 150, mime: 'image/webp' });
        expect(g.send).toEqual({ url: media('static1.klipy.com').url, width: 200, height: 150, mime: 'image/webp' });
        expect(g.placeholder).toBe('data:image/jpeg;base64,AAAA');
        expect(klipy.klipyRefOf(g)).toEqual({ slug: 'a', media: g.send, title: 't-a' });
    });

    it('drops renditions on a non-allowlisted host and falls through to the next', () => {
        const g = klipy.normalizeKlipyItem(item('a', {
            file: {
                sm: { webp: media('cdn.evil.net') , gif: media('static.klipy.com', 'gif') },
                md: { webp: media('static.klipy.com.evil.net'), gif: media('static2.klipy.com', 'gif') },
            },
        }))!;
        expect(g.preview.url).toContain('static.klipy.com/');
        expect(g.preview.mime).toBe('image/gif');
        expect(g.send.url).toContain('static2.klipy.com/');
    });

    it('drops items with no usable media, ads, bad slugs and duplicates', () => {
        const p = klipy.normalizeKlipyPage(page([
            item('ok'),
            item('ad1', { type: 'ad' }),
            item('bad/slug'),
            item('nomedia', { file: { sm: { webp: media('evil.net') } } }),
            item('ok'),
            null,
        ]), 1);
        expect(p.results.map(g => g.slug)).toEqual(['ok']);
        expect(p.hasNext).toBe(true);
    });

    it('rejects a non-KLIPY envelope', () => {
        expect(() => klipy.normalizeKlipyPage({ result: false }, 1)).toThrow(klipy.KlipyError);
        expect(() => klipy.normalizeKlipyPage('x', 1)).toThrow(klipy.KlipyError);
    });

    it('buildKlipyUrl can only produce api.klipy.com URLs, even with a hostile key', () => {
        const u = new URL(klipy.buildKlipyUrl('../../evil.net/x?', 'trending', { page: 1 }));
        expect(u.host).toBe('api.klipy.com');
        expect(u.pathname.startsWith('/api/v1/')).toBe(true);
    });
});

describe('attribution copy', () => {
    it('the search placeholder is exactly "Search KLIPY" (required by KLIPY)', () => {
        expect(klipy.KLIPY_SEARCH_PLACEHOLDER).toBe('Search KLIPY');
        expect(klipy.KLIPY_POWERED_BY).toBe('Powered by KLIPY');
        expect(klipy.KLIPY_NOTICE_TEXT).toBe(
            'GIF search connects your device directly to KLIPY. KLIPY will see your IP address and what you search for.');
    });
});

describe('klipyErrorDetail', () => {
    it('separates a rejected key from a request that never arrived, and never contains a URL', async () => {
        const { KlipyError, klipyErrorDetail } = await import('./klipy');
        expect(klipyErrorDetail(new KlipyError('unavailable', 404))).toContain('HTTP 404');
        expect(klipyErrorDetail(new KlipyError('unavailable', 502))).toBe('HTTP 502');
        expect(klipyErrorDetail(new KlipyError('unavailable'))).toContain('before reaching KLIPY');
        expect(klipyErrorDetail(new KlipyError('bad_response'))).toBe('unreadable response');
        expect(klipyErrorDetail(new Error('https://api.klipy.com/api/v1/secret/gifs'))).toBe('unexpected error');
    });
});
