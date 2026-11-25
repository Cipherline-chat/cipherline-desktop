/**
 * "Just works for everything" (2026-11-24, embeds-media-everywhere) as an
 * INVARIANT over a corpus of real hosts saved LIVE (__fixtures__/media/
 * corpus.json: every hop's status + headers, the body whole when small, else
 * its first 16-64 KB; KLIPY media: headers + 64 magic bytes only):
 *
 *   every link, through the REAL unfurler (main: unfurl.ts + media-probe.ts +
 *   media-sniff.ts, replayed by a local server) and the REAL sender chain
 *   (prepare.ts prepareLinkEmbed → completePicture → finalizeEmbeds, with the
 *   REAL copy handler of unfurl/ipc.ts behind it) ends as an embed the reader
 *   accepts (packages/shared sanitizeLinkEmbeds) that is either media (an
 *   image / GIF / video with its real size) or a visible link card. Never
 *   nothing.
 *
 * Plus per-link expectations: the Discord CDN GIF (a real one, with the signed
 * `ex/is/hm` params of an attachment link) is copied and attached; the expired
 * Discord attachment (Discord's real 404) is the minimal card; KLIPY's page is
 * KLIPY's GIF with NO request to KLIPY's media hosts and no copy; extensionless
 * images are images; i.imgur.com/<id> that redirects to an HTML page is a card.
 *
 * Stand-ins (Node has no decoders): the WebP re-encode, the frame grab, the
 * designed picture. POSITIVE CONTROLS at the end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Blob as NodeBlob } from 'node:buffer';

vi.mock('../../src/utils/linkEmbeds/thumb', async (orig) => {
    const real = await orig<typeof import('../../src/utils/linkEmbeds/thumb')>();
    const { Blob } = await import('node:buffer');
    return {
        ...real,
        reencodeThumb: vi.fn(async (bytes: Uint8Array) => (bytes.byteLength < 8 ? null : { blob: new Blob([new Uint8Array(20_000).fill(7)]) as unknown as globalThis.Blob, mime: 'image/webp' as const, width: 320, height: 240 })),
    };
});

import { unfurlLink, COPY_MAX_BYTES } from './unfurl';
import { createCopyGate, createMediaCopyHandler } from './ipc';
import type { FetchDeps, RequestFn } from '../media-embed/pinned-fetch';
import { completePicture, finalizeEmbeds, prepareLinkEmbed, type PictureDeps, type PreparedEmbed } from '../../src/utils/linkEmbeds/prepare';
import { LINK_EMBED_MEDIA_COPY_MAX_BYTES, sanitizeLinkEmbeds, type LinkEmbed } from '@cipherline/shared';
import { embedUrlsOf } from '../../src/utils/formatting/plainText';

(globalThis as unknown as { Blob: unknown }).Blob ??= NodeBlob;

const dir = path.join(__dirname, '__fixtures__', 'media');
interface Hop { url: string; status: number; headers: Record<string, string>; body?: string; total?: number; whole?: boolean }
interface Entry { id: string; url: string; note: string; constructed?: boolean; hops: Hop[] }
const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8')) as { entries: Entry[] };
const byUrl = new Map<string, Hop>();
for (const e of corpus.entries) for (const h of e.hops) byUrl.set(h.url, h);
// Pages saved by earlier rounds (reused, not refetched): Tenor's GIF page.
const tenorPage = fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', 'tenor-gif.html'), 'utf8');

let server: http.Server;
let port = 0;
const hits: { host: string; path: string; range?: string }[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const host = String(req.headers['x-test-host'] ?? '');
        const u = new URL(req.url!, 'http://x');
        const full = `https://${host}${u.pathname}${u.search}`;
        hits.push({ host, path: u.pathname + u.search, range: req.headers.range });
        if (host === 'tenor.com') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(tenorPage); return; }
        const hop = byUrl.get(full);
        if (!hop) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not in corpus'); return; }
        const headers: Record<string, string> = {};
        for (const k of ['content-type', 'location', 'accept-ranges', 'cache-control']) if (hop.headers[k]) headers[k] = hop.headers[k];
        if (!hop.body) { res.writeHead(hop.status, headers); res.end(); return; }
        const body = fs.readFileSync(path.join(dir, hop.body));
        const total = hop.whole ? body.length : (hop.total ?? body.length);
        const range = /^bytes=0-(\d+)$/.exec(String(req.headers.range ?? ''));
        // A server that ignored Range in real life (Tenor's media) ignores it here too.
        const honoursRange = hop.status === 206 || hop.headers['accept-ranges'] === 'bytes' || !!hop.headers['content-range'];
        if (range && honoursRange && hop.status < 300) {
            const end = Math.min(Number(range[1]), body.length - 1);
            res.writeHead(206, { ...headers, 'content-range': `bytes 0-${end}/${total}`, 'content-length': String(end + 1) });
            res.end(body.subarray(0, end + 1));
            return;
        }
        // Whole-file answers: the stored body (a truncated head is served as what we have).
        res.writeHead(hop.status === 206 ? 200 : hop.status, { ...headers, 'content-length': String(body.length) });
        res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetchDeps = (): FetchDeps => ({
    request: ((url, opts, cb) => {
        const u = new URL(url);
        return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: opts.method, headers: { ...opts.headers, 'x-test-host': u.hostname } }, cb);
    }) as RequestFn,
    resolve: async (url: string) => ({ ip: '93.184.215.14', family: 4, hostname: new URL(url).hostname }),
});

/** The bridge pair the renderer calls: embed:unfurl and embed:media-copy, wired like registerUnfurlIpc. */
function bridge() {
    const gate = createCopyGate();
    const copy = createMediaCopyHandler(gate, { fetchDeps: fetchDeps() });
    const unfurl = async (url: string) => {
        const r = await unfurlLink(url, { fetchDeps: fetchDeps() });
        if (r.ok && r.copy) gate.mark(url, r.copy);
        return r;
    };
    return { unfurl: unfurl as never, copy: copy as NonNullable<PictureDeps['copy']> };
}

