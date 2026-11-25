// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    shortenLinkText, shortLinkAnchorProps, expandCopiedLinks, handleMessageCopy,
    LINK_SHORTEN_THRESHOLD, LINK_DISPLAY_MAX, FULL_URL_ATTR,
} from './linkDisplay';

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=7&t=43s&pp=iAQB';
const DOCS = 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg/edit?usp=sharing&tab=t.0';
const AMAZON = 'https://www.amazon.com/Some-Very-Long-Product-Title-With-Many-Words-Here/dp/B08N5WRWNW/ref=sr_1_3?crid=2K&keywords=thing&qid=1699999999&sprefix=thi%2Caps%2C150&sr=8-3';
const QUERY = 'https://example.org/search?q=how+to+shorten+links&utm_source=newsletter&utm_medium=email&utm_campaign=autumn_sale_2026&ref=footer';
const PUNY = 'https://xn--bcher-kva.example/some/really/long/path/that/keeps/going/and/going/forever/index.html';
const IP = 'https://192.168.100.200/admin/dashboard/reports/quarterly/2026/q3/summary-final-v2.pdf';
const PORT = 'http://localhost:3005/v1/some/deeply/nested/api/route/with/many/segments/and/a/trailing/id/12345';

describe('shortenLinkText', () => {
    it('leaves short links exactly as typed (including the scheme)', () => {
        for (const u of ['https://example.com', 'https://example.com/a/b?c=d', 'http://www.example.com/x']) {
            const r = shortenLinkText(u);
            expect(r.shortened).toBe(false);
            expect(r.text).toBe(u);
        }
    });

    it('threshold: 48 chars is untouched, 49 is shortened (positive control for the boundary)', () => {
        const base = 'https://example.com/';
        const at48 = base + 'a'.repeat(LINK_SHORTEN_THRESHOLD - base.length);
        const at49 = at48 + 'a';
        expect(at48.length).toBe(48);
        expect(shortenLinkText(at48).shortened).toBe(false);
        const r = shortenLinkText(at49);
        expect(r.shortened).toBe(true);
        // Fits once https:// is dropped -> no ellipsis, just the scheme gone.
        expect(r.text).toBe(at49.slice('https://'.length));
    });

    it('the spec example: scheme and www. dropped, host whole, middle elided, tail kept', () => {
        const r = shortenLinkText('https://www.example.com/some/really/long/path/to/article-name-here?utm_source=x&ref=y');
        expect(r.shortened).toBe(true);
        expect(r.text.startsWith('example.com/some/really/long')).toBe(true);
        expect(r.text).toContain('…');
        expect(r.text.endsWith('ce=x&ref=y')).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(LINK_DISPLAY_MAX);
    });

    it.each([
        ['youtube', YT, 'youtube.com'],
        ['google docs', DOCS, 'docs.google.com'],
        ['amazon', AMAZON, 'amazon.com'],
        ['long query string', QUERY, 'example.org'],
        ['punycode host', PUNY, 'xn--bcher-kva.example'],
        ['ip host', IP, '192.168.100.200'],
        ['port', PORT, 'localhost:3005'],
    ])('%s: shorter than the original, within budget, host shown whole', (_n, url, host) => {
        const r = shortenLinkText(url);
        expect(r.shortened).toBe(true);
        expect(r.host).toBe(host);
        expect(r.text.startsWith(host)).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(LINK_DISPLAY_MAX);
        expect(r.text.length).toBeLessThan(url.length);
        expect(r.text).not.toMatch(/^https?:/);
        expect(r.text.startsWith('www.')).toBe(false);
    });

    it('keeps a meaningful tail and an ellipsis for real-looking URLs', () => {
        expect(shortenLinkText(YT).text.endsWith(YT.slice(-10))).toBe(true);
        expect(shortenLinkText(DOCS).text.endsWith(DOCS.slice(-10))).toBe(true);
        expect(shortenLinkText(PORT).text.endsWith('/id/12345')).toBe(true);
        expect(shortenLinkText(YT).text).toContain('…');
    });

    it('never rewrites the host: punycode stays punycode (no Unicode prettifying)', () => {
        expect(shortenLinkText(PUNY).text.startsWith('xn--bcher-kva.example/')).toBe(true);
        expect(shortenLinkText(PUNY).text).not.toContain('bücher');
    });

    it('a very long host is kept whole, never trimmed', () => {
        const host = 'this-is-a-really-long-subdomain-label-that-eats-the-whole-budget.example.com';
        const r = shortenLinkText(`https://${host}/path/to/something/else`);
        expect(r.text.startsWith(host)).toBe(true);
        expect(r.text).toBe(`${host}/…`);
    });

    it('only strips www. when a real domain remains', () => {
        expect(shortenLinkText('https://www.example.com/' + 'a'.repeat(60)).host).toBe('example.com');
        expect(shortenLinkText('https://www/' + 'a'.repeat(60)).host).toBe('www');
    });

    it('does not rewrite a userinfo link (google.com@evil.com disguise)', () => {
        const u = 'https://accounts.google.com@evil.example/' + 'a'.repeat(60);
        const r = shortenLinkText(u);
        expect(r.shortened).toBe(false);
        expect(r.text).toBe(u);
    });

    it('is case-insensitive about the scheme and leaves non-http input alone', () => {
        expect(shortenLinkText('HTTPS://WWW.EXAMPLE.COM/' + 'a'.repeat(60)).host).toBe('EXAMPLE.COM');
        expect(shortenLinkText('ftp://example.com/' + 'a'.repeat(60)).shortened).toBe(false);
    });

    it('never cuts through a %XX escape', () => {
        for (let pad = 0; pad < 12; pad++) {
            const u = `https://example.com/${'a'.repeat(pad)}${'%E2%9C%93'.repeat(14)}end`;
            const t = shortenLinkText(u).text;
            const [head, tail] = t.split('…');
            expect(head).not.toMatch(/%[0-9A-Fa-f]?$/);
            expect(head.replace(/%[0-9A-Fa-f]{2}/g, '')).not.toContain('%');
            expect(tail).toMatch(/^(%|end)/);
        }
    });

    it('never splits a surrogate pair', () => {
        for (let pad = 0; pad < 6; pad++) {
            const u = `https://example.com/${'a'.repeat(pad)}${'😀'.repeat(30)}`;
            const t = shortenLinkText(u).text;
            expect(t).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
            expect(t).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
        }
    });

    it('anchor props: full URL as title, accessible name and copy marker; none when not shortened', () => {
        const r = shortenLinkText(YT);
        expect(shortLinkAnchorProps(YT, r)).toEqual({ title: YT, 'aria-label': YT, [FULL_URL_ATTR]: YT });
        expect(shortLinkAnchorProps('https://a.co', shortenLinkText('https://a.co'))).toEqual({});
    });
});

