/**
 * "Always a thumbnail" (2026-11-24, embeds-always-thumb) as an INVARIANT:
 * every link in a corpus of fixtures, through the REAL unfurler (main,
 * unfurl.ts, against a local server) and the REAL sender chain in the
 * renderer (prepare.ts prepareLinkEmbed → completePicture → finalizeEmbeds),
 * ends as an embed the reader accepts WITH a picture, and the picture comes
 * from the expected step of the chain:
 *   provider → page (og:image) → frame (grab) → snapshot → designed.
 *
 * Owner bug: "sent a medal clip and it has no thumbnail". The Medal fixture's
 * og:image is served as Medal's REAL thumbnail for that clip, saved live
 * 2026-11-24 (__fixtures__/live/medal-thumb-black.avif: 331 bytes, a
 * 1920x1080 AVIF that decodes to pure black in Electron, mean 0.0). Medal's
 * thumbnail is the clip's first frame; this clip fades in from black.
 *
 * What is NOT real here (Node has no image / video decoder): the re-encode
 * (thumb.ts reencodeThumb) is a stand-in that knows the black fixture's
 * measured stats, the frame grab and the snapshot are stand-ins, and the
 * designed picture is a stand-in. Their real versions are covered in their
 * own tests and in the real-Electron harness (harness/always-thumb-electron.mjs).
 *
 * POSITIVE CONTROLS: with the frame grab off, the black-thumbnail Medal clip
 * has no REAL picture (only the designed one); with the designed picture off
 * as well, it has NO picture and the invariant check fails it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { unfurlLink } from './unfurl';
import type { FetchDeps, RequestFn } from '../media-embed/pinned-fetch';

const BLACK_MEDAL_THUMB = fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', 'medal-thumb-black.avif'));

// The renderer's re-encode, stood in: every picture decodes fine, except that
// the black Medal thumbnail is flat (its stats as measured in real Electron).
vi.mock('../../src/utils/linkEmbeds/thumb', async (orig) => {
    const real = await orig<typeof import('../../src/utils/linkEmbeds/thumb')>();
    const { Blob } = await import('node:buffer');
    return {
        ...real,
        reencodeThumb: vi.fn(async (bytes: Uint8Array) => {
            const black = Buffer.from(bytes).equals(BLACK_MEDAL_THUMB);
            const blob = new Blob([new Uint8Array(black ? 1414 : 20_000).fill(7)]) as unknown as globalThis.Blob;
            return { blob, mime: 'image/webp' as const, width: 920, height: 518, ...(black ? { flat: true as const } : {}) };
        }),
    };
});

import { completePicture, finalizeEmbeds, prepareLinkEmbed, type PictureDeps, type PrepareDeps, type PreparedEmbed } from '../../src/utils/linkEmbeds/prepare';
import { sanitizeLinkEmbeds, type LinkEmbed } from '@cipherline/shared';
import { embedUrlsOf } from '../../src/utils/formatting/plainText';
import { Blob as NodeBlob } from 'node:buffer';

const fx = (...p: string[]) => fs.readFileSync(path.join(__dirname, '__fixtures__', ...p), 'utf8');
const clipFx = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'media-embed', '__fixtures__', name), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: http.Server;
let port = 0;
const hits: { host: string; path: string }[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const host = String(req.headers['x-test-host'] ?? '');
        const u = new URL(req.url!, 'http://x');
        hits.push({ host, path: u.pathname + u.search });
        const html = (body: string, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
        const json = (body: string) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); };
        const img = (body: Buffer = PNG, type = 'image/png') => { res.writeHead(200, { 'content-type': type }); res.end(body); };
        // Medal: the saved clip page. Its og:image (cdn.medal.tv content-thumbnail) is the REAL black one.
        if (host === 'medal.tv' && u.pathname.includes('/downclip')) return html('<h1>Server error</h1>', 503);
        if (host === 'medal.tv' && u.pathname.includes('/goodclip')) {
            return html(clipFx('medal-clip.html').replace(/https:\/\/cdn\.medal\.tv\/ugcc\/content-thumbnail\/[^"]+/g, 'https://cdn.medal.tv/ugcc/content-thumbnail/good-0.jpg'));
        }
        if (host === 'medal.tv') return html(clipFx('medal-clip.html'));
        if (host === 'cdn.medal.tv' && u.pathname.includes('/content-thumbnail/good')) return img(PNG, 'image/jpeg');
        if (host === 'cdn.medal.tv' && u.pathname.includes('/content-thumbnail/')) return img(BLACK_MEDAL_THUMB, 'image/avif');
        if (host === 'tenor.com') return html(fx('live', 'tenor-gif.html'));
        if (host === 'www.youtube.com' && u.pathname === '/oembed') return json(fx('youtube-oembed.json'));
        if (host === 'clips.twitch.tv') return html(fx('providers', 'twitch-clip.html'));
        // A short link TikTok will not describe: no oEmbed.
        if (host === 'www.tiktok.com' && u.pathname === '/oembed' && (u.searchParams.get('url') ?? '').includes('vm.tiktok.com')) { res.writeHead(404); res.end(); return; }
        if (host === 'www.tiktok.com' && u.pathname === '/oembed') return json(fx('providers', 'tiktok-oembed.json'));
        // The live oEmbed has no cover: the cover comes from the video's page (saved live).
        if (host === 'www.tiktok.com' && u.pathname === '/@scout2015/video/6718335390845095173') return html(fx('providers', 'tiktok-page.html'));
        if (host === 'cdn.syndication.twimg.com') return json(fx('providers', 'x-video.json'));
        if (host === 'publish.x.com') return json(fx('providers', 'x-oembed.json'));
        if (host === 'www.reddit.com' && u.pathname === '/oembed') return json(fx('providers', 'reddit-oembed.json'));
        if (host === 'www.reddit.com' && u.pathname.endsWith('/.json')) return json(fx('providers', 'reddit-post-video.json'));
        if (host === 'news.example' && u.pathname === '/article') return html(fx('ars-article.html').replace(/https:\/\/cdn\.arstechnica\.net\/[^"]+\.jpg/g, 'https://img.example/hero.png'));
        if (host === 'pages.example' && u.pathname === '/nothing') return html('<html><head><title>Plain page</title></head><body>text</body></html>');
        if (host === 'pages.example' && u.pathname === '/nothing-login') return html('<html><head><title>Plain page 2</title></head><body>text</body></html>');
        if (host === 'walled.example') return html(fx('live', 'stackoverflow-challenge.html'), 403);
        // A direct video file (2026-11-24: probed by its bytes): a real 20 s mp4 with sound (a video, not a GIF loop).
        if (host === 'cdn.example' && u.pathname.endsWith('.mp4')) { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(fs.readFileSync(path.join(__dirname, '__fixtures__', 'media', 'discord-cdn-mp4-audio.bin'))); return; }
        // Any picture a page names (avatars, posters, covers, favicons): a PNG.
        if (/image\//.test(String(req.headers.accept ?? '')) || /\.(png|jpe?g|webp|ico)$/i.test(u.pathname)) return img();
        res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

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
                if (host.endsWith('.invalid')) throw new Error('getaddrinfo ENOTFOUND');
                return { ip: '93.184.215.14', family: 4, hostname: host };
            },
        },
    };
}

/** The bridge the renderer calls (what main's embed:unfurl returns). */
const unfurl = (url: string) => unfurlLink(url, deps()) as ReturnType<NonNullable<NonNullable<Window['electronAPI']>['unfurlLink']>>;

