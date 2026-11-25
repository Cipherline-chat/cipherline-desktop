// @vitest-environment jsdom
/**
 * Phase-4 embeds on the RECEIVER, mounted for real (Twitch, TikTok, X, Reddit):
 *   - every card draws from the message alone: no window.fetch, no XHR, no
 *     main-process fetch, no iframe, no media registration before play;
 *   - Twitch / TikTok: the frame is mounted only on play, built here on the
 *     provider's exact origin; POSITIVE CONTROLS: a forged player id (not the
 *     one the visible link names) and an off-allowlist provider draw no player;
 *   - X video: play registers the sender's file through main
 *     (registerPostMedia), never before;
 *   - NSFW / spoiler media is veiled until clicked;
 *   - tweet text is plain text with links (no HTML injection).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LinkEmbed } from '@cipherline/shared';

vi.hoisted(() => {
    const w = globalThis as unknown as { window?: { matchMedia?: unknown } };
    if (w.window && typeof w.window.matchMedia !== 'function') {
        w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
});
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: 'known' } }),
    useShowEmbeds: () => true,
}));
vi.mock('../../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async () => { throw new Error('no attachment thumbs in this test'); } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));
const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../../utils/openExternalLink', () => ({ openExternalLink: (u: string) => { opened.urls.push(u); } }));

import { SenderEmbed } from './SenderEmbed';
import { MessageEmbed } from './MessageEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { bytesToBase64 } from '../../utils/linkEmbeds/thumb';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...new Array(40).fill(7)]);
const pic = (w: number, hh: number) => ({ mime: 'image/webp' as const, width: w, height: hh, inline_b64: bytesToBase64(WEBP) });

let root: Root | null = null;
let host: HTMLDivElement;
let api: Record<string, ReturnType<typeof vi.fn>>;
let netFetch: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.fn>;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    api = {
        fetchBinary: vi.fn(async () => { throw new Error('must not be called'); }),
        youtubeOEmbed: vi.fn(async () => null),
        resolveClipMedia: vi.fn(async () => ({ ok: false, reason: 'failed' })),
        registerMedia: vi.fn(async () => ({ ok: false })),
        registerClipMedia: vi.fn(async () => ({ ok: false })),
        registerPostMedia: vi.fn(async () => ({ ok: true, src: `clmedia://media/${'b'.repeat(32)}` })),
        unfurlLink: vi.fn(async () => ({ ok: false, reason: 'failed' })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    netFetch = vi.fn(async () => { throw new Error('no network in this test'); });
    (window as unknown as { fetch: unknown }).fetch = netFetch;
    xhrOpen = vi.fn();
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class { open = xhrOpen; send() {} setRequestHeader() {} };
    opened.urls = [];
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

function render(nodes: React.ReactNode[]) {
    const scope = new PlaybackScope();
    act(() => { root!.render(h(EmbedPlaybackContext.Provider, { value: scope }, ...nodes)); });
}
const noRequests = () => {
    expect(netFetch).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    for (const [name, fn] of Object.entries(api)) expect(fn, name).not.toHaveBeenCalled();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('video')).toBeNull();
};
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

const TWITCH_CLIP: LinkEmbed = {
    url: 'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR', kind: 'player', site: 'Twitch',
    title: 'smol shroud', author: 'shroud', tag: 'World of Warcraft', thumb: pic(640, 360),
    player: { provider: 'twitch', id: 'clip:DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR' },
};
const TIKTOK: LinkEmbed = {
    url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173', kind: 'player', site: 'TikTok',
    title: 'Scramble up ur name', author: 'Scout, Suki & Stella', author_handle: '@scout2015', thumb: pic(320, 568),
    player: { provider: 'tiktok', id: '6718335390845095173' },
};
const TWEET: LinkEmbed = {
    url: 'https://x.com/elonmusk/status/1585341984679469056', kind: 'post', site: 'X', author: 'Elon Musk', author_handle: '@elonmusk',
    description: 'Entering Twitter HQ <img src=x onerror=alert(1)> see https://example.com/a.', published_at: '2022-10-26T18:45:58Z',
    author_icon: pic(128, 128), thumb: pic(640, 360),
    media: { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/a.mp4?tag=14', mime: 'video/mp4', width: 1920, height: 1080, duration_s: 9.3 },
};
const REDDIT: LinkEmbed = {
    url: 'https://www.reddit.com/r/EarthPorn/comments/1abcd2e/three_views/', kind: 'post', site: 'Reddit', title: 'Three views of the same valley',
    author: 'r/EarthPorn', author_handle: 'u/some_hiker', score: 8421, comments: 212, nsfw: true,
    images: [pic(640, 480), pic(640, 480), pic(640, 480)],
};

describe('phase-4 cards draw from the message alone', () => {
    it('Twitch, TikTok, X and Reddit: cards drawn, zero requests of any kind before play', async () => {
        render([TWITCH_CLIP, TIKTOK, TWEET, REDDIT].map((e, i) => h(SenderEmbed, { key: i, embed: e, layout: 'expanded' })));
        await flush();
        expect(host.querySelector('[data-embed="twitch"]')).not.toBeNull();
        expect(host.querySelector('[data-embed="tiktok"]')).not.toBeNull();
        expect(host.querySelector('[data-embed="post"][data-provider="x"]')).not.toBeNull();
        expect(host.querySelector('[data-embed="post"][data-provider="reddit"]')).not.toBeNull();
        expect(host.textContent).toContain('smol shroud');
        expect(host.textContent).toContain('@elonmusk');
        expect(host.textContent).toContain('r/EarthPorn');
        noRequests();
    });

    it('Twitch: play mounts clips.twitch.tv/embed with parent = this page\'s host, built here', async () => {
        render([h(SenderEmbed, { key: 1, embed: TWITCH_CLIP, layout: 'expanded' })]);
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        const f = host.querySelector('iframe')!;
        const src = new URL(f.getAttribute('src')!);
        expect(src.origin).toBe('https://clips.twitch.tv');
        expect(src.searchParams.get('clip')).toBe('DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR');
        expect(src.searchParams.get('parent')).toBe(window.location.hostname);
        expect(netFetch).not.toHaveBeenCalled();
    });

    it('TikTok: play mounts the vertical www.tiktok.com/player/v1/<id> frame', async () => {
        render([h(SenderEmbed, { key: 1, embed: TIKTOK, layout: 'compact' })]);
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        const src = new URL(host.querySelector('iframe')!.getAttribute('src')!);
        expect(src.origin + src.pathname).toBe('https://www.tiktok.com/player/v1/6718335390845095173');
    });

    it('POSITIVE CONTROL: a forged player id (another clip than the link names) gets no player', async () => {
        const forged = { ...TWITCH_CLIP, player: { provider: 'twitch' as const, id: 'clip:SomeOtherClip' } };
        const forgedTt = { ...TIKTOK, player: { provider: 'tiktok' as const, id: '7000000000000000001' } };
        render([h(SenderEmbed, { key: 1, embed: forged, layout: 'expanded' }), h(SenderEmbed, { key: 2, embed: forgedTt, layout: 'expanded' })]);
        await flush();
        // Each falls back to the local card for the VISIBLE link (its own id), never the forged one.
        const plays = host.querySelectorAll('button.cl-ve-play');
        for (const b of Array.from(plays)) click(b);
        await flush();
        const srcs = Array.from(host.querySelectorAll('iframe')).map((f) => f.getAttribute('src')!);
        expect(srcs.join(' ')).not.toContain('SomeOtherClip');
        expect(srcs.join(' ')).not.toContain('7000000000000000001');
        expect(host.textContent).not.toContain('smol shroud');
    });

    it('POSITIVE CONTROL: an off-allowlist provider or a frame URL in the message is refused', async () => {
        const evil = { url: TIKTOK.url, kind: 'player', title: 'x', player: { provider: 'evil', id: '6718335390845095173', src: 'https://evil.example/frame' } } as unknown as LinkEmbed;
        render([h(SenderEmbed, { key: 1, embed: evil, layout: 'expanded' })]);
        await flush();
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        for (const f of Array.from(host.querySelectorAll('iframe'))) expect(new URL(f.getAttribute('src')!).origin).toBe('https://www.tiktok.com');
        expect(host.innerHTML).not.toContain('evil.example');
    });

    it('X: the video plays the sender\'s file through main only on play; the text is plain text with a link', async () => {
        render([h(SenderEmbed, { key: 1, embed: TWEET, layout: 'expanded' })]);
        await flush();
        expect(api.registerPostMedia).not.toHaveBeenCalled();
        const text = host.querySelector('.cl-pe-text')!;
        expect(text.querySelector('img')).toBeNull();
        expect(text.textContent).toContain('<img src=x onerror=alert(1)>');
        const link = text.querySelector('a')!;
        expect(link.getAttribute('href')).toBe('https://example.com/a');
        click(link);
        expect(opened.urls).toEqual(['https://example.com/a']);
        click(host.querySelector('button.cl-pe-play'));
        await flush();
        expect(api.registerPostMedia).toHaveBeenCalledWith(TWEET.url, TWEET.media!.url);
        expect(host.querySelector('video')?.getAttribute('src')).toMatch(/^clmedia:\/\/media\//);
        expect(netFetch).not.toHaveBeenCalled();
    });

    it('Reddit NSFW: the pictures are veiled until clicked; score and comments shown', async () => {
        render([h(SenderEmbed, { key: 1, embed: REDDIT, layout: 'compact' })]);
        await flush();
        expect(host.querySelector('[data-veiled="true"]')).not.toBeNull();
        expect(host.textContent).toContain('NSFW');
        expect(host.textContent).toContain('8421');
        expect(host.textContent).toContain('212 comments');
        click(host.querySelector('button.cl-pe-veil'));
        expect(host.querySelector('[data-veiled="true"]')).toBeNull();
        expect(host.querySelectorAll('.cl-pe-cell')).toHaveLength(3);
    });

    it('a post embed on a link that is not X / Reddit is not drawn as a post', async () => {
        render([h(SenderEmbed, { key: 1, embed: { ...TWEET, url: 'https://example.com/x' }, layout: 'expanded' })]);
        await flush();
        expect(host.querySelector('[data-embed="post"]')).toBeNull();
    });

    it('no sender preview (older client): Twitch / TikTok links still get the click-to-play card, nothing loads first', async () => {
        render([h(MessageEmbed, { key: 1, url: 'https://www.twitch.tv/videos/2931745878' }), h(MessageEmbed, { key: 2, url: TIKTOK.url })]);
        await flush();
        noRequests();
        click(host.querySelector('[data-embed="twitch"] button.cl-ve-play'));
        await flush();
        const src = new URL(host.querySelector('iframe')!.getAttribute('src')!);
        expect(src.origin).toBe('https://player.twitch.tv');
        expect(src.searchParams.get('video')).toBe('v2931745878');
    });
});
