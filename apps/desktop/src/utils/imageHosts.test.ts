import { describe, it, expect } from 'vitest';
import {
    isImageUrl, isGifUrl, isKnownImageHost, isKnownExtensionlessImageHost,
    shouldAutoLoadImage,
} from './imageHosts';

// ── isImageUrl — extension-based detection ──────────────────────────────────

describe('Discord CDN (regression: the host was listed with the wrong TLD)', () => {
    // The exact URL shape reported as not embedding. media.discordapp.NET —
    // the list previously said .com, which is not a Discord host, so this fell
    // through to the click-to-load gate instead of auto-loading.
    const DISCORD_GIF = 'https://media.discordapp.net/attachments/778350656570130472/1220947866017730561/caption.gif?ex=6aa6224f&is=6aa4d0cf&hm=e0158a854999c32409fb17dfa0ca25c39cab267fdb43a0fcf44b45afb9517bb8&';

    it('detects it as an image despite the long signed query string', () => {
        expect(isImageUrl(DISCORD_GIF)).toBe(true);
    });

    it('auto-loads it under the default "known" mode', () => {
        expect(shouldAutoLoadImage('known', 'media.discordapp.net')).toBe(true);
    });

    it('auto-loads the other Discord CDN host too', () => {
        expect(shouldAutoLoadImage('known', 'cdn.discordapp.com')).toBe(true);
    });

    it('does NOT auto-load the Discord page host', () => {
        expect(shouldAutoLoadImage('known', 'discord.com')).toBe(false);
    });

    it('still respects "never"', () => {
        expect(shouldAutoLoadImage('never', 'media.discordapp.net')).toBe(false);
    });
});

describe('isImageUrl — file-extension detection', () => {
    it('matches every supported extension', () => {
        expect(isImageUrl('https://example.com/a.jpg')).toBe(true);
        expect(isImageUrl('https://example.com/a.jpeg')).toBe(true);
        expect(isImageUrl('https://example.com/a.png')).toBe(true);
        expect(isImageUrl('https://example.com/a.gif')).toBe(true);
        expect(isImageUrl('https://example.com/a.webp')).toBe(true);
        expect(isImageUrl('https://example.com/a.avif')).toBe(true);
        expect(isImageUrl('https://example.com/a.bmp')).toBe(true);
    });

    it('is case-insensitive on the extension', () => {
        expect(isImageUrl('https://example.com/a.JPG')).toBe(true);
        expect(isImageUrl('https://example.com/a.GIF')).toBe(true);
    });

    it('ignores a query string after the extension', () => {
        expect(isImageUrl('https://example.com/a.jpg?width=400&name=large')).toBe(true);
    });

    it('ignores a fragment after the extension', () => {
        expect(isImageUrl('https://example.com/a.png#section')).toBe(true);
    });

    it('ignores both a query string and a fragment', () => {
        expect(isImageUrl('https://example.com/a.gif?x=1#y')).toBe(true);
    });

    it('rejects a non-image extension', () => {
        expect(isImageUrl('https://example.com/a.pdf')).toBe(false);
        expect(isImageUrl('https://example.com/a.mp4')).toBe(false);
        expect(isImageUrl('https://example.com/a.html')).toBe(false);
    });

    it('rejects a bare URL with no path at all', () => {
        expect(isImageUrl('https://example.com')).toBe(false);
        expect(isImageUrl('https://example.com/')).toBe(false);
    });

    it('rejects an extension that only appears in the query string, on an unknown host', () => {
        // The extension must be in the path — a `?format=jpg`-style query
        // param on a host we don't otherwise recognize is not enough.
        expect(isImageUrl('https://example.com/media/abc123?format=jpg')).toBe(false);
    });
});

// ── isImageUrl — known extensionless CDN hosts ──────────────────────────────

