/**
 * clmedia:// handler. The refusals (unregistered token, private/loopback
 * address) run against the REAL resolver and must make no request at all.
 * Streaming (Range forwarding, 206 pass-through, type and size rules, caps)
 * runs against a local server through an injected request function, since
 * the real resolver refuses loopback by design.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { MediaRegistry } from './media-registry';
import { createClmediaHandler, forwardableRange, servedType } from './media-protocol';
import type { FetchDeps, RequestFn } from './pinned-fetch';

const FILE = Buffer.alloc(100_000);
for (let i = 0; i < FILE.length; i++) FILE[i] = i % 251;

let server: http.Server;
let port = 0;
const hits: { path: string; range?: string; headers: http.IncomingHttpHeaders }[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const u = new URL(req.url!, 'http://x');
        hits.push({ path: u.pathname, range: req.headers.range, headers: req.headers });
        const typeFor: Record<string, string> = {
            '/clip.mp4': 'video/mp4', '/clip.webm': 'video/webm', '/raw.mp4': 'application/octet-stream',
            '/raw.bin': 'application/octet-stream', '/page.mp4': 'text/html', '/pic.png': 'image/png',
        };
        if (u.pathname === '/redirect.mp4') { res.writeHead(307, { location: 'https://cdn2.example/clip.mp4' }); res.end(); return; }
        if (u.pathname === '/to-private.mp4') { res.writeHead(302, { location: 'https://192.168.0.10/clip.mp4' }); res.end(); return; }
        if (u.pathname === '/huge.mp4') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(2 * 1024 ** 3) }); res.end(); return; }
        if (u.pathname === '/forbidden.mp4') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('no'); return; }
        if (u.pathname === '/stall.mp4') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1000' }); res.write(Buffer.alloc(10)); return; }
        const type = typeFor[u.pathname];
        if (!type) { res.writeHead(404); res.end(); return; }
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Math.min(Number(m[2]), FILE.length - 1) : FILE.length - 1;
            if (start >= FILE.length) { res.writeHead(416, { 'content-range': `bytes */${FILE.length}` }); res.end(); return; }
            res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${FILE.length}`, 'content-length': String(end - start + 1) });
            res.end(FILE.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(FILE.length) });
        res.end(FILE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

function localDeps(): FetchDeps & { resolve: ReturnType<typeof vi.fn> } {
    const request: RequestFn = (url, opts, cb) => {
        const u = new URL(url);
        return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: opts.headers }, cb);
    };
    const resolve = vi.fn(async (url: string) => {
        const host = new URL(url).hostname;
        if (!host.endsWith('.example')) throw new Error('Refusing to fetch a private/loopback address');
        return { ip: '93.184.215.14', family: 4, hostname: host };
    });
    return { request, resolve };
}

const get = (src: string, headers: Record<string, string> = {}, method = 'GET') => new Request(src, { method, headers });

describe('clmedia refusals (real resolver, no request)', () => {
    it('POSITIVE CONTROL: an unregistered URL or token is a 404 with no request', async () => {
        const registry = new MediaRegistry();
        const request = vi.fn() as unknown as RequestFn;
        const resolve = vi.fn();
        const handle = createClmediaHandler(registry, { request, resolve });
        for (const u of [
            `clmedia://media/${'a'.repeat(32)}`,
            'clmedia://media/https%3A%2F%2Fcdn.example%2Fclip.mp4',
            'clmedia://media/../../etc/passwd',
            'clmedia://other/whatever',
        ]) {
            expect((await handle(get(u))).status, u).toBe(404);
        }
        expect(request).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
    });

    it.each([
        'https://127.0.0.1/clip.mp4',
        'https://10.0.0.8/clip.mp4',
        'https://192.168.1.1/clip.mp4',
        'https://169.254.169.254/latest/meta-data/x.mp4',
        'https://[::1]/clip.mp4',
        'https://[fd00::1]/clip.mp4',
        'https://localhost/clip.mp4',
    ])('POSITIVE CONTROL: a registered private/loopback target %s is refused (502) with no request', async (url) => {
        const registry = new MediaRegistry();
        const src = registry.register(url, 'video');
        const request = vi.fn() as unknown as RequestFn;
        const res = await createClmediaHandler(registry, { request })(get(src, { Range: 'bytes=0-' }));
        expect(res.status).toBe(502);
        expect(request).not.toHaveBeenCalled();
    });

    it('only GET/HEAD', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video');
        expect((await createClmediaHandler(registry, localDeps())(get(src, {}, 'POST'))).status).toBe(405);
    });
});

