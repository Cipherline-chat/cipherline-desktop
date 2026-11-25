/**
 * Page heads saved LIVE on 2026-11-23 from the dev box (__fixtures__/live/,
 * each file's first line says the URL, UA and status; token-like values
 * redacted). The parser must give every real page a sensible card, never take
 * a bot wall for a page, and find each site's icon. Positive controls: the
 * same pages fetched with the other UA (the walls) are recognised as walls,
 * and the real pages are not.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { bodyPicture, bodyPictureStop, drivePicture, iconCandidates, isBotWall, parsePageMeta } from './parse-page';
import { parseClipPage } from '../media-embed/clip-page';
import { parseRedditPostJson } from './reddit';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'live', name), 'utf8');
const page = (name: string, url: string) => {
    const html = fx(name);
    const meta = parsePageMeta(html, url);
    meta.image ??= bodyPicture(html, url);
    return { html, meta, wall: isBotWall(html, meta), icons: iconCandidates(html, url).map((c) => c.url) };
};

describe('real pages give a real card', () => {
    it('amazon.com home (preview UA; no Content-Type, 3 MB page, head ends at 43 KB)', () => {
        const p = page('amazon-home.html', 'https://www.amazon.com/');
        expect(p.wall).toBe(false);
        expect(p.meta.title).toBe('Amazon.com. Spend less. Smile more.');
        expect(p.meta.description).toMatch(/^Free shipping on millions of items/);
        expect(p.meta.image?.url).toMatch(/^https:\/\/m\.media-amazon\.com\/images\//);
        expect(p.icons).toEqual(['https://www.amazon.com/favicon.ico']);
    });

    it('an Amazon product page: no og:image in the head, the product photo from the body', () => {
        const url = 'https://www.amazon.com/dp/B0D1XD1ZV3';
        expect(bodyPictureStop(url)).toBeInstanceOf(RegExp);
        expect(bodyPictureStop('https://www.amazon.com/')).toBeUndefined();
        const p = page('amazon-product.html', url);
        expect(p.wall).toBe(false);
        expect(p.meta.title).toMatch(/^Amazon\.com: Apple AirPods Pro 2/);
        expect(p.meta.image?.url).toBe('https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg');
        // Positive control: a lookalike host is not Amazon and gets no body picture.
        expect(bodyPicture(fx('amazon-product.html'), 'https://www.amazon.com.evil.example/dp/B0D1XD1ZV3')).toBeUndefined();
    });

    it('nytimes.com (preview UA): title, site, picture; the SVG icon skipped, the PNG / ICO ones kept', () => {
        const p = page('nytimes-home.html', 'https://www.nytimes.com/');
        expect(p.wall).toBe(false);
        expect(p.meta).toMatchObject({ site: 'The New York Times', title: 'The New York Times - Breaking News, US News, World News and Videos' });
        expect(p.meta.image?.url).toMatch(/^https:\/\//);
        expect(p.icons.some((u) => u.endsWith('.svg'))).toBe(false);
        expect(p.icons[0]).toMatch(/^https:\/\/static01\.nyt\.com\/.*\.png$/); // a 114 px touch icon: the closest to ~96 px
        expect(p.icons).toContain('https://static01.nyt.com/vi-assets/static-assets/assets/favicon-NXM0N6-N.ico');
    });

    it('wikipedia, github, bbc: titles, pictures and the best icon first', () => {
        const w = page('wikipedia-cat.html', 'https://en.wikipedia.org/wiki/Cat');
        expect(w.meta.title).toBe('Cat - Wikipedia');
        expect(w.meta.image?.url).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
        expect(w.icons[0]).toBe('https://en.wikipedia.org/static/apple-touch/wikipedia.png');
        expect(w.icons).toContain('https://en.wikipedia.org/static/favicon/wikipedia.ico');

        const g = page('github-repo-wa.html', 'https://github.com/electron/electron');
        expect(g.meta.title).toMatch(/electron\/electron/);
        expect(g.icons[0]).toBe('https://github.githubassets.com/favicons/favicon.png'); // the svg one is skipped
        expect(g.icons.some((u) => /\.svg$/.test(u))).toBe(false);

        const b = page('bbc-news.html', 'https://www.bbc.com/news');
        expect(b.meta.title).toMatch(/^BBC News/);
        expect(b.icons[0]).toMatch(/apple-touch-icon\.png$/);           // 180 px
        expect(b.icons[1]).toMatch(/favicon-32x32\.png$/);
        expect(b.icons.indexOf(b.icons.find((u) => /favicon-16x16/.test(u))!)).toBeGreaterThan(1);
    });

    it('the Reddit post page (preview UA): og:title and the share picture of the post', () => {
        const p = page('reddit-post-page.html', 'https://www.reddit.com/r/aww/comments/1y332n4/my_new_cat_discovered_the_christmas_tree/');
        expect(p.wall).toBe(false);
        expect(p.meta.title).toBe('From the aww community on Reddit: My new cat discovered the Christmas Tree');
        expect(p.meta.image?.url).toBe('https://share.redd.it/preview/post/1y332n4');
    });

    it('a site with no icon and no metadata (example.com): its title, and only /favicon.ico to try', () => {
        const p = page('example-nofavicon.html', 'https://example.com/');
        expect(p.wall).toBe(false);
        expect(p.meta.title).toBe('Example Domain');
        expect(p.meta.image).toBeUndefined();
        expect(p.icons).toEqual(['https://example.com/favicon.ico']);
    });

    it('a missing Google Doc (404): parsed fine, the status decides (unfurl.ts readPage)', () => {
        const p = page('gdocs-missing.html', 'https://docs.google.com/document/d/x/edit');
        expect(p.icons[0]).toBe('https://docs.google.com/favicon.ico'); // protocol-relative resolved to https
    });
});

describe('Google Docs / Drive (saved live 2026-11-23, page-snapshots)', () => {
    it('a public Google Doc publishes its own first-page picture (og:image, 1200x630): used, no snapshot needed', () => {
        const p = page('gdocs-public.html', 'https://docs.google.com/document/d/1MPjVwL-oB8RT476yEPP47JEVqk6iVty5WpylrqsGESg/edit');
        expect(p.wall).toBe(false);
        expect(p.meta.title).toBe('(SAMPLE DOCUMENT) - How To Download Google Docs');
        expect(p.meta.image).toMatchObject({ width: 1200, height: 630 });
        expect(p.meta.image!.url).toMatch(/^https:\/\/lh7-us\.googleusercontent\.com\/docs\//);
    });

    it('a public Drive FILE page has no og:image: the viewer\'s own preloaded first-page picture is used', () => {
        const url = 'https://drive.google.com/file/d/1jWdfwVurLfpG71aOVsTOQQn6aV3lu7ya/view';
        const html = fx('gdrive-docx.html');
        expect(parsePageMeta(html, url).image).toBeUndefined(); // the root cause of "Google Drive gets no preview"
        const p = page('gdrive-docx.html', url);
        expect(p.wall).toBe(false);
        expect(p.meta.title).toBe('2021R_Updated curriculum and syllabus_04-04-2025.docx');
        expect(p.meta.image?.url).toMatch(/^https:\/\/drive\.google\.com\/drive-viewer\/AKGpih/);
        // Positive controls: the same tag on another host or path is not Drive's picture.
        expect(drivePicture(html, 'https://drive.google.com.evil.example/file/d/1jWdfwVurLfpG71aOVsTOQQn6aV3lu7ya/view')).toBeUndefined();
        expect(drivePicture(html, 'https://drive.google.com/drive/folders/1jWdfwVurLfpG71aOVsTOQQn6aV3lu7ya')).toBeUndefined();
        expect(drivePicture(html.replace('https://drive.google.com/drive-viewer/', 'https://evil.example/drive-viewer/'), url)).toBeUndefined();
    });

    it('a Drive file it cannot preview (.zip) has no picture at all: the snapshot step takes over', () => {
        const p = page('gdrive-zip.html', 'https://drive.google.com/file/d/18nRGlpZpYuUNVWsQ8v26Hvnqs-MHMcB8/view');
        expect(p.meta.title).toBe('image.zip');
        expect(p.meta.image).toBeUndefined();
    });

    it('a PRIVATE Google Doc answers 401 with a sign-in shell (no title, no picture): never a page card', () => {
        const p = page('gdocs-private.html', 'https://docs.google.com/document/d/16fWhE5jynZrw2nzDVrDq0TCnqo9vvt6_Ec2ni_gRKu0/edit');
        expect(p.meta.title).toBeUndefined();
        expect(p.meta.image).toBeUndefined();
    });
});

describe('bot walls are never a card (and the real pages are not walls: above)', () => {
    it.each([
        ['amazon-home-waf.html', 'https://www.amazon.com/'],                   // AWS WAF, HTTP 202, empty title
        ['amazon-product-captcha.html', 'https://www.amazon.com/dp/B0D1XD1ZV3'], // Amazon's robot check
        ['stackoverflow-challenge.html', 'https://stackoverflow.com/questions/1'], // Cloudflare "Just a moment..."
    ])('%s', (name, url) => {
        const p = page(name, url);
        expect(p.wall).toBe(true);
    });

    it('positive control: a wall title on a page WITH real metadata still counts as a wall; a real page with a captcha script somewhere does not', () => {
        expect(isBotWall('<title>Just a moment...</title>', { title: 'Just a moment...' })).toBe(true);
        expect(isBotWall('<script src="https://geo.captcha-delivery.com/x.js"></script>', { title: 'Shop', description: 'Real page' })).toBe(false);
        expect(isBotWall('<script src="https://geo.captcha-delivery.com/x.js"></script>', { title: 'Shop' })).toBe(true);
    });
});

describe('Tenor: a GIF with its real shape', () => {
    it('the loop file and og:video width / height (298 x 498, portrait)', () => {
        const html = fx('tenor-gif.html');
        const media = parseClipPage(html, 'tenor');
        expect(media).toMatchObject({ width: 298, height: 498 });
        expect(media!.url).toMatch(/^https:\/\/media\.tenor\.com\/.+\.mp4$/);
        const meta = parsePageMeta(html, 'https://tenor.com/view/x-3162456205570563299');
        expect(meta.image).toMatchObject({ width: 165, height: 276 }); // the poster has the same shape
    });
});

describe('Reddit post .json, captured live from old.reddit.com (preview UA)', () => {
    it('an image post: title, sub, author, score, comments, the picture', () => {
        const f = parseRedditPostJson(fx('reddit-live-image.json'))!;
        expect(f).toMatchObject({ title: 'My new cat discovered the Christmas Tree', sub: 'aww', author: 'cubsfan1384' });
        expect(f.score).toBeGreaterThan(1000);
        expect(f.images.length).toBe(1);
        expect(f.images[0].url).toMatch(/^https:\/\/(i|preview)\.redd\.it\//);
    });
    it('a text post: its words, no picture (the page picture is added by the shared fallback)', () => {
        const f = parseRedditPostJson(fx('reddit-live-self.json'))!;
        expect(f.sub).toBe('AskReddit');
        expect(f.images).toEqual([]);
        expect(f.video).toBeUndefined();
    });
    it('a video post: the v.redd.it file and a poster picture', () => {
        const f = parseRedditPostJson(fx('reddit-live-video.json'))!;
        expect(f.video?.url).toMatch(/^https:\/\/v\.redd\.it\//);
        expect(f.images.length).toBe(1);
    });
});
