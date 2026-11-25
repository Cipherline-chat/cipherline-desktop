// @vitest-environment jsdom
/**
 * Settings → Privacy → "Show embeds" (owner, 2026-11-23), with the REAL
 * usePrivacySettings (storage mocked in memory):
 *   - OFF: a chat holding every embed kind (direct image, GIF, YouTube, a clip
 *     page, a direct video, a Tenor loop, Twitch, TikTok, a plain link, and
 *     sender-built previews: a web card with an ATTACHMENT thumbnail, a tweet,
 *     a Reddit post, a Medal clip) draws no embed and makes zero requests:
 *     no window.fetch / XHR, no main-process fetch or media registration, and
 *     no preview-thumbnail attachment download;
 *   - live: switching it off from Settings (another usePrivacySettings copy)
 *     unmounts a playing player at once, and switching it on brings the cards
 *     back, without a reload;
 *   - it persists in the privacy settings object, default ON.
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
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    return { default: store, secureLocalStore: store };
});
const dl = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async (id: string) => { dl.calls.push(id); throw new Error('no download in this test'); } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't', user: null }) }));
vi.mock('axios', () => ({ default: { patch: vi.fn(async () => ({})), get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({})) } }));

import { MessageEmbed } from './MessageEmbed';
import { SenderEmbed } from './SenderEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { usePrivacySettings, showEmbedsEnabled } from '../../hooks/usePrivacySettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const KEY = 'cipherline_privacy_settings';
const att = { mime: 'image/webp' as const, width: 640, height: 360, attachment_id: '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', file_key_b64: 'A'.repeat(43) + '=', file_nonce_b64: 'B'.repeat(16), byte_size: 40_000 };

const LINKS = [
    'https://i.imgur.com/abcde.png',
    'https://media.tenor.com/abc/cat.gif',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt',
    'https://cdn.example/video.mp4',
    'https://tenor.com/view/cat-dance-12345678',
    'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR',
    'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://example.com/page',
];
const SENT: LinkEmbed[] = [
    { url: 'https://news.example/a', kind: 'card', title: 'News', thumb: att },
    { url: 'https://x.com/jack/status/20', kind: 'post', author: 'jack', description: 'hi', author_icon: att, images: [att],
        media: { url: 'https://video.twimg.com/tweet_video/a.mp4', mime: 'video/mp4', loop: true } },
    { url: 'https://www.reddit.com/r/aww/comments/90bu6w/x/', kind: 'post', title: 'Heat', images: [att] },
    { url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', kind: 'video', title: 'clip', thumb: att, media: { url: 'https://cdn.medal.tv/a.mp4', mime: 'video/mp4' } },
];

let root: Root | null = null;
let host: HTMLDivElement;
let api: Record<string, ReturnType<typeof vi.fn>>;
let netFetch: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.fn>;
const probe: { toggle: ((v: boolean) => void) | null } = { toggle: null };

const SettingsProbe: React.FC = () => { const { setShowEmbeds } = usePrivacySettings(); React.useEffect(() => { probe.toggle = setShowEmbeds; }, [setShowEmbeds]); return null; };

beforeEach(() => {
    mem.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const no = () => vi.fn(async () => { throw new Error('must not be called'); });
    api = {
        fetchBinary: no(), youtubeOEmbed: no(), resolveClipMedia: no(), registerMedia: no(), registerClipMedia: no(), registerPostMedia: no(),
        unfurlLink: no(), setContentProtection: vi.fn(),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    netFetch = vi.fn(async () => { throw new Error('no network'); });
    (window as unknown as { fetch: unknown }).fetch = netFetch;
    xhrOpen = vi.fn();
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class { open = xhrOpen; send() {} setRequestHeader() {} };
    dl.calls = [];
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); probe.toggle = null; });

const chat = () => h(EmbedPlaybackContext.Provider, { value: new PlaybackScope() },
    h(SettingsProbe),
    ...LINKS.map((u, i) => h('div', { key: `l${i}`, 'data-row': u }, h(MessageEmbed, { url: u }))),
    ...SENT.map((e, i) => h('div', { key: `s${i}` }, h(SenderEmbed, { embed: e, layout: 'expanded' }))));

describe('Show embeds', () => {
    it('defaults to ON', () => {
        expect(showEmbedsEnabled()).toBe(true);
    });

    it('OFF: every embed kind draws nothing and nothing is requested — no linked host, no main fetch, no thumbnail download', async () => {
        mem.set(KEY, JSON.stringify({ showEmbeds: false }));
        act(() => { root!.render(chat()); });
        await flush();
        expect(host.querySelectorAll('[data-embed], img, iframe, video, button').length).toBe(0);
        expect(host.textContent).toBe('');
        expect(netFetch).not.toHaveBeenCalled();
        expect(xhrOpen).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(api)) if (name !== 'setContentProtection') expect(fn, name).not.toHaveBeenCalled();
        expect(dl.calls).toEqual([]);
    });

    it('positive control: ON, the same chat draws embeds and asks for the attachment thumbnails', async () => {
        act(() => { root!.render(chat()); });
        await flush();
        expect(host.querySelectorAll('[data-embed]').length).toBeGreaterThan(8);
        expect(dl.calls.length).toBeGreaterThan(0);
    });

    it('live: turning it off from Settings unmounts a playing player and every card; on brings them back', async () => {
        act(() => { root!.render(chat()); });
        await flush();
        const play = host.querySelector('[data-embed="youtube"] button.cl-ve-play') as HTMLButtonElement;
        act(() => { play.click(); });
        await flush();
        expect(host.querySelector('iframe')).not.toBeNull();
        act(() => { probe.toggle!(false); });
        await flush();
        expect(host.querySelector('iframe')).toBeNull();
        expect(host.querySelectorAll('[data-embed]').length).toBe(0);
        expect(JSON.parse(mem.get(KEY)!).showEmbeds).toBe(false);
        act(() => { probe.toggle!(true); });
        await flush();
        expect(host.querySelectorAll('[data-embed]').length).toBeGreaterThan(8);
    });
});
