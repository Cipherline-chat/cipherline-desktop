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

    it('video files and clip pages (phase 2) are decided before images', () => {
        expect(embedKindOf('https://cdn.example.com/clip.mp4')).toBe('video');
        expect(embedKindOf('https://cdn.example.com/clip.WEBM?x=1')).toBe('video');
        expect(embedKindOf('https://cdn.example.com/clip.mov')).toBe('video');
        // i.imgur.com is an extension-less IMAGE host: its .mp4 and .gifv must still be video.
        expect(embedKindOf('https://i.imgur.com/A61SaA1.mp4')).toBe('video');
        expect(embedKindOf('https://i.imgur.com/A61SaA1.gifv')).toBe('clip');
        expect(embedKindOf('https://i.imgur.com/A61SaA1')).toBe('image');
        expect(embedKindOf('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt')).toBe('clip');
        expect(embedKindOf('https://streamable.com/moo')).toBe('clip');
        expect(embedKindOf('https://tenor.com/view/aww-yeah-get-over-here-gif-27631439')).toBe('clip');
        expect(embedKindOf('https://giphy.com/gifs/cat-JIX9t2j0ZTN9S')).toBe('clip');
        expect(embedKindOf('https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif')).toBe('image');
        // Plain http video is not played in place (main streams https only): a link card.
        expect(embedKindOf('http://cdn.example.com/clip.mp4')).toBe('link');
        // A theme link dressed as a video stays a theme card; YouTube stays YouTube.
        expect(embedKindOf('https://cipherline.chat/theme#clth1.abc.mp4')).toBe('theme');
        expect(embedKindOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=.mp4')).toBe('youtube');
    });

    it('the message embed sends video and clip links to the click-to-play VideoLinkEmbed (source check)', () => {
        const src = readFileSync(join(__dirname, '..', '..', 'components', 'embeds', 'MessageEmbed.tsx'), 'utf8');
        expect(src).toMatch(/if \(kind === 'video' \|\| kind === 'clip'\) return <VideoLinkEmbed url=\{url\} \/>;/);
    });

    it('ChatPane routes theme links to the theme card BEFORE the invite / generic embeds (source check)', () => {
        const src = readFileSync(join(__dirname, '..', '..', 'components', 'ChatPane.tsx'), 'utf8');
        const start = src.indexOf('const allUrls = embedUrlsOf(text);');
        expect(start).toBeGreaterThan(0);
        const block = src.slice(start, start + 4000);
        const theme = block.indexOf("embedKindOf(u) === 'theme'");
        expect(theme).toBeGreaterThan(0);
        expect(theme).toBeLessThan(block.indexOf('inviteCodeFromUrl(u)'));
        expect(theme).toBeLessThan(block.indexOf('<MessageEmbed'));
        // A sender-built preview can never stand in for a theme or invite card.
        expect(block.indexOf('inviteCodeFromUrl(u)')).toBeLessThan(block.indexOf('<SenderEmbed'));
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
