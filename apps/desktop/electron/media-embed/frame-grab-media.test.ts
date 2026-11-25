/**
 * clmedia:// and the IPC for the SENDER's frame grab (2026-11-24,
 * embeds-always-thumb):
 *   - CORS answered for the app's own renderer origin ONLY (so its canvas is
 *     not tainted), never for a player frame or a page;
 *   - a frame grab's registration is its own entry with a byte budget across
 *     all its requests; the player's entry for the same file is untouched;
 *   - embed:register-thumb-media takes only the file the unfurler would find:
 *     a clip page's file on that provider's media hosts, a post's on its
 *     media host, a direct video link naming itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { MediaRegistry } from './media-registry';
import { createClmediaHandler, corsHeaders } from './media-protocol';
import { FRAME_GRAB_BUDGET_BYTES, LINK_EMBED_CHANNELS, registerLinkEmbedIpc, registerThumbMedia } from './ipc';
import type { FetchDeps, RequestFn } from './pinned-fetch';

const FILE = Buffer.alloc(100_000, 7);
let server: http.Server;
let port = 0;
let requests = 0;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requests++;
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Math.min(Number(m[2]), FILE.length - 1) : FILE.length - 1;
            res.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${FILE.length}`, 'content-length': String(end - start + 1) });
            res.end(FILE.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(FILE.length) });
        res.end(FILE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

function localDeps(): FetchDeps {
    const request: RequestFn = (url, opts, cb) => {
        const u = new URL(url);
        return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: opts.headers }, cb);
    };
    return { request, resolve: async (url: string) => ({ ip: '93.184.215.14', family: 4, hostname: new URL(url).hostname }) };
}

const APP = 'http://127.0.0.1:5174';
const allowOrigin = (o: string) => o === APP;
const get = (src: string, headers: Record<string, string> = {}) => new Request(src, { headers });

describe('clmedia CORS: the app\'s own renderer only', () => {
    it('corsHeaders: the allowed origin echoed with Vary; anything else, "null", no Origin or no rule: nothing', () => {
        const req = (origin?: string) => new Request('clmedia://media/x', { headers: origin ? { origin } : {} });
        expect(corsHeaders(req(APP), allowOrigin)).toEqual({ 'Access-Control-Allow-Origin': APP, Vary: 'Origin' });
        for (const o of ['https://www.youtube-nocookie.com', 'https://clips.twitch.tv', 'http://127.0.0.1:5175', 'null']) expect(corsHeaders(req(o), allowOrigin), o).toEqual({});
        expect(corsHeaders(req(), allowOrigin)).toEqual({});
        expect(corsHeaders(req(APP), undefined)).toEqual({});
    });

    it('on a real stream: the app gets the header (positive control), a player frame does not', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video');
        const handle = createClmediaHandler(registry, { ...localDeps(), allowOrigin });
        const mine = await handle(get(src, { origin: APP, range: 'bytes=0-99' }));
        expect(mine.status).toBe(206);
        expect(mine.headers.get('access-control-allow-origin')).toBe(APP);
        await mine.arrayBuffer();
        const frame = await handle(get(src, { origin: 'https://www.youtube-nocookie.com', range: 'bytes=0-99' }));
        expect(frame.headers.get('access-control-allow-origin')).toBeNull();
        await frame.arrayBuffer();
    });
});

describe('clmedia byte budget (frame grabs)', () => {
    it('streams at most the budget across requests, then 429 with no upstream request', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video', undefined, { budgetBytes: 30_000 });
        const handle = createClmediaHandler(registry, { ...localDeps(), allowOrigin });
        const a = await handle(get(src, { origin: APP, range: 'bytes=0-19999' }));
        expect((await a.arrayBuffer()).byteLength).toBe(20_000);
        const b = await handle(get(src, { origin: APP }));
        await expect(b.arrayBuffer()).rejects.toThrow();
        const before = requests;
        const c = await handle(get(src, { origin: APP, range: 'bytes=0-9' }));
        expect(c.status).toBe(429);
        expect(requests).toBe(before);
    });

    it('a grab is its own entry (fresh token every time); the player\'s entry is shared and unbudgeted', async () => {
        const registry = new MediaRegistry();
        const play = registry.register('https://cdn.example/clip.mp4', 'video');
        const g1 = registry.register('https://cdn.example/clip.mp4', 'video', undefined, { budgetBytes: 10 });
        const g2 = registry.register('https://cdn.example/clip.mp4', 'video', undefined, { budgetBytes: 10 });
        expect(new Set([play, g1, g2]).size).toBe(3);
        expect(registry.register('https://cdn.example/clip.mp4', 'video')).toBe(play);
        const r = await createClmediaHandler(registry, localDeps())(get(play));
        expect((await r.arrayBuffer()).byteLength).toBe(100_000);
        expect(() => registry.register('https://cdn.example/clip.mp4', 'video', undefined, { budgetBytes: 0 })).toThrow();
        expect(() => registry.register('https://cdn.example/clip.mp4', 'video', undefined, { budgetBytes: 1.5 })).toThrow();
    });

    it('grabs fall out of the LRU like any entry (bounded)', () => {
        const registry = new MediaRegistry(4);
        const first = registry.register('https://cdn.example/a.mp4', 'video', undefined, { budgetBytes: 10 });
        for (let i = 0; i < 4; i++) registry.register(`https://cdn.example/${i}.mp4`, 'video', undefined, { budgetBytes: 10 });
        expect(registry.size).toBe(4);
        expect(registry.lookup(first)).toBeNull();
    });
});

describe('embed:register-thumb-media', () => {
    const deps = () => ({ registry: new MediaRegistry() });
    const MEDAL = 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt';

    it('a clip page + its file on the provider\'s media hosts; budgeted', () => {
        const d = deps();
        const r = registerThumbMedia(MEDAL, 'https://cdn.medal.tv/mediac/abc.mp4?auth=exp=1~hmac=2', d);
        expect(r.ok).toBe(true);
        const e = d.registry.lookup((r as { src: string }).src)!;
        expect(e.budget?.left).toBe(FRAME_GRAB_BUDGET_BYTES);
        expect(e.hostAllowed?.('cdn.medal.tv')).toBe(true);
        expect(e.hostAllowed?.('evil.example')).toBe(false);
        expect(registerThumbMedia('https://giphy.com/gifs/cat-JIX9t2j0ZTN9S', 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4', d).ok).toBe(true);
    });

    it('a post + its video on that provider\'s media host', () => {
        expect(registerThumbMedia('https://x.com/a/status/20', 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4', deps()).ok).toBe(true);
        expect(registerThumbMedia('https://www.reddit.com/r/aww/comments/90bu6w/x/', 'https://v.redd.it/zv89llsvexb11/DASH_720.mp4', deps()).ok).toBe(true);
    });

    it('a direct video link naming itself (any public https host; the SSRF guard still applies when streaming)', () => {
        expect(registerThumbMedia('https://cdn.example/a.mp4', 'https://cdn.example/a.mp4', deps()).ok).toBe(true);
        expect(registerThumbMedia('https://cdn.example/a.webm', 'https://cdn.example/a.webm', deps()).ok).toBe(true);
    });

    it('POSITIVE CONTROLS: refused', () => {
        const d = deps();
        for (const [page, media] of [
            [MEDAL, 'https://evil.example/a.mp4'], // off Medal's hosts
            [MEDAL, 'https://cdn.medal.tv/a.png'], // an image
            [MEDAL, 'http://cdn.medal.tv/a.mp4'], // not https
            [MEDAL, 'https://u:p@cdn.medal.tv/a.mp4'],
            ['https://x.com/a/status/20', 'https://pbs.twimg.com/a.mp4'], // not X's video host
            ['https://www.reddit.com/r/a/comments/1/x/', 'https://v.redd.it/abc'], // no video path
            ['https://cdn.example/a.mp4', 'https://cdn.example/b.mp4'], // a direct link naming another file
            ['https://news.example/article', 'https://news.example/a.mp4'], // a page that is not a clip / post
            ['https://cdn.example/a.mp4', 'https://cdn.example/a.mp4?x='.padEnd(2100, 'x')],
            [7, 'https://cdn.example/a.mp4'], [MEDAL, null],
        ] as [unknown, unknown][]) {
            expect(registerThumbMedia(page, media, d), `${String(page)} ${String(media)}`).toEqual({ ok: false });
        }
        expect(d.registry.size).toBe(0);
        expect(registerThumbMedia(MEDAL, 'https://cdn.medal.tv/a.mp4', {})).toEqual({ ok: false });
    });

    it('a direct link with NO extension naming itself is accepted (decided by its bytes, 2026-11-24); one with another extension is not', () => {
        const d = deps();
        expect(registerThumbMedia('https://cdn.example/v/abc123', 'https://cdn.example/v/abc123', d)).toMatchObject({ ok: true });
        expect(registerThumbMedia('https://cdn.example/a.html', 'https://cdn.example/a.html', d)).toEqual({ ok: false });
    });

    it('is wired on its channel', async () => {
        const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
        registerLinkEmbedIpc({ handle: (c, l) => { handlers.set(c, l); } }, deps());
        expect(LINK_EMBED_CHANNELS.registerThumbMedia).toBe('embed:register-thumb-media');
        const r = await handlers.get('embed:register-thumb-media')!({}, 'https://cdn.example/a.mp4', 'https://cdn.example/a.mp4');
        expect(r).toMatchObject({ ok: true });
    });
});