const blob = (n: number) => new NodeBlob([new Uint8Array(n).fill(3)]) as unknown as Blob;
const designedStandIn: PrepareDeps['designed'] = async () => ({ blob: blob(5_000), mime: 'image/webp', width: 640, height: 360, designed: true });
const grabbed: string[] = [];
const frameStandIn: PictureDeps = {
    register: async (pageUrl, mediaUrl) => { grabbed.push(`${pageUrl} ${mediaUrl}`); return { ok: true, src: `clmedia://media/${'a'.repeat(32)}` }; },
    grab: async () => ({ thumb: { blob: blob(30_000), mime: 'image/webp', width: 920, height: 518 }, width: 1280, height: 720, durationS: 24.15, atS: 1, samples: 2 }),
    snap: async () => ({ ok: true, bytes: new Uint8Array(PNG), mime: 'image/png', width: 1200, height: 675, ms: 900 }),
};
const upload = async () => ({ attachment_id: '11111111-2222-4333-8444-555555555555', file_key_b64: `${'A'.repeat(43)}=`, file_nonce_b64: 'B'.repeat(16), byte_size: 30_000 });

type Source = 'provider' | 'frame' | 'snapshot' | 'designed' | 'none';

/** The whole sender chain for one link → what the reader gets, and where its picture came from. */
async function send(url: string, picture: PictureDeps = frameStandIn, prep: PrepareDeps = { designed: designedStandIn }): Promise<{ embed?: LinkEmbed; source: Source; prepared: PreparedEmbed | null }> {
    let p = await prepareLinkEmbed(url, unfurl, prep);
    if (p?.snapshot === 'pending') p = await completePicture(p, `tok${Math.random().toString(36).slice(2, 10)}`, picture);
    if (!p) return { source: 'none', prepared: null };
    const text = `look ${url}`;
    const [embed] = await finalizeEmbeds(text, [p], upload, 2000);
    const source: Source = !embed?.thumb && !(embed?.kind === 'post' && !embed.media && (embed.images?.length || embed.author_icon)) ? 'none'
        : embed.thumb?.designed ? 'designed'
            : p.snapshotResult === 'frame' ? 'frame' : p.snapshotResult === 'ok' ? 'snapshot' : 'provider';
    return { embed, source, prepared: p };
}

