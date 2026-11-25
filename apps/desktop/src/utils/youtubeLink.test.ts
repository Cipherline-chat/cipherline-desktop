import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractYouTubeId, parseYouTubeLink, parseYouTubeTime, youTubeEmbedSrc, youTubeThumbUrls } from './youtubeLink';

const ID = 'dQw4w9WgXcQ';

describe('extractYouTubeId: only YouTube\'s own hosts produce a player', () => {
    it.each([
        `https://www.youtube.com/watch?v=${ID}`,
        `https://youtube.com/watch?v=${ID}&t=42s`,
        `https://m.youtube.com/watch?feature=share&v=${ID}`,
        `https://youtu.be/${ID}`,
        `https://youtu.be/${ID}?si=abc`,
        `https://www.youtube.com/embed/${ID}`,
        `https://www.youtube.com/shorts/${ID}`,
        `http://www.youtube.com/watch?v=${ID}`,
        `https://WWW.YOUTUBE.COM/watch?v=${ID}`,
    ])('%s', url => {
        expect(extractYouTubeId(url)).toBe(ID);
    });

    it.each([
        `https://evil.example/watch?v=${ID}`,
        `https://evil.example/?v=${ID}`,
        `https://evil.example/embed/${ID}`,
        `https://youtube.com.evil.example/watch?v=${ID}`,
        `https://evil.example/youtu.be/${ID}`,
        `https://notyoutube.com/watch?v=${ID}`,
        `https://www.youtube.com@evil.example/watch?v=${ID}`,
        `https://user:pw@www.youtube.com/watch?v=${ID}`,
        `javascript://www.youtube.com/watch?v=${ID}`,
        `https://www.youtube.com/watch?v=short`,
        `https://www.youtube.com/watch?v=${ID}x`,
        `https://www.youtube.com/channel/${ID}`,
        'not a url',
    ])('%s is not a YouTube video', url => {
        expect(extractYouTubeId(url)).toBeNull();
    });
});

describe('parseYouTubeLink: start offset, Shorts, hosts', () => {
    it.each([
        [`https://www.youtube.com/watch?v=${ID}&t=42`, 42],
        [`https://www.youtube.com/watch?v=${ID}&t=42s`, 42],
        [`https://youtu.be/${ID}?t=90`, 90],
        [`https://youtu.be/${ID}?si=x&t=1m30s`, 90],
        [`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, 3723],
        [`https://www.youtube.com/embed/${ID}?start=15`, 15],
        [`https://www.youtube.com/watch?v=${ID}#t=2m`, 120],
        [`https://www.youtube.com/watch?v=${ID}`, 0],
        [`https://www.youtube.com/watch?v=${ID}&t=abc`, 0],
        [`https://www.youtube.com/watch?v=${ID}&t=-5`, 0],
        [`https://www.youtube.com/watch?v=${ID}&t=0`, 0],
        [`https://www.youtube.com/watch?v=${ID}&t=999999999`, 0],
    ])('%s → start %i', (url, start) => {
        expect(parseYouTubeLink(url)).toEqual({ id: ID, start, short: false });
    });

    it('a /shorts/ link is vertical; other paths are not', () => {
        expect(parseYouTubeLink(`https://www.youtube.com/shorts/${ID}`)).toEqual({ id: ID, start: 0, short: true });
        expect(parseYouTubeLink(`https://youtube.com/shorts/${ID}?feature=share`)?.short).toBe(true);
        expect(parseYouTubeLink(`https://youtu.be/${ID}`)?.short).toBe(false);
        expect(parseYouTubeLink(`https://www.youtube.com/live/${ID}`)?.short).toBe(false);
    });

    it('music.youtube.com watch links play; its other pages do not', () => {
        expect(parseYouTubeLink(`https://music.youtube.com/watch?v=${ID}&list=RD`)?.id).toBe(ID);
        expect(parseYouTubeLink(`https://music.youtube.com/channel/${ID}`)).toBeNull();
    });

    it('parseYouTubeTime bounds', () => {
        expect(parseYouTubeTime('')).toBe(0);
        expect(parseYouTubeTime(null)).toBe(0);
        expect(parseYouTubeTime('h')).toBe(0);
        expect(parseYouTubeTime('172800')).toBe(172800); // 48 h: the cap itself
        expect(parseYouTubeTime('172801')).toBe(0);
    });

    it('the player URL is built from the parsed id only, autoplaying at the offset', () => {
        const link = parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}&t=42&list=x&autoplay=0&origin=evil`)!;
        const src = new URL(youTubeEmbedSrc(link, 'http://127.0.0.1:42917'));
        expect(src.origin).toBe('https://www.youtube-nocookie.com');
        expect(src.pathname).toBe(`/embed/${ID}`);
        expect(src.searchParams.get('autoplay')).toBe('1');
        expect(src.searchParams.get('start')).toBe('42');
        expect(src.searchParams.get('origin')).toBe('http://127.0.0.1:42917');
        expect(src.searchParams.get('list')).toBeNull();
        expect(new URL(youTubeEmbedSrc({ id: ID, start: 0, short: false }, 'x')).searchParams.has('start')).toBe(false);
    });

    it('thumbnails: hqdefault first, mqdefault as the fallback, on i.ytimg.com', () => {
        expect(youTubeThumbUrls(ID)).toEqual([
            `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
            `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`,
        ]);
    });
});

describe('call sites', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
    it('the YouTube embed and the pinned panel use the shared, host-pinned parser', () => {
        expect(read('components/embeds/YouTubeEmbed.tsx')).toMatch(/import \{[^}]*\bparseYouTubeLink\b[^}]*\} from '\.\.\/\.\.\/utils\/youtubeLink'/);
        expect(read('components/PinnedMessagesPanel.tsx')).toMatch(/import \{ extractYouTubeId \} from '\.\.\/utils\/youtubeLink'/);
        for (const f of ['components/ChatPane.tsx', 'components/PinnedMessagesPanel.tsx', 'components/embeds/YouTubeEmbed.tsx']) {
            expect(read(f)).not.toMatch(/function extractYouTubeId|function parseYouTubeLink/);
        }
    });
    it('no chat code mounts a YouTube iframe itself (the facade does, on click)', () => {
        expect(read('components/ChatPane.tsx')).not.toMatch(/youtube-nocookie\.com\/embed/);
        const embed = read('components/embeds/MessageEmbed.tsx');
        expect(embed).not.toMatch(/youtube-nocookie\.com\/embed/);
        expect(embed).toMatch(/kind === 'youtube'\) return <YouTubeEmbed url=\{url\} \/>/);
        expect(read('components/ChatPane.tsx')).toMatch(/import \{ MessageEmbed \} from '\.\/embeds\/MessageEmbed'/);
    });
    it('the pinned panel draws no <img> from a URL in message text', () => {
        const src = read('components/PinnedMessagesPanel.tsx');
        expect(src).not.toMatch(/src=\{firstImgUrl\}/);
        expect(src).not.toMatch(/isDirectImageUrl/);
    });
});
