// @vitest-environment jsdom
/**
 * The YouTube facade (phase 1 of docs/plans/embeds.md), mounted for real:
 * nothing from youtube-nocookie loads until play; the thumbnail comes through
 * the main-process image path (hqdefault, then mqdefault); the title through
 * main's oEmbed; one player per chat view; Shorts are vertical; and with
 * "Load images from links: Never" the facade fetches nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const privacy = vi.hoisted(() => ({ imageAutoLoad: 'known' as 'always' | 'known' | 'never' }));
const layoutEnv = vi.hoisted(() => ({ layout: 'expanded' as 'expanded' | 'compact' }));
vi.mock('../../utils/embedPrefs', async (orig) => ({ ...(await orig<typeof import('../../utils/embedPrefs')>()), useEmbedLayout: () => layoutEnv.layout }));
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: privacy.imageAutoLoad } }),
    useShowEmbeds: () => true,
}));

import { YouTubeEmbed } from './YouTubeEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { clearRemoteImageCache } from '../../utils/remoteImageCache';
import { _clearYouTubeMetaCache } from '../../utils/youtubeMeta';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';
import { confirmLeave, getLeaveSnapshot, registerLeaveHost } from '../../utils/externalLinks/leaveGate';
import { setUserGestureProbeForTests } from '../../utils/externalLinks/shellOpen';

/** A real click carries a user gesture; the leaving-Cipherline dialog host is
 *  mounted app-wide. Returns the URL the gate asked about, then "presses Visit". */
