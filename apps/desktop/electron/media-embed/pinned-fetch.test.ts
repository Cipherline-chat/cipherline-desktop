/**
 * The guarded fetch every link embed uses. The SSRF rules are exercised with
 * the REAL resolver (net-guard's assertPublicHttpUrl: literal private IPs and
 * localhost are refused without any network); the HTTP behaviour (redirects,
 * caps, deadlines, headers sent) against a local server through an injected
 * request function, because the real resolver refuses loopback by design.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { assertHttpsUrlShape, fetchTextPinned, openPinned, EMBED_FETCH_UA, type FetchDeps, type RequestFn } from './pinned-fetch';

let server: http.Server;
let port = 0;
const seen: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        seen.push(req.headers);
        const u = new URL(req.url!, 'http://x');
        if (u.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<meta property="og:video" content="https://cdn.example/x.mp4">'); return; }
        if (u.pathname === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('a'.repeat(5000)); return; }
        if (u.pathname === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":1}'); return; }
        if (u.pathname === '/redirect') { res.writeHead(302, { location: 'https://pages.example/page' }); res.end(); return; }
        if (u.pathname === '/to-private') { res.writeHead(302, { location: 'https://10.0.0.5/x' }); res.end(); return; }
        if (u.pathname === '/to-http') { res.writeHead(302, { location: 'http://pages.example/page' }); res.end(); return; }
        if (u.pathname === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
        if (u.pathname === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('late'); }, 400); return; }
        if (u.pathname === '/404') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('no'); return; }
        res.writeHead(500); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Every "https://<host>/path" goes to the local server; the resolver accepts the fake hosts only. */
function localDeps(): FetchDeps & { resolved: string[] } {
    const resolved: string[] = [];
    const request: RequestFn = (url, opts, cb) => {
        const u = new URL(url);
        return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: opts.headers }, cb);
    };
    return {
        resolved,
        request,
        resolve: async (url: string) => {
            const host = new URL(url).hostname;
            resolved.push(host);
            if (!host.endsWith('.example')) throw new Error('Refusing to fetch a private/loopback address');
            return { ip: '93.184.215.14', family: 4, hostname: host };
        },
    };
}

const textOpts = { accept: 'text/html', allowedTypes: ['text/html'], maxBytes: 1024, timeoutMs: 2000, maxRedirects: 3, truncate: true };

describe('assertHttpsUrlShape', () => {
    it('https only, no credentials, bounded', () => {
        expect(assertHttpsUrlShape('https://medal.tv/a')).toBe('https://medal.tv/a');
        for (const bad of ['http://medal.tv/a', 'file:///etc/passwd', 'clmedia://media/x', 'https://u:p@medal.tv/', `https://a.example/${'x'.repeat(2100)}`, '', 7, null, 'nope']) {
            expect(() => assertHttpsUrlShape(bad)).toThrow();
        }
    });
});

describe('real resolver: private and loopback targets are refused before any request', () => {
    it.each([
        'https://127.0.0.1/clip.mp4',
        'https://10.1.2.3/page',
        'https://192.168.1.20/page',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/x',
        'https://localhost/x',
        'https://printer.local/x',
    ])('%s', async (url) => {
        const request = vi.fn() as unknown as RequestFn;
        await expect(openPinned(url, { maxRedirects: 2, headersTimeoutMs: 2000 }, { request })).rejects.toThrow(/private|loopback|local/i);
        expect(request).not.toHaveBeenCalled();
    });
});

describe('fetchTextPinned', () => {
    it('sends the generic UA, no cookie/referer/auth, and returns the body', async () => {
        seen.length = 0;
        const r = await fetchTextPinned('https://pages.example/page', textOpts, localDeps());
        expect(r.text).toContain('og:video');
        expect(r.truncated).toBe(false);
        const hdr = seen[0];
        expect(hdr['user-agent']).toBe(EMBED_FETCH_UA);
        expect(hdr.cookie).toBeUndefined();
        expect(hdr.referer).toBeUndefined();
        expect(hdr.authorization).toBeUndefined();
        expect(hdr.accept).toBe('text/html');
    });

    it('follows a redirect, re-validating the new host', async () => {
        const deps = localDeps();
        const r = await fetchTextPinned('https://start.example/redirect', textOpts, deps);
        expect(r.finalUrl).toBe('https://pages.example/page');
        expect(deps.resolved).toEqual(['start.example', 'pages.example']);
    });

    it('refuses a redirect to a private address, to plain http, or past the hop limit', async () => {
        await expect(fetchTextPinned('https://a.example/to-private', textOpts, localDeps())).rejects.toThrow(/private|loopback/i);
        await expect(fetchTextPinned('https://a.example/to-http', textOpts, localDeps())).rejects.toThrow(/https/);
        await expect(fetchTextPinned('https://a.example/loop', textOpts, localDeps())).rejects.toThrow(/Too many redirects/);
    });

    it('applies the per-hop host policy', async () => {
        await expect(fetchTextPinned('https://start.example/redirect', { ...textOpts, hostAllowed: (h) => h === 'start.example' }, localDeps()))
            .rejects.toThrow(/Host not allowed/);
    });

    it('cuts an HTML body at the cap (truncate) or refuses it (no truncate)', async () => {
        const r = await fetchTextPinned('https://a.example/big', textOpts, localDeps());
        expect(r.text).toHaveLength(1024);
        expect(r.truncated).toBe(true);
        await expect(fetchTextPinned('https://a.example/big', { ...textOpts, truncate: false }, localDeps())).rejects.toThrow(/too large/);
    });

    it('refuses the wrong content type and non-2xx', async () => {
        await expect(fetchTextPinned('https://a.example/json', textOpts, localDeps())).rejects.toThrow(/content type/);
        await expect(fetchTextPinned('https://a.example/404', textOpts, localDeps())).rejects.toThrow(/HTTP 404/);
    });

    it('gives up at the deadline', async () => {
        await expect(fetchTextPinned('https://a.example/slow', { ...textOpts, timeoutMs: 100 }, localDeps())).rejects.toThrow(/timed out/);
    });
});
