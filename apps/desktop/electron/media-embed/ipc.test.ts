import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LINK_EMBED_CHANNELS, createClipResolver, registerDirectMedia, registerLinkEmbedIpc, youTubeMetaFor, type IpcMainLike } from './ipc';
import { MediaRegistry } from './media-registry';
import type { FetchDeps, RequestFn } from './pinned-fetch';

const MEDAL = readFileSync(join(__dirname, '__fixtures__', 'medal-clip.html'), 'utf8');
let server: http.Server;
let port = 0;
const pageHits: string[] = [];
beforeAll(async () => {
    server = http.createServer((req, res) => {
        pageHits.push(req.url!);
        if (req.url!.startsWith('/games/valorant/clips/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(MEDAL); return; }
        if (req.url === '/moo') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>no video here</title></head></html>'); return; }
        if (req.url === '/away') { res.writeHead(302, { location: 'https://evil.example/page' }); res.end(); return; }
        res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Every https host is served by the local server; the resolver accepts any non-IP host. */
function localFetch(): FetchDeps {
    return {
        request: (url, opts, cb) => { const u = new URL(url); return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: opts.headers }, cb); },
        resolve: async (url: string) => ({ ip: '93.184.215.14', family: 4, hostname: new URL(url).hostname }),
    };
}

function fakeIpc() {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = { handle: (c, l) => { handlers.set(c, l); } };
    return { ipc, handlers };
}

describe('link-embed IPC', () => {
    it('registers exactly the documented channels', () => {
        const { ipc, handlers } = fakeIpc();
        registerLinkEmbedIpc(ipc);
        expect([...handlers.keys()].sort()).toEqual(Object.values(LINK_EMBED_CHANNELS).sort());
    });

    it('youtube-oembed: an invalid id is a quiet null with no request', async () => {
        const request = vi.fn() as unknown as RequestFn;
        const resolve = vi.fn();
        for (const bad of ['', 'x', 'https://evil.example/', '../oembed', 42, null, { id: 'dQw4w9WgXcQ' }]) {
            expect(await youTubeMetaFor(bad, { fetchDeps: { request, resolve } })).toBeNull();
        }
        expect(request).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
    });

    it('youtube-oembed: asks youtube.com only, and a failure is a quiet null', async () => {
        const resolve = vi.fn(async (url: string) => { throw new Error(`blocked ${new URL(url).host}`); });
        expect(await youTubeMetaFor('dQw4w9WgXcQ', { fetchDeps: { resolve } })).toBeNull();
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(new URL(resolve.mock.calls[0][0]).host).toBe('www.youtube.com');
    });
});

describe('embed:register-media (direct links)', () => {
    it('registers an https media file the chat shows, as clmedia://', () => {
        const registry = new MediaRegistry();
        const r = registerDirectMedia('https://cdn.example/clip.mp4', 'video', { registry });
        expect(r).toMatchObject({ ok: true });
        expect((r as { src: string }).src).toMatch(/^clmedia:\/\/media\/[0-9a-f]{32}$/);
        expect(registerDirectMedia('https://cdn.example/a.webm?x=1', 'video', { registry }).ok).toBe(true);
        expect(registerDirectMedia('https://cdn.example/a.png', 'image', { registry }).ok).toBe(true);
    });

    it('an extensionless direct link registers for either kind (decided by its bytes; the protocol checks the type)', () => {
        const registry = new MediaRegistry();
        expect(registerDirectMedia('https://www.gravatar.com/avatar/00?d=identicon', 'image', { registry })).toMatchObject({ ok: true });
        expect(registerDirectMedia('https://cdn.example/v/abc123', 'video', { registry })).toMatchObject({ ok: true });
    });

    it('refuses anything else, quietly', () => {
        const registry = new MediaRegistry();
        for (const [url, kind] of [
            ['http://cdn.example/clip.mp4', 'video'],
            ['https://cdn.example/page.html', 'video'],
            ['https://cdn.example/clip.mp4', 'audio'],
            ['https://cdn.example/clip.mp4', 'image'],
            ['https://cdn.example/a.png', 'video'],
            ['https://u:p@cdn.example/clip.mp4', 'video'],
            ['file:///c/clip.mp4', 'video'],
            [42, 'video'],
            [null, null],
        ] as [unknown, unknown][]) {
            expect(registerDirectMedia(url, kind, { registry }), String(url)).toEqual({ ok: false });
        }
        expect(registry.size).toBe(0);
        expect(registerDirectMedia('https://cdn.example/clip.mp4', 'video', {})).toEqual({ ok: false });
    });
});

describe('embed:resolve-clip (clip pages, on click)', () => {
    it('Medal: fetches the page, picks the clip file, registers it', async () => {
        const registry = new MediaRegistry();
        const resolve = createClipResolver({ registry, fetchDeps: localFetch() });
        pageHits.length = 0;
        const r = await resolve('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt?invite=abc');
        expect(r).toMatchObject({ ok: true, width: 1280, height: 720 });
        const entry = registry.lookup((r as { src: string }).src)!;
        expect(entry.url).toMatch(/^https:\/\/cdn\.medal\.tv\/mediac\/nMMYxJgAb8bP9b\.mp4\?auth=/);
        expect(entry.kind).toBe('video');
        expect(pageHits).toEqual(['/games/valorant/clips/nYiYMMGqugp5N9XWt']); // query dropped
        // A second click within the cache window makes no new page request.
        await resolve('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt');
        expect(pageHits).toHaveLength(1);
    });

    it('Giphy and Imgur .gifv resolve from the URL alone (no page fetch)', async () => {
        const registry = new MediaRegistry();
        const request = vi.fn() as unknown as RequestFn;
        const resolve = createClipResolver({ registry, fetchDeps: { request } });
        const g = await resolve('https://giphy.com/gifs/cat-JIX9t2j0ZTN9S');
        expect(registry.lookup((g as { src: string }).src)!.url).toBe('https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4');
        const i = await resolve('https://i.imgur.com/A61SaA1.gifv');
        expect(registry.lookup((i as { src: string }).src)!.url).toBe('https://i.imgur.com/A61SaA1.mp4');
        expect(request).not.toHaveBeenCalled();
    });

    it('unsupported, no video, off-site redirect, unreachable', async () => {
        const registry = new MediaRegistry();
        const resolve = createClipResolver({ registry, fetchDeps: localFetch() });
        expect(await resolve('https://example.com/clip')).toEqual({ ok: false, reason: 'unsupported' });
        expect(await resolve(42)).toEqual({ ok: false, reason: 'unsupported' });
        expect(await resolve('https://streamable.com/moo')).toEqual({ ok: false, reason: 'no-media' });
        expect(await createClipResolver({ registry, fetchDeps: { ...localFetch(), request: (url, o, cb) => http.request(`http://127.0.0.1:${port}/away`, { headers: o.headers }, cb) } })('https://tenor.com/view/x-gif-123456'))
            .toEqual({ ok: false, reason: 'failed' });
        expect(registry.size).toBe(0);
    });

    it('the page fetch goes through the SSRF resolver: a refusal there means no request', async () => {
        // net-guard's own refusals are proven in pinned-fetch.test.ts; here, that resolve() gates the page fetch.
        const registry = new MediaRegistry();
        const request = vi.fn() as unknown as RequestFn;
        const resolve = createClipResolver({ registry, fetchDeps: { request, resolve: async () => { throw new Error('Host resolves to a private/loopback address'); } } });
        expect(await resolve('https://medal.tv/clips/abcdef')).toEqual({ ok: false, reason: 'failed' });
        expect(request).not.toHaveBeenCalled();
    });
});
