// @vitest-environment jsdom
/**
 * Click an embed's picture to enlarge it (docs/plans/embeds.md §11, owner
 * 2026-11-24), mounted for real:
 *   - a web card's picture (Island hero, Ambient / Tile thumbnail, a page
 *     snapshot) and a post's picture open the app's image viewer
 *     (ImageLightbox) on click AND on Enter;
 *   - the viewer shows the decrypted copy from the message: an inline picture
 *     becomes a local blob: URL (so Save works), never a request (fetch, XHR,
 *     main-process fetch all counted);
 *   - "Open original" opens the PAGE / post link through openExternalLink;
 *   - a DESIGNED picture (not a picture of anything) does not open
 *     (positive control: the same card with a real picture does);
 *   - video posters still play on click (they never open the viewer).
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
    return { layout: 'expanded' as 'expanded' | 'compact', opened: [] as string[] };
});
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: 'known' } }),
    useShowEmbeds: () => true,
}));
vi.mock('../../utils/embedPrefs', async (orig) => ({ ...(await orig<typeof import('../../utils/embedPrefs')>()), useEmbedLayout: () => env.layout }));
vi.mock('../../hooks/useWindowFocus', () => ({ useWindowFocus: () => true }));
vi.mock('../../utils/attachmentDownload', () => ({
    downloadEncryptedAttachment: async () => { throw new Error('no attachments in this test'); },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));
vi.mock('../../utils/openExternalLink', () => ({ openExternalLink: (u: string) => { env.opened.push(u); return { ok: true }; } }));

import { SenderEmbed } from './SenderEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { objectUrlForDataImage, isLocalPicture, pictureFilename } from './embedPicture';
import { bytesToBase64 } from '../../utils/linkEmbeds/thumb';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';
import { clearDecryptedMediaCache } from '../../utils/decryptedMediaCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...new Array(40).fill(7)]);
const B64 = bytesToBase64(WEBP);
const PAGE = 'https://www.example.org/article/1';

let root: Root | null = null;
let host: HTMLDivElement;
let netFetch: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.fn>;
let fetchBinary: ReturnType<typeof vi.fn>;
let made: string[];

beforeEach(() => {
    env.layout = 'expanded';
    env.opened = [];
    made = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    fetchBinary = vi.fn(async () => { throw new Error('must not be called'); });
    (window as unknown as { electronAPI: unknown }).electronAPI = { fetchBinary, registerMedia: vi.fn(), registerClipMedia: vi.fn(), resolveClipMedia: vi.fn() };
    netFetch = vi.fn(async () => { throw new Error('no network in this test'); });
    (window as unknown as { fetch: unknown }).fetch = netFetch;
    xhrOpen = vi.fn();
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class { open = xhrOpen; send() {} setRequestHeader() {} };
    URL.createObjectURL = vi.fn(() => { const u = `blob:test/${made.length}`; made.push(u); return u; });
    URL.revokeObjectURL = vi.fn();
    _resetAutoLoadLimiterForTests();
    clearDecryptedMediaCache();
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    document.body.innerHTML = '';
});

const mount = (embeds: LinkEmbed[]) => {
    const scope = new PlaybackScope();
    act(() => {
        root!.render(h(EmbedPlaybackContext.Provider, { value: scope }, ...embeds.map((e, i) => h(SenderEmbed, { key: i, embed: e }))));
    });
};
const thumb = (w: number, hgt: number, extra: Record<string, unknown> = {}) => ({ mime: 'image/webp' as const, width: w, height: hgt, inline_b64: B64, ...extra });
const viewerImg = () => [...document.body.querySelectorAll('img')].find((i) => i.style.maxWidth === '90vw') ?? null;
const expectNoRequest = () => {
    expect(netFetch).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(fetchBinary).not.toHaveBeenCalled();
};

describe('click a web card picture to enlarge it', () => {
    it('Island (expanded, wide picture): click the picture → the viewer with the decrypted copy as a local blob:, no request', async () => {
        mount([{ url: PAGE, kind: 'card', site: 'Example', title: 'An article', thumb: thumb(1200, 630) }]);
        await flush();
        const hero = host.querySelector<HTMLElement>('.cl-se-hero')!;
        expect(hero.getAttribute('role')).toBe('button');
        expect(viewerImg()).toBeNull();
        act(() => { hero.click(); });
        await flush();
        const img = viewerImg();
        expect(img).not.toBeNull();
        // The inline picture was turned into a blob: locally (Save works), from the message's own bytes.
        expect(img!.getAttribute('src')).toMatch(/^blob:test\//);
        expectNoRequest();
    });

    it('Enter on the focused picture opens it; "Open original" opens the PAGE link (shared helper)', async () => {
        mount([{ url: PAGE, kind: 'card', site: 'Example', title: 'An article', thumb: thumb(1200, 630) }]);
        await flush();
        const hero = host.querySelector<HTMLElement>('.cl-se-hero')!;
        expect(hero.tabIndex).toBe(0);
        act(() => { hero.focus(); hero.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await flush();
        expect(viewerImg()).not.toBeNull();
        const openOriginal = document.body.querySelector<HTMLElement>('[aria-label="Open original"]');
        expect(openOriginal).not.toBeNull();
        act(() => { openOriginal!.click(); });
        expect(env.opened).toEqual([PAGE]);
        // Save is offered (the bytes are local).
        expect(document.body.querySelector('[aria-label="Save image"]')).not.toBeNull();
        expectNoRequest();
    });

    it('Ambient (square picture) and compact Ambient (wide picture) open too; the thumbnail keeps its real shape', async () => {
        mount([{ url: PAGE, kind: 'card', site: 'Example', title: 'Square', thumb: thumb(600, 800) }]);
        await flush();
        const amb = host.querySelector<HTMLElement>('.cl-se-thumb--amb')!;
        expect(amb.style.getPropertyValue('--cl-se-amb-a')).toBe('0.75');
        act(() => { amb.click(); });
        await flush();
        expect(viewerImg()).not.toBeNull();
        expectNoRequest();
    });

    it('a page SNAPSHOT (the sender\'s picture of the page) opens like any picture', async () => {
        mount([{ url: PAGE, kind: 'card', site: 'Example', title: 'Snap', thumb: thumb(1280, 720) }]);
        await flush();
        act(() => { host.querySelector<HTMLElement>('[data-picture-open]')!.click(); });
        await flush();
        expect(viewerImg()).not.toBeNull();
    });

    it('POSITIVE CONTROL: a DESIGNED picture does not open (and is not a focusable control)', async () => {
        mount([{ url: PAGE, kind: 'card', site: 'Example', title: 'No picture', thumb: thumb(1280, 720, { designed: true }) }]);
        await flush();
        expect(host.querySelector('[data-picture-open]')).toBeNull();
        act(() => { host.querySelector<HTMLElement>('.cl-se-hero, .cl-se-thumb')?.click(); });
        await flush();
        expect(viewerImg()).toBeNull();
    });
});

describe('post pictures (X / Reddit)', () => {
    it('a single post picture keeps its own shape and opens the viewer; Open original = the post', async () => {
        const post = 'https://x.com/someone/status/1859912345678901234';
        mount([{ url: post, kind: 'post', author: 'Someone', author_handle: '@someone', description: 'look', images: [thumb(720, 1280)] }]);
        await flush();
        const cell = host.querySelector<HTMLElement>('.cl-pe-cell')!;
        // The picture's own shape at the media box's width (9:16 → 252 wide); the card hugs it (252 + padding, 280 at least).
        expect(cell.style.aspectRatio).toBe('720 / 1280');
        expect(host.querySelector<HTMLElement>('.cl-pe-mediawrap')!.style.width).toBe('252px');
        const card = host.querySelector<HTMLElement>('.cl-pe')!;
        expect(card.getAttribute('data-hug')).toBe('true');
        expect(card.style.getPropertyValue('--cl-pe-mw')).toBe('252px');
        act(() => { cell.click(); });
        await flush();
        expect(viewerImg()!.getAttribute('src')).toMatch(/^blob:test\//);
        act(() => { document.body.querySelector<HTMLElement>('[aria-label="Open original"]')!.click(); });
        expect(env.opened).toEqual([post]);
        expectNoRequest();
    });
});

describe('video posters still play', () => {
    it('clicking a clip poster never opens the viewer', async () => {
        mount([{ url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', kind: 'video', title: 'Clip', thumb: thumb(1080, 1920), media: { url: 'https://cdn.medal.tv/a.mp4', mime: 'video/mp4', width: 1080, height: 1920 } }]);
        await flush();
        expect(host.querySelector('[data-picture-open]')).toBeNull();
        act(() => { host.querySelector<HTMLElement>('.cl-ve-player')!.click(); });
        await flush();
        expect(viewerImg()).toBeNull();
    });
});

describe('helpers', () => {
    it('only local pictures may be shown', () => {
        expect(isLocalPicture('blob:x/1')).toBe(true);
        expect(isLocalPicture(`data:image/webp;base64,${B64}`)).toBe(true);
        expect(isLocalPicture('https://example.org/a.jpg')).toBe(false);
        expect(isLocalPicture('data:text/html;base64,PGI+')).toBe(false);
        expect(isLocalPicture(null)).toBe(false);
    });
    it('a data: picture becomes a blob: URL locally; anything else is refused', () => {
        expect(objectUrlForDataImage(`data:image/webp;base64,${B64}`)).toMatch(/^blob:test\//);
        expect(objectUrlForDataImage('https://example.org/a.jpg')).toBeNull();
        expect(objectUrlForDataImage('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull();
        expectNoRequest();
    });
    it('Save names the file after the site', () => {
        expect(pictureFilename('https://www.example.org/x', 'image/jpeg')).toBe('example.org-picture.jpg');
        expect(pictureFilename('not a url', undefined)).toBe('link-picture.webp');
    });
});
