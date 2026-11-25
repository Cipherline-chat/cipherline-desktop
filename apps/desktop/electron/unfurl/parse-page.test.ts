/**
 * The page parser against pages saved live on 2026-11-23 (__fixtures__/,
 * trimmed to their <head> metadata), plus hostile inputs.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parsePageMeta, parseOEmbedJson, isoDurationSeconds, normalizeThemeColor, absHttps } from './parse-page';
import { parseClipPage } from '../media-embed/clip-page';
import { medalFacts } from './providers';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const clipFx = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'media-embed', '__fixtures__', name), 'utf8');

describe('parsePageMeta: real pages', () => {
    it('news article (Ars Technica): title, description, site, wide image, large-image hint', () => {
        const url = 'https://arstechnica.com/reviews/2026/11/review-the-asus-proart-p16-offers-a-glimpse-of-a-future-powered-by-local-ai/';
        const m = parsePageMeta(fx('ars-article.html'), url);
        expect(m.title).toBe('Review: The Asus ProArt P16 offers a glimpse of a future powered by local AI');
        expect(m.description).toBe('The new Asus ProArt laptop costs up to $7,000, but it can run a gaggle of local AI agents.');
        expect(m.site).toBe('Ars Technica');
        expect(m.image).toEqual({ url: 'https://cdn.arstechnica.net/wp-content/uploads/2026/11/Asus-P16-3-1152x648.jpg', width: 1152, height: 648 });
        expect(m.largeImage).toBe(true);
        expect(m.type).toBe('article');
        expect(m.author).toBeTruthy(); // JSON-LD NewsArticle author
    });

    it('news article (BBC): entities decoded, theme-color, JSON-LD publisher as the site, cXense author', () => {
        const m = parsePageMeta(fx('bbc-article.html'), 'https://www.bbc.com/news/articles/cr894gjz0j0yo');
        expect(m.title).toBe('Russian warship hit by Ukrainian drones in Libya, Zelensky says');
        expect(m.description).toContain('"escalation of tensions in the region"');
        expect(m.color).toBe('#ffffff');
        expect(m.site).toBe('BBC News');
        expect(m.author).toBe('Hafsa Khalil | Joe Inwood');
        expect(m.image?.url).toMatch(/^https:\/\/ichef\.bbci\.co\.uk\/news\/1024\//);
        expect(m.durationS).toBe(87); // the page's VideoObject, PT1M27S
    });

    it('repository page (GitHub): wide image, theme-color', () => {
        const m = parsePageMeta(fx('gh-repo.html'), 'https://github.com/electron/electron');
        expect(m.site).toBe('GitHub');
        expect(m.color).toBe('#1e2327');
        expect(m.image).toMatchObject({ width: 1200, height: 600 });
        expect(m.largeImage).toBe(true);
    });

    it('profile page (GitHub user): a square avatar, summary card', () => {
        const m = parsePageMeta(fx('gh-user.html'), 'https://github.com/torvalds');
        expect(m.title).toBe('torvalds - Overview');
        expect(m.image?.url).toMatch(/^https:\/\/avatars\.githubusercontent\.com\//);
        expect(m.largeImage).toBe(false);
    });

    it('a page with no image (Wikipedia stub) and one with nothing but <title> (example.com)', () => {
        const w = parsePageMeta(fx('wiki-noimage.html'), 'https://en.wikipedia.org/wiki/Tick_(software)');
        expect(w.title).toBe('Tick (software) - Wikipedia');
        expect(w.image).toBeUndefined();
        const e = parsePageMeta(fx('example-bare.html'), 'https://example.com/');
        expect(e.title).toBe('Example Domain');
        expect(e.image).toBeUndefined();
        expect(e.site).toBeUndefined();
    });

    it('Medal clip page: title + game without the boilerplate, duration, author, thumbnail, oEmbed link, video file', () => {
        const html = clipFx('medal-clip.html');
        const url = 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt';
        const m = parsePageMeta(html, url);
        expect(m.durationS).toBe(24.15);
        expect(m.author).toBe('TofuFPS');
        expect(m.image?.url).toMatch(/^https:\/\/cdn\.medal\.tv\/ugcc\/content-thumbnail\//);
        expect(m.oembedUrl).toBe('https://medal.tv/api/oembed?url=https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt');
        expect(medalFacts(m.title, url)).toEqual({ title: 'wyw my sweetie // Clips in my Discord', game: 'Valorant' });
        expect(parseClipPage(html, 'medal')?.url).toMatch(/^https:\/\/cdn\.medal\.tv\/mediac\/.*\.mp4/);
    });
    it('Medal\'s /clip/<id> page names no game ("… - Clipped with Medal.tv", live 2026-11-24): the boilerplate still goes', () => {
        expect(medalFacts('Playboi Carti- Rather Lie - Clipped with Medal.tv', 'https://medal.tv/clip/nTRtkRTuFjGCzGbP8')).toEqual({ title: 'Playboi Carti- Rather Lie', game: undefined });
        expect(medalFacts('Insane - Clipped with Medal.tv', 'https://medal.tv/games/rocket-league/clips/abcd1234')).toEqual({ title: 'Insane', game: 'Rocket League' });
    });
});

describe('parsePageMeta: hostile and malformed input', () => {
    it('never returns markup, control or bidi characters; caps lengths', () => {
        const html = `<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;‮gnp.exe\u0007 title">
            <meta property="og:description" content="${'d'.repeat(2000)}">
            <meta name="theme-color" content="red; background:url(https://evil.example)">`;
        const m = parsePageMeta(html, 'https://a.example/');
        expect(m.title).toBe('<img src=x onerror=alert(1)>gnp.exe title'); // plain text: drawn as text, never as HTML
        expect(m.title!.includes('\u202E') || m.title!.includes('\u0007')).toBe(false);
        expect(Array.from(m.description!).length).toBe(350);
        expect(m.color).toBeUndefined();
    });

    it('image URLs: relative resolved against the page, http / data / credentialed / ported refused', () => {
        expect(parsePageMeta('<meta property="og:image" content="/img/a.png">', 'https://a.example/p/q').image?.url).toBe('https://a.example/img/a.png');
        for (const bad of ['http://a.example/a.png', 'data:image/png;base64,AAAA', 'https://u:p@a.example/a.png', 'https://a.example:8443/a.png', 'javascript:alert(1)']) {
            expect(parsePageMeta(`<meta property="og:image" content="${bad}">`, 'https://a.example/').image).toBeUndefined();
        }
    });

    it('a URL-valued author meta is not an author', () => {
        expect(parsePageMeta('<meta name="author" content="https://facebook.com/someone">', 'https://a.example/').author).toBeUndefined();
    });

    it('broken JSON-LD and absurd nesting do not throw', () => {
        const deep = '['.repeat(5000) + ']'.repeat(5000);
        expect(() => parsePageMeta(`<script type="application/ld+json">{oops</script><script type="application/ld+json">${deep}</script>`, 'https://a.example/')).not.toThrow();
    });
});

describe('helpers', () => {
    it('isoDurationSeconds', () => {
        expect(isoDurationSeconds('PT0H0M24.15S')).toBe(24.15);
        expect(isoDurationSeconds('PT1M27S')).toBe(87);
        expect(isoDurationSeconds('PT2H')).toBe(7200);
        for (const bad of ['', 'P', 'PT', '24', 'PT-5S', 'P2D', 7]) expect(isoDurationSeconds(bad)).toBeUndefined();
    });
    it('normalizeThemeColor', () => {
        expect(normalizeThemeColor('#ABC')).toBe('#aabbcc');
        expect(normalizeThemeColor(' #1E2327 ')).toBe('#1e2327');
        for (const bad of ['red', 'rgb(1,2,3)', '#12345', '#1234567', undefined]) expect(normalizeThemeColor(bad)).toBeUndefined();
    });
    it('absHttps', () => {
        expect(absHttps('//cdn.example/x.png', 'https://a.example/')).toBe('https://cdn.example/x.png');
        expect(absHttps('x.png', 'http://a.example/')).toBeUndefined();
    });
    it('oEmbed JSON (YouTube, Medal saved live)', () => {
        const yt = parseOEmbedJson(fx('youtube-oembed.json'), 'https://www.youtube.com/oembed');
        expect(yt).toMatchObject({ title: 'Me at the zoo', author: 'jawed', site: 'YouTube', thumbnail: { url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg', width: 480, height: 360 } });
        const medal = parseOEmbedJson(fx('medal-oembed.json'), 'https://medal.tv/api/oembed');
        expect(medal?.title).toBe('wyw my sweetie // Clips in my Discord');
        expect(parseOEmbedJson('[1,2]', 'https://a.example/')).toBeNull();
        expect(parseOEmbedJson('nope', 'https://a.example/')).toBeNull();
    });
});
