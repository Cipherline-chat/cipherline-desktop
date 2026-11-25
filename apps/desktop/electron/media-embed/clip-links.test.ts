import { describe, it, expect } from 'vitest';
import { clipLinkOf, mediaHostAllowed, pageHostAllowed } from './clip-links';

describe('clipLinkOf: supported clip pages', () => {
    it.each([
        ['https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', 'medal', 'nYiYMMGqugp5N9XWt', 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', null],
        ['https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt/some-slug?invite=x', 'medal', 'nYiYMMGqugp5N9XWt', 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt/some-slug', null],
        ['https://www.medal.tv/clips/nYiYMMGqugp5N9XWt', 'medal', 'nYiYMMGqugp5N9XWt', 'https://medal.tv/clips/nYiYMMGqugp5N9XWt', null],
        ['https://medal.tv/games/valorant/clip/nYiYMMGqugp5N9XWt', 'medal', 'nYiYMMGqugp5N9XWt', 'https://medal.tv/games/valorant/clip/nYiYMMGqugp5N9XWt', null],
        ['https://medal.tv/de/games/fortnite/clips/abcD_123-x', 'medal', 'abcD_123-x', 'https://medal.tv/de/games/fortnite/clips/abcD_123-x', null],
        ['https://streamable.com/moo', 'streamable', 'moo', 'https://streamable.com/moo', null],
        ['https://streamable.com/e/moo', 'streamable', 'moo', 'https://streamable.com/moo', null],
        ['https://i.imgur.com/A61SaA1.gifv', 'imgur', 'A61SaA1', null, 'https://i.imgur.com/A61SaA1.mp4'],
        ['https://imgur.com/A61SaA1', 'imgur', 'A61SaA1', 'https://imgur.com/A61SaA1', null],
        ['https://tenor.com/view/aww-yeah-get-over-here-gif-27631439', 'tenor', '27631439', 'https://tenor.com/view/aww-yeah-get-over-here-gif-27631439', null],
        ['https://tenor.com/en-GB/view/cat-gif-12345678', 'tenor', '12345678', 'https://tenor.com/en-GB/view/cat-gif-12345678', null],
        ['https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S', 'giphy', 'JIX9t2j0ZTN9S', null, 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4'],
        ['https://giphy.com/gifs/JIX9t2j0ZTN9S', 'giphy', 'JIX9t2j0ZTN9S', null, 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4'],
        ['https://giphy.com/embed/JIX9t2j0ZTN9S', 'giphy', 'JIX9t2j0ZTN9S', null, 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4'],
    ])('%s', (url, provider, id, pageUrl, directUrl) => {
        expect(clipLinkOf(url)).toEqual({ provider, id, pageUrl, directUrl });
    });

    it.each([
        'http://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', // not https
        'https://medal.tv/',
        'https://medal.tv/games/valorant',
        'https://medal.tv.evil.example/clips/nYiYMMGqugp5N9XWt',
        'https://evil.example/medal.tv/clips/nYiYMMGqugp5N9XWt',
        'https://user:pw@medal.tv/clips/nYiYMMGqugp5N9XWt',
        'https://medal.tv:8443/clips/nYiYMMGqugp5N9XWt',
        'https://streamable.com/login',
        'https://streamable.com/upload',
        'https://streamable.com/a/b',
        'https://imgur.com/gallery/abcdef',
        'https://imgur.com/upload',
        'https://imgur.com/a/abcdef',
        'https://i.imgur.com/A61SaA1.png', // an image, not a clip
        'https://i.imgur.com/A61SaA1.mp4', // a direct file, not a clip
        'https://tenor.com/',
        'https://tenor.com/search/cat-gifs',
        'https://giphy.com/',
        'https://giphy.com/clips/some-thing-abc',
        'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif', // already an image link
        'not a url',
        '',
        42,
    ])('%s is not a clip page', (url) => {
        expect(clipLinkOf(url)).toBeNull();
    });
});

describe('host policies', () => {
    it('page hosts are the provider\'s own site only; Giphy is never fetched', () => {
        expect(pageHostAllowed('medal', 'medal.tv')).toBe(true);
        expect(pageHostAllowed('medal', 'cdn.medal.tv')).toBe(false);
        expect(pageHostAllowed('medal', 'evil.example')).toBe(false);
        expect(pageHostAllowed('tenor', 'tenor.com')).toBe(true);
        expect(pageHostAllowed('giphy', 'giphy.com')).toBe(false);
    });

    it('media files must start on the provider\'s CDN', () => {
        expect(mediaHostAllowed('medal', 'cdn.medal.tv')).toBe(true);
        expect(mediaHostAllowed('medal', 'medal.tv')).toBe(true); // og:video API redirect
        expect(mediaHostAllowed('medal', 'cdn.medal.tv.evil.example')).toBe(false);
        expect(mediaHostAllowed('streamable', 'cdn-cf-west.streamable.com')).toBe(true);
        expect(mediaHostAllowed('streamable', 'streamable.com')).toBe(false); // the HTML /t/ page
        expect(mediaHostAllowed('tenor', 'media.tenor.com')).toBe(true);
        expect(mediaHostAllowed('tenor', 'media1.tenor.com')).toBe(true);
        expect(mediaHostAllowed('tenor', 'tenor.com')).toBe(false);
        expect(mediaHostAllowed('imgur', 'i.imgur.com')).toBe(true);
        expect(mediaHostAllowed('imgur', 'imgur.com')).toBe(false);
        expect(mediaHostAllowed('giphy', 'media.giphy.com')).toBe(true);
        expect(mediaHostAllowed('giphy', 'giphy.com')).toBe(false);
    });
});
