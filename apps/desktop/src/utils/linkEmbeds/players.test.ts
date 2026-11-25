/**
 * Phase-4 player frames: built by the READER from { provider, id }, the id
 * tied to the visible link, the origin on an exact allowlist that equals the
 * CSP frame-src and the fullscreen permission list in main.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PLAYER_FRAME_ORIGINS, playerFrameSrc, playerIdForLink, trustedPlayer } from './players';
import { FULLSCREEN_EMBED_ORIGINS } from '../../../electron/permission-policy';
import { postTextParts, compactCount } from './postText';

const CLIP = 'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR';
const TT = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';

describe('trustedPlayer: the id must be the one the visible link names', () => {
    it('accepts the matching id', () => {
        expect(trustedPlayer(CLIP, { provider: 'twitch', id: 'clip:DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR' })).not.toBeNull();
        expect(trustedPlayer('https://www.twitch.tv/videos/2931745878', { provider: 'twitch', id: 'video:2931745878' })).not.toBeNull();
        expect(trustedPlayer('https://www.twitch.tv/shroud', { provider: 'twitch', id: 'channel:shroud' })).not.toBeNull();
        expect(trustedPlayer(TT, { provider: 'tiktok', id: '6718335390845095173' })).not.toBeNull();
    });
    it('POSITIVE CONTROL: a forged id, a provider that is not the link\'s, a malformed id, an unknown provider: refused', () => {
        expect(trustedPlayer(CLIP, { provider: 'twitch', id: 'clip:SomeOtherClip' })).toBeNull();
        expect(trustedPlayer(CLIP, { provider: 'twitch', id: 'channel:shroud' })).toBeNull();
        expect(trustedPlayer(TT, { provider: 'tiktok', id: '7000000000000000001' })).toBeNull();
        expect(trustedPlayer(TT, { provider: 'twitch', id: 'video:6718335390845095173' })).toBeNull();
        expect(trustedPlayer(CLIP, { provider: 'twitch', id: 'clip:../../evil' })).toBeNull();
        expect(trustedPlayer(CLIP, { provider: 'evil' as 'twitch', id: 'clip:x' })).toBeNull();
        expect(trustedPlayer(CLIP, undefined)).toBeNull();
    });
    it('a short TikTok link: the reader cannot know the id, so the sender\'s (well-formed) one is used', () => {
        expect(playerIdForLink('tiktok', 'https://vm.tiktok.com/ZMabcdEF/')).toBeNull();
        expect(trustedPlayer('https://vm.tiktok.com/ZMabcdEF/', { provider: 'tiktok', id: '6718335390845095173' })).not.toBeNull();
        expect(trustedPlayer('https://vm.tiktok.com/ZMabcdEF/', { provider: 'tiktok', id: 'abc' })).toBeNull();
    });
});

describe('playerFrameSrc', () => {
    it('builds each frame on its provider\'s exact origin', () => {
        expect(playerFrameSrc({ provider: 'twitch', id: 'clip:Abc-1' }, '127.0.0.1')).toBe('https://clips.twitch.tv/embed?clip=Abc-1&parent=127.0.0.1&autoplay=true');
        expect(playerFrameSrc({ provider: 'twitch', id: 'video:42' }, 'cipherline.chat')).toBe('https://player.twitch.tv/?video=v42&parent=cipherline.chat&autoplay=true');
        expect(playerFrameSrc({ provider: 'twitch', id: 'channel:shroud' }, '127.0.0.1')).toBe('https://player.twitch.tv/?channel=shroud&parent=127.0.0.1&autoplay=true');
        expect(playerFrameSrc({ provider: 'tiktok', id: '6718335390845095173' }, null)).toBe('https://www.tiktok.com/player/v1/6718335390845095173?autoplay=1&music_info=1&description=1&rel=0');
    });
    it('POSITIVE CONTROL: malformed ids, unknown providers and a bad parent build nothing', () => {
        expect(playerFrameSrc({ provider: 'twitch', id: 'clip:a/b?x=1' }, '127.0.0.1')).toBeNull();
        expect(playerFrameSrc({ provider: 'twitch', id: 'clip:Abc-1' }, null)).toBeNull();
        expect(playerFrameSrc({ provider: 'twitch', id: 'clip:Abc-1' }, 'evil.example/&parent=x')).toBeNull();
        expect(playerFrameSrc({ provider: 'tiktok', id: '1/../../x' }, null)).toBeNull();
        expect(playerFrameSrc({ provider: 'vimeo' as 'tiktok', id: '6718335390845095173' }, null)).toBeNull();
    });
    it('the allowlist IS the CSP frame-src (no wildcard) and the fullscreen list', () => {
        const main = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'electron', 'main.ts'), 'utf8');
        const frameSrc = /"frame-src ([^"]+)"/.exec(main)![1].split(/\s+/);
        const all = Object.values(PLAYER_FRAME_ORIGINS).flat();
        for (const o of all) {
            expect(frameSrc).toContain(o);
            expect(FULLSCREEN_EMBED_ORIGINS).toContain(o);
        }
        expect(frameSrc.filter((s) => /twitch|tiktok/.test(s)).sort()).toEqual([...all].sort());
        expect(frameSrc.some((s) => s.includes('*') && /twitch|tiktok/.test(s))).toBe(false);
    });
});

describe('post text', () => {
    it('plain text with bare links only; trailing punctuation is not part of a link', () => {
        expect(postTextParts('see https://example.com/a. and (https://en.wikipedia.org/wiki/X_(y)) ok')).toEqual([
            { text: 'see ' }, { url: 'https://example.com/a' }, { text: '. and (' }, { url: 'https://en.wikipedia.org/wiki/X_(y)' }, { text: ') ok' },
        ]);
        expect(postTextParts('<b>hi</b> javascript:alert(1)')).toEqual([{ text: '<b>hi</b> javascript:alert(1)' }]);
        expect(postTextParts('')).toEqual([]);
    });
    it('counts', () => {
        expect(compactCount(212)).toBe('212');
        expect(compactCount(8421)).toBe('8421');
        expect(compactCount(151032)).toBe('151K');
        expect(compactCount(1_500_000)).toBe('1.5M');
        expect(compactCount(-3)).toBe('-3');
    });
});
