/**
 * packages/shared/link-embeds.ts, phase 4: players for Twitch / TikTok, the
 * `post` kind (X, Reddit), and the new picture fields — all re-validated by
 * every reader (the sender is untrusted).
 */
import { describe, it, expect } from 'vitest';
import {
    sanitizeLinkEmbed, sanitizeLinkEmbeds, linkEmbedAttachmentIds, linkEmbedsReportText, isLinkEmbedPlayerId,
    LINK_EMBED_MAX_IMAGES, LINK_EMBED_FIELD_MAX, type LinkEmbed,
} from '@cipherline/shared';

const KEY = 'A'.repeat(43) + '=';
const NONCE = 'B'.repeat(16);
const att = (n: number) => ({ mime: 'image/webp', width: 640, height: 480, attachment_id: `0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4${n}`, file_key_b64: KEY, file_nonce_b64: NONCE, byte_size: 40_000 });
const TWEET = 'https://x.com/jack/status/20';

describe('players: twitch and tiktok', () => {
    it('well-formed ids per provider', () => {
        for (const [p, id] of [['twitch', 'clip:Abc-def_1'], ['twitch', 'video:2931745878'], ['twitch', 'channel:shroud'], ['tiktok', '6718335390845095173'], ['youtube', 'jNQXAC9IVRw']]) {
            expect(isLinkEmbedPlayerId(p, id), `${p} ${id}`).toBe(true);
        }
        for (const [p, id] of [['twitch', 'clip:a'], ['twitch', 'video:abc'], ['twitch', 'channel:Shroud'], ['twitch', 'channel:a-b'], ['twitch', 'shroud'],
            ['tiktok', '123'], ['tiktok', '67183353908450951x3'], ['vimeo', '123456'], ['twitch', 5]]) {
            expect(isLinkEmbedPlayerId(p, id), `${p} ${id}`).toBe(false);
        }
    });
    it('POSITIVE CONTROL: an off-allowlist provider, a bad id, or a frame URL field never survives', () => {
        const url = 'https://clips.twitch.tv/Abc-def_1';
        expect(sanitizeLinkEmbed({ url, kind: 'player', title: 't', player: { provider: 'twitch', id: 'clip:Abc-def_1' } })?.player).toEqual({ provider: 'twitch', id: 'clip:Abc-def_1' });
        expect(sanitizeLinkEmbed({ url, kind: 'player', title: 't', player: { provider: 'evil', id: 'clip:Abc-def_1' } })).toBeUndefined();
        expect(sanitizeLinkEmbed({ url, kind: 'player', title: 't', player: { provider: 'twitch', id: 'clip:../x' } })).toBeUndefined();
        const withSrc = sanitizeLinkEmbed({ url, kind: 'player', title: 't', player: { provider: 'twitch', id: 'clip:Abc-def_1', src: 'https://evil.example/', start_s: 5 } });
        expect(withSrc?.player).toEqual({ provider: 'twitch', id: 'clip:Abc-def_1' });
        expect(JSON.stringify(withSrc)).not.toContain('evil');
    });
});