/** The invariant itself: the reader accepts the embed and it has a picture for its kind. */
function hasPicture(text: string, embed: LinkEmbed | undefined): boolean {
    if (!embed) return false;
    const [ok] = sanitizeLinkEmbeds([embed], embedUrlsOf(text));
    if (!ok) return false;
    if (ok.kind === 'post' && !ok.media) return !!(ok.images?.length || ok.author_icon || ok.thumb);
    return !!ok.thumb;
}

const CORPUS: [string, Source][] = [
    // Medal, the owner's bug: the og:image is the clip's black first frame → a grabbed frame.
    ['https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', 'frame'],
    ['https://medal.tv/clips/nYiYMMGqugp5N9XWt', 'frame'],
    ['https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt/d1337abc?invite=cr-MSxsdkEsMjM0NTY3LA', 'frame'],
    ['https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt?mobilebypass=true', 'frame'],
    // A Medal clip whose thumbnail is fine keeps it (no grab).
    ['https://medal.tv/games/valorant/clips/goodclip123', 'provider'],
    // Medal's page down: still a clip card, with the designed picture.
    ['https://medal.tv/games/valorant/clips/downclip123', 'designed'],
    // A direct video file and a GIF loop: a frame of the file itself.
    ['https://cdn.example/clips/match-point.mp4', 'frame'],
    ['https://giphy.com/gifs/cat-JIX9t2j0ZTN9S', 'frame'],
    ['https://i.imgur.com/A61SaA1.gifv', 'frame'],
    // Providers with their own picture.
    ['https://tenor.com/view/morning-morning-coffee-coffee-gif-12345678', 'provider'],
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'provider'],
    ['https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR', 'provider'],
    ['https://www.tiktok.com/@scout2015/video/6718335390845095173', 'provider'],
    // A TikTok whose page does not answer: no cover anywhere → a snapshot of its page.
    ['https://www.tiktok.com/@someone/video/7000000000000000001', 'snapshot'],
    // A TikTok short link that never resolves (was "no embed" on .277): its page's card, designed picture.
    ['https://vm.tiktok.com/ZMabcdEF/', 'designed'],
    ['https://x.com/elonmusk/status/1585341984679469056', 'provider'],
    ['https://www.reddit.com/r/aww/comments/90bu6w/heat_index/', 'provider'],
    ['https://news.example/article', 'provider'],
    // A real page with no picture: its snapshot.
    ['https://pages.example/nothing', 'snapshot'],
    // A wall, and a host that does not resolve: the designed picture.
    ['https://walled.example/q', 'designed'],
    ['https://unreachable.invalid/page', 'designed'],
];

