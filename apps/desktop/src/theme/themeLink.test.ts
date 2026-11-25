import { describe, expect, it } from 'vitest';
import { CUSTOM_THEME_PRESETS } from './customPresets';
import { CUSTOM_THEME_SHARE_PREFIX, encodeShareCode, type CustomThemeDef } from './customTheme';
import {
    THEME_LINK_BASE, THEME_LINK_CODE_MAX, buildThemeDeepLink, buildThemeLink, isThemeCodeShape, isThemeLinkUrl, labelThemeLinks,
    parseThemeLink, sameThemeLook, themeCodeFromDeepLink, themeCodeFromFragment, themeCodeFromLink, themeLinkLabel, themeShareMessage,
} from './themeLink';

const presets = CUSTOM_THEME_PRESETS.map((p) => p.def);
const ocean = CUSTOM_THEME_PRESETS.find((p) => p.key === 'ocean')!.def;
const rose = CUSTOM_THEME_PRESETS.find((p) => p.key === 'rose')!.def;

/** base64url of arbitrary JSON text, as a crafted link would carry it. */
const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const crafted = (o: unknown) => `${THEME_LINK_BASE}${CUSTOM_THEME_SHARE_PREFIX}${b64(JSON.stringify(o))}`;

describe('theme links: build and parse', () => {
    it('a link is the site origin, /theme, and the share code in the FRAGMENT only', () => {
        const link = buildThemeLink(ocean);
        const u = new URL(link);
        expect(u.origin).toBe('https://cipherline.chat');
        expect(u.pathname).toBe('/theme');
        expect(u.search).toBe('');
        // What a browser would request: everything before '#' — no theme data at all.
        expect(link.split('#')[0]).toBe('https://cipherline.chat/theme');
        expect(u.hash).toBe(`#${encodeShareCode(ocean)}`);
    });

    it('round-trips every preset to the same normalised theme', () => {
        for (const def of presets) {
            const p = parseThemeLink(buildThemeLink(def));
            expect(p.kind).toBe('ok');
            if (p.kind === 'ok') {
                expect(p.result.def).toEqual(def);
                expect(p.code).toBe(encodeShareCode(def));
            }
        }
    });

    it('typical links stay short (well under 800 characters)', () => {
        for (const def of presets) expect(buildThemeLink(def).length).toBeLessThan(400);
        const longName: CustomThemeDef = { ...ocean, name: 'W'.repeat(40) };
        expect(buildThemeLink(longName).length).toBeLessThan(420);
        const emojiName: CustomThemeDef = { ...ocean, name: '🌊'.repeat(40) };
        expect(buildThemeLink(emojiName).length).toBeLessThan(600);
        expect(encodeShareCode(emojiName).length).toBeLessThan(THEME_LINK_CODE_MAX);
    });

    it('a code never ends in a character the message URL grammar trims (`_`)', () => {
        // The JSON always ends in `}`, so the last base64url character is 9, Q or 0.
        const names = ['a', 'ab', 'abc', 'abcd', 'Ocean', 'Rosé', '🌊', 'x'.repeat(39)];
        for (const def of presets) for (const name of names) {
            const code = encodeShareCode({ ...def, name });
            expect(code).not.toMatch(/_$/);
            expect(code).toMatch(/[9Q0]$/);
        }
    });

    it('accepts the forms people will paste: upper-case host, http, trailing slash, percent-encoded fragment', () => {
        const code = encodeShareCode(rose);
        for (const url of [
            `https://CIPHERLINE.chat/theme#${code}`,
            `http://cipherline.chat/theme#${code}`,
            `https://cipherline.chat/theme/#${code}`,
            `https://cipherline.chat/theme#${code.replace('.', '%2E')}`,
        ]) expect(themeCodeFromLink(url)).toBe(code);
    });

    it('refuses other hosts, paths and placements', () => {
        const code = encodeShareCode(rose);
        for (const url of [
            `https://www.cipherline.chat/theme#${code}`,
            `https://cipherline.chat.evil.io/theme#${code}`,
            `https://evil.io/theme#${code}`,
            `https://cipherline.chat/themes#${code}`,
            `https://cipherline.chat/theme?c=${code}`,
            `https://cipherline.chat/theme/${code}`,
            `https://cipherline.chat/invite/abc#${code}`,
            `cipherline://theme#${code}`,
        ]) expect(isThemeLinkUrl(url)).toBe(false);
    });

    it('a theme link with an unusable fragment is "invalid" (the small card), not "none"', () => {
        for (const url of [
            'https://cipherline.chat/theme#',
            'https://cipherline.chat/theme#hello',
            'https://cipherline.chat/theme#clth1.',
            'https://cipherline.chat/theme#clth1.@@@',
            'https://cipherline.chat/theme#clth2.abcd',
            `https://cipherline.chat/theme#${encodeShareCode(rose)}?x=1`,
            `https://cipherline.chat/theme#${encodeShareCode(rose).slice(0, -6)}`, // cut off
        ]) expect(parseThemeLink(url).kind).toBe('invalid');
        expect(parseThemeLink('https://cipherline.chat/theme').kind).toBe('none');
        expect(parseThemeLink('https://example.com/').kind).toBe('none');
        expect(parseThemeLink(42).kind).toBe('none');
    });

    it('caps the code length before decoding anything', () => {
        const huge = `${THEME_LINK_BASE}clth1.${'A'.repeat(THEME_LINK_CODE_MAX + 10)}`;
        expect(themeCodeFromLink(huge)).toBeNull();
        expect(isThemeCodeShape(`clth1.${'A'.repeat(THEME_LINK_CODE_MAX)}`)).toBe(false);
        expect(themeCodeFromFragment(`#clth1.${'A'.repeat(5000)}`)).toBeNull();
    });
});

