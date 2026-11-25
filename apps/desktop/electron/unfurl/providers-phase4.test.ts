/**
 * Phase-4 provider parsers (pure), against responses saved LIVE on
 * 2026-11-23 in __fixtures__/providers/ — Twitch pages (heads only), X
 * syndication + oEmbed JSON, TikTok oEmbed + the page's rehydration JSON
 * (pruned to the fields read; signed-URL signatures replaced by "SIG"),
 * Reddit oEmbed.
 *
 * EXCEPTION: reddit-post-*.json are NOT live captures. Reddit's post .json
 * answered 403 "blocked by network security" from this network (see
 * reddit.ts), so those three are shaped from Reddit's documented listing
 * format to exercise the parser's branches (video, gallery order + bad items,
 * self post with NSFW, negative score, deleted author).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parsePageMeta } from './parse-page';
import { isGenericTwitchShell, twitchFacts } from './twitch';
import { parseTweetResult, parseXOEmbed, syndicationToken } from './x';
import { parseTikTokOEmbed, parseTikTokPage, tikTokTitle, tikTokImageHostAllowed } from './tiktok';
import { parseRedditOEmbed, parseRedditPostJson } from './reddit';
import { twitchRefOf, twitchPlayerId, xStatusRefOf, tikTokRefOf, redditRefOf, redditCanonicalUrl } from './provider-links';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'providers', n), 'utf8');

describe('provider links', () => {
    it('Twitch: clips, VODs, channels; app pages are not channels', () => {
        expect(twitchRefOf('https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR')).toEqual({ kind: 'clip', slug: 'DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR', channel: null });
        expect(twitchRefOf('https://www.twitch.tv/shroud/clip/AbcDef-123')).toEqual({ kind: 'clip', slug: 'AbcDef-123', channel: 'shroud' });
        expect(twitchRefOf('https://m.twitch.tv/clip/AbcDef-123')).toEqual({ kind: 'clip', slug: 'AbcDef-123', channel: null });
        expect(twitchRefOf('https://www.twitch.tv/videos/2931745878')).toEqual({ kind: 'video', id: '2931745878' });
        expect(twitchRefOf('https://twitch.tv/Shroud')).toEqual({ kind: 'channel', login: 'shroud' });
        for (const u of ['https://www.twitch.tv/directory', 'https://www.twitch.tv/settings', 'https://clips.twitch.tv/embed', 'http://www.twitch.tv/shroud',
            'https://evil.twitch.tv.example/shroud', 'https://www.twitch.tv/', 'https://www.twitch.tv/a/b/c/d']) {
            expect(twitchRefOf(u), u).toBeNull();
        }
        expect(twitchPlayerId({ kind: 'clip', slug: 'X-y', channel: null })).toBe('clip:X-y');
        expect(twitchPlayerId({ kind: 'video', id: '9' })).toBe('video:9');
        expect(twitchPlayerId({ kind: 'channel', login: 'abc' })).toBe('channel:abc');
    });

    it('X: status links on x.com / twitter.com only (a mirror is another site)', () => {
        expect(xStatusRefOf('https://x.com/elonmusk/status/1585341984679469056')).toEqual({ id: '1585341984679469056', handle: 'elonmusk' });
        expect(xStatusRefOf('https://twitter.com/jack/status/20/photo/1')).toEqual({ id: '20', handle: 'jack' });
        expect(xStatusRefOf('https://mobile.twitter.com/i/web/status/20')).toEqual({ id: '20', handle: null });
        for (const u of ['https://fxtwitter.com/jack/status/20', 'https://vxtwitter.com/jack/status/20', 'https://x.com/jack', 'https://x.com/jack/status/abc',
            'https://x.com/jack/status/20/likes', 'https://x.com.evil.example/jack/status/20']) {
            expect(xStatusRefOf(u), u).toBeNull();
        }
    });

    it('TikTok: video links carry the id; short links do not', () => {
        expect(tikTokRefOf('https://www.tiktok.com/@scout2015/video/6718335390845095173')).toEqual({ id: '6718335390845095173', handle: 'scout2015', short: false });
        expect(tikTokRefOf('https://vm.tiktok.com/ZMabcdEF/')).toEqual({ id: null, handle: null, short: true });
        expect(tikTokRefOf('https://www.tiktok.com/t/ZTabc123/')).toEqual({ id: null, handle: null, short: true });
        expect(tikTokRefOf('https://www.tiktok.com/@scout2015')).toBeNull();
        expect(tikTokRefOf('https://www.tiktok.com/@x/photo/6718335390845095173')).toBeNull();
    });

    it('Reddit: posts, redd.it, share links', () => {
        expect(redditRefOf('https://www.reddit.com/r/aww/comments/90bu6w/heat_index/')).toEqual({ id: '90bu6w', sub: 'aww', share: null });
        expect(redditRefOf('https://old.reddit.com/comments/90bu6w')).toEqual({ id: '90bu6w', sub: null, share: null });
        expect(redditRefOf('https://redd.it/90bu6w')).toEqual({ id: '90bu6w', sub: null, share: null });
        expect(redditRefOf('https://www.reddit.com/r/aww/s/AbCdEf1234')).toEqual({ id: null, sub: 'aww', share: 'AbCdEf1234' });
        expect(redditRefOf('https://www.reddit.com/r/aww/')).toBeNull();
        expect(redditRefOf('https://www.reddit.com/user/x/')).toBeNull();
        expect(redditCanonicalUrl({ id: '90bu6w', sub: 'aww', share: null })).toBe('https://www.reddit.com/r/aww/comments/90bu6w/');
    });
});

describe('Twitch pages (live 2026-11-23)', () => {
    it('a clip: title, channel, game, duration; picture is the 1920x1080 frame', () => {
        const html = fx('twitch-clip.html');
        const page = parsePageMeta(html, 'https://clips.twitch.tv/x');
        expect(isGenericTwitchShell(page)).toBe(false);
        const f = twitchFacts(page, { kind: 'clip', slug: 'x', channel: null }, html);
        expect(f).toEqual({ title: 'smol shroud', author: 'shroud', tag: 'World of Warcraft', durationS: 18 });
        expect(page.image?.url).toMatch(/^https:\/\/static-cdn\.jtvnw\.net\/.+1920x1080\.jpg$/);
    });
    it('a VOD and a channel', () => {
        const vod = fx('twitch-vod.html');
        expect(twitchFacts(parsePageMeta(vod, 'https://www.twitch.tv/videos/1'), { kind: 'video', id: '1' }, vod))
            .toMatchObject({ title: 'short dungeon sesh with the boys', author: 'shroud', tag: 'VOD' });
        const ch = fx('twitch-channel.html');
        const page = parsePageMeta(ch, 'https://www.twitch.tv/shroud');
        expect(twitchFacts(page, { kind: 'channel', login: 'shroud' }, ch)).toEqual({ author: 'shroud', tag: 'Channel' });
        expect(page.image?.url).toContain('profile_image-300x300');
    });
    it('the generic shell Twitch answers first is recognised (the unfurler retries)', () => {
        expect(isGenericTwitchShell(parsePageMeta(fx('twitch-generic-shell.html'), 'https://m.twitch.tv/clip/x'))).toBe(true);
    });
});

describe('X (live 2026-11-23)', () => {
    it('token matches the one the embed widget sends', () => {
        expect(syndicationToken('20')).toBe('6dq1a2xwd93');
    });
    it('a video tweet: author, avatar at 200px, text without the media link, an mp4 of at most ~2.5 Mb/s, poster', () => {
        const t = parseTweetResult(fx('x-video.json'))!;
        expect(t).toMatchObject({ id: '1585341984679469056', name: 'Elon Musk', handle: 'elonmusk', text: 'Entering Twitter HQ – let that sink in!', createdAt: '2022-10-26T18:45:58Z', sensitive: false, photos: [] });
        expect(t.avatarUrl).toMatch(/^https:\/\/pbs\.twimg\.com\/profile_images\/.+_200x200\.jpg$/);
        expect(t.video).toMatchObject({ width: 1920, height: 1080, durationS: 9.3, loop: false });
        expect(t.video!.url).toBe('https://video.twimg.com/ext_tw_video/1585341912877146112/pu/vid/1280x720/cwj11yOgYZ05R_sY.mp4?tag=14');
        expect(t.video!.poster).toMatch(/^https:\/\/pbs\.twimg\.com\//);
    });
    it('a GIF is a silent loop', () => {
        const t = parseTweetResult(fx('x-gif.json'))!;
        expect(t.video).toMatchObject({ url: 'https://video.twimg.com/tweet_video/EAZ-JyTXkAEtZeH.mp4', loop: true });
    });
    it('a photo tweet: the photo at a card-sized rendition', () => {
        const t = parseTweetResult(fx('x-photo.json'))!;
        expect(t.photos).toHaveLength(1);
        expect(t.photos[0].url).toMatch(/^https:\/\/pbs\.twimg\.com\/media\/[^?]+\?format=jpg&name=medium$/);
        // A 2014 tweet's media link is http://t.co/…: it goes too (found in the real app run).
        expect(t.text).toBe('Sunsets don\'t get much better than this one over @GrandTetonNPS. #nature #sunset');
        expect(t.video).toBeUndefined();
    });
    it('a deleted / protected tweet (tombstone) and junk give nothing', () => {
        expect(parseTweetResult(fx('x-tombstone.json'))).toBeNull();
        expect(parseTweetResult('<!DOCTYPE html><html></html>')).toBeNull();
        expect(parseTweetResult('{"__typename":"Tweet","id_str":"1","user":{"screen_name":"bad handle!"}}')).toBeNull();
    });
    it('media on any host but X\'s own is dropped', () => {
        const j = JSON.parse(fx('x-video.json'));
        for (const v of j.mediaDetails[0].video_info.variants) v.url = v.url.replace('video.twimg.com', 'evil.example');
        j.user.profile_image_url_https = 'https://evil.example/a_normal.jpg';
        const t = parseTweetResult(JSON.stringify(j))!;
        expect(t.video).toBeUndefined();
        expect(t.avatarUrl).toBeUndefined();
    });
    it('oEmbed fallback: name, handle and the words as plain text', () => {
        expect(parseXOEmbed(fx('x-oembed.json'))).toEqual({ name: 'jack', handle: 'jack', text: 'just setting up my twttr' });
        expect(parseXOEmbed(JSON.stringify({ author_name: 'a', author_url: 'https://x.com/a', html: '<blockquote><p>hi <b>there</b><script>x</script> &amp; bye</p></blockquote>' })))
            .toEqual({ name: 'a', handle: 'a', text: 'hi therex & bye' });
    });
});

describe('TikTok (live 2026-11-23)', () => {
    it('oEmbed today has only the id (no title, author or thumbnail)', () => {
        expect(parseTikTokOEmbed(fx('tiktok-oembed.json'))).toEqual({ id: '6718335390845095173' });
    });
    it('the page\'s rehydration JSON fills the card', () => {
        const f = parseTikTokPage(fx('tiktok-page.html'))!;
        expect(f).toMatchObject({ id: '6718335390845095173', author: 'Scout, Suki & Stella', handle: 'scout2015', width: 576, height: 1024, durationS: 10, createdAt: '2019-07-27T13:32:38Z' });
        expect(f.caption).toMatch(/^Scramble up ur name/);
        expect(tikTokTitle(f.caption)).toBe('Scramble up ur name & I’ll try to guess it😍❤️');
        expect(new URL(f.coverUrl!).hostname).toBe('p16-common-sign.tiktokcdn-us.com');
        expect(f.avatarUrl).toBeDefined();
    });
    it('image hosts: TikTok CDNs only', () => {
        expect(tikTokImageHostAllowed('p16-common-sign.tiktokcdn-us.com')).toBe(true);
        expect(tikTokImageHostAllowed('p19-sign.tiktokcdn.com')).toBe(true);
        expect(tikTokImageHostAllowed('tiktokcdn.com.evil.example')).toBe(false);
        expect(tikTokImageHostAllowed('evil.example')).toBe(false);
    });
    it('a page without the script, or junk JSON, gives null', () => {
        expect(parseTikTokPage('<html></html>')).toBeNull();
        expect(parseTikTokPage('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{nope</script>')).toBeNull();
    });
});

describe('Reddit', () => {
    it('oEmbed (live 2026-11-23): title, author, subreddit', () => {
        expect(parseRedditOEmbed(fx('reddit-oembed.json'))).toEqual({
            title: 'Heat index was 110 degrees so we offered him a cold drink. He went for a full body soak instead',
            author: 'FootLoosePickleJuice', sub: 'aww',
        });
    });
    it('.json (shaped, not live): a v.redd.it video with its poster', () => {
        const f = parseRedditPostJson(fx('reddit-post-video.json'))!;
        expect(f).toMatchObject({ sub: 'aww', author: 'FootLoosePickleJuice', score: 151032, comments: 1906, createdAt: '2018-07-19T16:40:18Z' });
        expect(f.video).toEqual({ url: 'https://v.redd.it/zv89llsvexb11/DASH_720.mp4?source=fallback', width: 406, height: 720, durationS: 13, hasAudio: true });
        expect(f.images).toHaveLength(1);
        expect(f.images[0].url).toContain('external-preview.redd.it');
        expect(f.images[0].url).not.toContain('&amp;');
        expect(f.nsfw).toBeUndefined();
    });
    it('.json (shaped): a gallery keeps the post\'s order, skips failed / off-host items, at most 4', () => {
        const f = parseRedditPostJson(fx('reddit-post-gallery.json'))!;
        expect(f.images.map((i) => new URL(i.url).pathname)).toEqual(['/m3.png', '/m1.jpg', '/m2.jpg', '/m6.jpg']);
        expect(f.images[1]).toMatchObject({ width: 640, height: 480 });
        expect(f.spoiler).toBe(true);
    });
    it('.json (shaped): a self post: NSFW, negative score, deleted author, the body as text', () => {
        const f = parseRedditPostJson(fx('reddit-post-self.json'))!;
        expect(f).toMatchObject({ sub: 'AskReddit', nsfw: true, score: -3, comments: 0 });
        expect(f.author).toBeUndefined();
        expect(f.selftext).toMatch(/^Long text post body\./);
        expect(f.images).toEqual([]);
    });
    it('the block page / junk give null', () => {
        expect(parseRedditPostJson('<body>blocked</body>')).toBeNull();
        expect(parseRedditPostJson('[]')).toBeNull();
        expect(parseRedditOEmbed('{}')).toBeNull();
    });
});
