import { describe, it, expect } from 'vitest';
import {
    KLIPY_MEDIA_HOSTS,
    KLIPY_ALLOWED_HOSTS,
    isKlipyMediaUrl,
    klipyGifProblem,
    parseKlipyGifRef,
} from '@cipherline/shared';
import { contentProblem } from './contentValidation';

/**
 * The `klipy_gif` content variant (packages/shared/klipy.ts) names a URL that
 * the RECIPIENT's client loads. The sender is untrusted, so this validator is
 * the only thing between a GIF message and an IP-logging tracking pixel on an
 * arbitrary host. These cases are also the executable spec the mobile client
 * mirrors (docs/klipy-client-contract.md).
 */

const URL_OK = 'https://static.klipy.com/ii/abc123/de/f0/Ab12Cd34.webp';
const GOOD = {
    type: 'klipy_gif',
    slug: 'happy-dance-KLx9',
    media: { url: URL_OK, width: 498, height: 480, mime: 'image/webp' },
    title: 'Happy dance',
};
const withMedia = (m: Record<string, unknown>) => ({ ...GOOD, media: { ...GOOD.media, ...m } });

describe('isKlipyMediaUrl — exact KLIPY CDN allowlist', () => {
    it.each(KLIPY_MEDIA_HOSTS.map(h => [h]))('accepts https://%s/…', (h) => {
        expect(isKlipyMediaUrl(`https://${h}/ii/x/y.gif`)).toBe(true);
    });

    it('accepts a query string (KLIPY delivery params are preserved verbatim)', () => {
        expect(isKlipyMediaUrl('https://static.klipy.com/a/b.gif?v=2&sig=Ab_c-1')).toBe(true);
    });

    it.each([
        ['plain http', 'http://static.klipy.com/a.gif'],
        ['protocol-relative', '//static.klipy.com/a.gif'],
        ['data: URI', 'data:image/gif;base64,R0lGOD'],
        ['javascript:', 'javascript:alert(1)'],
        ['the marketing site', 'https://klipy.com/a.gif'],
        ['the API host (not a media host)', 'https://api.klipy.com/a.gif'],
        ['suffix look-alike', 'https://static.klipy.com.evil.net/a.gif'],
        ['prefix look-alike', 'https://evilstatic.klipy.com/a.gif'],
        ['other subdomain', 'https://static3.klipy.com/a.gif'],
        ['wrong TLD', 'https://static.klipy.co/a.gif'],
        ['hyphen look-alike', 'https://static-klipy.com/a.gif'],
        ['trailing-dot host', 'https://static.klipy.com./a.gif'],
        ['explicit port', 'https://static.klipy.com:443/a.gif'],
        ['non-default port', 'https://static.klipy.com:8443/a.gif'],
        ['userinfo before an attacker host', 'https://static.klipy.com@evil.net/a.gif'],
        ['userinfo on the real host', 'https://user:pw@static.klipy.com/a.gif'],
        ['backslash host confusion', 'https://static.klipy.com\\@evil.net/a.gif'],
        ['uppercase host', 'https://STATIC.KLIPY.COM/a.gif'],
        ['no path', 'https://static.klipy.com'],
        ['fragment', 'https://static.klipy.com/a.gif#x'],
        ['embedded whitespace', 'https://static.klipy.com/a b.gif'],
        ['leading whitespace', ' https://static.klipy.com/a.gif'],
        ['trailing newline', 'https://static.klipy.com/a.gif\n'],
        ['quote (attribute breakout)', 'https://static.klipy.com/a.gif"onerror="x'],
        ['angle bracket', 'https://static.klipy.com/<a>.gif'],
        ['empty', ''],
    ])('rejects %s', (_label, url) => {
        expect(isKlipyMediaUrl(url)).toBe(false);
    });

    it('rejects non-strings and over-long URLs', () => {
        expect(isKlipyMediaUrl(undefined)).toBe(false);
        expect(isKlipyMediaUrl(42)).toBe(false);
        expect(isKlipyMediaUrl({ toString: () => URL_OK })).toBe(false);
        expect(isKlipyMediaUrl(`https://static.klipy.com/${'a'.repeat(2048)}`)).toBe(false);
    });

    it('the host list is exactly KLIPY’s documented API + media hosts', () => {
        expect([...KLIPY_ALLOWED_HOSTS].sort()).toEqual(
            ['api.klipy.com', 'static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'],
        );
    });
});

describe('klipyGifProblem — the klipy_gif content shape', () => {
    it('accepts a well-formed payload, with or without a title', () => {
        expect(klipyGifProblem(GOOD)).toBeNull();
        const noTitle: Record<string, unknown> = { ...GOOD };
        delete noTitle.title;
        expect(klipyGifProblem(noTitle)).toBeNull();
        expect(klipyGifProblem(withMedia({ mime: 'image/gif' }))).toBeNull();
    });

    it.each([
        ['wrong type', { ...GOOD, type: 'text' }],
        ['missing slug', { ...GOOD, slug: undefined }],
        ['slug with a slash', { ...GOOD, slug: '../x' }],
        ['slug too long', { ...GOOD, slug: 'a'.repeat(201) }],
        ['media missing', { ...GOOD, media: undefined }],
        ['media is an array', { ...GOOD, media: [] }],
        ['non-KLIPY url', withMedia({ url: 'https://evil.net/pixel.gif' })],
        ['http url', withMedia({ url: 'http://static.klipy.com/a.gif' })],
        ['zero width', withMedia({ width: 0 })],
        ['fractional height', withMedia({ height: 10.5 })],
        ['huge width', withMedia({ width: 100000 })],
        ['string width', withMedia({ width: '480' })],
        ['video mime', withMedia({ mime: 'video/mp4' })],
        ['svg mime', withMedia({ mime: 'image/svg+xml' })],
        ['numeric title', { ...GOOD, title: 7 }],
        ['title too long', { ...GOOD, title: 'x'.repeat(201) }],
        ['numeric client_msg_id', { ...GOOD, client_msg_id: 5 }],
        ['null', null],
        ['array', [GOOD]],
    ])('rejects %s', (_label, c) => {
        expect(klipyGifProblem(c)).not.toBeNull();
    });

    it('is wired into the decrypted-content boundary (a bad one becomes a placeholder)', () => {
        expect(contentProblem(GOOD)).toBeNull();
        expect(contentProblem(withMedia({ url: 'https://tracker.example/p.gif' }))).not.toBeNull();
    });
});

describe('parseKlipyGifRef — copies only known fields', () => {
    it('drops unknown keys a sender smuggled in', () => {
        const ref = parseKlipyGifRef({ ...GOOD, onload: 'x', media: { ...GOOD.media, srcset: 'https://evil.net/a 2x' } });
        expect(ref).toEqual({
            slug: GOOD.slug,
            media: { url: URL_OK, width: 498, height: 480, mime: 'image/webp' },
            title: 'Happy dance',
        });
    });

    it('returns null for anything the validator rejects', () => {
        expect(parseKlipyGifRef(withMedia({ url: 'https://static.klipy.com.evil.net/a.gif' }))).toBeNull();
        expect(parseKlipyGifRef('nope')).toBeNull();
    });
});