describe('clmedia streaming (local server)', () => {
    it('forwards a Range request and passes the 206 + Content-Range through, byte-exact', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video');
        hits.length = 0;
        const log: string[] = [];
        const res = await createClmediaHandler(registry, { ...localDeps(), log: (l) => log.push(l) })(get(src, { Range: 'bytes=1000-1999' }));
        expect(res.status).toBe(206);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        expect(res.headers.get('content-range')).toBe(`bytes 1000-1999/${FILE.length}`);
        expect(res.headers.get('content-length')).toBe('1000');
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(FILE.subarray(1000, 2000))).toBe(true);
        expect(hits[0].range).toBe('bytes=1000-1999');
        // No cookie, no referrer, no app identity upstream.
        expect(hits[0].headers.cookie).toBeUndefined();
        expect(hits[0].headers.referer).toBeUndefined();
        expect(hits[0].headers['user-agent']).not.toMatch(/electron|cipherline/i);
        // The dev log names the token prefix and the range, never the URL.
        expect(log.join('\n')).toContain('206 range=bytes=1000-1999');
        expect(log.join('\n')).not.toContain('cdn.example');
    });

    it('an open-ended seek (bytes=N-) streams to the end', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video');
        const res = await createClmediaHandler(registry, localDeps())(get(src, { Range: 'bytes=99000-' }));
        expect(res.status).toBe(206);
        expect(Buffer.from(await res.arrayBuffer()).equals(FILE.subarray(99000))).toBe(true);
    });

    it('no Range → 200 with the whole body; a malformed or multi Range is not forwarded', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video');
        const handle = createClmediaHandler(registry, localDeps());
        hits.length = 0;
        const res = await handle(get(src));
        expect(res.status).toBe(200);
        expect((await res.arrayBuffer()).byteLength).toBe(FILE.length);
        const res2 = await handle(get(src, { Range: 'bytes=0-1,5-9' }));
        expect(res2.status).toBe(200);
        await res2.arrayBuffer();
        expect(hits.map((h) => h.range)).toEqual([undefined, undefined]);
    });

    it('416 passes through with its Content-Range', async () => {
        const registry = new MediaRegistry();
        const src = registry.register('https://cdn.example/clip.mp4', 'video');
        const res = await createClmediaHandler(registry, localDeps())(get(src, { Range: 'bytes=500000-' }));
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe(`bytes */${FILE.length}`);
    });

    it('follows a redirect (re-resolving the new host); refuses one to a private address', async () => {
        const registry = new MediaRegistry();
        const deps = localDeps();
        const ok = await createClmediaHandler(registry, deps)(get(registry.register('https://cdn.example/redirect.mp4', 'video'), { Range: 'bytes=0-9' }));
        expect(ok.status).toBe(206);
        await ok.arrayBuffer();
        expect(deps.resolve.mock.calls.map(([u]) => new URL(u).host)).toEqual(['cdn.example', 'cdn2.example']);
        const bad = await createClmediaHandler(registry, localDeps())(get(registry.register('https://cdn.example/to-private.mp4', 'video')));
        expect(bad.status).toBe(502);
    });

    it('content type: HTML refused; octet-stream only with a media extension, relabelled', async () => {
        const registry = new MediaRegistry();
        const handle = createClmediaHandler(registry, localDeps());
        expect((await handle(get(registry.register('https://cdn.example/page.mp4', 'video')))).status).toBe(415);
        const raw = await handle(get(registry.register('https://cdn.example/raw.mp4', 'video'), { Range: 'bytes=0-9' }));
        expect(raw.status).toBe(206);
        expect(raw.headers.get('content-type')).toBe('video/mp4');
        await raw.arrayBuffer();
        expect((await handle(get(registry.register('https://cdn.example/raw.bin', 'video')))).status).toBe(415);
        // A video entry never serves an image, nor an image entry a video.
        expect((await handle(get(registry.register('https://cdn.example/pic.png', 'video')))).status).toBe(415);
        expect((await handle(get(registry.register('https://cdn.example/clip.mp4', 'image')))).status).toBe(415);
        const png = await handle(get(registry.register('https://cdn.example/pic.png', 'image')));
        expect(png.headers.get('content-type')).toBe('image/png');
        await png.arrayBuffer();
    });

    it('size cap and upstream errors', async () => {
        const registry = new MediaRegistry();
        const handle = createClmediaHandler(registry, localDeps());
        expect((await handle(get(registry.register('https://cdn.example/huge.mp4', 'video')))).status).toBe(413);
        expect((await handle(get(registry.register('https://cdn.example/forbidden.mp4', 'video')))).status).toBe(502);
    });

    it('a host that stops sending errors the stream after the idle timeout', async () => {
        const registry = new MediaRegistry();
        const res = await createClmediaHandler(registry, { ...localDeps(), idleTimeoutMs: 150 })(get(registry.register('https://cdn.example/stall.mp4', 'video')));
        expect(res.status).toBe(200);
        await expect(res.arrayBuffer()).rejects.toThrow();
    });

    it('HEAD answers headers without a body', async () => {
        const registry = new MediaRegistry();
        const res = await createClmediaHandler(registry, localDeps())(get(registry.register('https://cdn.example/clip.mp4', 'video'), {}, 'HEAD'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(FILE.length));
    });
});

describe('helpers', () => {
    it('forwardableRange', () => {
        expect(forwardableRange('bytes=0-')).toBe('bytes=0-');
        expect(forwardableRange(' bytes=10-20 ')).toBe('bytes=10-20');
        for (const bad of [null, '', 'bytes=20-10', 'bytes=-500', 'bytes=0-1,4-5', 'items=0-1', 'bytes=a-b', 'bytes=0-1\r\nX: y']) {
            expect(forwardableRange(bad), String(bad)).toBeNull();
        }
    });
    it('servedType', () => {
        const v = { url: '', kind: 'video' as const };
        expect(servedType(v, 'video/mp4; codecs=avc1', 'https://x/a')).toBe('video/mp4');
        expect(servedType(v, 'video/quicktime', 'https://x/a.mov')).toBe('video/quicktime');
        expect(servedType(v, 'video/x-m4v', 'https://x/a.m4v')).toBe('video/mp4');
        expect(servedType(v, 'binary/octet-stream', 'https://x/a.webm')).toBe('video/webm');
        expect(servedType(v, '', 'https://x/a.mp4')).toBe('video/mp4');
        expect(servedType(v, 'text/html', 'https://x/a.mp4')).toBeNull();
        expect(servedType(v, 'image/svg+xml', 'https://x/a.svg')).toBeNull();
        expect(servedType({ url: '', kind: 'image' }, 'image/svg+xml', 'https://x/a.svg')).toBeNull();
    });
});