describe('always a thumbnail: every embed the sender builds has a picture', () => {
    for (const [url, expected] of CORPUS) {
        it(`${url} → ${expected}`, async () => {
            const { embed, source } = await send(url);
            expect(hasPicture(`look ${url}`, embed), JSON.stringify(embed)).toBe(true);
            expect(source).toBe(expected);
        });
    }

    it('the Medal frame records the video\'s real size and length in `media` (for sizing the card)', async () => {
        const { embed } = await send('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt');
        expect(embed?.media).toMatchObject({ width: 1280, height: 720, duration_s: 24.15 });
        expect(embed?.media?.url).toMatch(/^https:\/\/cdn\.medal\.tv\//);
    });

    it('the grab asks main for the file the UNFURLER found (the clip page + its cdn.medal.tv file; a direct link names itself)', async () => {
        grabbed.length = 0;
        await send('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt');
        await send('https://cdn.example/clips/match-point.mp4');
        expect(grabbed[0]).toMatch(/^https:\/\/medal\.tv\/games\/valorant\/clips\/nYiYMMGqugp5N9XWt https:\/\/cdn\.medal\.tv\/mediac\//);
        expect(grabbed[1]).toBe('https://cdn.example/clips/match-point.mp4 https://cdn.example/clips/match-point.mp4');
    });

    it('a picture that is not flat is never replaced (no grab, no snapshot)', async () => {
        grabbed.length = 0;
        const p = await prepareLinkEmbed('https://medal.tv/games/valorant/clips/goodclip123', unfurl, { designed: designedStandIn });
        expect(p?.snapshot).toBeUndefined();
        expect(p?.thumb?.designed).toBeUndefined();
        expect(grabbed).toEqual([]);
    });

    it('when the frame grab fails, a provider page falls to its snapshot, a file to the designed picture', async () => {
        const noFrame: PictureDeps = { ...frameStandIn, grab: async () => null };
        expect((await send('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', noFrame)).source).toBe('snapshot');
        expect((await send('https://cdn.example/clips/match-point.mp4', noFrame)).source).toBe('designed');
    });

    it('a snapshot refused (a login page, a wall) keeps the designed picture', async () => {
        const refused: PictureDeps = { ...frameStandIn, snap: async () => ({ ok: false, reason: 'login' }) };
        const r = await send('https://pages.example/nothing-login', refused);
        expect(r.source).toBe('designed');
        expect(hasPicture('look https://pages.example/nothing-login', r.embed)).toBe(true);
    });

    it('POSITIVE CONTROL: frame grab off → the black Medal clip has no REAL picture; designed off too → no picture at all (the check fails it)', async () => {
        const off: PictureDeps = { register: async () => ({ ok: false }), snap: async () => ({ ok: false, reason: 'failed' }) };
        const a = await send('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', off);
        expect(a.source).toBe('designed');
        expect(a.embed?.thumb?.designed).toBe(true);
        const b = await send('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', off, { designed: async () => null });
        expect(b.source).toBe('none');
        expect(hasPicture('look https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', b.embed)).toBe(false);
    });

    it('POSITIVE CONTROL: without the flat-picture rule the black Medal thumbnail would have been sent as the picture', async () => {
        // The bytes main hands over for this clip ARE the black frame (what staging .277 sent).
        const r = await unfurl('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt');
        expect(r.ok && Buffer.from(r.image!.bytes).equals(BLACK_MEDAL_THUMB)).toBe(true);
    });
});
