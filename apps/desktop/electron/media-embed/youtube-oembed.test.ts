import { describe, it, expect } from 'vitest';
import { cleanText, isYouTubeId, parseYouTubeOEmbed, youTubeOEmbedUrl } from './youtube-oembed';

describe('youtube-oembed', () => {
    it('builds the oEmbed URL from a validated id only', () => {
        const u = new URL(youTubeOEmbedUrl('dQw4w9WgXcQ'));
        expect(u.origin + u.pathname).toBe('https://www.youtube.com/oembed');
        expect(u.searchParams.get('url')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(u.searchParams.get('format')).toBe('json');
        for (const bad of ['', 'short', 'dQw4w9WgXcQx', 'dQw4w9WgX&Q', '../../../a', 42, null]) {
            expect(isYouTubeId(bad)).toBe(false);
            expect(() => youTubeOEmbedUrl(bad as string)).toThrow();
        }
    });

    it('parses the real response shape (captured live 2026-11-23)', () => {
        const body = '{"title":"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)","author_name":"Rick Astley","author_url":"https://www.youtube.com/@RickAstleyYT","type":"video","height":113,"width":200,"version":"1.0","provider_name":"YouTube","provider_url":"https://www.youtube.com/","thumbnail_height":360,"thumbnail_width":480,"thumbnail_url":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg","html":"\\u003ciframe\\u003e"}';
        expect(parseYouTubeOEmbed(body)).toEqual({
            title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
            author: 'Rick Astley',
        });
    });

    it('anything else is "no title"', () => {
        for (const b of ['', 'not json', '[]', 'null', '{"title":""}', '{"title":5}', '{"author_name":"x"}']) {
            expect(parseYouTubeOEmbed(b)).toBeNull();
        }
    });

    it('display text: control and bidi-override characters removed, whitespace folded, length capped', () => {
        expect(cleanText('a\u0000b\nc‮d⁦e')).toBe('a b cde');
        expect(cleanText('  x   y  ')).toBe('x y');
        expect(cleanText('z'.repeat(500))).toHaveLength(200);
        expect(cleanText(undefined)).toBe('');
    });
});
