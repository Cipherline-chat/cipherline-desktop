/**
 * The phase-4 adapters end to end through unfurlLink, against a local server
 * that serves the live-saved fixtures under each provider's real host name
 * (an injected request function routes every https request there, as in
 * unfurl.test.ts). Checks the draft each provider produces, which hosts were
 * contacted (and that nothing else was), and the fail-soft paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { unfurlLink } from './unfurl';
import type { FetchDeps, RequestFn } from '../media-embed/pinned-fetch';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'providers', n), 'utf8');
const liveFx = (n: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', n), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: http.Server;
let port = 0;
const hits: { host: string; path: string; headers: http.IncomingHttpHeaders }[] = [];
/** Per-test switches. */
const mode = { twitchShellFirst: 0, syndicationDown: false, redditJsonBlocked: true, tiktokOEmbedFull: false, oldRedditJson: false };

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const host = String(req.headers['x-test-host'] ?? '');
        const u = new URL(req.url!, 'http://x');
        hits.push({ host, path: u.pathname + u.search, headers: req.headers });
        const send = (type: string, body: string | Buffer, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
        const img = () => send('image/jpeg', PNG);
        if (host === 'clips.twitch.tv') {
            if (mode.twitchShellFirst > 0) { mode.twitchShellFirst--; return send('text/html', fx('twitch-generic-shell.html')); }
            return send('text/html', fx('twitch-clip.html'));
        }
        if (host === 'www.twitch.tv' && u.pathname === '/shroud') return send('text/html', fx('twitch-channel.html'));
        if (host === 'www.twitch.tv' && u.pathname.startsWith('/videos/')) return send('text/html', fx('twitch-vod.html'));
        if (host === 'static-cdn.jtvnw.net') return img();
        if (host === 'cdn.syndication.twimg.com') {
            if (mode.syndicationDown) return send('text/html', '<!DOCTYPE html><title>X / ?</title>', 404);
            const id = u.searchParams.get('id');
            const file = id === '1585341984679469056' ? 'x-video.json' : id === '463440424141459456' ? 'x-photo.json' : id === '983280288238317568' ? 'x-tombstone.json' : null;
            return file ? send('application/json', fx(file)) : send('text/html', '<!DOCTYPE html>', 404);
        }
        if (host === 'publish.x.com') {
            if (u.searchParams.get('url')?.includes('/status/20')) return send('application/json', fx('x-oembed.json'));
            return send('application/json', '{}', 404);
        }
        if (host === 'pbs.twimg.com') return img();
        if (host === 'www.tiktok.com' && u.pathname === '/oembed') {
            if (mode.tiktokOEmbedFull) return send('application/json', JSON.stringify({ ...JSON.parse(fx('tiktok-oembed.json')), title: 'From oEmbed', author_name: 'Scout', author_url: 'https://www.tiktok.com/@scout2015', thumbnail_url: 'https://p16-sign.tiktokcdn-us.com/cover.jpeg' }));
            return send('application/json', fx('tiktok-oembed.json'));
        }
        if (host === 'www.tiktok.com' && u.pathname.startsWith('/@scout2015/video/')) return send('text/html', fx('tiktok-page.html'));
        if (host === 'vm.tiktok.com') { res.writeHead(301, { location: 'https://www.tiktok.com/@scout2015/video/6718335390845095173?_r=1' }); res.end(); return; }
        if (/tiktokcdn(-us)?\.com$/.test(host)) return img();
        if (host === 'www.reddit.com' && u.pathname === '/oembed') return send('application/json', fx('reddit-oembed.json'));
        if (host === 'www.reddit.com' && u.pathname.startsWith('/comments/')) {
            if (mode.redditJsonBlocked) return send('text/html', "You've been blocked by network security.", 403);
            return send('application/json', fx('reddit-post-video.json'));
        }
        // old.reddit.com answers the post .json to the link-preview UA (live 2026-11-23).
        if (host === 'old.reddit.com' && u.pathname.startsWith('/comments/')) {
            if (mode.oldRedditJson && req.headers['user-agent'] === 'WhatsApp/2') return send('application/json', liveFx('reddit-live-image.json'));
            return send('text/html', "You've been blocked by network security.", 403);
        }
        // The post PAGE: the real head (og:image = share.redd.it) to the preview UA, the block page to the browser UA.
        if (host === 'www.reddit.com' && u.pathname.startsWith('/r/')) {
            return req.headers['user-agent'] === 'WhatsApp/2' ? send('text/html', liveFx('reddit-post-page.html')) : send('text/html', liveFx('reddit-post-page-blocked.html'));
        }
        if (host.endsWith('redd.it')) return img();
        send('text/plain', 'not routed', 500);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function deps(): { fetchDeps: FetchDeps; sleep: (ms: number) => Promise<void> } {
    const request: RequestFn = (url, opts, cb) => {
        const u = new URL(url);
        return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: { ...opts.headers, 'x-test-host': u.hostname } }, cb);
    };
    return {
        sleep: async () => {},
        fetchDeps: { request, resolve: async (url: string) => ({ ip: '93.184.215.14', family: 4, hostname: new URL(url).hostname }) },
    };
}
const run = async (url: string) => { hits.length = 0; return unfurlLink(url, deps()); };
const hostsHit = () => [...new Set(hits.map((h) => h.host))].sort();

