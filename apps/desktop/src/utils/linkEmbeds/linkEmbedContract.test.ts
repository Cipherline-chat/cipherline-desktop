/**
 * packages/shared/link-embeds.ts: the reader-side validator every client runs
 * on a sender's embeds (the sender is untrusted), and the edit rule.
 */
import { describe, it, expect } from 'vitest';
import {
    sanitizeLinkEmbeds, sanitizeLinkEmbed, sanitizeEmbedImage, withEditEmbeds, linkEmbedAttachmentIds, cleanEmbedText,
    LINK_EMBED_MAX_PER_MESSAGE, LINK_EMBED_MAX_JSON_BYTES, LINK_EMBED_THUMB_INLINE_MAX_BYTES, LINK_EMBED_THUMB_MAX_BYTES,
    type LinkEmbed,
} from '@cipherline/shared';
import { embedUrlsOf } from '../formatting/plainText';

const KEY = 'A'.repeat(43) + '=';
const NONCE = 'B'.repeat(16);
const ID = '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c';
const thumbAtt = { mime: 'image/webp', width: 640, height: 335, attachment_id: ID, file_key_b64: KEY, file_nonce_b64: NONCE, byte_size: 40_000 };
const card = (url: string, extra: Partial<LinkEmbed> = {}): LinkEmbed => ({ url, kind: 'card', title: 'A page', ...extra });

describe('sanitizeLinkEmbeds: tied to the links in the text', () => {
    const text = 'look https://news.example/a and https://b.example/x';
    const urls = embedUrlsOf(text);

    it('keeps embeds for links that are in the text, in the sender\'s order', () => {
        const out = sanitizeLinkEmbeds([card('https://b.example/x'), card('https://news.example/a')], urls);
        expect(out.map((e) => e.url)).toEqual(['https://b.example/x', 'https://news.example/a']);
    });

    it('POSITIVE CONTROL: a forged embed for a URL not in the text is ignored', () => {
        const forged = card('https://phish.example/login', { title: 'Your bank', description: 'Sign in' });
        expect(sanitizeLinkEmbeds([forged], urls)).toEqual([]);
        expect(sanitizeLinkEmbeds([forged, card('https://news.example/a')], urls).map((e) => e.url)).toEqual(['https://news.example/a']);
    });

    it('a link the reader does not embed (spoiler, code, <url>) gets no sender card either', () => {
        for (const t of ['||https://news.example/a||', '`https://news.example/a`', '<https://news.example/a>']) {
            expect(sanitizeLinkEmbeds([card('https://news.example/a')], embedUrlsOf(t))).toEqual([]);
        }
    });

    it('at most five, one per URL', () => {
        const many = 'https://a.example/1 https://a.example/2 https://a.example/3 https://a.example/4 https://a.example/5 https://a.example/6';
        const u = embedUrlsOf(many);
        const out = sanitizeLinkEmbeds([...u.map((x) => card(x)), card(u[0])], u);
        expect(out).toHaveLength(LINK_EMBED_MAX_PER_MESSAGE);
        expect(new Set(out.map((e) => e.url)).size).toBe(out.length);
    });

    it('the text part is capped at 8 KB in total', () => {
        const u = Array.from({ length: 5 }, (_, i) => `https://a.example/${i}`);
        const fat = u.map((x) => card(x, { title: 't'.repeat(256), description: 'd'.repeat(350), author: 'a'.repeat(120), site: 's'.repeat(80) }));
        const out = sanitizeLinkEmbeds(fat, u);
        expect(JSON.stringify(out).length).toBeLessThanOrEqual(LINK_EMBED_MAX_JSON_BYTES);
        expect(out.length).toBeGreaterThan(0);
    });

    it('junk never throws', () => {
        for (const raw of [null, undefined, 'x', 5, {}, [null, 7, 'x', [], { url: 5 }], [{ url: 'https://news.example/a', kind: 'nope', title: 't' }]]) {
            expect(sanitizeLinkEmbeds(raw, urls)).toEqual([]);
        }
    });
});

