/**
 * The renderer chooses the "clip" card with its own copy of clipLinkOf
 * (src/utils/mediaEmbed/mediaLinks.ts); main resolves with this one and is the
 * authority. electron/ and src/ may not import each other in the app builds
 * (tsconfig rootDir), but a test can read both: they must agree on every row.
 */
import { describe, it, expect } from 'vitest';
import { clipLinkOf as mainClipLinkOf } from './clip-links';
import { clipLinkOf as rendererClipLinkOf } from '../../src/utils/mediaEmbed/mediaLinks';

const TABLE = [
    'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt',
    'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt/slug?x=1#t',
    'https://www.medal.tv/clips/abcd',
    'https://medal.tv/de/games/fortnite/clip/abc_d-1234',
    'https://medal.tv/games/valorant',
    'http://medal.tv/clips/abcdef',
    'https://medal.tv:444/clips/abcdef',
    'https://streamable.com/moo',
    'https://streamable.com/e/moo',
    'https://streamable.com/login',
    'https://streamable.com/toolongidentifier',
    'https://i.imgur.com/A61SaA1.gifv',
    'https://i.imgur.com/A61SaA1.mp4',
    'https://imgur.com/A61SaA1',
    'https://imgur.com/upload',
    'https://imgur.com/gallery/x',
    'https://tenor.com/view/aww-yeah-get-over-here-gif-27631439',
    'https://tenor.com/en-GB/view/x-gif-12345',
    'https://tenor.com/view/no-number',
    'https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S',
    'https://giphy.com/embed/JIX9t2j0ZTN9S',
    'https://giphy.com/clips/x-y-z',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://example.com/video.mp4',
    'javascript:alert(1)',
    '',
];

describe('clip-links: renderer copy matches the main-process authority', () => {
    it.each(TABLE)('%s', (url) => {
        expect(rendererClipLinkOf(url)).toEqual(mainClipLinkOf(url));
    });

    it('positive control: the table contains accepted AND refused rows', () => {
        const accepted = TABLE.filter((u) => mainClipLinkOf(u)).length;
        expect(accepted).toBeGreaterThan(8);
        expect(TABLE.length - accepted).toBeGreaterThan(8);
    });
});