describe('Twitch', () => {
    it('a clip: player id from the link, title / channel / game, the frame picture; read from clips.twitch.tv', async () => {
        const r = await run('https://www.twitch.tv/shroud/clip/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'player', site: 'Twitch', title: 'smol shroud', author: 'shroud', tag: 'World of Warcraft',
            player: { provider: 'twitch', id: 'clip:DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR' } });
        expect(r.image).toBeDefined();
        expect(hostsHit()).toEqual(['clips.twitch.tv', 'static-cdn.jtvnw.net']);
        for (const h of hits) { expect(h.headers.cookie).toBeUndefined(); expect(h.headers.referer).toBeUndefined(); }
    });
    it('the generic shell first: one retry gets the real page', async () => {
        mode.twitchShellFirst = 1;
        const r = await run('https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR');
        expect(r.ok && r.embed.title).toBe('smol shroud');
        expect(hits.filter((h) => h.host === 'clips.twitch.tv')).toHaveLength(2);
    });
    it('the shell every time (adapter twice, page fallback twice): still a playable card from the link, and the shell\'s Twitch-logo picture is NOT used', async () => {
        mode.twitchShellFirst = 4;
        const r = await run('https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR');
        expect(r.ok).toBe(true);
        if (r.ok) { expect(r.embed).toMatchObject({ kind: 'player', title: 'Twitch clip', tag: 'Clip' }); expect(r.image).toBeUndefined(); }
        expect(hits.filter((h) => h.host === 'clips.twitch.tv')).toHaveLength(4);
        expect(hits.some((h) => h.host === 'static-cdn.jtvnw.net')).toBe(false);
    });
    it('the shell twice, then the real page: the shared page fallback adds the clip\'s picture', async () => {
        mode.twitchShellFirst = 2;
        const r = await run('https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR');
        expect(r.ok && r.image).toBeDefined();
        mode.twitchShellFirst = 0;
    });
    it('a channel: its picture is the author\'s icon, the description kept', async () => {
        const r = await run('https://www.twitch.tv/shroud');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'player', title: 'shroud on Twitch', tag: 'Channel', player: { provider: 'twitch', id: 'channel:shroud' } });
        expect(r.embed.description).toMatch(/streams live on Twitch/);
        expect(r.icon).toBeDefined();
        expect(r.image).toBeUndefined();
    });
});

