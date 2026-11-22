import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedKindOf } from './embedKind';
import { buildThemeLink } from '../../theme/themeLink';
import { CUSTOM_THEME_PRESETS } from '../../theme/customPresets';

const T = buildThemeLink(CUSTOM_THEME_PRESETS.find((p) => p.key === 'rose')!.def);

describe('embedKindOf — theme links are never fetched', () => {
    it('a theme link is a theme card, decided before invites, YouTube and images', () => {
        expect(embedKindOf(T)).toBe('theme');
        // Crafted to look like what the image / video embeds would load: still a theme card (no fetch).
        expect(embedKindOf('https://cipherline.chat/theme#clth1.abc.png')).toBe('theme');
        expect(embedKindOf('https://cipherline.chat/theme#clth1.x?v=dQw4w9WgXcQ.gif')).toBe('theme');
        expect(embedKindOf('https://cipherline.chat/theme#junk')).toBe('theme'); // the "can't be read" card
    });

    it('positive controls: the other kinds are unchanged', () => {
        expect(embedKindOf('https://cipherline.chat/invite/abc123')).toBe('invite');
        expect(embedKindOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
        expect(embedKindOf('https://i.imgur.com/abc123.png')).toBe('image');
        expect(embedKindOf('https://example.com/docs')).toBe('link');
        expect(embedKindOf('https://cipherline.chat/theme')).toBe('link'); // the website page itself
    });

    it('ChatPane routes theme links to the theme card BEFORE the invite / generic embeds (source check)', () => {
        const src = readFileSync(join(__dirname, '..', '..', 'components', 'ChatPane.tsx'), 'utf8');
        const start = src.indexOf('const unique = embedUrlsOf(text).slice(0, 3);');
        expect(start).toBeGreaterThan(0);
        const block = src.slice(start, start + 2500);
        const theme = block.indexOf("embedKindOf(u) === 'theme'");
        expect(theme).toBeGreaterThan(0);
        expect(theme).toBeLessThan(block.indexOf('inviteCodeFromUrl(u)'));
        expect(theme).toBeLessThan(block.indexOf('<MessageEmbed'));
        expect(block).toContain('<ThemeLinkEmbed');
    });

    it('the theme card renders from the link alone: no network, no logging (source check)', () => {
        const dir = join(__dirname, '..', '..', 'components', 'themeShare');
        for (const f of ['ThemeLinkEmbed.tsx', 'ThemeDeepLinkHost.tsx']) {
            const src = readFileSync(join(dir, f), 'utf8');
            expect(src, f).not.toMatch(/\baxios\b|\bfetch\(|XMLHttpRequest|fetchBinary|new Image\(/);
            expect(src, f).not.toMatch(/console\.(log|info|warn|error)/);
        }
    });
});