describe('sanitizeLinkEmbed: fields', () => {
    it('text is plain, cleaned and capped; colour must be #rrggbb', () => {
        const e = sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', title: '<b>Hi</b>‮\u0000 there', description: 'x'.repeat(1000), color: 'red', site: '  Site  ' })!;
        expect(e.title).toBe('<b>Hi</b> there'); // drawn as text, never markup
        expect(Array.from(e.description!).length).toBe(350);
        expect(e.color).toBeUndefined();
        expect(e.site).toBe('Site');
        expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', title: 't', color: '#ABC' })!.color).toBe('#aabbcc');
    });

    it('media must be https with an allowed type; only on video/image kinds', () => {
        const ok = sanitizeLinkEmbed({ url: 'https://medal.tv/clips/abcd', kind: 'video', title: 't', media: { url: 'https://cdn.medal.tv/a.mp4', mime: 'video/mp4', width: 1280, height: 720, duration_s: 24.15 } })!;
        expect(ok.media).toEqual({ url: 'https://cdn.medal.tv/a.mp4', mime: 'video/mp4', width: 1280, height: 720, duration_s: 24.15 });
        for (const media of [{ url: 'http://cdn.medal.tv/a.mp4', mime: 'video/mp4' }, { url: 'javascript:alert(1)', mime: 'video/mp4' }, { url: 'https://cdn.medal.tv/a.mp4', mime: 'text/html' }, { url: 'https://u:p@cdn.medal.tv/a.mp4', mime: 'video/mp4' }]) {
            expect(sanitizeLinkEmbed({ url: 'https://medal.tv/clips/abcd', kind: 'video', title: 't', media })!.media).toBeUndefined();
        }
        expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', title: 't', media: { url: 'https://a.example/a.mp4', mime: 'video/mp4' } })!.media).toBeUndefined();
    });

    it('a player must be an allowlisted provider with a well-formed id; there is no frame URL field', () => {
        expect(sanitizeLinkEmbed({ url: 'https://youtu.be/jNQXAC9IVRw', kind: 'player', player: { provider: 'youtube', id: 'jNQXAC9IVRw', start_s: 5 } })!.player).toEqual({ provider: 'youtube', id: 'jNQXAC9IVRw', start_s: 5 });
        expect(sanitizeLinkEmbed({ url: 'https://x.example/', kind: 'player', player: { provider: 'evil', id: 'jNQXAC9IVRw' } })).toBeUndefined();
        expect(sanitizeLinkEmbed({ url: 'https://x.example/', kind: 'player', player: { provider: 'youtube', id: '"><script>' } })).toBeUndefined();
        const withSrc = sanitizeLinkEmbed({ url: 'https://youtu.be/jNQXAC9IVRw', kind: 'player', player: { provider: 'youtube', id: 'jNQXAC9IVRw', src: 'https://evil.example/' } })!;
        expect(JSON.stringify(withSrc)).not.toContain('evil');
    });

    it('a card with nothing to show is dropped; the MINIMAL card (a site only) is kept, for a card only', () => {
        expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card' })).toBeUndefined();
        expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', site: '  ' })).toBeUndefined();
        expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', site: 'only a site' })).toEqual({ url: 'https://a.example/', kind: 'card', site: 'only a site' });
        // Positive control: other kinds still need something of their own.
        for (const kind of ['video', 'post', 'image']) expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind, site: 'only a site' })).toBeUndefined();
    });
});

describe('sanitizeEmbedImage', () => {
    it('an attachment reference must be well-formed and within the cap', () => {
        expect(sanitizeEmbedImage(thumbAtt)).toEqual(thumbAtt);
        expect(sanitizeEmbedImage({ ...thumbAtt, byte_size: LINK_EMBED_THUMB_MAX_BYTES + 1 })).toBeUndefined();
        expect(sanitizeEmbedImage({ ...thumbAtt, attachment_id: '../../etc' })).toBeUndefined();
        expect(sanitizeEmbedImage({ ...thumbAtt, file_key_b64: 'short' })).toBeUndefined();
        expect(sanitizeEmbedImage({ ...thumbAtt, mime: 'image/svg+xml' })).toBeUndefined();
        expect(sanitizeEmbedImage({ ...thumbAtt, width: 0 })).toBeUndefined();
        expect(sanitizeEmbedImage({ ...thumbAtt, width: 99999 })).toBeUndefined();
    });
    it('inline bytes: base64 within the inline cap, and never both sources', () => {
        const small = btoa('x'.repeat(100));
        expect(sanitizeEmbedImage({ mime: 'image/webp', width: 10, height: 10, inline_b64: small })?.inline_b64).toBe(small);
        const big = btoa('x'.repeat(LINK_EMBED_THUMB_INLINE_MAX_BYTES + 3));
        expect(sanitizeEmbedImage({ mime: 'image/webp', width: 10, height: 10, inline_b64: big })).toBeUndefined();
        expect(sanitizeEmbedImage({ mime: 'image/webp', width: 10, height: 10, inline_b64: 'not base64!!' })).toBeUndefined();
        expect(sanitizeEmbedImage({ ...thumbAtt, inline_b64: small })).toBeUndefined();
    });
});

describe('edits and helpers', () => {
    const base = { type: 'text', text: 'https://a.example/', embeds: [card('https://a.example/')] };
    it('withEditEmbeds: array replaces, null / [] removes, absent keeps', () => {
        expect(withEditEmbeds(base, { type: 'edit', embeds: [card('https://a.example/', { title: 'new' })] }).embeds?.[0].title).toBe('new');
        expect('embeds' in withEditEmbeds(base, { type: 'edit', embeds: null })).toBe(false);
        expect('embeds' in withEditEmbeds(base, { type: 'edit', embeds: [] })).toBe(false);
        expect(withEditEmbeds(base, { type: 'edit', text: 'x' })).toBe(base);
        expect(withEditEmbeds(base, { type: 'edit', embeds: 'junk' })).toBe(base);
    });
    it('linkEmbedAttachmentIds lists only valid thumbnail attachments', () => {
        expect(linkEmbedAttachmentIds([card('https://a.example/', { thumb: thumbAtt as LinkEmbed['thumb'] }), { thumb: { attachment_id: 'bad' } }])).toEqual([ID]);
    });
    it('cleanEmbedText', () => {
        expect(cleanEmbedText('  a\n\tb  ', 10)).toBe('a b');
        expect(cleanEmbedText('', 10)).toBeUndefined();
        expect(cleanEmbedText(5, 10)).toBeUndefined();
        expect(cleanEmbedText('abcdefghijkl', 5)).toBe('abcd…');
    });
});
