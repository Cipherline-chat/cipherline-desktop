// @vitest-environment jsdom
/**
 * Tenor / Giphy / Imgur .gifv links behave like GIFs (owner, 2026-11-23):
 * frameless picture, muted loop through the real GifPlayer, sized per the
 * Compact embeds setting, auto-loaded like an image (or behind "Load GIF").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const env = vi.hoisted(() => {
    // The button kit reads matchMedia at import; jsdom has none.
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    return ({ layout: 'expanded' as 'expanded' | 'compact', imageAutoLoad: 'known' as 'always' | 'known' | 'never' });
});
vi.mock('../../utils/embedPrefs', async (orig) => ({ ...(await orig<typeof import('../../utils/embedPrefs')>()), useEmbedLayout: () => env.layout }));
vi.mock('../../hooks/usePrivacySettings', () => ({ usePrivacySettings: () => ({ settings: { imageAutoLoad: env.imageAutoLoad } }), useShowEmbeds: () => true }));
vi.mock('../../hooks/useWindowFocus', () => ({ useWindowFocus: () => true }));

import { MessageEmbed } from './MessageEmbed';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const SRC = `clmedia://media/${'d'.repeat(32)}`;
let root: Root | null = null;
let host: HTMLDivElement;
let resolveClipMedia: ReturnType<typeof vi.fn>;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
    env.layout = 'expanded';
    env.imageAutoLoad = 'known';
    _resetAutoLoadLimiterForTests();
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    resolveClipMedia = vi.fn(async () => ({ ok: true, src: SRC, width: 640, height: 616 }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { resolveClipMedia, registerMedia: vi.fn(), fetchBinary: vi.fn() };
    HTMLMediaElement.prototype.play = vi.fn(async () => {}) as unknown as HTMLMediaElement['play'];
    HTMLMediaElement.prototype.pause = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

const TENOR = 'https://tenor.com/view/aww-yeah-get-over-here-gif-27631439';

describe('GIF-like loops', () => {
    it.each([TENOR, 'https://giphy.com/gifs/cat-JIX9t2j0ZTN9S', 'https://i.imgur.com/A61SaA1.gifv'])('%s: auto-loads, a muted loop, no card, no play button', async (url) => {
        act(() => { root!.render(h(MessageEmbed, { url })); });
        await flush();
        expect(resolveClipMedia).toHaveBeenCalledWith(url);
        const v = host.querySelector('video')!;
        expect(v.getAttribute('src')).toBe(SRC);
        expect(v.muted && v.loop).toBe(true);
        expect(v.hasAttribute('controls')).toBe(false);
        expect(host.querySelector('.cl-ve, .cl-ve-play')).toBeNull();   // not a video card
        expect(host.querySelector('[data-embed="gif-loop"]')!.classList.contains('cl-gif')).toBe(true);
    });

    it('sized by the setting: 400×300 expanded, 240×180 compact, never past the column', async () => {
        act(() => { root!.render(h(MessageEmbed, { url: TENOR })); });
        await flush();
        const wrap = () => host.querySelector('[data-embed="gif-loop"] > div') as HTMLElement;
        expect(wrap().style.maxWidth).toBe('min(100%, 400px)');
        expect((host.querySelector('video') as HTMLElement).style.maxHeight).toBe('300px');
        env.layout = 'compact';
        act(() => { root!.render(h(MessageEmbed, { url: TENOR, key: 'c' })); });
        await flush();
        expect(wrap().style.maxWidth).toBe('min(100%, 240px)');
        expect((host.querySelector('video') as HTMLElement).style.maxHeight).toBe('180px');
    });

    it('"Load images from links: Never": nothing is requested until "Load GIF"', async () => {
        env.imageAutoLoad = 'never';
        act(() => { root!.render(h(MessageEmbed, { url: TENOR })); });
        await flush();
        expect(resolveClipMedia).not.toHaveBeenCalled();
        const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Load GIF'))!;
        act(() => { btn.click(); });
        await flush();
        expect(resolveClipMedia).toHaveBeenCalledWith(TENOR);
        expect(host.querySelector('video')).not.toBeNull();
    });

    it('positive control: a Medal clip is still a click-to-play video card', async () => {
        act(() => { root!.render(h(MessageEmbed, { url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt' })); });
        await flush();
        expect(resolveClipMedia).not.toHaveBeenCalled();
        expect(host.querySelector('.cl-ve button.cl-ve-play')).not.toBeNull();
    });
});
