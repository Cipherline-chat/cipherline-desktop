// @vitest-environment jsdom
/**
 * Inline video for links (phase 2 of docs/plans/embeds.md), mounted for real:
 * nothing is requested before the click; a direct file is registered with
 * main, a clip page resolved by main; only a clmedia:// URL main hands back is
 * ever put in <video src>; failures offer "Open in browser"; and one playing
 * embed per chat view is shared with the YouTube player.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const layoutEnv = vi.hoisted(() => ({ layout: 'expanded' as 'expanded' | 'compact' }));
vi.mock('../../utils/embedPrefs', async (orig) => ({ ...(await orig<typeof import('../../utils/embedPrefs')>()), useEmbedLayout: () => layoutEnv.layout }));
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: 'never' } }),
    useShowEmbeds: () => true,
}));

import { VideoLinkEmbed } from './VideoLinkEmbed';
import { YouTubeEmbed } from './YouTubeEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
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
const SRC1 = `clmedia://media/${'a'.repeat(32)}`;
const SRC2 = `clmedia://media/${'b'.repeat(32)}`;

let root: Root | null = null;
let host: HTMLDivElement;
let api: {
    registerMedia: ReturnType<typeof vi.fn>;
    resolveClipMedia: ReturnType<typeof vi.fn>;
    openExternal: ReturnType<typeof vi.fn>;
    fetchBinary: ReturnType<typeof vi.fn>;
};
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

function mount(...nodes: React.ReactNode[]) {
    act(() => { root!.render(h(EmbedPlaybackContext.Provider, { value: new PlaybackScope() }, ...nodes)); });
}
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

beforeEach(() => {
    layoutEnv.layout = 'expanded';
    api = {
        registerMedia: vi.fn(async () => ({ ok: true, src: SRC1 })),
        resolveClipMedia: vi.fn(async () => ({ ok: true, src: SRC2, width: 1280, height: 720, title: 'Insane 1v4 clutch' })),
        openExternal: vi.fn(async () => {}),
        fetchBinary: vi.fn(),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    // jsdom has no media playback; record calls instead.
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.play = vi.fn(async () => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
});

describe('VideoLinkEmbed', () => {
    it('direct file: a dark facade with name + host; NO request until the click', async () => {
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://cdn.example.com/clips/My%20Clip.mp4' }));
        await flush();
        expect(host.querySelector('video')).toBeNull();
        expect(api.registerMedia).not.toHaveBeenCalled();
        expect(api.fetchBinary).not.toHaveBeenCalled();
        expect(host.textContent).toContain('My Clip.mp4');
        expect(host.textContent).toContain('cdn.example.com');
        expect(host.textContent).toContain('MP4');
        const btn = host.querySelector('button.cl-ve-play')!;
        expect(btn.getAttribute('aria-label')).toBe('Play video: My Clip.mp4');
        click(btn);
        await flush();
        expect(api.registerMedia).toHaveBeenCalledWith('https://cdn.example.com/clips/My%20Clip.mp4', 'video');
        const v = host.querySelector('video')!;
        expect(v.getAttribute('src')).toBe(SRC1);
        expect(v.hasAttribute('controls')).toBe(true);
        expect(v.autoplay).toBe(true);
    });

    it('clip page (compact): main resolves it on click; the card grows to the clip\'s aspect', async () => {
        layoutEnv.layout = 'compact';
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt' }));
        await flush();
        expect(host.textContent).toContain('Medal');
        expect(host.textContent).toContain('Medal clip');
        expect(api.resolveClipMedia).not.toHaveBeenCalled();
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        expect(api.resolveClipMedia).toHaveBeenCalledWith('https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt');
        expect(api.registerMedia).not.toHaveBeenCalled();
        expect(host.querySelector('video')!.getAttribute('src')).toBe(SRC2);
        expect((host.querySelector('[data-embed="clip"] .cl-ve-player') as HTMLElement).style.aspectRatio).toBe(String(1280 / 720));
        // The page's own title (read by main with the video) replaces "Medal clip"; Collapse returns to the row.
        expect(host.querySelector('a.cl-ve-title')!.textContent).toBe('Insane 1v4 clutch');
        act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Collapse player"]')!.click(); });
        expect(host.querySelector('video')).toBeNull();
        expect(host.querySelector('button.cl-ve-play')!.getAttribute('aria-label')).toBe('Play Medal clip: Insane 1v4 clutch');
    });

    it('a src that is not a clmedia:// stream URL is never used', async () => {
        api.registerMedia.mockResolvedValue({ ok: true, src: 'https://evil.example/x.mp4' });
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://cdn.example.com/a.mp4' }));
        await flush();
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        expect(host.querySelector('video')).toBeNull();
        expect(host.textContent).toContain("This video can't be played here.");
    });

    it('failure says so and offers "Open in browser" (validated open)', async () => {
        api.resolveClipMedia.mockResolvedValue({ ok: false, reason: 'no-media' });
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://streamable.com/moo' }));
        await flush();
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        expect(host.textContent).toContain("Couldn't find the video on this Streamable page.");
        const open = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open in browser')!;
        // Through the leaving-Cipherline dialog: nothing opens until Visit.
        expect(viaLeaveDialog(() => click(open))).toBe('https://streamable.com/moo');
        expect(api.openExternal).toHaveBeenCalledWith('https://streamable.com/moo');
    });

    it('a playback error (codec, expired link) also falls back to "Open in browser"', async () => {
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://cdn.example.com/a.mov' }));
        await flush();
        click(host.querySelector('button.cl-ve-play'));
        await flush();
        act(() => { host.querySelector('video')!.dispatchEvent(new Event('error')); });
        expect(host.querySelector('video')).toBeNull();
        expect(host.textContent).toContain('Open in browser');
    });

    it('one playing embed per chat view, shared with YouTube', async () => {
        mount(
            h('div', { key: 'v' }, h(VideoLinkEmbed, { url: 'https://cdn.example.com/a.mp4' })),
            h('div', { key: 'y' }, h(YouTubeEmbed, { url: 'https://youtu.be/dQw4w9WgXcQ' })),
        );
        await flush();
        click(host.querySelector('[data-embed="video"] button'));
        await flush();
        const video = host.querySelector('video')!;
        expect(video).not.toBeNull();
        const pause = HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>;
        pause.mockClear();
        // Starting YouTube pauses the video (kept mounted at its position)...
        click(host.querySelector('[data-embed="youtube"] button'));
        expect(host.querySelector('iframe')).not.toBeNull();
        expect(pause).toHaveBeenCalled();
        expect(host.querySelector('video')).toBe(video);
        // ...and pressing play on the video again returns YouTube to its facade.
        act(() => { video.dispatchEvent(new Event('play')); });
        expect(host.querySelector('iframe')).toBeNull();
        expect(host.querySelector('[data-embed="youtube"] button.cl-ve-play')).not.toBeNull();
    });

    it('expanded (default): with no size known the poster is 16:9; once the file says portrait, the box takes its shape (no letterbox)', async () => {
        api.resolveClipMedia.mockResolvedValue({ ok: true, src: SRC2, width: 720, height: 1280 });
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt' }));
        await flush();
        const idle = host.querySelector<HTMLElement>('[data-embed="clip"] .cl-ve-player')!;
        const before = idle.style.aspectRatio;
        expect(before).toBe(String(16 / 9));
        act(() => { idle.querySelector<HTMLButtonElement>('button.cl-ve-play')!.click(); });
        await flush();
        const v = host.querySelector('video')!;
        Object.defineProperty(v, 'videoWidth', { value: 720 });
        Object.defineProperty(v, 'videoHeight', { value: 1280 });
        act(() => { v.dispatchEvent(new Event('loadedmetadata')); });
        const card = host.querySelector<HTMLElement>('[data-embed="clip"]')!;
        expect(Number(card.querySelector<HTMLElement>('.cl-ve-player')!.style.aspectRatio)).toBeCloseTo(720 / 1280, 4);
        expect(card.style.width).toBe('252px');
    });

    it('a sender\'s media size shapes the idle poster already (a vertical Medal clip is a 9:16 reel, not a 16:9 box)', async () => {
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', sender: { title: 'One tap', width: 1080, height: 1920 } }));
        await flush();
        const card = host.querySelector<HTMLElement>('[data-embed="clip"]')!;
        expect(card.classList.contains('cl-ve--reel')).toBe(true);
        expect(card.style.width).toBe('252px');
        expect(card.querySelector<HTMLElement>('.cl-ve-player')!.style.aspectRatio).toBe(String(9 / 16));
        // Direction C: the site pill + duration on top, the title on the bottom gradient, over the picture.
        expect(card.querySelector('.cl-ve-top .cl-ve-site--glass')).not.toBeNull();
        expect(card.querySelector('.cl-ve-cap .cl-ve-title--on-pic')?.textContent).toBe('One tap');
    });

    it('old message: no media size, only the thumbnail\'s: the box takes the thumbnail\'s shape', async () => {
        mount(h(VideoLinkEmbed, { key: 1, url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', sender: { title: 'Sq', thumbWidth: 640, thumbHeight: 640 } }));
        await flush();
        const card = host.querySelector<HTMLElement>('[data-embed="clip"]')!;
        expect(card.querySelector<HTMLElement>('.cl-ve-player')!.style.aspectRatio).toBe('1');
        expect(card.style.width).toBe('336px');
    });
});
