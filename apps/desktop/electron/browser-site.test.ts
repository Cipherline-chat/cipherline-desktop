import { describe, it, expect } from 'vitest';
import { BROWSER_PROCESS_NAMES, pageTitleCandidates, siteFromWindowTitles } from './browser-site';

/**
 * Windows hands Chromium / Firefox media sessions no URL, so the site comes from
 * the browser's window titles: "<page title> - <browser>". These are the
 * matcher's rules (see browser-site.ts for the limits).
 */

const site = (title: string, ...windows: string[]) => siteFromWindowTitles(title, windows);
// Edge writes "Microsoft<ZERO WIDTH SPACE> Edge" in its window title.
const EDGE = 'Microsoft\u200b Edge';

describe('the page title inside a window title', () => {
    it.each([
        ['Video - YouTube - Google Chrome', ['video - youtube', 'video']],
        ['Video - YouTube - Personal - ' + EDGE, ['video - youtube - personal', 'video - youtube']],
        ['Video - YouTube and 3 more pages - Personal - ' + EDGE, ['video - youtube - personal', 'video - youtube']],
        ['Video - YouTube — Mozilla Firefox', ['video - youtube', 'video']],
        ['(3) Video - YouTube - Google Chrome', ['video - youtube', 'video']],
        ['Netflix - Google Chrome', ['netflix']],
        ['Video - YouTube - Google Chrome - Dawson', ['video - youtube', 'video']],
        ['Video - Brave', ['video']],
        ['No browser name here', ['no browser name here']],
    ])('%s', (w, expected) => {
        expect(pageTitleCandidates(w)).toEqual(expected);
    });

    it('private windows give nothing (Edge [InPrivate], Chrome Incognito, Firefox Private Browsing)', () => {
        expect(pageTitleCandidates('Video - YouTube - [InPrivate] - ' + EDGE)).toEqual([]);
        expect(pageTitleCandidates('Video - YouTube - Google Chrome (Incognito)')).toEqual([]);
        expect(pageTitleCandidates('Video - YouTube — Mozilla Firefox Private Browsing')).toEqual([]);
    });

    it('empty, whitespace and the browser name alone give nothing', () => {
        expect(pageTitleCandidates('')).toEqual([]);
        expect(pageTitleCandidates('   \u200b ')).toEqual([]);
        expect(pageTitleCandidates('Google Chrome')).toEqual([]);
    });
});

describe('siteFromWindowTitles: the session title is in a window whose page title names a site', () => {
    const VIDEO = 'Rick Astley - Never Gonna Give You Up (Official Video)';

    it('YouTube in Chrome ("<video> - YouTube - Google Chrome", the title itself holds " - ")', () => {
        expect(site(VIDEO, `${VIDEO} - YouTube - Google Chrome`)).toBe('youtube');
    });

    it('Edge with a profile and the zero-width space in its name, with "and N more pages", and Firefox with an em dash', () => {
        expect(site('Lofi Beats', `Lofi Beats - YouTube - Personal - ${EDGE}`)).toBe('youtube');
        expect(site('Lofi Beats', `Lofi Beats - YouTube and 2 more pages - Work - ${EDGE}`)).toBe('youtube');
        expect(site('Lofi Beats', 'Lofi Beats - YouTube — Mozilla Firefox')).toBe('youtube');
        expect(site('Lofi Beats', 'Lofi Beats - YouTube - Google Chrome - Dawson')).toBe('youtube');
    });

    it('a notification count in front of the tab title is ignored', () => {
        expect(site('Lofi Beats', '(12) Lofi Beats - YouTube - Google Chrome')).toBe('youtube');
    });

    it('YouTube Music, Twitch, Crunchyroll, Hulu, Prime Video, Disney+, SoundCloud, Deezer, Apple Music, Spotify', () => {
        expect(site('Teardrop', 'Teardrop - YouTube Music - Google Chrome')).toBe('youtube_music');
        expect(site('Chill stream', 'xQc - Twitch - Google Chrome')).toBeNull(); // the stream title is not in the window title
        expect(site('xQc', 'xQc - Twitch - Google Chrome')).toBe('twitch');
        expect(site('Frieren', 'Watch Frieren on Crunchyroll - Google Chrome')).toBe('crunchyroll');
        expect(site('Frieren', 'Frieren - Crunchyroll - Google Chrome')).toBe('crunchyroll');
        expect(site('The Simpsons', 'Watch The Simpsons | Hulu - Google Chrome')).toBe('hulu');
        expect(site('The Boys', 'The Boys | Prime Video - Google Chrome')).toBe('prime_video');
        expect(site('The Boys', 'Prime Video: The Boys - Google Chrome')).toBe('prime_video');
        expect(site('The Mandalorian', `Disney+ | The Mandalorian - ${EDGE}`)).toBe('disney_plus');
        expect(site('Teardrop', 'Stream Teardrop by Massive Attack | Listen online for free on SoundCloud - Google Chrome')).toBe('soundcloud');
        expect(site('Teardrop', 'Teardrop - Massive Attack | Deezer - Google Chrome')).toBe('deezer');
        expect(site('Teardrop', 'Teardrop on Apple Music - Google Chrome')).toBe('apple_music');
        expect(site('Teardrop', 'Teardrop • Massive Attack - Google Chrome')).toBe('spotify');
        expect(site('Teardrop', 'Teardrop - Massive Attack - Spotify - Google Chrome')).toBe('spotify');
    });

    it('several windows: the one holding the session title decides; other windows are ignored', () => {
        const w = ['Inbox (4) - Gmail - Google Chrome', `${VIDEO} - YouTube - Google Chrome`, 'Docs - Google Chrome', 'Netflix - Google Chrome'];
        expect(site(VIDEO, ...w)).toBe('youtube');
        expect(site(VIDEO, ...w.slice().reverse())).toBe('youtube');
    });

    it('the same title in two windows of one site is still that site', () => {
        expect(site('Lofi', 'Lofi - YouTube - Google Chrome', 'Lofi - YouTube - Google Chrome')).toBe('youtube');
    });

    it('the same title on two different sites decides nothing (stays "browser")', () => {
        expect(site('Teardrop', 'Teardrop - YouTube - Google Chrome', 'Teardrop - YouTube Music - Google Chrome')).toBeNull();
    });

    it('matching ignores case and runs of spaces', () => {
        expect(site('  LOFI   beats ', 'lofi beats   - YOUTUBE - Google Chrome')).toBe('youtube');
    });

    it('a session title cut at 120 characters still matches the longer page title', () => {
        const long = 'x'.repeat(130);
        expect(site(long.slice(0, 120), `${long} - YouTube - Google Chrome`)).toBe('youtube');
    });
});