const blob = (n: number) => new NodeBlob([new Uint8Array(n).fill(3)]) as unknown as Blob;
const picture: PictureDeps = {
    register: async () => ({ ok: true, src: `clmedia://media/${'a'.repeat(32)}` }),
    grab: async () => ({ thumb: { blob: blob(30_000), mime: 'image/webp', width: 320, height: 240 }, width: 320, height: 240, durationS: 2, atS: 1, samples: 1 }),
    snap: async () => ({ ok: false, reason: 'blank' }),
};
let uploads = 0;
const upload = async (b: Blob) => { uploads++; return { attachment_id: `11111111-2222-4333-8444-${String(uploads).padStart(12, '0')}`, file_key_b64: `${'A'.repeat(43)}=`, file_nonce_b64: 'B'.repeat(16), byte_size: b.size }; };
const designed = async () => ({ blob: blob(5_000), mime: 'image/webp' as const, width: 640, height: 360, designed: true as const });

/** The whole sender chain for one link → what the reader draws. */
async function send(url: string, b = bridge()): Promise<{ embed?: LinkEmbed; prepared: PreparedEmbed | null }> {
    let p = await prepareLinkEmbed(url, b.unfurl, { designed });
    if (p?.snapshot === 'pending') p = await completePicture(p, `tok${Math.random().toString(36).slice(2, 10)}`, { ...picture, copy: b.copy });
    if (!p) return { prepared: null };
    const text = `look ${url}`;
    const [embed] = sanitizeLinkEmbeds(await finalizeEmbeds(text, [p], upload, 30_000), embedUrlsOf(text));
    return { embed, prepared: p };
}

/** The invariant: media with a real size, or a visible card. Never nothing. */
function renderable(e: LinkEmbed | undefined): string | null {
    if (!e) return 'nothing';
    if (e.kind === 'card') return e.site || e.title ? null : 'a card with nothing to show';
    if (e.kind === 'image' || e.kind === 'video') return e.media ? null : `${e.kind} without media`;
    if (e.kind === 'player' || e.kind === 'post') return null;
    return `unknown kind ${e.kind}`;
}

