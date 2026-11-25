/** page-media.ts against pages saved live (KLIPY 2026-11-24, Tenor 2026-11-23) and hand-made edge cases. */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isGifPageHost, isKlipyPageUrl, pageMedia } from './page-media';

const klipy = fs.readFileSync(path.join(__dirname, '__fixtures__', 'media', 'klipy-page.bin'), 'utf8');
const tenor = fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', 'tenor-gif.html'), 'utf8');

describe('pageMedia', () => {
    it('KLIPY page (live): its GIF (the image/gif og:image, not the webp) and its mp4 (og:video:url + secure_url as one)', () => {
        const m = pageMedia(klipy, 'https://klipy.com/gifs/livvy-dunne');
        expect(m.gif).toEqual({ url: 'https://static2.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/1d/1b/H3If9Bb35lxCdqQAOo.gif', mime: 'image/gif', width: 281, height: 374 });
        expect(m.video).toEqual({ url: 'https://static2.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/1d/1b/lDw3Gx0fT8Uf51timeC.mp4', mime: 'video/mp4', width: 374, height: 498 });
    });

    it('Tenor page (live): an mp4 and a GIF', () => {
        const m = pageMedia(tenor, 'https://tenor.com/view/x-3162456205570563299');
        expect(m.video?.mime).toBe('video/mp4');
        expect(m.gif?.url).toMatch(/\.gif$/);
    });

    it('an og:video that is an HTML player (YouTube /embed/) is not a file; twitter:player:stream and JSON-LD contentUrl are', () => {
        expect(pageMedia('<meta property="og:video" content="https://www.youtube.com/embed/abc"><meta property="og:video:type" content="text/html">', 'https://a.example/').video).toBeUndefined();
        expect(pageMedia('<meta name="twitter:player:stream" content="https://cdn.a.example/v.mp4">', 'https://a.example/').video?.url).toBe('https://cdn.a.example/v.mp4');
        expect(pageMedia('<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.a.example/c.webm"}</script>', 'https://a.example/').video).toMatchObject({ mime: 'video/webm' });
        expect(pageMedia('<meta property="og:video" content="http://cdn.a.example/v.mp4">', 'https://a.example/').video).toBeUndefined();
    });

    it('a static og:image is not a GIF; a .gif without a type is', () => {
        expect(pageMedia('<meta property="og:image" content="https://a.example/p.jpg">', 'https://a.example/').gif).toBeUndefined();
        expect(pageMedia('<meta property="og:image" content="https://a.example/p.gif">', 'https://a.example/').gif?.url).toBe('https://a.example/p.gif');
    });
});

describe('hosts', () => {
    it('KLIPY page shapes', () => {
        for (const u of ['https://klipy.com/gifs/livvy-dunne', 'https://www.klipy.com/stickers/x', 'https://klipy.com/clips/y', 'https://klipy.com/memes/z']) expect(isKlipyPageUrl(u)).toBe(true);
        for (const u of ['https://klipy.com/', 'https://static2.klipy.com/a.gif', 'http://klipy.com/gifs/x', 'https://notklipy.com/gifs/x']) expect(isKlipyPageUrl(u)).toBe(false);
    });
    it('GIF page hosts', () => {
        expect(isGifPageHost('www.tenor.com')).toBe(true);
        expect(isGifPageHost('klipy.com')).toBe(true);
        expect(isGifPageHost('example.com')).toBe(false);
    });
});