describe('isImageUrl — extensionless known-host detection', () => {
    it('treats a bare Imgur direct-media path as an image', () => {
        expect(isImageUrl('https://i.imgur.com/AbC123')).toBe(true);
    });

    it('treats a bare Twitter/X media path (format in the query) as an image', () => {
        expect(isImageUrl('https://pbs.twimg.com/media/Gxyz123?format=jpg&name=large')).toBe(true);
    });

    it('does NOT extend the bypass to the Imgur page host', () => {
        expect(isImageUrl('https://imgur.com/AbC123')).toBe(false);
        expect(isImageUrl('https://www.imgur.com/AbC123')).toBe(false);
    });

    it('does NOT extend the bypass to the Twitter/X page host', () => {
        expect(isImageUrl('https://twitter.com/someone/status/123')).toBe(false);
        expect(isImageUrl('https://x.com/someone/status/123')).toBe(false);
    });

    it('does NOT bypass extension-less paths on Giphy/Tenor CDN hosts (real media URLs always carry one)', () => {
        expect(isImageUrl('https://media.giphy.com/media/abc123/nofile')).toBe(false);
        expect(isImageUrl('https://media.tenor.com/abc123/nofile')).toBe(false);
    });

    it('still matches a Giphy/Tenor CDN URL that does carry an extension', () => {
        expect(isImageUrl('https://media2.giphy.com/media/abc123/giphy.gif')).toBe(true);
        expect(isImageUrl('https://media.tenor.com/abc123/tenor.gif')).toBe(true);
    });

    it('does NOT extend the bypass to the Giphy/Tenor share-page hosts', () => {
        expect(isImageUrl('https://giphy.com/gifs/study-hard-jjr2Frs9tvfjqZLBUv')).toBe(false);
        expect(isImageUrl('https://tenor.com/view/some-gif-12345')).toBe(false);
    });
});

// ── isImageUrl — malformed input ────────────────────────────────────────────

describe('isImageUrl — malformed input never throws', () => {
    it('returns false for garbage strings', () => {
        expect(isImageUrl('not a url')).toBe(false);
        expect(isImageUrl('')).toBe(false);
        expect(isImageUrl('ftp://example.com/a.jpg')).toBe(true); // valid URL, protocol is irrelevant to the check
        expect(isImageUrl('javascript:alert(1)')).toBe(false);
    });
});

// ── isGifUrl ─────────────────────────────────────────────────────────────────

describe('isGifUrl', () => {
    it('matches only .gif', () => {
        expect(isGifUrl('https://example.com/a.gif')).toBe(true);
        expect(isGifUrl('https://example.com/a.GIF')).toBe(true);
        expect(isGifUrl('https://example.com/a.png')).toBe(false);
    });

    it('ignores query string and fragment', () => {
        expect(isGifUrl('https://example.com/a.gif?x=1#y')).toBe(true);
    });

    it('is false for an extensionless known-host image (falls back to <img>, not GifPlayer)', () => {
        expect(isGifUrl('https://i.imgur.com/AbC123')).toBe(false);
    });

    it('never throws on malformed input', () => {
        expect(isGifUrl('not a url')).toBe(false);
    });
});

// ── isKnownImageHost — auto-load gating ─────────────────────────────────────