describe('no confident match -> null (the tab stays "browser")', () => {
    it('no windows, no session title', () => {
        expect(siteFromWindowTitles('Lofi', [])).toBeNull();
        expect(siteFromWindowTitles('', ['Lofi - YouTube - Google Chrome'])).toBeNull();
        expect(siteFromWindowTitles(null, ['Lofi - YouTube - Google Chrome'])).toBeNull();
        expect(siteFromWindowTitles(undefined, ['x'])).toBeNull();
    });

    it('the playing tab is in the background: its title is in no window', () => {
        expect(site('Lofi Beats', 'Inbox - Gmail - Google Chrome', 'Docs - Google Chrome')).toBeNull();
        // ... even though another window IS a YouTube page (a different video).
        expect(site('Lofi Beats', 'Some other video - YouTube - Google Chrome')).toBeNull();
    });

    it('a title that merely CONTAINS a site name is not that site', () => {
        expect(site('How to use YouTube Studio', 'How to use YouTube Studio - Google Chrome')).toBeNull();
        expect(site('YouTube tips and tricks', 'YouTube tips and tricks - Google Chrome')).toBeNull();
        expect(site('I quit Netflix', 'I quit Netflix - Google Chrome')).toBeNull();
        expect(site('Why Twitch is dying', 'Why Twitch is dying - Google Chrome')).toBeNull();
        expect(site('Hulu vs Peacock', 'Hulu vs Peacock - Google Chrome')).toBeNull();
        expect(site('Planet - YouTubers', 'Planet - YouTubers - Google Chrome')).toBeNull();
        // The site name must sit after a separator with spaces: "non-YouTube" is just a word.
        expect(site('A non-YouTube video', 'A non-YouTube video - Google Chrome')).toBeNull();
    });

    it('the site name as the BROWSER\'s own suffix on a blog about it is still only a suffix match of the PAGE title', () => {
        // "<page> - YouTube Studio" ends with "Studio", not "YouTube".
        expect(site('Upload', 'Upload - YouTube Studio - Google Chrome')).toBeNull();
    });

    it('private windows are never read', () => {
        expect(site('Lofi', `Lofi - YouTube - [InPrivate] - ${EDGE}`)).toBeNull();
        expect(site('Lofi', 'Lofi - YouTube - Google Chrome (Incognito)')).toBeNull();
    });
});

describe('weak sites: a tab titled just "Netflix"', () => {
    it('a lone bare "Netflix" window identifies a Netflix session whose own title is in no window', () => {
        expect(site('Stranger Things', 'Netflix - Google Chrome', 'Inbox - Gmail - Google Chrome')).toBe('netflix');
        expect(site('It', 'Netflix - Google Chrome')).toBe('netflix'); // a very short title
        expect(site('The Boys', `Prime Video - ${EDGE}`)).toBe('prime_video');
    });

    it('but not when the session title is visible in another window (then it is not the bare tab)', () => {
        expect(site('Stranger Things', 'Netflix - Google Chrome', 'Stranger Things fan wiki - Google Chrome')).toBeNull();
    });

    it('not when two bare-title sites are open (cannot tell which plays)', () => {
        expect(site('Stranger Things', 'Netflix - Google Chrome', 'Hulu - Google Chrome')).toBeNull();
    });

    it('YouTube and the music sites are never matched on a bare window name', () => {
        expect(site('Lofi Beats', 'YouTube - Google Chrome')).toBeNull();
        expect(site('Teardrop', 'YouTube Music - Google Chrome')).toBeNull();
        expect(site('Teardrop', 'Spotify – Web Player - Google Chrome')).toBeNull();
    });

    it('a strong match beats a bare window', () => {
        expect(site('Lofi', 'Netflix - Google Chrome', 'Lofi - YouTube - Google Chrome')).toBe('youtube');
    });
});

describe('robustness', () => {
    it('bad input never throws', () => {
        expect(() => siteFromWindowTitles('x', [1 as unknown as string, null as unknown as string, undefined as unknown as string])).not.toThrow();
        expect(siteFromWindowTitles('Lofi', 'nope' as unknown as string[])).toBeNull();
        expect(() => siteFromWindowTitles('x'.repeat(5000), ['y'.repeat(100_000)])).not.toThrow();
    });

    it('only the first 32 windows are looked at', () => {
        const filler = Array.from({ length: 40 }, (_, i) => `Doc ${i} - Google Chrome`);
        expect(siteFromWindowTitles('Lofi', [...filler, 'Lofi - YouTube - Google Chrome'])).toBeNull();
    });

    it('the browser process list is exactly the browser families the helper may enumerate', () => {
        expect([...BROWSER_PROCESS_NAMES].sort()).toEqual(['brave', 'chrome', 'chromium', 'firefox', 'msedge', 'opera', 'vivaldi']);
    });
});
