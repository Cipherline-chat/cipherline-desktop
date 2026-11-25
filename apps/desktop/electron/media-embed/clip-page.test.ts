/**
 * Clip-page parsing against pages saved LIVE on 2026-11-23 (__fixtures__/,
 * trimmed to their meta / JSON-LD blocks, signatures redacted).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipTitle, decodeEntities, jsonLdVideoUrls, metaTags, parseClipPage } from './clip-page';

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

describe('parseClipPage on real pages', () => {
    it('Medal: the JSON-LD contentUrl (the clip file, signed cdn.medal.tv mp4) beats og:video', () => {
        const m = parseClipPage(fx('medal-clip.html'), 'medal')!;
        expect(m.url).toBe('https://cdn.medal.tv/mediac/nMMYxJgAb8bP9b.mp4?auth=exp=1795469400~data=REDACTEDDATA~hmac=REDACTEDHMAC');
        expect(m.width).toBe(1280);
        expect(m.height).toBe(720);
        expect(m.title).toBe('wyw my sweetie // Clips in my Discord');
    });

    it('Medal: without JSON-LD, the og:video API URL (extension-less, declared video/mp4) is used', () => {
        const html = fx('medal-clip.html').replace(/<script[^>]*ld\+json[\s\S]*?<\/script>/g, '');
        const m = parseClipPage(html, 'medal')!;
        expect(m.url).toMatch(/^https:\/\/medal\.tv\/api\/content\/nYiYMMGqugp5N9XWt\/socialVideoUrl\?v=24\.15&i=/);
    });

    it('Streamable: og:video (signed CloudFront mp4); the HTML twitter:player:stream is ignored', () => {
        const m = parseClipPage(fx('streamable-moo.html'), 'streamable')!;
        expect(m.url).toMatch(/^https:\/\/cdn-cf-west\.streamable\.com\/video\/f6441ae0c84311e4af010bc47400a0a4\.mp4\?Expires=/);
        expect(m.width).toBe(852);
        expect(m.height).toBe(480);
        expect(m.title).toBe("Please don't eat me!");
    });

    it('Tenor: the mp4 rendition on media.tenor.com (not the .gif og:image, not webm first)', () => {
        const m = parseClipPage(fx('tenor-view.html'), 'tenor')!;
        expect(m.url).toBe('https://media.tenor.com/gs59zxSVz8AAAAPo/aww-yeah.mp4');
        expect(m.title).toBe('Aww Yeah GIF - Aww Yeah Get');
    });

    it('Imgur page: the .gif mislabelled as video/mp4 is skipped for the real mp4', () => {
        const html = fx('imgur-page.html');
        expect(html).toContain('og:video" data-react-helmet="true" content="https://i.imgur.com/A61SaA1.gif"');
        expect(parseClipPage(html, 'imgur')!.url).toBe('https://i.imgur.com/A61SaA1.mp4');
    });

    it('Imgur .gifv page agrees with the pattern main uses without fetching it', () => {
        expect(parseClipPage(fx('imgur-gifv.html'), 'imgur')!.url).toBe('https://i.imgur.com/A61SaA1.mp4');
    });

    it('a provider mismatch finds nothing (Medal\'s files are not Streamable\'s CDN)', () => {
        expect(parseClipPage(fx('medal-clip.html'), 'streamable')).toBeNull();
    });
});

describe('parseClipPage refusals', () => {
    const page = (metas: string) => `<html><head>${metas}</head></html>`;
    it('no video tags → null', () => {
        expect(parseClipPage(page('<meta property="og:image" content="https://cdn.medal.tv/x.jpg">'), 'medal')).toBeNull();
        expect(parseClipPage('', 'medal')).toBeNull();
    });
    it('http, credentials, ports, foreign hosts and image extensions are refused', () => {
        for (const u of ['http://cdn.medal.tv/a.mp4', 'https://u:p@cdn.medal.tv/a.mp4', 'https://cdn.medal.tv:8443/a.mp4',
            'https://evil.example/a.mp4', 'https://cdn.medal.tv/a.gif', 'javascript:alert(1)', '/relative.mp4']) {
            expect(parseClipPage(page(`<meta property="og:video" content="${u}"><meta property="og:video:type" content="video/mp4">`), 'medal'), u).toBeNull();
        }
    });
    it('an extension-less URL needs a declared video type', () => {
        expect(parseClipPage(page('<meta property="og:video" content="https://cdn.medal.tv/api/x">'), 'medal')).toBeNull();
        expect(parseClipPage(page('<meta property="og:video" content="https://cdn.medal.tv/api/x"><meta property="og:video:type" content="text/html">'), 'medal')).toBeNull();
        expect(parseClipPage(page('<meta property="og:video" content="https://cdn.medal.tv/api/x"><meta property="og:video:type" content="video/mp4">'), 'medal')!.url).toBe('https://cdn.medal.tv/api/x');
    });
    it('malformed JSON-LD is skipped, not fatal', () => {
        const html = '<script type="application/ld+json">{not json</script><meta property="og:video" content="https://cdn.medal.tv/a.mp4">';
        expect(parseClipPage(html, 'medal')!.url).toBe('https://cdn.medal.tv/a.mp4');
    });
});

describe('scanner helpers', () => {
    it('decodes the entities pages use, leaves unknown ones', () => {
        expect(decodeEntities('a&amp;b &quot;q&quot; &#x27;s&#39; &lt;&gt; &bogus; &#0;')).toBe('a&b "q" \'s\' <> &bogus; &#0;');
    });
    it('reads meta in either attribute order and quote style', () => {
        expect(metaTags(`<meta content='https://x/a.mp4' property=og:video><META NAME="twitter:player:stream" CONTENT="b">`))
            .toEqual([{ key: 'og:video', content: 'https://x/a.mp4' }, { key: 'twitter:player:stream', content: 'b' }]);
    });
    it('JSON-LD: VideoObject contentUrl only, through arrays and @graph, in order', () => {
        const ld = JSON.stringify({ '@graph': [{ '@type': 'ImageObject', contentUrl: 'https://x/i.gif' }, { '@type': 'VideoObject', contentUrl: 'https://x/1.mp4' }, [{ '@type': ['VideoObject'], contentUrl: 'https://x/2.mp4' }]] });
        expect(jsonLdVideoUrls(`<script type="application/ld+json">${ld}</script>`)).toEqual(['https://x/1.mp4', 'https://x/2.mp4']);
    });
});

describe('clipTitle', () => {
    it('is plain, bounded text with the provider boilerplate removed', () => {
        expect(clipTitle('Insane 1v4 - Clipped Valorant with Medal.tv', 'medal')).toBe('Insane 1v4');
        expect(clipTitle('a\u202Eb<script>', 'imgur')).toBe('ab<script>'); // text only; React renders it as text
        expect(clipTitle('x'.repeat(400), 'imgur')!.length).toBe(120);
        expect(clipTitle('', 'medal')).toBeUndefined();
        expect(clipTitle(undefined, 'medal')).toBeUndefined();
    });
});
