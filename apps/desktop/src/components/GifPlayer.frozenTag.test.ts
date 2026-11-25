// @vitest-environment jsdom
/**
 * Round 3 (owner, 2026-11-23), for EVERY GifPlayer in the app:
 *   - the small "GIF" tag (aria-hidden, bottom-left) shows only while the GIF
 *     is frozen because the window is unfocused, in the "Always" mode;
 *   - `videoSrc`: a GIF published as a muted mp4 loop plays / pauses under the
 *     same rule (window focus + Animated images), with no controls, and only a
 *     clmedia:// stream URL is accepted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const env = vi.hoisted(() => ({ focused: true, mode: 'always' as 'always' | 'hover' | 'never' }));
vi.mock('../hooks/useWindowFocus', () => ({ useWindowFocus: () => env.focused }));
vi.mock('../utils/a11y/motionPrefs', async (orig) => ({ ...(await orig<typeof import('../utils/a11y/motionPrefs')>()), useImageMode: () => env.mode }));

import { GifPlayer } from './GifPlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const CLMEDIA = `clmedia://media/${'c'.repeat(32)}`;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
    env.focused = true;
    env.mode = 'always';
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    play = vi.fn(async () => {});
    pause = vi.fn();
    HTMLMediaElement.prototype.play = play as unknown as HTMLMediaElement['play'];
    HTMLMediaElement.prototype.pause = pause as unknown as HTMLMediaElement['pause'];
});

function mountImg() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () => act(() => { root.render(React.createElement(GifPlayer, { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', alt: 'a gif' })); });
    render();
    const img = host.querySelector('img') as HTMLImageElement;
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 480, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 270, configurable: true });
    act(() => { img.dispatchEvent(new Event('load')); });
    return { host, render };
}
const tag = (host: HTMLElement) => host.querySelector('.gif-frozen-tag');

describe('the frozen "GIF" tag', () => {
    it('shows only when the window is unfocused in Always; aria-hidden; bottom-left', () => {
        const { host, render } = mountImg();
        expect(tag(host)).toBeNull();               // focused + Always: playing, no tag
        env.focused = false;
        render();
        const t = tag(host) as HTMLElement;
        expect(t).not.toBeNull();
        expect(t.textContent).toBe('GIF');
        expect(t.getAttribute('aria-hidden')).toBe('true');
        expect(t.style.left).toBe('7px');
        expect(t.style.bottom).toBe('7px');
        expect((host.querySelector('img') as HTMLElement).style.display).toBe('none'); // frozen
    });

    it('not in On hover / Never (they have the play badge instead)', () => {
        env.focused = false;
        for (const m of ['hover', 'never'] as const) {
            env.mode = m;
            const { host } = mountImg();
            expect(tag(host)).toBeNull();
            expect(host.querySelector('button.gif-play-badge')).not.toBeNull();
        }
    });
});

describe('videoSrc: a GIF-like loop under the same rule', () => {
    function mountVideo(videoSrc: string, onError = vi.fn()) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const render = () => act(() => { root.render(React.createElement(GifPlayer, { src: '', videoSrc, onError })); });
        render();
        return { host, render, onError };
    }

    it('muted, looping, no controls; plays when focused, pauses (and tags) when unfocused', () => {
        const { host, render } = mountVideo(CLMEDIA);
        const v = host.querySelector('video')!;
        expect(v.muted).toBe(true);
        expect(v.loop).toBe(true);
        expect(v.hasAttribute('controls')).toBe(false);
        expect(v.getAttribute('src')).toBe(CLMEDIA);
        act(() => { v.dispatchEvent(new Event('loadeddata')); });
        expect(play).toHaveBeenCalled();
        env.focused = false;
        render();
        expect(pause).toHaveBeenCalled();
        expect(tag(host)).not.toBeNull();
    });

    it('Never: paused, with the play badge; the badge plays it', () => {
        env.mode = 'never';
        const { host } = mountVideo(CLMEDIA);
        const v = host.querySelector('video')!;
        act(() => { v.dispatchEvent(new Event('loadeddata')); });
        expect(pause).toHaveBeenCalled();
        play.mockClear();
        act(() => { (host.querySelector('button.gif-play-badge') as HTMLButtonElement).click(); });
        expect(play).toHaveBeenCalled();
    });

    it('anything but a clmedia:// stream is refused (no <video>, onError)', () => {
        const { host, onError } = mountVideo('https://media.tenor.com/x/a.mp4');
        expect(host.querySelector('video')).toBeNull();
        expect(onError).toHaveBeenCalled();
    });
});