function viaLeaveDialog(click: () => void): string | null {
    setUserGestureProbeForTests(() => true);
    const off = registerLeaveHost();
    try {
        click();
        const req = getLeaveSnapshot();
        if (!req) return null;
        confirmLeave(req.id);
        return req.model.href;
    } finally {
        off();
        setUserGestureProbeForTests(null);
    }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const ID = 'dQw4w9WgXcQ';
const ID2 = 'oHg5SJYRHA0';

let root: Root | null = null;
let host: HTMLDivElement;
let fetchBinary: ReturnType<typeof vi.fn>;
let youtubeOEmbed: ReturnType<typeof vi.fn>;

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

function mount(urls: string[]) {
    const scope = new PlaybackScope();
    act(() => {
        root!.render(h(EmbedPlaybackContext.Provider, { value: scope },
            ...urls.map((u, i) => h('div', { key: i, 'data-i': i }, h(YouTubeEmbed, { url: u })))));
    });
    return scope;
}
const frames = () => [...host.querySelectorAll<HTMLElement>('[data-embed="youtube"]')];
const iframes = () => [...host.querySelectorAll('iframe')];

beforeEach(() => {
    layoutEnv.layout = 'expanded';
    privacy.imageAutoLoad = 'known';
    clearRemoteImageCache();
    _clearYouTubeMetaCache();
    _resetAutoLoadLimiterForTests();
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:thumb-${++n}`);
    URL.revokeObjectURL = vi.fn();
    fetchBinary = vi.fn(async (u: string) => ({ b64: btoa('jpeg'), mimeType: 'image/jpeg', u }));
    youtubeOEmbed = vi.fn(async () => ({ title: 'Never Gonna Give You Up', author: 'Rick Astley' }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { fetchBinary, youtubeOEmbed };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
});

describe('YouTubeEmbed facade', () => {
    it('shows thumbnail + title + play; no player and no youtube-nocookie request before a click', async () => {
        mount([`https://www.youtube.com/watch?v=${ID}`]);
        await flush();
        expect(iframes()).toHaveLength(0);
        expect(fetchBinary).toHaveBeenCalledWith(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
        expect(fetchBinary.mock.calls.every(([u]) => !String(u).includes('youtube-nocookie'))).toBe(true);
        expect(youtubeOEmbed).toHaveBeenCalledWith(ID);
        const btn = host.querySelector('button.cl-ve-play')!;
        expect(btn.getAttribute('type')).toBe('button'); // native Enter/Space activation
        expect(btn.getAttribute('aria-label')).toBe('Play YouTube video: Never Gonna Give You Up');
        expect(host.textContent).toContain('Rick Astley');
        expect(host.textContent).toContain('YouTube');
        expect(host.querySelector('img.cl-ve-frame')!.getAttribute('src')).toMatch(/^blob:thumb-/);
    });

    it('falls back to mqdefault when hqdefault fails, and to no thumbnail/title silently', async () => {
        fetchBinary.mockImplementation(async (u: string) => {
            if (u.includes('hqdefault')) throw new Error('HTTP 404');
            return { b64: btoa('jpeg'), mimeType: 'image/jpeg' };
        });
        youtubeOEmbed.mockResolvedValue(null);
        mount([`https://youtu.be/${ID}`]);
        await flush();
        expect(fetchBinary.mock.calls.map(([u]) => u)).toEqual([
            `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
            `https://i.ytimg.com/vi/${ID}/mqdefault.jpg`,
        ]);
        expect(host.querySelector('img.cl-ve-frame')).not.toBeNull();
        expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('Play YouTube video');
    });

    it('click mounts the nocookie player autoplaying at ?t=, with the documented attributes', async () => {
        mount([`https://www.youtube.com/watch?v=${ID}&t=1m5s`]);
        await flush();
        act(() => { host.querySelector<HTMLButtonElement>('button.cl-ve-play')!.click(); });
        const [f] = iframes();
        const src = new URL(f.getAttribute('src')!);
        expect(src.origin + src.pathname).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
        expect(src.searchParams.get('autoplay')).toBe('1');
        expect(src.searchParams.get('start')).toBe('65');
        expect(src.searchParams.get('origin')).toBe(window.location.origin);
        expect(f.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
        expect(f.getAttribute('allow')).toContain('autoplay');
        expect(f.hasAttribute('allowfullscreen')).toBe(true);
        expect(host.querySelector('button.cl-ve-play')).toBeNull();
    });

    it('one player per chat view: starting another returns the first to its facade', async () => {
        mount([`https://www.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID2}`]);
        await flush();
        const play = (i: number) => act(() => { frames()[i].querySelector<HTMLButtonElement>('button')!.click(); });
        play(0);
        expect(iframes()).toHaveLength(1);
        expect(frames()[0].querySelector('iframe')).not.toBeNull();
        play(1);
        expect(iframes()).toHaveLength(1);
        expect(frames()[0].querySelector('iframe')).toBeNull();
        expect(frames()[0].querySelector('button.cl-ve-play')).not.toBeNull();
        expect(frames()[1].querySelector('iframe')!.getAttribute('src')).toContain(ID2);
    });

    it('separate chat views (scopes) do not stop each other', async () => {
        const a = new PlaybackScope();
        const b = new PlaybackScope();
        act(() => {
            root!.render(h('div', null,
                h(EmbedPlaybackContext.Provider, { value: a }, h(YouTubeEmbed, { url: `https://youtu.be/${ID}` })),
                h(EmbedPlaybackContext.Provider, { value: b }, h(YouTubeEmbed, { url: `https://youtu.be/${ID2}` }))));
        });
        await flush();
        act(() => { frames()[0].querySelector<HTMLButtonElement>('button')!.click(); });
        act(() => { frames()[1].querySelector<HTMLButtonElement>('button')!.click(); });
        expect(iframes()).toHaveLength(2);
    });

    it('Shorts: a "Short" tag; size follows the media: a 9:16 card 252 × 448, a 16:9 card 400 × 225', async () => {
        mount([`https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/watch?v=${ID2}`]);
        await flush();
        const [short, wide] = frames();
        expect(short.textContent).toContain('Short');
        expect(wide.textContent).not.toContain('Short');
        act(() => { short.querySelector<HTMLButtonElement>('button.cl-ve-play')!.click(); });
        const sp = frames()[0].querySelector<HTMLElement>('.cl-ve-player')!;
        expect(sp.style.aspectRatio).toBe(String(9 / 16));
        // The card IS the media's width: no side gutters around a vertical video.
        expect(frames()[0].style.width).toBe('252px');
        act(() => { frames()[1].querySelector<HTMLButtonElement>('button.cl-ve-play')!.click(); });
        const wp = frames()[1].querySelector<HTMLElement>('.cl-ve-player')!;
        expect(wp.style.aspectRatio).toBe(String(16 / 9));
        expect(frames()[1].style.width).toBe('400px');
    });

    it('compact (setting on): a row card, no left rail; play grows it; Collapse returns to the row; ?t= shown', async () => {
        layoutEnv.layout = 'compact';
        mount([`https://www.youtube.com/watch?v=${ID}&t=90`]);
        await flush();
        const card = frames()[0];
        expect(card.classList.contains('cl-ve')).toBe(true);
        expect(card.classList.contains('cl-ve--open')).toBe(false);
        expect(card.querySelector('.cl-ve-thumb')).not.toBeNull();
        expect(card.style.borderLeft).toBe('');
        expect(card.textContent).toContain('Starts at 1:30');
        act(() => { card.querySelector<HTMLButtonElement>('button.cl-ve-play')!.click(); });
        expect(iframes()).toHaveLength(1);
        expect(frames()[0].classList.contains('cl-ve--open')).toBe(true);
        act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Collapse player"]')!.click(); });
        expect(iframes()).toHaveLength(0);
        expect(frames()[0].querySelector('.cl-ve-thumb button.cl-ve-play')).not.toBeNull();
    });

    it('expanded (default): player size idle AND playing, same box; no Collapse', async () => {
        mount([`https://www.youtube.com/watch?v=${ID}`]);
        await flush();
        const card = frames()[0];
        expect(card.dataset.layout).toBe('expanded');
        const idle = card.querySelector<HTMLElement>('.cl-ve-player')!;
        expect(idle.querySelector('button.cl-ve-play')).not.toBeNull();
        expect(idle.querySelector('img.cl-ve-frame')).not.toBeNull();   // the poster
        const idleBox = `${idle.style.aspectRatio}|${idle.style.maxWidth}`;
        expect(host.querySelector('button[aria-label="Collapse player"]')).toBeNull();
        act(() => { idle.querySelector<HTMLButtonElement>('button.cl-ve-play')!.click(); });
        const playing = frames()[0].querySelector<HTMLElement>('.cl-ve-player')!;
        expect(playing.querySelector('iframe')).not.toBeNull();
        expect(`${playing.style.aspectRatio}|${playing.style.maxWidth}`).toBe(idleBox);
        expect(host.querySelector('button[aria-label="Collapse player"]')).toBeNull();
        expect(host.querySelector('button[aria-label="Open on youtube.com"]')).not.toBeNull();
    });

    it('the title opens the link in the browser (validated), not in the app', async () => {
        const openExternal = vi.fn(async () => {});
        (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.openExternal = openExternal;
        mount([`https://youtu.be/${ID}`]);
        await flush();
        // Through the leaving-Cipherline dialog: nothing opens until Visit.
        const asked = viaLeaveDialog(() => act(() => { host.querySelector<HTMLAnchorElement>('a.cl-ve-title')!.click(); }));
        expect(asked).toBe(`https://youtu.be/${ID}`);
        expect(openExternal).toHaveBeenCalledWith(`https://youtu.be/${ID}`);
        expect(iframes()).toHaveLength(0);
    });

    it('"Load images from links: Never" fetches nothing until play', async () => {
        privacy.imageAutoLoad = 'never';
        mount([`https://www.youtube.com/watch?v=${ID}`]);
        await flush();
        expect(fetchBinary).not.toHaveBeenCalled();
        expect(youtubeOEmbed).not.toHaveBeenCalled();
        expect(host.querySelector('img')).toBeNull();
        act(() => { host.querySelector<HTMLButtonElement>('button')!.click(); });
        expect(iframes()).toHaveLength(1);
    });

    it('positive control: a non-YouTube link renders nothing', async () => {
        mount(['https://evil.example/watch?v=dQw4w9WgXcQ']);
        await flush();
        expect(host.innerHTML).toBe('<div data-i="0"></div>');
    });
});
