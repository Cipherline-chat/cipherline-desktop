/**
 * The sender side in the renderer: which links get a preview, cleaning the
 * unfurler's draft, inline vs uploaded thumbnails, the send deadline, and the
 * thumbnail uploader (encrypted, octet-stream, key never sent).
 */
import { describe, it, expect, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { LINK_EMBED_THUMB_INLINE_MAX_BYTES, sanitizeLinkEmbeds } from '@cipherline/shared';

vi.mock('axios', () => ({ default: { post: vi.fn(async () => { throw new Error('the real axios is not used in tests'); }) } }));
const thumbMock = vi.hoisted(() => ({ next: null as null | { size: number } }));
vi.mock('./thumb', async (orig) => {
    const real = await orig<typeof import('./thumb')>();
    return {
        ...real,
        reencodeThumb: vi.fn(async () => thumbMock.next
            ? { blob: new (await import('node:buffer')).Blob([new Uint8Array(thumbMock.next.size).fill(9)]) as unknown as Blob, mime: 'image/webp', width: 640, height: 335 }
            : null),
    };
});

import { previewableUrls, prepareLinkEmbed, finalizeEmbeds, takeAndFinalize, minimalPrepared, type PreparedEmbed } from './prepare';
import { createThumbUploader } from './uploadThumb';
import { embedUrlsOf } from '../formatting/plainText';

describe('previewableUrls', () => {
    it('the reader\'s embed rules, http(s) only, at most five, de-duplicated', () => {
        // http links are listed too: they get the minimal card without any fetch (below).
        expect(previewableUrls('a https://x.example/1 http://x.example/2 ||https://x.example/3|| `https://x.example/4` <https://x.example/5> https://x.example/1 ftp://x.example/6')).toEqual(['https://x.example/1', 'http://x.example/2']);
        const many = Array.from({ length: 8 }, (_, i) => `https://x.example/${i}`).join(' ');
        expect(previewableUrls(many)).toHaveLength(5);
    });
    it('never a Cipherline invite or a KLIPY media file (KLIPY\'s rules); direct images and videos do (2026-11-24: sized / copied by their bytes)', () => {
        expect(previewableUrls('https://cipherline.chat/invite/abcDEF12 https://i.example/a.png https://v.example/b.mp4 https://ok.example/')).toEqual(['https://i.example/a.png', 'https://v.example/b.mp4', 'https://ok.example/']);
        expect(previewableUrls('https://static2.klipy.com/ii/abc/1d/1b/x.gif https://klipy.com/gifs/livvy-dunne')).toEqual(['https://klipy.com/gifs/livvy-dunne']);
        // An http link (a video too) is never fetched: it is listed for the minimal card, as before.
        expect(previewableUrls('http://v.example/b.mp4')).toEqual(['http://v.example/b.mp4']);
    });
});

describe('prepareLinkEmbed', () => {
    it('cleans the unfurler\'s draft with the shared validator and keeps the message URL', async () => {
        thumbMock.next = { size: 30_000 };
        const unfurl = vi.fn(async () => ({ ok: true as const, embed: { url: 'https://evil.example/swap', kind: 'card', title: 'T‮', site: 'S', color: 'nope', thumb: { inline_b64: 'AAAA' } }, image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' } }));
        const p = await prepareLinkEmbed('https://news.example/a', unfurl);
        expect(p?.url).toBe('https://news.example/a');
        expect(p?.embed).toEqual({ url: 'https://news.example/a', kind: 'card', title: 'T', site: 'S' });
        expect(p?.thumb?.width).toBe(640);
    });
    it('a failed unfurl or a throw: the minimal card (site only); no bridge: nothing', async () => {
        const minimal = { url: 'https://a.example/', embed: { url: 'https://a.example/', kind: 'card', site: 'a.example' } };
        expect(await prepareLinkEmbed('https://a.example/', vi.fn(async () => ({ ok: false as const, reason: 'failed' })))).toEqual(minimal);
        expect(await prepareLinkEmbed('https://a.example/', vi.fn(async () => { throw new Error('x'); }))).toEqual(minimal);
        expect(await prepareLinkEmbed('https://a.example/', undefined)).toBeNull();
    });
    it('an http link is never fetched: the minimal card straight away', async () => {
        const unfurl = vi.fn();
        expect(await prepareLinkEmbed('http://old.example/page', unfurl)).toEqual({ url: 'http://old.example/page', embed: { url: 'http://old.example/page', kind: 'card', site: 'old.example' } });
        expect(unfurl).not.toHaveBeenCalled();
    });
    it('links the reader draws better from the link alone never get the minimal card (positive control: a web link does)', async () => {
        const failed = vi.fn(async () => ({ ok: false as const, reason: 'local' }));
        for (const u of ['https://giphy.com/gifs/cat-JIX9t2j0ZTN9S', 'https://i.imgur.com/A61SaA1.gifv', 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
            'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR', 'https://www.tiktok.com/@scout2015/video/6718335390845095173', 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt']) {
            expect(minimalPrepared(u)).toBeNull();
            expect(await prepareLinkEmbed(u, failed)).toBeNull();
        }
        expect(minimalPrepared('https://www.nytimes.com/')?.embed).toEqual({ url: 'https://www.nytimes.com/', kind: 'card', site: 'nytimes.com' });
        expect(minimalPrepared('javascript:alert(1)')).toBeNull();
    });
    it('a card\'s icon is the site\'s favicon, re-encoded small (64 px); a post\'s author picture stays 128 px', async () => {
        thumbMock.next = { size: 500 };
        const reencode = vi.mocked((await import('./thumb')).reencodeThumb);
        reencode.mockClear();
        await prepareLinkEmbed('https://news.example/a', vi.fn(async () => ({ ok: true as const, embed: { url: 'https://news.example/a', kind: 'card', site: 'News' }, icon: { bytes: new Uint8Array([0, 0, 1, 0]), mime: 'image/x-icon' } })));
        expect(reencode).toHaveBeenCalledWith(new Uint8Array([0, 0, 1, 0]), 64);
        reencode.mockClear();
        await prepareLinkEmbed('https://x.com/a/status/1', vi.fn(async () => ({ ok: true as const, embed: { url: 'https://x.com/a/status/1', kind: 'post', site: 'X', author: 'A', description: 'hi' }, icon: { bytes: new Uint8Array([1]), mime: 'image/png' } })));
        expect(reencode).toHaveBeenCalledWith(new Uint8Array([1]), 128);
        thumbMock.next = null;
    });
    it('a picture-only page gets its host as the title', async () => {
        thumbMock.next = { size: 100 };
        const p = await prepareLinkEmbed('https://www.pics.example/a', vi.fn(async () => ({ ok: true as const, embed: { url: 'x', kind: 'card' }, image: { bytes: new Uint8Array([1]), mime: 'image/png' } })));
        expect(p?.embed.title).toBe('pics.example');
    });
});

const blob = (n: number) => new NodeBlob([new Uint8Array(n).fill(5)]) as unknown as Blob;
const prep = (url: string, thumbBytes?: number): PreparedEmbed => ({
    url, embed: { url, kind: 'card', title: 'T' },
    ...(thumbBytes ? { thumb: { blob: blob(thumbBytes), mime: 'image/webp' as const, width: 640, height: 335 } } : {}),
});

describe('finalizeEmbeds', () => {
    const text = 'see https://a.example/1 and https://a.example/2 and https://a.example/3';
    it('tiny thumbnails go inline, others are uploaded; the result passes the reader\'s validator', async () => {
        const upload = vi.fn(async () => ({ attachment_id: '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', file_key_b64: 'A'.repeat(43) + '=', file_nonce_b64: 'B'.repeat(16), byte_size: 40_000 }));
        const out = await finalizeEmbeds(text, [prep('https://a.example/1', 500), prep('https://a.example/2', 40_000), prep('https://a.example/3')], upload, 1000);
        expect(out[0].thumb?.inline_b64).toBeTruthy();
        expect(out[0].thumb?.attachment_id).toBeUndefined();
        expect(out[1].thumb?.attachment_id).toBe('0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c');
        expect(out[2].thumb).toBeUndefined();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(sanitizeLinkEmbeds(out, embedUrlsOf(text))).toEqual(out);
        expect(LINK_EMBED_THUMB_INLINE_MAX_BYTES).toBeGreaterThanOrEqual(500);
    });
    it('a slow or failed upload drops only the thumbnail, within the budget', async () => {
        const slow = vi.fn(() => new Promise<never>(() => {}));
        const t0 = Date.now();
        const out = await finalizeEmbeds(text, [prep('https://a.example/2', 40_000)], slow, 150);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(out).toEqual([{ url: 'https://a.example/2', kind: 'card', title: 'T' }]);
        const failing = vi.fn(async () => { throw new Error('500'); });
        expect((await finalizeEmbeds(text, [prep('https://a.example/2', 40_000)], failing, 500))[0].thumb).toBeUndefined();
    });
    it('takeAndFinalize: one budget for waiting and uploading; nothing ready = nothing sent', async () => {
        const slowUpload = vi.fn(() => new Promise<never>(() => {}));
        const take = vi.fn(async () => { await new Promise((r) => setTimeout(r, 250)); return [prep('https://a.example/2', 40_000)]; });
        const t0 = Date.now();
        const out = await takeAndFinalize(text, take, slowUpload, 600);
        const took = Date.now() - t0;
        expect(take).toHaveBeenCalledWith(text, 600);
        expect(took).toBeLessThan(900); // 250 waiting + at most the 350 left (floor 300)
        expect(out).toEqual([{ url: 'https://a.example/2', kind: 'card', title: 'T' }]);
        expect(await takeAndFinalize(text, async () => [], slowUpload, 600)).toEqual([]);
    });
    it('a preview whose link left the text is not sent', async () => {
        expect(await finalizeEmbeds('no links now', [prep('https://a.example/1', 100)], null, 100)).toEqual([]);
    });
});

describe('phase 4: a post\'s author picture and pictures', () => {
    it('each picture is re-encoded here, then sent inline or uploaded; a pictures-only tweet is still a post', async () => {
        thumbMock.next = { size: 30_000 };
        const img = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' };
        const unfurl = vi.fn(async () => ({
            ok: true as const,
            embed: { url: 'https://x.com/a/status/1', kind: 'post', site: 'X', author: 'A', author_handle: '@a', author_icon: { inline_b64: 'evil' }, images: [{ inline_b64: 'evil' }] },
            icon: img, images: [img, img, img, img, img, img],
        }));
        const p = await prepareLinkEmbed('https://x.com/a/status/1', unfurl);
        expect(p?.embed.kind).toBe('post');
        expect(p?.embed.images).toBeUndefined();
        expect(p?.embed.author_icon).toBeUndefined();
        expect(p?.icon).toBeDefined();
        expect(p?.images).toHaveLength(4);
        const uploads: number[] = [];
        let n = 0;
        const upload = vi.fn(async (b: Blob) => { uploads.push(b.size); n++; return { attachment_id: `0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4${n}`, file_key_b64: 'A'.repeat(43) + '=', file_nonce_b64: 'B'.repeat(16), byte_size: 30_000 }; });
        const [e] = await finalizeEmbeds('https://x.com/a/status/1', [p!], upload, 2000);
        expect(e.author_icon?.attachment_id).toBeDefined();
        expect(e.images).toHaveLength(4);
        expect(upload).toHaveBeenCalledTimes(5);
    });
});

describe('createThumbUploader', () => {
    const w = globalThis as unknown as { window: { crypto?: Crypto; btoa?: unknown; atob?: unknown } };
    if (!w.window.crypto) w.window.crypto = globalThis.crypto;
    if (!w.window.btoa) { w.window.btoa = globalThis.btoa; w.window.atob = globalThis.atob; }

    it('encrypts, initiates as an opaque octet-stream blob with no name, PUTs ciphertext, returns the key for the message only', async () => {
        const seen: { url: string; body: unknown }[] = [];
        const initiate = vi.fn(async (url: string, body: unknown, token: string) => {
            seen.push({ url, body });
            expect(token).toBe('tok');
            return { attachment_id: '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', upload_url: 'https://minio.example/put' };
        });
        const put = vi.fn(async (url: string, body: Blob) => { seen.push({ url, body }); return { ok: true, status: 200 }; });
        const plain = new Uint8Array(2000).fill(42);
        const up = createThumbUploader({ token: 'tok', apiBase: 'https://api.example/v1', channelId: 'c1' }, { initiate, put });
        const r = await up(new NodeBlob([plain]) as unknown as Blob);
        expect(r.attachment_id).toBe('0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c');
        expect(r.file_key_b64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
        expect(r.file_nonce_b64).toMatch(/^[A-Za-z0-9+/]{16}$/);
        expect(r.byte_size).toBe(2000);
        expect(seen[0]).toEqual({ url: 'https://api.example/v1/attachments/initiate', body: { size_bytes: expect.any(Number), mime_type: 'application/octet-stream', channel_id: 'c1' } });
        expect(JSON.stringify(seen[0])).not.toContain(r.file_key_b64);
        expect(seen[1].url).toBe('https://minio.example/put');
        const sent = new Uint8Array(await (seen[1].body as Blob).arrayBuffer());
        expect(sent.length).toBeGreaterThan(plain.length); // ciphertext + GCM tag
        expect(Buffer.from(sent).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);
    });
    it('throws on a refused upload or a malformed initiate answer', async () => {
        const ok = async () => ({ attachment_id: '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', upload_url: 'https://minio.example/put' });
        const up = createThumbUploader({ token: 't', apiBase: 'https://api.example/v1', conversationId: 'd1' }, { initiate: ok, put: async () => ({ ok: false, status: 413 }) });
        await expect(up(new NodeBlob([new Uint8Array(10)]) as unknown as Blob)).rejects.toThrow(/413/);
        const bad = createThumbUploader({ token: 't', apiBase: 'https://api.example/v1', conversationId: 'd1' }, { initiate: async () => ({}) });
        await expect(bad(new NodeBlob([new Uint8Array(10)]) as unknown as Blob)).rejects.toThrow(/initiate/);
    });
});
