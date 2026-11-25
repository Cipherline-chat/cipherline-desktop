/**
 * Discord import → link previews (phase 4): Discord's previews of links in a
 * message become the row's `embeds`, picture included (from Discord, re-encoded
 * here, inline or uploaded through the import's own path); what cannot be tied
 * to a link in the text falls back to quoted text; nothing ever throws.
 */
import { describe, it, expect, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import type { ImportLinkEmbed } from '../types';
import { draftFromDiscord, importedLinkEmbeds, matchTextUrl } from './linkEmbeds';

const base = (over: Partial<ImportLinkEmbed>): ImportLinkEmbed => ({
    url: 'https://news.example/a', type: 'article', title: 'A headline', description: 'Body', site: 'News', author: 'Someone',
    color: '#ff4e00', thumbRef: 'ref-1', thumbWidth: 1200, thumbHeight: 630, videoUrl: null, ...over,
});
const thumb = (size: number) => ({ blob: new NodeBlob([new Uint8Array(size).fill(7)]) as unknown as Blob, mime: 'image/webp' as const, width: 920, height: 483 });

function deps(opts: { size?: number; fetchFails?: boolean; uploadFails?: boolean } = {}) {
    let n = 0;
    return {
        fetchMedia: vi.fn(async () => (opts.fetchFails ? { ok: false as const, code: 'not_found', message: 'gone' } : { ok: true as const, mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) })),
        reencode: vi.fn(async () => thumb(opts.size ?? 40_000)),
        upload: vi.fn(async (b: Uint8Array) => {
            if (opts.uploadFails) throw new Error('no room');
            n++;
            return { attachmentId: `0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4${n}`, keyB64: 'A'.repeat(43) + '=', nonceB64: 'B'.repeat(16), storedBytes: b.byteLength + 28 };
        }),
    };
}

describe('matchTextUrl', () => {
    it('the same link, or the same page written differently', () => {
        const text = ['https://youtu.be/jNQXAC9IVRw', 'https://www.news.example/a/', 'https://other.example/x'];
        expect(matchTextUrl('https://other.example/x', text)).toBe('https://other.example/x');
        expect(matchTextUrl('https://news.example/a', text)).toBe('https://www.news.example/a/');
        expect(matchTextUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw', text)).toBe('https://youtu.be/jNQXAC9IVRw');
        expect(matchTextUrl('https://elsewhere.example/', text)).toBeNull();
    });
});

describe('draftFromDiscord: the kind comes from Cipherline\'s own reading of the link', () => {
    it('YouTube / Twitch / TikTok → players; a clip page → the clip card; X → a post; else a web card', () => {
        expect(draftFromDiscord(base({ title: 'Me at the zoo', author: 'jawed' }), 'https://youtu.be/jNQXAC9IVRw')).toMatchObject({ kind: 'player', player: { provider: 'youtube', id: 'jNQXAC9IVRw' }, title: 'Me at the zoo' });
        expect(draftFromDiscord(base({}), 'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR')?.player).toEqual({ provider: 'twitch', id: 'clip:DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR' });
        expect(draftFromDiscord(base({}), 'https://www.tiktok.com/@a/video/6718335390845095173')?.player).toEqual({ provider: 'tiktok', id: '6718335390845095173' });
        expect(draftFromDiscord(base({ title: 'clip' }), 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt')?.kind).toBe('video');
        expect(draftFromDiscord(base({ type: 'rich', author: 'jack (@jack)', description: 'just setting up my twttr' }), 'https://x.com/jack/status/20')).toMatchObject({ kind: 'post', author: 'jack (@jack)', description: 'just setting up my twttr' });
        expect(draftFromDiscord(base({}), 'https://news.example/a')).toMatchObject({ kind: 'card', site: 'News', title: 'A headline', color: '#ff4e00' });
    });
    it('Discord\'s own player / video URL is never carried over', () => {
        const d = draftFromDiscord(base({ videoUrl: 'https://www.youtube.com/embed/zzzzzzzzzzz' }), 'https://youtu.be/jNQXAC9IVRw')!;
        expect(JSON.stringify(d)).not.toContain('zzzzzzzzzzz');
    });
});

describe('importedLinkEmbeds', () => {
    it('a big picture is uploaded (its attachment listed for the row), a tiny one rides inline', async () => {
        const d = deps();
        const r = await importedLinkEmbeds([base({})], 'read https://news.example/a', d);
        expect(r.embeds).toHaveLength(1);
        expect(r.embeds[0].thumb).toMatchObject({ mime: 'image/webp', width: 920, height: 483, byte_size: 40_000 });
        expect(r.attachmentIds).toEqual([r.embeds[0].thumb!.attachment_id]);
        expect(r.storedBytes).toBe(40_028);
        expect(d.fetchMedia).toHaveBeenCalledWith('ref-1');
        const small = await importedLinkEmbeds([base({})], 'read https://news.example/a', deps({ size: 2_000 }));
        expect(small.embeds[0].thumb?.inline_b64).toBeDefined();
        expect(small.attachmentIds).toEqual([]);
    });
    it('fail soft: no picture when it cannot be fetched or stored; the card still comes over', async () => {
        for (const d of [deps({ fetchFails: true }), deps({ uploadFails: true })]) {
            const r = await importedLinkEmbeds([base({})], 'https://news.example/a', d);
            expect(r.embeds).toHaveLength(1);
            expect(r.embeds[0].thumb).toBeUndefined();
            expect(r.unmapped).toEqual([]);
        }
        const thrower = { ...deps(), reencode: vi.fn(async () => { throw new Error('decoder'); }) };
        expect((await importedLinkEmbeds([base({})], 'https://news.example/a', thrower)).embeds).toHaveLength(1);
    });
    it('a preview for a link that is not in the text is not an embed: it goes back to the caller as quoted text', async () => {
        const r = await importedLinkEmbeds([base({ url: 'https://gone.example/' }), base({})], 'only https://news.example/a', deps());
        expect(r.embeds.map((e) => e.url)).toEqual(['https://news.example/a']);
        expect(r.unmapped.map((e) => e.url)).toEqual(['https://gone.example/']);
    });
    it('a link inside a spoiler gets no preview (the readers\' rule), at most five, one per link', async () => {
        expect((await importedLinkEmbeds([base({})], '||https://news.example/a||', deps())).embeds).toEqual([]);
        const urls = Array.from({ length: 7 }, (_, i) => `https://news.example/${i}`);
        const r = await importedLinkEmbeds(urls.map((u) => base({ url: u, thumbRef: null })), urls.join(' '), deps());
        expect(r.embeds).toHaveLength(5);
        const dup = await importedLinkEmbeds([base({ thumbRef: null }), base({ thumbRef: null, title: 'again' })], 'https://news.example/a', deps());
        expect(dup.embeds).toHaveLength(1);
    });
    it('nothing to do: no previews', async () => {
        const d = deps();
        expect(await importedLinkEmbeds(undefined, 'https://news.example/a', d)).toEqual({ embeds: [], unmapped: [], attachmentIds: [], storedBytes: 0 });
        expect(d.fetchMedia).not.toHaveBeenCalled();
    });
});