describe('isKnownImageHost', () => {
    it('recognizes every curated CDN host', () => {
        expect(isKnownImageHost('media.giphy.com')).toBe(true);
        expect(isKnownImageHost('media0.giphy.com')).toBe(true);
        expect(isKnownImageHost('i.giphy.com')).toBe(true);
        expect(isKnownImageHost('media.tenor.com')).toBe(true);
        expect(isKnownImageHost('c.tenor.com')).toBe(true);
        expect(isKnownImageHost('i.imgur.com')).toBe(true);
        expect(isKnownImageHost('cdn.discordapp.com')).toBe(true);
        // .net — the real Discord proxy CDN. This line previously asserted
        // .com, which locked in the typo that stopped Discord GIFs embedding.
        expect(isKnownImageHost('media.discordapp.net')).toBe(true);
        expect(isKnownImageHost('media.discordapp.com')).toBe(false);
        expect(isKnownImageHost('pbs.twimg.com')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isKnownImageHost('MEDIA.GIPHY.COM')).toBe(true);
    });

    it('excludes each service\'s bare page/share host', () => {
        expect(isKnownImageHost('giphy.com')).toBe(false);
        expect(isKnownImageHost('tenor.com')).toBe(false);
        expect(isKnownImageHost('imgur.com')).toBe(false);
        expect(isKnownImageHost('www.imgur.com')).toBe(false);
        expect(isKnownImageHost('twitter.com')).toBe(false);
        expect(isKnownImageHost('x.com')).toBe(false);
    });

    it('does not match a look-alike host (suffix confusion)', () => {
        expect(isKnownImageHost('evil-tracker.example.com')).toBe(false);
        expect(isKnownImageHost('notgiphy.com')).toBe(false);
        expect(isKnownImageHost('giphy.com.evil.com')).toBe(false);
    });

    it('rejects an arbitrary/unknown host', () => {
        expect(isKnownImageHost('example.com')).toBe(false);
    });
});

// ── shouldAutoLoadImage — the setting × host decision table ─────────────────

describe('shouldAutoLoadImage', () => {
    describe('mode = "always"', () => {
        it('auto-loads a known CDN host', () => {
            expect(shouldAutoLoadImage('always', 'media.giphy.com')).toBe(true);
        });
        it('auto-loads an arbitrary unknown host too', () => {
            expect(shouldAutoLoadImage('always', 'evil-tracker.example.com')).toBe(true);
        });
    });

    describe('mode = "never"', () => {
        it('gates a known CDN host', () => {
            expect(shouldAutoLoadImage('never', 'media.giphy.com')).toBe(false);
        });
        it('gates an arbitrary unknown host', () => {
            expect(shouldAutoLoadImage('never', 'evil-tracker.example.com')).toBe(false);
        });
    });

    describe('mode = "known" (default)', () => {
        it('auto-loads every curated CDN host', () => {
            expect(shouldAutoLoadImage('known', 'media.giphy.com')).toBe(true);
            expect(shouldAutoLoadImage('known', 'media.tenor.com')).toBe(true);
            expect(shouldAutoLoadImage('known', 'i.imgur.com')).toBe(true);
            expect(shouldAutoLoadImage('known', 'cdn.discordapp.com')).toBe(true);
            expect(shouldAutoLoadImage('known', 'pbs.twimg.com')).toBe(true);
        });
        it('gates an arbitrary/unknown host — the whole point of the setting', () => {
            expect(shouldAutoLoadImage('known', 'evil-tracker.example.com')).toBe(false);
        });
        it('gates each service\'s own page/share host (not a media CDN)', () => {
            expect(shouldAutoLoadImage('known', 'giphy.com')).toBe(false);
            expect(shouldAutoLoadImage('known', 'imgur.com')).toBe(false);
        });
        it('gates an empty hostname (malformed URL upstream)', () => {
            expect(shouldAutoLoadImage('known', '')).toBe(false);
        });
    });
});

describe('isKnownExtensionlessImageHost', () => {
    it('is true only for the hosts explicitly marked extensionless', () => {
        expect(isKnownExtensionlessImageHost('i.imgur.com')).toBe(true);
        expect(isKnownExtensionlessImageHost('pbs.twimg.com')).toBe(true);
    });

    it('is false for known hosts that are NOT marked extensionless', () => {
        expect(isKnownExtensionlessImageHost('media.giphy.com')).toBe(false);
        expect(isKnownExtensionlessImageHost('media.tenor.com')).toBe(false);
        expect(isKnownExtensionlessImageHost('cdn.discordapp.com')).toBe(false);
    });

    it('is false for an unknown host', () => {
        expect(isKnownExtensionlessImageHost('example.com')).toBe(false);
    });
});
