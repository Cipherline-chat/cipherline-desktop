/**
 * media-sniff.ts against bytes saved LIVE (__fixtures__/media/corpus.json,
 * 2026-11-24) and ffmpeg-made files with known facts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isExpiringMediaUrl, isShortLoop, sniffMedia } from './media-sniff';

const dir = path.join(__dirname, '__fixtures__', 'media');
const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8')) as { entries: { id: string; url: string; hops: { body?: string }[] }[] };
const bytesOf = (id: string) => {
    const e = corpus.entries.find((x) => x.id === id)!;
    return new Uint8Array(fs.readFileSync(path.join(dir, e.hops.at(-1)!.body!)));
};

describe('sniffMedia (live bytes)', () => {
    it.each([
        ['discord-cdn-gif', 'image/gif', 128, 128, true],
        ['discord-cdn-png', 'image/png', 256, 256, false],
        ['giphy-media', 'image/gif', 480, 480, true],
        ['tenor-media-gif', 'image/gif', 298, 498, true],
        ['wikimedia-gif', 'image/gif', 400, 400, true],
        ['animated-webp', 'image/webp', 400, 400, true],
        ['gravatar-extensionless', 'image/png', 128, 128, false],
        ['picsum-extensionless', 'image/jpeg', 400, 300, false],
        ['reddit-i', 'image/jpeg', 3000, 4000, false],
    ] as const)('%s → %s %sx%s animated=%s', (id, mime, w, h, animated) => {
        const f = sniffMedia(bytesOf(id))!;
        expect(f.mime).toBe(mime);
        if (w) { expect(f.width).toBe(w); expect(f.height).toBe(h); }
        expect(!!f.animated).toBe(animated);
    });

    it('KLIPY media magic bytes (64 bytes saved, no media stored): a GIF and an mp4', () => {
        expect(sniffMedia(bytesOf('klipy-gif'))?.mime).toBe('image/gif');
        expect(sniffMedia(bytesOf('klipy-mp4'))?.mime).toBe('video/mp4');
    });

    it('mp4 facts: duration, tracks, size; a 2 s silent loop is a GIF, a 20 s clip with sound is not', () => {
        const loop = sniffMedia(bytesOf('discord-cdn-mp4-loop'))!;
        expect(loop).toMatchObject({ mime: 'video/mp4', width: 320, height: 240, hasAudio: false, hasVideo: true, complete: true });
        expect(loop.durationS).toBeCloseTo(2, 0);
        expect(isShortLoop(loop)).toBe(true);
        const clip = sniffMedia(bytesOf('discord-cdn-mp4-audio'))!;
        expect(clip).toMatchObject({ mime: 'video/mp4', width: 192, height: 108, hasAudio: true, hasVideo: true });
        expect(clip.durationS).toBeGreaterThan(19);
        expect(isShortLoop(clip)).toBe(false);
    });

    it('an mp4 whose index is at the END: a video, facts unknown, never called a loop', () => {
        const f = sniffMedia(bytesOf('discord-cdn-mp4-tailmoov'))!;
        // The whole file is here, so moov IS found when read whole...
        expect(f.mime).toBe('video/mp4');
        // ...but its first 4 KB alone say only "video".
        const head = sniffMedia(bytesOf('discord-cdn-mp4-tailmoov').subarray(0, 4096))!;
        expect(head).toMatchObject({ mime: 'video/mp4', complete: false });
        expect(isShortLoop(head)).toBe(false);
    });

    it('live mp4 heads (MDN flower, Tenor) are videos', () => {
        expect(sniffMedia(bytesOf('mdn-mp4'))?.mime).toBe('video/mp4');
        const t = sniffMedia(bytesOf('tenor-media-mp4'))!;
        expect(t.mime).toBe('video/mp4');
    });

    it('not media: HTML, Discord\'s expired 404 text, JSON, empty', () => {
        expect(sniffMedia(bytesOf('discord-cdn-expired'))).toBeNull();
        expect(sniffMedia(bytesOf('imgur-direct-extensionless'))).toBeNull();
        expect(sniffMedia(bytesOf('klipy-page'))).toBeNull();
        expect(sniffMedia(new TextEncoder().encode('{"message":"404"}'))).toBeNull();
        expect(sniffMedia(new Uint8Array(0))).toBeNull();
    });

    it('truncated and hostile bytes never throw', () => {
        const gif = bytesOf('discord-cdn-gif');
        for (const n of [6, 7, 13, 20, 100, 800, 5000]) expect(() => sniffMedia(gif.subarray(0, n))).not.toThrow();
        const mp4 = bytesOf('discord-cdn-mp4-loop');
        for (const n of [12, 30, 200, 1000, 4000]) expect(() => sniffMedia(mp4.subarray(0, n))).not.toThrow();
        const evil = new Uint8Array(64); evil.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); evil.set([0xff, 0xff, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76], 24);
        expect(() => sniffMedia(evil)).not.toThrow();
    });

    it('POSITIVE CONTROL: a one-frame GIF read to its trailer is not animated; the 2-frame live GIF is', () => {
        // 1x1 GIF89a, one frame.
        const one = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64'));
        expect(sniffMedia(one)).toMatchObject({ mime: 'image/gif', width: 1, height: 1, animated: false });
        expect(sniffMedia(bytesOf('discord-cdn-gif'))?.animated).toBe(true);
    });
});

describe('isExpiringMediaUrl', () => {
    it.each([
        ['https://cdn.discordapp.com/attachments/1/2/a.gif?ex=656a5c4b&is=6557e74b&hm=2b0ef6', true],
        ['https://media.discordapp.net/attachments/1/2/a.mp4?ex=656a5c4b&is=6557e74b&hm=2b&=&width=400', true],
        ['https://cdn.discordapp.com/attachments/1/2/a.png', true],
        ['https://cdn.discordapp.com/emojis/1113579886439833690.gif?size=128', false],
        ['https://cdn.discordapp.com/emojis/1113579886439833690.gif?size=128&ex=6745d2a1&is=67448121&hm=9f3c', true],
        ['https://bucket.s3.amazonaws.com/a.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261124T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc', true],
        ['https://storage.googleapis.com/b/a.gif?X-Goog-Algorithm=GOOG4&X-Goog-Expires=900&X-Goog-Signature=abc', true],
        ['https://d111.cloudfront.net/a.mp4?Expires=1732400000&Signature=abcdefgh&Key-Pair-Id=K2', true],
        ['https://acct.blob.core.windows.net/c/a.png?sv=2022-11-02&se=2026-11-25T00%3A00%3A00Z&sig=abc', true],
        ['https://scontent.xx.fbcdn.net/v/a.jpg?oh=00_AbC&oe=6745D2A1', true],
        ['https://cdn.example/a.mp4?expires=1732400000&signature=0123456789abcdef', true],
        ['https://fastly.picsum.photos/id/237/400/300.jpg?hmac=32RuLp2fb9I2fzPP3U', false],
        ['https://preview.redd.it/abc.gif?width=640&format=mp4&s=0123456789abcdef', false],
        ['https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif', false],
        ['https://example.com/a.gif?e=hello&s=0123456789abcdef', false],
        ['not a url', false],
    ])('%s → %s', (url, want) => {
        expect(isExpiringMediaUrl(url)).toBe(want);
    });
});
