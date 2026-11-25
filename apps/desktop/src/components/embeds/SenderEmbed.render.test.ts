// @vitest-environment jsdom
/**
 * Sender-built embeds on the RECEIVER (phase 3), mounted for real:
 *   - a news card, a YouTube card and a Medal clip card render from the
 *     message alone: no main-process fetch, no oEmbed, no clip resolution,
 *     no network request of any kind (window.fetch / XHR spied);
 *   - the thumbnail comes from the encrypted attachment (our API only) or
 *     inline bytes, and must really be the declared image type;
 *   - a forged embed for a link that is not in the text is not drawn;
 *   - the owner's layout table: wide → Ambient (compact, the Amazon card's
 *     layout, owner 2026-11-23) / Island (expanded), square → Ambient, none → Tile;
 *   - Medal play streams the SENDER's file (registerClipMedia) with no page fetch;
 *   - "Remove embed" on own messages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LinkEmbed } from '@cipherline/shared';
import { Blob as NodeBlob } from 'node:buffer';

// jsdom's Blob has no arrayBuffer(); Electron's (Chromium's) does. Use Node's.
(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;

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
const dl = vi.hoisted(() => ({ calls: [] as string[], blob: null as Blob | null }));
vi.mock('../../utils/attachmentDownload', () => ({
    downloadEncryptedAttachment: async (id: string) => { dl.calls.push(id); return dl.blob!; },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));

import { SenderEmbed } from './SenderEmbed';
import { senderEmbedsFor } from './senderEmbeds';
import { pictureShapeOf, webCardStyleFor } from './webCardStyle';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { embedUrlsOf } from '../../utils/formatting/plainText';
import { encryptBlob, exportKeyToBase64, generateAesGcmKey } from '../../utils/crypto';
import { bytesToBase64 } from '../../utils/linkEmbeds/thumb';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';
import { clearDecryptedMediaCache } from '../../utils/decryptedMediaCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

// A real WebP header (RIFF....WEBP) + filler.
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...new Array(40).fill(7)]);

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
        registerClipMedia: vi.fn(async () => ({ ok: true, src: `clmedia://media/${'a'.repeat(32)}` })),
        unfurlLink: vi.fn(async () => ({ ok: false, reason: 'failed' })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    netFetch = vi.fn(async () => { throw new Error('no network in this test'); });
    (window as unknown as { fetch: unknown }).fetch = netFetch;
    xhrOpen = vi.fn();
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class { open = xhrOpen; send() {} setRequestHeader() {} };
    URL.createObjectURL = vi.fn(() => `blob:test/${Math.random().toString(36).slice(2)}`);
    URL.revokeObjectURL = vi.fn();
    dl.calls = [];
    _resetAutoLoadLimiterForTests();
    clearDecryptedMediaCache();
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

function render(embeds: LinkEmbed[], layout: 'compact' | 'expanded' = 'expanded', onRemove?: (u: string) => void) {
    const scope = new PlaybackScope();
    act(() => {
        root!.render(h(EmbedPlaybackContext.Provider, { value: scope },
            ...embeds.map((e, i) => h(SenderEmbed, { key: i, embed: e, layout, onRemove: onRemove ? () => onRemove(e.url) : undefined }))));
    });
}

const inlineThumb = (w: number, hgt: number) => ({ mime: 'image/webp' as const, width: w, height: hgt, inline_b64: bytesToBase64(WEBP) });

const NEWS: LinkEmbed = {
    url: 'https://arstechnica.com/reviews/2026/11/review-the-asus-proart-p16/', kind: 'card', site: 'Ars Technica',
    title: 'Review: The Asus ProArt P16 offers a glimpse of a future powered by local AI',
    description: 'The new Asus ProArt laptop costs up to $7,000.', author: 'Someone', color: '#ff4e00', image_large: true,
    thumb: inlineThumb(640, 360),
};
const YT: LinkEmbed = {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', kind: 'player', site: 'YouTube', title: 'Me at the zoo', author: 'jawed',
    player: { provider: 'youtube', id: 'jNQXAC9IVRw' }, thumb: inlineThumb(320, 180),
};
const MEDAL: LinkEmbed = {
    url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', kind: 'video', site: 'Medal', title: 'wyw my sweetie', tag: 'Valorant', author: 'TofuFPS',
    media: { url: 'https://cdn.medal.tv/mediac/x.mp4?auth=1', mime: 'video/mp4', width: 1920, height: 1080, duration_s: 24.15 }, thumb: inlineThumb(320, 180),
};

describe('receiver: sender-built embeds render with no request to the linked sites', () => {
    it('news + YouTube + Medal: real titles, thumbnails, duration; zero fetches of any kind', async () => {
        render([NEWS, YT, MEDAL]);
        await flush();
        const text = host.textContent ?? '';
        expect(text).toContain('Review: The Asus ProArt P16');
        expect(text).toContain('Me at the zoo');
        expect(text).toContain('jawed');
        expect(text).toContain('wyw my sweetie');
        expect(text).toContain('Valorant');
        expect(text).toContain('0:24');
        expect(text).not.toContain('Medal clip'); // no placeholder
        // Every picture is a local blob: URL from the message.
        const imgs = [...host.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '');
        expect(imgs.length).toBeGreaterThanOrEqual(3);
        for (const src of imgs) expect(src).toMatch(/^(blob:|data:image\/webp;base64,)/);
        expect(api.fetchBinary).not.toHaveBeenCalled();
        expect(api.youtubeOEmbed).not.toHaveBeenCalled();
        expect(api.resolveClipMedia).not.toHaveBeenCalled();
        expect(api.registerClipMedia).not.toHaveBeenCalled();
        expect(netFetch).not.toHaveBeenCalled();
        expect(xhrOpen).not.toHaveBeenCalled();
        expect(host.querySelector('iframe')).toBeNull();
    });

    it('Medal play streams the sender\'s file through main (provider host check) without reading the page', async () => {
        render([MEDAL]);
        await flush();
        await act(async () => { (host.querySelector('button.cl-ve-play') as HTMLButtonElement).click(); });
        await flush();
        expect(api.registerClipMedia).toHaveBeenCalledWith(MEDAL.url, MEDAL.media!.url);
        expect(api.resolveClipMedia).not.toHaveBeenCalled();
        expect(host.querySelector('video')?.getAttribute('src')).toMatch(/^clmedia:\/\/media\//);
    });

    it('Medal: if main refuses the sender\'s file, it falls back to reading the page on click', async () => {
        api.registerClipMedia.mockResolvedValueOnce({ ok: false });
        render([MEDAL]);
        await flush();
        await act(async () => { (host.querySelector('button.cl-ve-play') as HTMLButtonElement).click(); });
        await flush();
        expect(api.resolveClipMedia).toHaveBeenCalledWith(MEDAL.url);
    });

    it('YouTube: the player frame is built from the visible link\'s id; a mismatching embed id is not trusted', async () => {
        render([{ ...YT, player: { provider: 'youtube', id: 'dQw4w9WgXcQ' } }]);
        await flush();
        // Falls back to the local facade (which is allowed to fetch the thumbnail via main) — not the sender's claim.
        expect(host.textContent).not.toContain('Me at the zoo');
        render([YT]);
        await flush();
        await act(async () => { (host.querySelector('button.cl-ve-play') as HTMLButtonElement).click(); });
        expect(host.querySelector('iframe')?.getAttribute('src')).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/jNQXAC9IVRw\?/);
    });

    it('an attachment thumbnail is downloaded from OUR API and decrypted; a wrong type is refused', async () => {
        const key = await generateAesGcmKey();
        const { encryptedBlob, ivB64 } = await encryptBlob(new Blob([WEBP]), key);
        dl.blob = encryptedBlob;
        const thumb = { mime: 'image/webp' as const, width: 640, height: 360, attachment_id: '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', file_key_b64: await exportKeyToBase64(key), file_nonce_b64: ivB64, byte_size: WEBP.length };
        render([{ ...NEWS, thumb }]);
        await flush();
        expect(dl.calls).toEqual([thumb.attachment_id]);
        expect(host.querySelector('img.cl-se-frame')?.getAttribute('src')).toMatch(/^blob:/);
        expect(host.querySelector('[data-embed-style]')?.getAttribute('data-embed-style')).toBe('island');

        // Same key, but the plaintext is not a WebP: no picture, the card falls back to no-image.
        clearDecryptedMediaCache();
        const { encryptedBlob: notImg, ivB64: iv2 } = await encryptBlob(new Blob([new Uint8Array(56).fill(1)]), key);
        dl.blob = notImg;
        render([{ ...NEWS, url: NEWS.url + '?2', thumb: { ...thumb, attachment_id: '1b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', file_nonce_b64: iv2, byte_size: 56 } }]);
        await flush();
        expect(host.querySelector('img.cl-se-frame')).toBeNull();
        expect(host.querySelector('[data-embed-shape]')?.getAttribute('data-embed-shape')).toBe('none');
    });

    it('Remove embed (own message) calls back with that embed', async () => {
        const removed: string[] = [];
        render([NEWS, MEDAL], 'expanded', (u) => removed.push(u));
        await flush();
        const btns = host.querySelectorAll('button[aria-label="Remove embed"]');
        expect(btns.length).toBe(2);
        await act(async () => { (btns[1] as HTMLButtonElement).click(); });
        expect(removed).toEqual([MEDAL.url]);
    });
});

describe('the owner\'s layout table (§10)', () => {
    it('wide → Ambient (compact) / Island (expanded); square → Ambient; none → Tile', () => {
        expect(webCardStyleFor('compact', 'wide')).toBe('ambient');
        expect(webCardStyleFor('expanded', 'wide')).toBe('island');
        expect(webCardStyleFor('compact', 'square')).toBe('ambient');
        expect(webCardStyleFor('expanded', 'square')).toBe('ambient');
        expect(webCardStyleFor('compact', 'none')).toBe('tile');
        expect(webCardStyleFor('expanded', 'none')).toBe('tile');
        expect(pictureShapeOf({ thumb: inlineThumb(640, 335) })).toBe('wide');
        expect(pictureShapeOf({ thumb: inlineThumb(460, 460) })).toBe('square');
        expect(pictureShapeOf({})).toBe('none');
    });

    it('renders each style', async () => {
        render([NEWS], 'compact');
        await flush();
        expect(host.querySelector('[data-embed-style]')?.getAttribute('data-embed-style')).toBe('ambient');
        render([NEWS], 'expanded');
        await flush();
        expect(host.querySelector('[data-embed-style]')?.getAttribute('data-embed-style')).toBe('island');
        render([{ ...NEWS, thumb: inlineThumb(400, 400) }], 'expanded');
        await flush();
        expect(host.querySelector('[data-embed-style]')?.getAttribute('data-embed-style')).toBe('ambient');
        render([{ ...NEWS, thumb: undefined }], 'expanded');
        await flush();
        expect(host.querySelector('[data-embed-style]')?.getAttribute('data-embed-style')).toBe('tile');
        expect(host.querySelector('[data-embed-shape]')?.getAttribute('data-embed-shape')).toBe('none');
    });
});

describe('senderEmbedsFor (what ChatPane draws)', () => {
    it('POSITIVE CONTROL: a forged embed for a URL that is not in the text is ignored', () => {
        const text = 'read this https://arstechnica.com/reviews/2026/11/review-the-asus-proart-p16/';
        const forged = { ...NEWS, url: 'https://phish.example/login', title: 'Sign in to your bank' };
        const out = senderEmbedsFor(text, [forged, NEWS], embedUrlsOf(text));
        expect(out.map((e) => e.url)).toEqual([NEWS.url]);
        expect(senderEmbedsFor(text, [forged], embedUrlsOf(text))).toEqual([]);
    });
    it('no field, no embeds (older senders keep today\'s local embeds)', () => {
        expect(senderEmbedsFor('https://a.example/', undefined, ['https://a.example/'])).toEqual([]);
    });
});
