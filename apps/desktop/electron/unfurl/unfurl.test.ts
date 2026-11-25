/**
 * The sender-side unfurler end to end against a local server (every
 * "https://<host>.example|youtube|medal…" request is routed to it through an
 * injected request function), with the SSRF rules exercised by the REAL
 * resolver where the target is private.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { unfurlLink, fetchImagePinned, fetchIconPinned, sniffIconMime, UNFURL_LIMITS } from './unfurl';
import type { FetchDeps, RequestFn } from '../media-embed/pinned-fetch';
import { EMBED_FETCH_UA, EMBED_PREVIEW_UA } from '../media-embed/pinned-fetch';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const clipFx = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'media-embed', '__fixtures__', name), 'utf8');
const liveFx = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', name), 'utf8');
const liveBin = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', name));
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: http.Server;
let port = 0;
const hits: { host: string; path: string; headers: http.IncomingHttpHeaders }[] = [];
/** Bytes the server managed to write per path before the client closed (the </head> stop). */
const sentBytes = new Map<string, number>();

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const host = String(req.headers['x-test-host'] ?? '');
        const u = new URL(req.url!, 'http://x');
        hits.push({ host, path: u.pathname + u.search, headers: req.headers });
        const html = (body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
        const png = (body = PNG, type = 'image/png', extra: Record<string, string> = {}) => { res.writeHead(200, { 'content-type': type, ...extra }); res.end(body); };
        if (host === 'news.example' && u.pathname === '/article') return html(fx('ars-article.html').replace(/https:\/\/cdn\.arstechnica\.net\/wp-content\/uploads\/2026\/11\/Asus-P16-3-1152x648\.jpg/g, 'https://img.example/hero.png'));
        if (host === 'img.example' && u.pathname === '/hero.png') return png();
        // Direct media files (2026-11-24: probed by their bytes): a WebM's EBML head, a real 2 s silent mp4, a PNG.
        if (host === 'cdn.example' && u.pathname === '/clip.webm') return png(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42]), 'video/webm');
        if (host === 'cdn.example' && u.pathname === '/clip.mp4') return png(fs.readFileSync(path.join(__dirname, '__fixtures__', 'media', 'discord-cdn-mp4-loop.bin')), 'video/mp4');
        if (host === 'cdn.example' && u.pathname === '/a.png') return png();
        if (host === 'img.example' && u.pathname === '/huge.png') return png(Buffer.alloc(UNFURL_LIMITS.imageMaxBytes + 10), 'image/png');
        if (host === 'img.example' && u.pathname === '/huge-chunked.png') {
            res.writeHead(200, { 'content-type': 'image/png' });
            const chunk = Buffer.alloc(1024 * 1024);
            let sent = 0;
            const pump = () => { while (sent < 7 && res.write(chunk)) sent++; if (sent < 7) res.once('drain', () => { sent++; pump(); }); else res.end(); };
            pump();
            return;
        }
        if (host === 'img.example' && u.pathname === '/svg') return png(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
        if (host === 'pages.example' && u.pathname === '/huge') {
            // 3 MB of filler BEFORE the metadata: past the 512 KB cap, so no preview.
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(`<html><head><!--${'x'.repeat(3 * 1024 * 1024)}--><meta property="og:title" content="too late"></head></html>`);
            return;
        }
        if (host === 'pages.example' && u.pathname === '/head-then-huge') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(`<html><head><meta property="og:title" content="early title"></head><body>${'x'.repeat(3 * 1024 * 1024)}</body></html>`);
            return;
        }
        if (host === 'pages.example' && u.pathname === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
        if (host === 'pages.example' && u.pathname.startsWith('/hop')) {
            const n = Number(u.pathname.slice(4));
            res.writeHead(302, { location: `https://pages.example/hop${n + 1}` }); res.end(); return;
        }
        if (host === 'pages.example' && u.pathname === '/to-private') { res.writeHead(302, { location: 'https://10.0.0.7/admin' }); res.end(); return; }
        if (host === 'pages.example' && u.pathname === '/oembed-only') return html('<link rel="alternate" type="application/json+oembed" href="https://pages.example/oembed.json">');
        if (host === 'pages.example' && u.pathname === '/oembed.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ title: 'From oEmbed', author_name: 'Someone', provider_name: 'Prov', thumbnail_url: 'https://img.example/hero.png' })); return; }
        if (host === 'pages.example' && u.pathname === '/nothing') return html('<html><head></head></html>');
        if (host === 'www.youtube.com' && u.pathname === '/oembed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fx('youtube-oembed.json')); return; }
        if (host === 'i.ytimg.com' && u.pathname.endsWith('/hq720.jpg')) { res.writeHead(404); res.end(); return; }
        if (host === 'i.ytimg.com' && u.pathname.endsWith('/mqdefault.jpg')) return png(PNG, 'image/jpeg');
        // ── 2026-11-23 fixes ──
        const preview = req.headers['user-agent'] === EMBED_PREVIEW_UA;
        // amazon.com as measured live: the browser UA gets AWS WAF's challenge (202), the
        // preview UA the real page, with NO Content-Type and megabytes after </head>.
        if (host === 'www.amazon.com' && u.pathname === '/') {
            if (!preview) { res.writeHead(202, { 'content-type': 'text/html; charset=UTF-8' }); res.end(liveFx('amazon-home-waf.html')); return; }
            res.writeHead(200, {});
            res.write(liveFx('amazon-home.html'));
            // The rest of a 3 MB page, slowly: a reader that waits for the end would time out.
            let n = 0;
            const t = setInterval(() => {
                if (res.destroyed || res.writableEnded) { clearInterval(t); return; }
                res.write(`<div>${'x'.repeat(64 * 1024)}</div>`); n += 64 * 1024; sentBytes.set('amazon', n);
                if (n > 3 * 1024 * 1024) { clearInterval(t); res.end(); }
            }, 200);
            res.on('close', () => clearInterval(t));
            return;
        }
        if (host === 'www.amazon.com' && u.pathname === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/x-icon' }); res.end(liveBin('amazon.ico')); return; }
        if (host === 'm.media-amazon.com') return png(PNG, 'image/png');
        if (host === 'www.amazon.com' && u.pathname === '/dp/B0D1XD1ZV3') {
            if (!preview) return html(liveFx('amazon-product-captcha.html'));
            res.writeHead(200, {}); res.end(liveFx('amazon-product.html')); return;
        }
        // A Cloudflare challenge to every UA (stackoverflow, medium as measured): the minimal card.
        if (host === 'walled.example' && u.pathname === '/q') { res.writeHead(403, { 'content-type': 'text/html' }); res.end(liveFx('stackoverflow-challenge.html')); return; }
        if (host === 'walled.example' && u.pathname === '/favicon.ico') return png(PNG, 'image/vnd.microsoft.icon');
        // Icons: an SVG one (never requested), a PNG one; HTML served as an "icon" is refused.
        if (host === 'icons.example' && u.pathname === '/') return html('<html><head><title>Icons</title><link rel="icon" type="image/svg+xml" href="/i.svg"><link rel="mask-icon" href="/m.svg"><link rel="icon" href="/fav.png" sizes="32x32"></head></html>');
        if (host === 'icons.example' && u.pathname === '/fav.png') return png(PNG, 'application/octet-stream');
        if (host === 'noicon.example' && u.pathname === '/') return html('<html><head><title>No icon</title></head></html>');
        if (host === 'noicon.example' && u.pathname === '/favicon.ico') return html('<!doctype html><title>Not found</title>');
        if (host === 'tenor.com') return html(liveFx('tenor-gif.html'));
        if (/^media\d*\.tenor\.com$/.test(host)) return png(PNG, 'image/gif');
        if (host === 'medal.tv') return html(clipFx('medal-clip.html'));
        if (host === 'cdn.medal.tv') return png(PNG, 'image/jpeg');
        res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const PUBLIC = /\.example$|^(www\.)?youtube\.com$|^i\.ytimg\.com$|^(cdn\.)?medal\.tv$|^www\.amazon\.com$|^m\.media-amazon\.com$|^(media\d*\.)?tenor\.com$/;
function deps(): { fetchDeps: FetchDeps } {
    const request: RequestFn = (url, opts, cb) => {
        const u = new URL(url);
        return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: { ...opts.headers, 'x-test-host': u.hostname } }, cb);
    };
    return {
        fetchDeps: {
            request,
            resolve: async (url: string) => {
                const host = new URL(url).hostname;
                if (!PUBLIC.test(host)) throw new Error('Refusing to fetch a private/loopback address');
                return { ip: '93.184.215.14', family: 4, hostname: host };
            },
        },
    };
}

describe('unfurlLink: a news article', () => {
    it('card with title, description, site, large-image hint and the image bytes; no cookie, referrer or auth sent', async () => {
        hits.length = 0;
        const r = await unfurlLink('https://news.example/article', deps());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({
            url: 'https://news.example/article', kind: 'card', site: 'Ars Technica', image_large: true,
            title: 'Review: The Asus ProArt P16 offers a glimpse of a future powered by local AI',
        });
        expect(r.image?.mime).toBe('image/png');
        expect(Buffer.from(r.image!.bytes).equals(PNG)).toBe(true);
        for (const h of hits) {
            expect(h.headers.cookie).toBeUndefined();
            expect(h.headers.referer).toBeUndefined();
            expect(h.headers.authorization).toBeUndefined();
            // The page (and what it names) with the link-preview UA, which got a real page here.
            expect(h.headers['user-agent']).toBe(EMBED_PREVIEW_UA);
        }
        const seen = hits.map((h) => `${h.host}${h.path}`);
        expect(seen.slice(0, 1)).toEqual(['news.example/article']);
        expect(seen).toContain('img.example/hero.png');
        // Everything else is the site's icon search (the Ars page's own icons, then /favicon.ico).
        expect(seen.filter((x) => x !== 'news.example/article' && x !== 'img.example/hero.png').every((x) => /icon|favicon|\.png|\.ico/i.test(x))).toBe(true);
    });

    it('falls back to the page\'s oEmbed when the page itself has no title / image', async () => {
        const r = await unfurlLink('https://pages.example/oembed-only', deps());
        expect(r.ok && r.embed).toMatchObject({ kind: 'card', title: 'From oEmbed', author: 'Someone', site: 'Prov' });
        expect(r.ok && r.image?.bytes.byteLength).toBe(PNG.length);
    });

    it('a page with nothing to show still gets the minimal card (its site), flagged for a snapshot (a real page, read fine)', async () => {
        expect(await unfurlLink('https://pages.example/nothing', deps())).toEqual({ ok: true, embed: { url: 'https://pages.example/nothing', kind: 'card', site: 'pages.example' }, snapshot: true, snapshotable: true });
    });
});

describe('unfurlLink: providers', () => {
    it('YouTube: oEmbed title/channel + thumbnail (hq720 404 → mqdefault); the watch page is never fetched', async () => {
        hits.length = 0;
        const r = await unfurlLink('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5', deps());
        expect(r.ok && r.embed).toEqual({
            url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5', kind: 'player', site: 'YouTube',
            player: { provider: 'youtube', id: 'jNQXAC9IVRw', start_s: 5 }, title: 'Me at the zoo', author: 'jawed',
        });
        expect(r.ok && r.image?.mime).toBe('image/jpeg');
        expect(hits.some((h) => h.path.startsWith('/watch'))).toBe(false);
    });

    it('Medal: title, game, author, duration, the video file and the thumbnail', async () => {
        const r = await unfurlLink('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', deps());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'video', site: 'Medal', title: 'wyw my sweetie // Clips in my Discord', tag: 'Valorant', author: 'TofuFPS' });
        expect(r.embed.media).toMatchObject({ mime: 'video/mp4', duration_s: 24.15 });
        expect(r.embed.media!.url).toMatch(/^https:\/\/cdn\.medal\.tv\/mediac\//);
        expect(r.image?.mime).toBe('image/jpeg');
    });

    it('Giphy, Imgur .gifv: the file from the link (no request); direct media files: probed by their BYTES (one ranged GET each), at their real size', async () => {
        hits.length = 0;
        expect(await unfurlLink('https://giphy.com/gifs/abc-xyz123456', deps())).toEqual({
            ok: true, embed: { url: 'https://giphy.com/gifs/abc-xyz123456', kind: 'video', site: 'GIPHY', media: { url: 'https://media.giphy.com/media/xyz123456/giphy.mp4', mime: 'video/mp4', loop: true } },
        });
        expect(await unfurlLink('https://i.imgur.com/A61SaA1.gifv', deps())).toEqual({
            ok: true, embed: { url: 'https://i.imgur.com/A61SaA1.gifv', kind: 'video', site: 'Imgur', media: { url: 'https://i.imgur.com/A61SaA1.mp4', mime: 'video/mp4', loop: true } },
        });
        expect(hits).toEqual([]);
        expect(await unfurlLink('https://cdn.example/clip.webm', deps())).toEqual({
            ok: true, embed: { url: 'https://cdn.example/clip.webm', kind: 'video', site: 'cdn.example', media: { url: 'https://cdn.example/clip.webm', mime: 'video/webm' } },
        });
        // Not snapshotable: a file is not a page. A 2 s silent file is a GIF (loop).
        const mp4 = await unfurlLink('https://cdn.example/clip.mp4', deps());
        expect(mp4.ok && mp4.snapshotable).toBeFalsy();
        expect(mp4.ok && mp4.embed.media).toMatchObject({ mime: 'video/mp4', width: 320, height: 240, loop: true, no_audio: true });
        // A direct image is an image embed now (its real size; its own bytes are the picture).
        const png = await unfurlLink('https://cdn.example/a.png', deps());
        expect(png).toMatchObject({ ok: true, embed: { kind: 'image', media: { url: 'https://cdn.example/a.png', mime: 'image/png', width: 1, height: 1 } }, image: { mime: 'image/png' } });
        // One ranged GET per file, nothing else.
        expect(hits.map((h) => `${h.host}${h.path} ${h.headers.range}`)).toEqual([
            'cdn.example/clip.webm bytes=0-262143', 'cdn.example/clip.mp4 bytes=0-262143', 'cdn.example/a.png bytes=0-262143',
        ]);
    });
});

describe('unfurlLink: the guards (positive controls)', () => {
    it('refuses non-https and malformed input without a request', async () => {
        hits.length = 0;
        for (const bad of ['http://news.example/article', 'file:///etc/passwd', 'https://u:p@news.example/', '', 7, null, `https://a.example/${'x'.repeat(2100)}`]) {
            expect(await unfurlLink(bad, deps())).toEqual({ ok: false, reason: 'invalid' });
        }
        expect(hits).toEqual([]);
    });

    it('private / loopback / link-local targets are refused by the REAL resolver before any request: the minimal card, no icon', async () => {
        const request = vi.fn() as unknown as RequestFn;
        for (const [u, site] of [['https://127.0.0.1/', '127.0.0.1'], ['https://10.1.2.3/page', '10.1.2.3'], ['https://192.168.1.1/', '192.168.1.1'],
            ['https://169.254.169.254/latest/meta-data', '169.254.169.254'], ['https://[::1]/', '[::1]'], ['https://localhost/', 'localhost']]) {
            expect(await unfurlLink(u, { fetchDeps: { request } })).toEqual({ ok: true, embed: { url: u, kind: 'card', site } });
        }
        expect(request).not.toHaveBeenCalled();
    });

    it('a redirect to a private address is refused at that hop (minimal card, nothing more fetched)', async () => {
        hits.length = 0;
        expect(await unfurlLink('https://pages.example/to-private', deps())).toEqual({ ok: true, embed: { url: 'https://pages.example/to-private', kind: 'card', site: 'pages.example' } });
        expect(hits.map((h) => h.path)).toEqual(['/to-private']);
    });

    it('at most 5 redirects', async () => {
        hits.length = 0;
        const r = await unfurlLink('https://pages.example/hop0', deps());
        expect(r).toEqual({ ok: true, embed: { url: 'https://pages.example/hop0', kind: 'card', site: 'pages.example' } });
        expect(hits.length).toBe(6); // the first request + 5 followed hops, then refused (not retried: unreachable)
    });

    it('oversized head: reading stops at 1 MB, so metadata past the cap gives the minimal card; a head that ends early is read', async () => {
        const huge = await unfurlLink('https://pages.example/huge', deps());
        expect(huge.ok && huge.embed).toEqual({ url: 'https://pages.example/huge', kind: 'card', site: 'pages.example' });
        const r = await unfurlLink('https://pages.example/head-then-huge', deps());
        expect(r.ok && r.embed.title).toBe('early title');
    });

    it('a non-HTML link (the site answered) gets the minimal card', async () => {
        expect(await unfurlLink('https://pages.example/json', deps())).toEqual({ ok: true, embed: { url: 'https://pages.example/json', kind: 'card', site: 'pages.example' } });
    });

    it('images: over 5 MB refused (declared and streamed), non-raster types refused', async () => {
        await expect(fetchImagePinned('https://img.example/huge.png', deps())).rejects.toThrow(/too large/i);
        await expect(fetchImagePinned('https://img.example/huge-chunked.png', deps())).rejects.toThrow(/too large/i);
        await expect(fetchImagePinned('https://img.example/svg', deps())).rejects.toThrow(/not an image/i);
        await expect(fetchImagePinned('https://img.example/hero.png', deps())).resolves.toMatchObject({ mime: 'image/png' });
    });
});

describe('2026-11-23 fixes: every web link gets a card', () => {
    it('amazon.com (as measured live): the browser UA would get AWS WAF; the preview UA gets the page (no Content-Type) and reading stops at </head>', async () => {
        hits.length = 0;
        sentBytes.clear();
        const t0 = Date.now();
        const r = await unfurlLink('https://www.amazon.com/', deps());
        expect(Date.now() - t0).toBeLessThan(3000); // never waited for the 3 MB body
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'card', site: 'amazon.com', title: 'Amazon.com. Spend less. Smile more.' });
        expect(r.embed.description).toMatch(/^Free shipping/);
        expect(r.image).toBeDefined();
        expect(r.icon?.mime).toBe('image/x-icon');                         // /favicon.ico, an .ico (decoded by the renderer)
        const page = hits.filter((h) => h.host === 'www.amazon.com' && h.path === '/');
        expect(page.map((h) => h.headers['user-agent'])).toEqual([EMBED_PREVIEW_UA]); // one read, preview UA first
        expect(sentBytes.get('amazon') ?? 0).toBeLessThan(1024 * 1024);
    });

    it('positive control: the browser UA alone gets the WAF challenge (202, empty title), never used as the page', async () => {
        const r = await fetch202();
        expect(r).toBe(202);
    });

    it('an Amazon product page: the product photo from the body; the captcha (browser UA) is not the page', async () => {
        hits.length = 0;
        const r = await unfurlLink('https://www.amazon.com/dp/B0D1XD1ZV3', deps());
        expect(r.ok && r.embed.title).toMatch(/^Amazon\.com: Apple AirPods Pro 2/);
        expect(r.ok && r.image).toBeDefined();
        expect(hits.some((h) => h.host === 'm.media-amazon.com' && h.path === '/images/I/61SUj2aKoEL._AC_SL1500_.jpg')).toBe(true);
    });

    it('a bot wall for every UA (Cloudflare, 403): the minimal card + the site\'s icon; "Just a moment..." is never a title', async () => {
        hits.length = 0;
        const r = await unfurlLink('https://walled.example/q', deps());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toEqual({ url: 'https://walled.example/q', kind: 'card', site: 'walled.example' });
        expect(r.icon?.mime).toBe('image/png'); // served as image/vnd.microsoft.icon; the bytes decide
        expect(hits.filter((h) => h.path === '/q').map((h) => h.headers['user-agent'])).toEqual([EMBED_PREVIEW_UA, EMBED_FETCH_UA]);
    });

    it('site icons: an SVG icon is never requested; the PNG one is taken (even labelled octet-stream)', async () => {
        hits.length = 0;
        const r = await unfurlLink('https://icons.example/', deps());
        expect(r.ok && r.embed).toMatchObject({ title: 'Icons', site: 'icons.example' });
        expect(r.ok && r.icon?.mime).toBe('image/png');
        expect(hits.some((h) => h.path.endsWith('.svg'))).toBe(false);
    });

    it('a site with no icon (an HTML page at /favicon.ico): no icon (the reader draws the letter tile)', async () => {
        const r = await unfurlLink('https://noicon.example/', deps());
        expect(r.ok && r.embed).toEqual({ url: 'https://noicon.example/', kind: 'card', site: 'noicon.example', title: 'No icon' });
        expect(r.ok && r.icon).toBeUndefined();
        await expect(fetchIconPinned('https://noicon.example/favicon.ico', deps())).rejects.toThrow(/not an icon/i);
    });

    it('sniffIconMime: raster formats and .ico by their bytes; SVG / HTML / text never', () => {
        expect(sniffIconMime(new Uint8Array(liveBin('amazon.ico')))).toBe('image/x-icon');
        expect(sniffIconMime(new Uint8Array(liveBin('nytimes.ico')))).toBe('image/png');
        expect(sniffIconMime(new Uint8Array(PNG))).toBe('image/png');
        for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><html>', 'GIF', '']) {
            expect(sniffIconMime(new Uint8Array(Buffer.from(bad)))).toBeNull();
        }
    });

    it('Tenor: a GIF (media.loop) with the file\'s real width / height', async () => {
        const r = await unfurlLink('https://tenor.com/view/morning-morning-coffee-morning-cat-coffee-cat-bad-hair-cat-gif-3162456205570563299', deps());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'video', site: 'Tenor' });
        expect(r.embed.media).toMatchObject({ mime: 'video/mp4', width: 298, height: 498, loop: true });
        // Positive control: a Medal clip is a video, not a loop.
        const m = await unfurlLink('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', deps());
        expect(m.ok && m.embed.media?.loop).toBeUndefined();
    });
});

/** The amazon route answers the browser UA with the WAF challenge (the control for the test above). */
async function fetch202(): Promise<number> {
    return new Promise((ok, fail) => {
        const req = http.request(`http://127.0.0.1:${port}/`, { headers: { 'x-test-host': 'www.amazon.com', 'user-agent': EMBED_FETCH_UA } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
        req.on('error', fail);
        req.end();
    });
}