describe('post kind', () => {
    const post = (extra: Record<string, unknown> = {}) => ({ url: TWEET, kind: 'post', author: 'jack', author_handle: '@jack', description: 'just setting up my twttr', ...extra });

    it('keeps the post fields, cleaned', () => {
        const e = sanitizeLinkEmbed(post({
            published_at: '2006-03-21T20:50:14.000Z', author_icon: att(1), images: [att(2), att(3)], nsfw: true, spoiler: true, score: -3, comments: 7,
            media: { url: 'https://video.twimg.com/tweet_video/a.mp4', mime: 'video/mp4', loop: true, no_audio: true },
        }))!;
        expect(e).toMatchObject({ kind: 'post', author_handle: '@jack', published_at: '2006-03-21T20:50:14Z', nsfw: true, spoiler: true, score: -3, comments: 7 });
        expect(e.images).toHaveLength(2);
        expect(e.author_icon?.attachment_id).toBe(att(1).attachment_id);
        expect(e.media).toMatchObject({ loop: true, no_audio: true });
    });
    it('a post\'s text may be longer than a card description, but is capped', () => {
        const long = 'w '.repeat(600);
        expect(sanitizeLinkEmbed(post({ description: long }))!.description!.length).toBeLessThanOrEqual(LINK_EMBED_FIELD_MAX.post_text);
        expect(sanitizeLinkEmbed(post({ description: long }))!.description!.length).toBeGreaterThan(LINK_EMBED_FIELD_MAX.description);
        expect(sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', description: long })!.description!.length).toBeLessThanOrEqual(LINK_EMBED_FIELD_MAX.description);
    });
    it('junk is dropped field by field: bad pictures, dates, counts, flags, media', () => {
        const e = sanitizeLinkEmbed(post({
            published_at: 'yesterday', author_icon: { mime: 'image/svg+xml', width: 1, height: 1, inline_b64: 'AAAA' }, images: [att(1), { bad: 1 }, 'x', att(2), att(3), att(4), att(5)],
            nsfw: 'yes', score: 1.5, comments: -1, media: { url: 'http://video.twimg.com/a.mp4', mime: 'video/mp4' },
        }))!;
        expect(e.published_at).toBeUndefined();
        expect(e.author_icon).toBeUndefined();
        expect(e.images).toHaveLength(LINK_EMBED_MAX_IMAGES);
        expect(e.nsfw).toBeUndefined();
        expect(e.score).toBeUndefined();
        expect(e.comments).toBeUndefined();
        expect(e.media).toBeUndefined();
        expect(sanitizeLinkEmbed(post({ published_at: '2999-01-01T00:00:00Z' }))!.published_at).toBeUndefined();
    });
    it('a post with only pictures is a post; with nothing is nothing', () => {
        expect(sanitizeLinkEmbed({ url: TWEET, kind: 'post', images: [att(1)] })).toBeDefined();
        expect(sanitizeLinkEmbed({ url: TWEET, kind: 'post', author: 'jack' })).toBeUndefined();
    });
    it('post fields do not leak onto other kinds where they mean nothing', () => {
        const e = sanitizeLinkEmbed({ url: 'https://a.example/', kind: 'card', title: 't', images: [att(1)], nsfw: true, score: 4 })!;
        expect(e.images).toBeUndefined();
        expect(e.nsfw).toBeUndefined();
        expect(e.score).toBeUndefined();
    });
    it('still tied to the text: a forged post for a link that is not there is ignored', () => {
        expect(sanitizeLinkEmbeds([post({ url: 'https://x.com/elonmusk/status/1' })], [TWEET])).toEqual([]);
        expect(sanitizeLinkEmbeds([post()], [TWEET])).toHaveLength(1);
    });
    it('every picture\'s attachment is listed (retention, reports), and the report text names them', () => {
        const e = sanitizeLinkEmbed(post({ author_icon: att(1), images: [att(2), att(2), att(3)], thumb: att(4) }))!;
        expect(linkEmbedAttachmentIds([e])).toEqual([att(4).attachment_id, att(1).attachment_id, att(2).attachment_id, att(3).attachment_id]);
        const report = linkEmbedsReportText([e]);
        expect(report).toContain('Handle: @jack');
        expect(report).toContain(`Author picture: attachment ${att(1).attachment_id}`);
        expect(report).toContain(`Image 3: attachment ${att(3).attachment_id}`);
    });
    it('inline picture bytes do not count against the 8 KB text cap', () => {
        const inline = { mime: 'image/webp', width: 10, height: 10, inline_b64: 'A'.repeat(12 * 1024) };
        const out = sanitizeLinkEmbeds([post({ author_icon: inline, images: [inline, inline, inline, inline] }) as unknown as LinkEmbed], [TWEET]);
        expect(out).toHaveLength(1);
        expect(out[0].images).toHaveLength(4);
    });
});