describe('theme links: the import validator is the gate (malicious payloads)', () => {
    const base = { v: 1, name: 'x', base: 'dark', glow: true, colors: { ...ocean.colors } };
    it.each([
        ['url()', { ...base, colors: { ...base.colors, bg: 'url(https://evil.example/x.png)' } }],
        ['var()', { ...base, colors: { ...base.colors, accent: 'var(--cl-lume)' } }],
        ['expression()', { ...base, colors: { ...base.colors, text: 'expression(alert(1))' } }],
        ['CSS injection', { ...base, colors: { ...base.colors, panel: '#000; } body { display:none' } }],
        ['a theme() token', { ...base, colors: { ...base.colors, panel: 'theme(lume)' } }],
        ['a non-string colour', { ...base, colors: { ...base.colors, panel: { r: 1 } } }],
        ['bad base', { ...base, base: 'neon' }],
        ['future version', { ...base, v: 2 }],
        ['an array', [1, 2, 3]],
        ['too large', { ...base, name: 'x', pad: 'y'.repeat(2100) }],
    ])('refuses %s', (_label, payload) => {
        expect(parseThemeLink(crafted(payload)).kind).toBe('invalid');
    });

    it('cleans a hostile name (bidi overrides, control characters) and caps it', () => {
        const p = parseThemeLink(crafted({ ...base, name: '‮evil\u0000<script>' + 'n'.repeat(80) }));
        expect(p.kind).toBe('ok');
        if (p.kind === 'ok') {
            expect(p.result.def.name).not.toMatch(/[‮\u0000]/);
            expect(Array.from(p.result.def.name).length).toBeLessThanOrEqual(40);
        }
    });

    it('extra keys are dropped: only the nine colours, base, glow and the name survive', () => {
        const p = parseThemeLink(crafted({ ...base, css: 'body{}', onload: 'x', colors: { ...base.colors, extra: '#fff' } }));
        expect(p.kind).toBe('ok');
        if (p.kind === 'ok') {
            expect(Object.keys(p.result.def).sort()).toEqual(['base', 'colors', 'glow', 'name', 'v']);
            expect(Object.keys(p.result.def.colors)).toHaveLength(9);
        }
    });

    it('a low-contrast pick arrives exactly as the sender made it (no nudge, no "adjusted" note)', () => {
        const colors = { ...base.colors, text: '#0b2030', muted: '#0c2131' };
        const p = parseThemeLink(crafted({ ...base, colors }));
        expect(p.kind).toBe('ok');
        if (p.kind === 'ok') {
            expect(p.result.def.colors).toEqual(colors);
            expect(p.result).not.toHaveProperty('adjustments');
        }
    });
});

describe('theme deep links (cipherline://theme#…)', () => {
    it('builds only from a code-shaped string', () => {
        const code = encodeShareCode(ocean);
        expect(buildThemeDeepLink(code)).toBe(`cipherline://theme#${code}`);
        expect(buildThemeDeepLink('javascript:alert(1)')).toBeNull();
        expect(buildThemeDeepLink('clth1.a b')).toBeNull();
        expect(themeCodeFromDeepLink(`cipherline://theme#${code}`)).toBe(code);
        expect(themeCodeFromDeepLink(`cipherline://invite#${code}`)).toBeNull();
    });
});

describe('theme links in plain-text previews and the share message', () => {
    it('labels a valid link with the theme name, an unreadable one generically', () => {
        const link = buildThemeLink(ocean);
        expect(themeLinkLabel(link)).toBe('Theme: Ocean');
        expect(labelThemeLinks(`try this ${link} !`)).toBe('try this Theme: Ocean !');
        expect(labelThemeLinks('https://cipherline.chat/theme#clth1.zzzz')).toBe('Theme link');
        expect(labelThemeLinks('no links here')).toBe('no links here');
    });

    it('the message is the optional note, then the link on its own line', () => {
        expect(themeShareMessage(ocean)).toBe(buildThemeLink(ocean));
        expect(themeShareMessage(ocean, '  try this  ')).toBe(`try this\n${buildThemeLink(ocean)}`);
    });

    it('sameThemeLook ignores the name, not the colours', () => {
        expect(sameThemeLook(ocean, { ...ocean, name: 'Other' })).toBe(true);
        expect(sameThemeLook(ocean, { ...ocean, colors: { ...ocean.colors, accent: '#ff0000' } })).toBe(false);
        expect(sameThemeLook(ocean, { ...ocean, glow: !ocean.glow })).toBe(false);
    });
});
