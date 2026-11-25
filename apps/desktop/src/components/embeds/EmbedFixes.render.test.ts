// @vitest-environment jsdom
/**
 * The 2026-11-23 embed fixes on the RECEIVER, mounted for real:
 *   1. a web card's site icon comes from the message (`author_icon` on a card,
 *      sender-fetched); a missing or broken one is the generated letter tile,
 *      never a broken image; nothing is requested from the site;
 *   2. a Tenor link is a GIF (no player, no play button) at the media's REAL
 *      shape, playing the SENDER's file with no page read; also for a message
 *      from an older sender (no `loop`);
 *   3. the MINIMAL card (site only) draws the no-image Tile with the host and
 *      the path; a link with NO sender preview draws the same card locally.
 * Every case counts requests: window.fetch / XHR / main-process calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LinkEmbed } from '@cipherline/shared';
import { Blob as NodeBlob } from 'node:buffer';

(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;

const env = vi.hoisted(() => {
    const w = globalThis as unknown as { window?: { matchMedia?: unknown } };
    if (w.window && typeof w.window.matchMedia !== 'function') {
        w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
    return { layout: 'expanded' as 'expanded' | 'compact' };
});
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: 'known' } }),
    useShowEmbeds: () => true,
}));
vi.mock('../../utils/embedPrefs', async (orig) => ({ ...(await orig<typeof import('../../utils/embedPrefs')>()), useEmbedLayout: () => env.layout }));
vi.mock('../../hooks/useWindowFocus', () => ({ useWindowFocus: () => true }));
const dl = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../utils/attachmentDownload', () => ({
    downloadEncryptedAttachment: async (id: string) => { dl.calls.push(id); throw new Error('no attachments in this test'); },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));

import { SenderEmbed } from './SenderEmbed';
import { MessageEmbed } from './MessageEmbed';
import { linkPathLabel, siteLetter } from './webCardStyle';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { bytesToBase64 } from '../../utils/linkEmbeds/thumb';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';
import { clearDecryptedMediaCache } from '../../utils/decryptedMediaCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...new Array(40).fill(7)]);
const SRC = `clmedia://media/${'a'.repeat(32)}`;

let root: Root | null = null;
let host: HTMLDivElement;
let api: Record<string, ReturnType<typeof vi.fn>>;
let netFetch: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.fn>;

beforeEach(() => {
    env.layout = 'expanded';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    api = {
        fetchBinary: vi.fn(async () => { throw new Error('must not be called'); }),
        youtubeOEmbed: vi.fn(async () => null),
        resolveClipMedia: vi.fn(async () => ({ ok: true, src: SRC, width: 10, height: 10 })),
        registerMedia: vi.fn(async () => ({ ok: false })),
        registerClipMedia: vi.fn(async () => ({ ok: true, src: SRC })),
        unfurlLink: vi.fn(async () => ({ ok: false, reason: 'failed' })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    netFetch = vi.fn(async () => { throw new Error('no network in this test'); });
    (window as unknown as { fetch: unknown }).fetch = netFetch;
    xhrOpen = vi.fn();
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class { open = xhrOpen; send() {} setRequestHeader() {} };
    URL.createObjectURL = vi.fn(() => `blob:test/${Math.random().toString(36).slice(2)}`);
    URL.revokeObjectURL = vi.fn();
    HTMLMediaElement.prototype.play = vi.fn(async () => {}) as unknown as HTMLMediaElement['play'];
    HTMLMediaElement.prototype.pause = vi.fn();
    dl.calls = [];
    _resetAutoLoadLimiterForTests();
    clearDecryptedMediaCache();
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

function render(nodes: React.ReactNode[]) {
    act(() => { root!.render(h(EmbedPlaybackContext.Provider, { value: new PlaybackScope() }, ...nodes)); });
}
const noRequests = () => {
    expect(netFetch).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(api.fetchBinary).not.toHaveBeenCalled();
    expect(api.unfurlLink).not.toHaveBeenCalled();
    expect(api.youtubeOEmbed).not.toHaveBeenCalled();
};
const inline = (bytes: Uint8Array, w = 64, hh = 64) => ({ mime: 'image/webp' as const, width: w, height: hh, inline_b64: bytesToBase64(bytes) });

describe('1. the site icon', () => {
    const NOIMG: LinkEmbed = { url: 'https://www.amazon.com/', kind: 'card', site: 'amazon.com', title: 'Amazon.com. Spend less. Smile more.', description: 'Free shipping' };

    it('the sender\'s favicon (author_icon on a card) draws in the well and the site pill, from the message; no request', async () => {
        render([h(SenderEmbed, { key: 1, embed: { ...NOIMG, author_icon: inline(WEBP) }, layout: 'compact' })]);
        await flush();
        const card = host.querySelector('[data-embed="web"]')!;
        expect(card.getAttribute('data-embed-shape')).toBe('none');
        expect(card.getAttribute('data-embed-icon')).toBe('site');
        const icons = [...card.querySelectorAll('.cl-se-mark--icon img')].map((i) => i.getAttribute('src'));
        expect(icons.length).toBe(2);
        for (const s of icons) expect(s).toMatch(/^data:image\/webp;base64,/);
        noRequests();
    });

    it('no icon: the letter tile (A), never an <img>', async () => {
        render([h(SenderEmbed, { key: 1, embed: NOIMG, layout: 'compact' })]);
        await flush();
        const well = host.querySelector('.cl-se-well')!;
        expect(well.querySelector('img')).toBeNull();
        expect(well.textContent).toBe('A');
        expect(host.querySelector('[data-embed="web"]')!.getAttribute('data-embed-icon')).toBe('letter');
        noRequests();
    });

    it('an icon whose bytes are not an image is refused (letter); one that fails to draw falls back to the letter', async () => {
        const HTML = new Uint8Array(Buffer.from('<!doctype html><html><body>not an icon</body></html>'));
        render([h(SenderEmbed, { key: 1, embed: { ...NOIMG, author_icon: inline(HTML) }, layout: 'compact' })]);
        await flush();
        expect(host.querySelector('.cl-se-well img')).toBeNull();
        expect(host.querySelector('.cl-se-well')!.textContent).toBe('A');

        render([h(SenderEmbed, { key: 2, embed: { ...NOIMG, author_icon: inline(WEBP) }, layout: 'compact' })]);
        await flush();
        const img = host.querySelector('.cl-se-well img')!;
        expect(img).not.toBeNull();
        act(() => { img.dispatchEvent(new Event('error')); });
        expect(host.querySelector('.cl-se-well img')).toBeNull();
        expect(host.querySelector('.cl-se-well')!.textContent).toBe('A');
    });

    it('siteLetter: the first letter or digit of the site', () => {
        expect(siteLetter('www.bbc.com')).toBe('B');
        expect(siteLetter('  8bit.io')).toBe('8');
        expect(siteLetter('ünïcode.de')).toBe('Ü');
        expect(siteLetter('---')).toBe('•');
    });
});

describe('2. Tenor is a GIF at its real shape', () => {
    const TENOR_URL = 'https://tenor.com/view/morning-morning-coffee-morning-cat-coffee-cat-bad-hair-cat-gif-3162456205570563299';
    const MEDIA = 'https://media.tenor.com/K-NNKd7DXOMAAAPo/morning-morning-coffee.mp4';
    const TENOR: LinkEmbed = {
        url: TENOR_URL, kind: 'video', site: 'Tenor', title: 'Morning Morning Coffee GIF', author: 'MeghanHolbrook',
        media: { url: MEDIA, mime: 'video/mp4', width: 298, height: 498, duration_s: 5, loop: true }, thumb: inline(WEBP, 165, 276),
    };

    it.each([['expanded', 300], ['compact', 180]] as const)('%s: a muted loop, no player / play button, box %s px tall at 298:498, the sender\'s file (no page read)', async (layout, maxH) => {
        env.layout = layout;
        render([h(SenderEmbed, { key: 1, embed: TENOR, layout })]);
        await flush();
        expect(host.querySelector('[data-sender-embed="gif"]')).not.toBeNull();
        expect(host.querySelector('.cl-ve, .cl-ve-play, [data-sender-embed="video"]')).toBeNull();
        const v = host.querySelector('video')!;
        expect(v.getAttribute('src')).toBe(SRC);
        expect(v.muted && v.loop).toBe(true);
        expect(v.hasAttribute('controls')).toBe(false);
        expect(v.style.aspectRatio).toBe('298 / 498');
        expect(parseFloat(v.style.width)).toBeCloseTo(298 * (maxH / 498), 1);
        expect(api.registerClipMedia).toHaveBeenCalledWith(TENOR_URL, MEDIA);
        expect(api.resolveClipMedia).not.toHaveBeenCalled(); // the tenor.com page is never read
        noRequests();
    });

    it('a message from an older sender (kind video, no loop flag) is a GIF too', async () => {
        const old: LinkEmbed = { ...TENOR, media: { url: MEDIA, mime: 'video/mp4', width: 298, height: 498 } };
        render([h(SenderEmbed, { key: 1, embed: old })]);
        await flush();
        expect(host.querySelector('[data-sender-embed="gif"] video')).not.toBeNull();
        expect(host.querySelector('.cl-ve-play')).toBeNull();
    });

    it('the sender\'s file refused (expired): one page read, still a GIF', async () => {
        api.registerClipMedia.mockResolvedValueOnce({ ok: false });
        render([h(SenderEmbed, { key: 1, embed: TENOR })]);
        await flush();
        expect(api.resolveClipMedia).toHaveBeenCalledTimes(1);
        expect(host.querySelector('[data-sender-embed="gif"] video')).not.toBeNull();
        // The sender's shape stays (the page's own numbers do not override it).
        expect((host.querySelector('video') as HTMLElement).style.aspectRatio).toBe('298 / 498');
    });

    it('positive control: a Medal clip from a sender is still the click-to-play video card', async () => {
        render([h(SenderEmbed, { key: 1, embed: { url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', kind: 'video', site: 'Medal', title: 'x', media: { url: 'https://cdn.medal.tv/mediac/x.mp4', mime: 'video/mp4', width: 1920, height: 1080 } } })]);
        await flush();
        expect(host.querySelector('.cl-ve-play')).not.toBeNull();
        expect(host.querySelector('[data-sender-embed="gif"]')).toBeNull();
    });
});

describe('3. the minimal card', () => {
    it('site only: the no-image Tile, the host as title, the path under it, no duplicate site pill; no request', async () => {
        render([h(SenderEmbed, { key: 1, embed: { url: 'https://www.nytimes.com/2026/11/22/world/a-story.html?x=1', kind: 'card', site: 'nytimes.com' } })]);
        await flush();
        const card = host.querySelector('[data-embed="web"]')!;
        expect(card.getAttribute('data-embed-minimal')).toBe('true');
        expect(card.getAttribute('data-embed-shape')).toBe('none');
        expect(card.querySelector('.cl-se-title')!.textContent).toBe('nytimes.com');
        expect(card.querySelector('.cl-se-path')!.textContent).toBe('/2026/11/22/world/a-story.html?x=1');
        expect(card.querySelector('.cl-se-site')).toBeNull();
        expect(card.querySelector('.cl-se-well')!.textContent).toBe('N');
        noRequests();
    });

    it('a link with NO sender preview (older client, previews off): the same card, built locally, no request', async () => {
        render([h(MessageEmbed, { key: 1, url: 'https://example.com/some/page' })]);
        await flush();
        const card = host.querySelector('[data-embed="web"]')!;
        expect(card).not.toBeNull();
        expect(card.getAttribute('data-embed-minimal')).toBe('true');
        expect(card.querySelector('.cl-se-title')!.textContent).toBe('example.com');
        expect(card.querySelector('.cl-se-path')!.textContent).toBe('/some/page');
        expect(host.querySelector('[style*="border-left"]')).toBeNull(); // the old rail card is gone
        noRequests();
        expect(api.resolveClipMedia).not.toHaveBeenCalled();
        expect(api.registerClipMedia).not.toHaveBeenCalled();
    });

    it('linkPathLabel: decoded, control / bidi characters dropped, bounded; the bare root has none', () => {
        expect(linkPathLabel('https://a.example/')).toBe('');
        expect(linkPathLabel('https://a.example/caf%C3%A9')).toBe('/café');
        expect(linkPathLabel('https://a.example/a%E2%80%AEb')).toBe('/ab');
        expect(linkPathLabel(`https://a.example/${'x'.repeat(200)}`).length).toBe(90);
    });
});