describe('expandCopiedLinks', () => {
    const short = shortenLinkText(YT).text;
    it('swaps a fully selected shortened link for its full URL, keeping surrounding text', () => {
        expect(expandCopiedLinks(`look: ${short} nice`, [{ full: YT, fullySelected: true }])).toBe(`look: ${YT} nice`);
    });
    it('handles several links in order', () => {
        const s2 = shortenLinkText(DOCS).text;
        expect(expandCopiedLinks(`${short}\n${s2}`, [
            { full: YT, fullySelected: true }, { full: DOCS, fullySelected: true },
        ])).toBe(`${YT}\n${DOCS}`);
    });
    it('leaves a partly selected link, and returns null when nothing changes', () => {
        expect(expandCopiedLinks(short.slice(3), [{ full: YT, fullySelected: false }])).toBeNull();
        expect(expandCopiedLinks('plain text', [])).toBeNull();
    });
});

// ── DOM: a real selection + the real handler ────────────────────────────────────

function mount(html: string): HTMLElement {
    document.body.innerHTML = `<div id="body">${html}</div>`;
    return document.getElementById('body') as HTMLElement;
}
function linkHtml(url: string): string {
    const r = shortenLinkText(url);
    const attrs = Object.entries(shortLinkAnchorProps(url, r)).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<span role="link" ${attrs}>${r.text}</span>`;
}
function copyEvent(body: HTMLElement) {
    const data: Record<string, string> = {};
    let prevented = false;
    return {
        e: {
            clipboardData: { setData: (t: string, v: string) => { data[t] = v; } } as unknown as DataTransfer,
            preventDefault: () => { prevented = true; },
            currentTarget: body,
        },
        data, prevented: () => prevented,
    };
}

describe('handleMessageCopy (jsdom selection)', () => {
    it('select-all over a message with a shortened link copies the FULL url', () => {
        const body = mount(`see ${linkHtml(YT)} please`);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(body);
        sel.addRange(r);
        const c = copyEvent(body);
        handleMessageCopy(c.e);
        expect(c.prevented()).toBe(true);
        expect(c.data['text/plain']).toBe(`see ${YT} please`);
    });

    it('selecting only the link text copies the full URL', () => {
        const body = mount(`x ${linkHtml(AMAZON)} y`);
        const link = body.querySelector('[role=link]')!;
        const r = document.createRange();
        r.selectNodeContents(link);
        const sel = window.getSelection()!;
        sel.removeAllRanges(); sel.addRange(r);
        const c = copyEvent(body);
        handleMessageCopy(c.e);
        expect(c.data['text/plain']).toBe(AMAZON);
    });

    it('a partial selection of the link is copied as selected (native)', () => {
        const body = mount(linkHtml(YT));
        const t = body.querySelector('[role=link]')!.firstChild!;
        const r = document.createRange();
        r.setStart(t, 2); r.setEnd(t, 9);
        const sel = window.getSelection()!;
        sel.removeAllRanges(); sel.addRange(r);
        const c = copyEvent(body);
        handleMessageCopy(c.e);
        expect(c.prevented()).toBe(false);
        expect(c.data['text/plain']).toBeUndefined();
    });

    it('a short (unshortened) link and plain text are not touched', () => {
        const body = mount(`hi ${linkHtml('https://example.com')}`);
        const r = document.createRange();
        r.selectNodeContents(body);
        const sel = window.getSelection()!;
        sel.removeAllRanges(); sel.addRange(r);
        const c = copyEvent(body);
        handleMessageCopy(c.e);
        expect(c.prevented()).toBe(false);
    });

    it('collapsed selection does nothing', () => {
        const body = mount(linkHtml(YT));
        window.getSelection()!.removeAllRanges();
        const c = copyEvent(body);
        handleMessageCopy(c.e);
        expect(c.prevented()).toBe(false);
    });
});

describe('ChatPane wiring (source-level)', () => {
    const src = readFileSync(join(__dirname, '../../components/ChatPane.tsx'), 'utf8');
    const fn = src.slice(src.indexOf('function renderTextWithLinks('), src.indexOf('// ── Mention / custom-emoji token regex'));
    it('the bare-link span shows the short text but opens, titles and names the FULL url', () => {
        expect(fn).toContain('const display = shortenLinkText(url);');
        expect(fn).toContain('{...shortLinkAnchorProps(url, display)}');
        expect(fn).toContain('{display.text}');
        expect(fn).toContain('openUrl(url);');
    });
    it('the message body copies full URLs, and nothing else gets a DOM-reading copy path', () => {
        expect(src).toContain('onCopy={handleMessageCopy}');
        // "Copy Text" reads the raw message content, not the rendered DOM.
        expect(src).not.toMatch(/\.(innerText|textContent)/);
    });
});
