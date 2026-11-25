/**
 * Main (electron/unfurl/provider-links.ts) and the renderer
 * (src/utils/linkEmbeds/providerLinks.ts) each keep a copy of the phase-4
 * link parsers (electron/ and src/ may not import each other in the app
 * builds). A test can read both: they must agree on every row, and the two
 * files must stay identical apart from their header comment.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as main from './provider-links';
import * as renderer from '../../src/utils/linkEmbeds/providerLinks';

const TABLE = [
    'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR',
    'https://www.twitch.tv/shroud/clip/AbcDef-123?filter=clips',
    'https://m.twitch.tv/clip/AbcDef-123',
    'https://www.twitch.tv/videos/2931745878',
    'https://www.twitch.tv/shroud',
    'https://www.twitch.tv/directory',
    'https://clips.twitch.tv/embed',
    'http://www.twitch.tv/shroud',
    'https://x.com/elonmusk/status/1585341984679469056',
    'https://twitter.com/jack/status/20/photo/1',
    'https://mobile.twitter.com/i/web/status/20',
    'https://fxtwitter.com/jack/status/20',
    'https://x.com/jack/status/20/likes',
    'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://vm.tiktok.com/ZMabcdEF/',
    'https://www.tiktok.com/t/ZTabc123/',
    'https://www.tiktok.com/embed/v2/6718335390845095173',
    'https://www.tiktok.com/@x/photo/6718335390845095173',
    'https://www.reddit.com/r/aww/comments/90bu6w/heat_index/',
    'https://old.reddit.com/comments/90bu6w',
    'https://redd.it/90bu6w',
    'https://www.reddit.com/r/aww/s/AbCdEf1234',
    'https://www.reddit.com/r/aww/',
    'https://user:pw@x.com/jack/status/20',
    'not a url',
];

describe('phase-4 provider links: main and renderer agree', () => {
    it.each(TABLE)('%s', (u) => {
        expect(renderer.twitchRefOf(u)).toEqual(main.twitchRefOf(u));
        expect(renderer.xStatusRefOf(u)).toEqual(main.xStatusRefOf(u));
        expect(renderer.tikTokRefOf(u)).toEqual(main.tikTokRefOf(u));
        expect(renderer.redditRefOf(u)).toEqual(main.redditRefOf(u));
    });
    it('the two files are the same code', () => {
        const strip = (f: string) => fs.readFileSync(f, 'utf8').replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
        expect(strip(path.join(__dirname, '..', '..', 'src', 'utils', 'linkEmbeds', 'providerLinks.ts')))
            .toBe(strip(path.join(__dirname, 'provider-links.ts')));
    });
});