describe('X / Twitter', () => {
    it('a video tweet: a post with author, handle, text, time, the mp4, poster and avatar', async () => {
        const r = await run('https://x.com/elonmusk/status/1585341984679469056');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({
            kind: 'post', site: 'X', author: 'Elon Musk', author_handle: '@elonmusk', description: 'Entering Twitter HQ – let that sink in!',
            published_at: '2022-10-26T18:45:58Z',
            media: { url: expect.stringMatching(/^https:\/\/video\.twimg\.com\//), mime: 'video/mp4', width: 1920, height: 1080, duration_s: 9.3 },
        });
        expect(r.image).toBeDefined();
        expect(r.icon).toBeDefined();
        expect(hostsHit()).toEqual(['cdn.syndication.twimg.com', 'pbs.twimg.com']);
        // The x.com page itself is never fetched.
        expect(hits.some((h) => h.host === 'x.com')).toBe(false);
    });
    it('a photo tweet: the photo among the post\'s pictures', async () => {
        const r = await run('https://twitter.com/Interior/status/463440424141459456');
        expect(r.ok && r.images?.length).toBe(1);
    });
    it('syndication down: the oEmbed words (fail soft); a deleted tweet: no embed', async () => {
        mode.syndicationDown = true;
        try {
            const r = await run('https://x.com/jack/status/20');
            expect(r.ok && r.embed).toMatchObject({ kind: 'post', author: 'jack', author_handle: '@jack', description: 'just setting up my twttr' });
            // A deleted tweet: no post, but still the link's card (the minimal one: x.com gives nothing here).
            const gone = await run('https://x.com/someone/status/983280288238317568');
            expect(gone).toEqual({ ok: true, embed: { url: 'https://x.com/someone/status/983280288238317568', kind: 'card', site: 'x.com' } });
        } finally { mode.syndicationDown = false; }
        const gone = await run('https://x.com/someone/status/983280288238317568');
        expect(gone.ok && gone.embed.kind).toBe('card');
    });
});

describe('TikTok', () => {
    it('bare oEmbed (as live today): the page fills title, author, cover, avatar', async () => {
        const r = await run('https://www.tiktok.com/@scout2015/video/6718335390845095173');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'player', site: 'TikTok', author: 'Scout, Suki & Stella', author_handle: '@scout2015',
            title: 'Scramble up ur name & I’ll try to guess it😍❤️', player: { provider: 'tiktok', id: '6718335390845095173' } });
        expect(r.image).toBeDefined();
        expect(r.icon).toBeDefined();
    });
    it('a full oEmbed: no page fetch', async () => {
        mode.tiktokOEmbedFull = true;
        try {
            const r = await run('https://www.tiktok.com/@scout2015/video/6718335390845095173');
            expect(r.ok && r.embed.title).toBe('From oEmbed');
            expect(hits.some((h) => h.path.startsWith('/@scout2015'))).toBe(false);
        } finally { mode.tiktokOEmbedFull = false; }
    });
    it('a short link: the id comes from where it redirects', async () => {
        const r = await run('https://vm.tiktok.com/ZMabcdEF/');
        expect(r.ok && r.embed.player).toEqual({ provider: 'tiktok', id: '6718335390845095173' });
    });
});

describe('Reddit', () => {
    it('every .json blocked: the oEmbed words + the post PAGE\'s picture (share.redd.it, read with the preview UA), never a text-only card', async () => {
        mode.redditJsonBlocked = true;
        const r = await run('https://www.reddit.com/r/aww/comments/90bu6w/heat_index/');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.embed).toMatchObject({ kind: 'post', site: 'Reddit', author: 'r/aww', author_handle: 'u/FootLoosePickleJuice' });
        expect(r.embed.title).toMatch(/^Heat index/);
        expect(r.embed.media).toBeUndefined();
        expect(r.images?.length).toBe(1);
        const share = hits.find((h) => h.host === 'share.redd.it');
        expect(share?.path).toBe('/preview/post/1y332n4');             // the fixture page's og:image
        expect(share?.headers['user-agent']).toBe('WhatsApp/2');       // same UA as the page read (Reddit draws the post only for it)
        // The post's words are the post's: the page's summary does not become them.
        expect(r.embed.description).toBeUndefined();
    });
    it('www .json blocked, old.reddit .json answers the preview UA: the full post (picture, score, comments)', async () => {
        mode.redditJsonBlocked = true;
        mode.oldRedditJson = true;
        try {
            const r = await run('https://www.reddit.com/r/aww/comments/1y332n4/my_new_cat_discovered_the_christmas_tree/');
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            expect(r.embed).toMatchObject({ kind: 'post', title: 'My new cat discovered the Christmas Tree', author: 'r/aww', author_handle: 'u/cubsfan1384', comments: 64 });
            expect(r.images?.length).toBe(1);
            expect(hits.find((h) => h.host === 'old.reddit.com')?.headers['user-agent']).toBe('WhatsApp/2');
            // A picture already: the page is not read again.
            expect(hits.some((h) => h.host === 'www.reddit.com' && h.path.startsWith('/r/'))).toBe(false);
        } finally { mode.oldRedditJson = false; }
    });
    it('.json reachable: score, comments, the video (no sound) and its poster', async () => {
        mode.redditJsonBlocked = false;
        try {
            const r = await run('https://redd.it/90bu6w');
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            expect(r.embed).toMatchObject({ score: 151032, comments: 1906, media: { url: 'https://v.redd.it/zv89llsvexb11/DASH_720.mp4?source=fallback', no_audio: true, width: 406, height: 720 } });
            expect(r.image).toBeDefined();
            expect(r.images).toBeUndefined();
        } finally { mode.redditJsonBlocked = true; }
    });
});