const links = corpus.entries.filter((e) => !e.id.startsWith('klipy-gif') && !e.id.startsWith('klipy-mp4'));
const PAGE_LINKS = [
    'https://tenor.com/view/morning-morning-coffee-morning-cat-coffee-cat-bad-hair-cat-gif-3162456205570563299',
    'https://giphy.com/gifs/cat-JIX9t2j0ZTN9S',
    'https://i.imgur.com/A61SaA1.gifv',
];

describe('media everywhere: every link in the live corpus is media or a visible card, never nothing', () => {
    it.each(links.map((e) => [e.id, e.url] as const))('%s', async (_id, url) => {
        const { embed } = await send(url);
        expect(renderable(embed), JSON.stringify(embed)).toBeNull();
    });

    it.each(PAGE_LINKS)('page link %s', async (url) => {
        const { embed } = await send(url);
        expect(renderable(embed), JSON.stringify(embed)).toBeNull();
    });
});

describe('media everywhere: what each link becomes', () => {
    const url = (id: string) => corpus.entries.find((e) => e.id === id)!.url;

    it('Discord CDN GIF (signed ex/is/hm): a GIF at its real size, the sender attaches a COPY (media.file), readers need nothing from Discord', async () => {
        uploads = 0;
        const { embed, prepared } = await send(url('discord-cdn-gif'));
        expect(prepared?.copyResult).toBe('ok');
        expect(embed).toMatchObject({ kind: 'image', media: { mime: 'image/gif', width: 128, height: 128, animated: true } });
        expect(embed!.media!.file).toMatchObject({ byte_size: 95920 });
        expect(embed!.thumb).toBeTruthy();
    });

    it('Discord CDN PNG and mp4s (constructed from Discord\'s real headers): copied; a 2 s silent mp4 is a GIF loop, a 20 s one with sound a video', async () => {
        const png = (await send(url('discord-cdn-png'))).embed!;
        expect(png).toMatchObject({ kind: 'image', media: { mime: 'image/png', width: 256, height: 256 } });
        expect(png.media!.file).toBeTruthy();
        const loop = (await send(url('discord-cdn-mp4-loop'))).embed!;
        expect(loop).toMatchObject({ kind: 'video', media: { mime: 'video/mp4', loop: true, no_audio: true, width: 320, height: 240 } });
        expect(loop.media!.file?.byte_size).toBe(11509);
        const clip = (await send(url('discord-cdn-mp4-audio'))).embed!;
        expect(clip.kind).toBe('video');
        expect(clip.media!.loop).toBeUndefined();
        expect(clip.media!.file).toBeTruthy();
        // Index at the end: the probe cannot tell its length, the copy does (whole file).
        const tail = (await send(url('discord-cdn-mp4-tailmoov'))).embed!;
        expect(tail.kind).toBe('video');
        expect(tail.media!.file).toBeTruthy();
    });

    it('an EXPIRED Discord attachment (Discord\'s real 404): the minimal card naming the site, no copy', async () => {
        for (const id of ['discord-cdn-expired', 'discord-media-expired']) {
            const { embed } = await send(url(id));
            expect(embed).toMatchObject({ kind: 'card' });
            expect(embed!.site).toMatch(/discord/);
            expect(embed!.media).toBeUndefined();
        }
    });

    it('KLIPY page link: KLIPY\'s own GIF reference at its real size, NO request to KLIPY media hosts, no copy, no KLIPY picture', async () => {
        hits.length = 0;
        const { embed } = await send(url('klipy-page'));
        expect(embed).toMatchObject({ kind: 'image', site: 'KLIPY', media: { mime: 'image/gif', animated: true, width: 281, height: 374 } });
        expect(embed!.media!.url).toMatch(/^https:\/\/static2\.klipy\.com\/.+\.gif$/);
        expect(embed!.media!.file).toBeUndefined();
        expect(embed!.thumb?.designed ?? true).toBe(true); // only our own designed picture, never KLIPY's
        expect(hits.filter((h) => /klipy\.com$/.test(h.host) && h.host !== 'klipy.com')).toEqual([]);
    });

    it('a pasted KLIPY media URL is never fetched by the sender (readers follow KLIPY\'s opt-in)', async () => {
        hits.length = 0;
        expect(await unfurlLink(url('klipy-gif'), { fetchDeps: fetchDeps() })).toEqual({ ok: false, reason: 'local' });
        expect(hits).toEqual([]);
    });

    it('known GIF hosts and direct media on arbitrary hosts: by their bytes, at their real size, no copy (links that do not expire)', async () => {
        expect((await send(url('giphy-media'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/gif', animated: true, width: 480, height: 480 } });
        // Tenor ignores Range and streams 9.5 MB: the probe stops at its cap.
        expect((await send(url('tenor-media-gif'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/gif', animated: true, width: 298, height: 498 } });
        expect((await send(url('wikimedia-gif'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/gif', width: 400, height: 400 } });
        expect((await send(url('animated-webp'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/webp', animated: true, width: 400, height: 400 } });
        expect((await send(url('reddit-i'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/jpeg', width: 3000, height: 4000 } });
        expect((await send(url('mdn-mp4'))).embed).toMatchObject({ kind: 'video', media: { mime: 'video/mp4' } });
        for (const id of ['giphy-media', 'tenor-media-gif', 'wikimedia-gif', 'animated-webp', 'mdn-mp4']) expect((await send(url(id))).embed!.media!.file).toBeUndefined();
    });

    it('extensionless images are images (Gravatar; picsum through its redirect to a signed .jpg)', async () => {
        expect((await send(url('gravatar-extensionless'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/png', width: 128, height: 128 } });
        expect((await send(url('picsum-extensionless'))).embed).toMatchObject({ kind: 'image', media: { mime: 'image/jpeg', width: 400, height: 300 } });
    });

    it('i.imgur.com/<id> that answers with an HTML page is a page card (the old URL rule called it an image)', async () => {
        const { embed } = await send(url('imgur-direct-extensionless'));
        expect(embed?.kind).toBe('card');
    });

    it('a broken media link (404 HTML) is the minimal card', async () => {
        const { embed } = await send(url('wikimedia-404'));
        expect(embed).toMatchObject({ kind: 'card', site: 'mathiasbynens.be' });
    });

    it('the copy respects the caps: offered only within LINK_EMBED_MEDIA_COPY_MAX_BYTES, and main\'s caps equal the shared ones', async () => {
        expect(COPY_MAX_BYTES).toEqual(LINK_EMBED_MEDIA_COPY_MAX_BYTES);
        const gate = createCopyGate();
        const h = createMediaCopyHandler(gate, { fetchDeps: fetchDeps() });
        expect(await h(url('discord-cdn-gif'), 1_000_000)).toEqual({ ok: false, reason: 'not-eligible' });
        gate.mark(url('discord-cdn-gif'), { mediaUrl: url('discord-cdn-gif'), mime: 'image/gif', bytes: 95920 });
        // The renderer's limit below the file: refused before any download.
        hits.length = 0;
        expect(await h(url('discord-cdn-gif'), 50_000)).toEqual({ ok: false, reason: 'too-large' });
        expect(hits).toEqual([]);
        const ok = await h(url('discord-cdn-gif'), 1_000_000);
        expect(ok).toMatchObject({ ok: true, mime: 'image/gif', width: 128, height: 128 });
    });
});

describe('POSITIVE CONTROLS', () => {
    it('the invariant check fails "nothing" and an empty card', () => {
        expect(renderable(undefined)).toBe('nothing');
        expect(renderable({ url: 'https://a.example/', kind: 'image' } as LinkEmbed)).toBe('image without media');
    });

    it('without the copy handler, the Discord GIF goes out WITHOUT a copy (the copy really comes from the handler)', async () => {
        const b = bridge();
        let p = await prepareLinkEmbed(url0('discord-cdn-gif'), b.unfurl, { designed });
        if (p?.snapshot === 'pending') p = await completePicture(p, 'tok-control', { ...picture, copy: async () => ({ ok: false, reason: 'failed' }) });
        const text = `look ${url0('discord-cdn-gif')}`;
        const [embed] = sanitizeLinkEmbeds(await finalizeEmbeds(text, [p!], upload, 30_000), embedUrlsOf(text));
        expect(embed.kind).toBe('image');
        expect(embed.media!.file).toBeUndefined();
    });
});

function url0(id: string): string { return corpus.entries.find((e) => e.id === id)!.url; }
