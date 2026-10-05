// @vitest-environment jsdom
/**
 * GifPlayer used to copy every GIF into a full-size canvas the moment it
 * loaded (a main-thread drawImage + a second full-resolution bitmap per GIF),
 * even though that frozen frame is only shown while paused. It now captures
 * only when the GIF is (or becomes) paused — and does so before the paint that
 * swaps the canvas in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

let focused = true;
vi.mock('../hooks/useWindowFocus', () => ({ useWindowFocus: () => focused }));
vi.mock('../hooks/useGifSettings', () => ({ useGifSettings: () => ({ settings: { autoPlayGifs: true } }) }));
vi.mock('../hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));

import { GifPlayer } from './GifPlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const drawImage = vi.fn();
beforeEach(() => {
    drawImage.mockClear();
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = vi.fn(() => ({ drawImage }));
});

function loadImg(host: HTMLElement) {
    const img = host.querySelector('img') as HTMLImageElement;
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 480, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 270, configurable: true });
    act(() => { img.dispatchEvent(new Event('load')); });
}

describe('GifPlayer frame capture', () => {
    it('does not copy a playing GIF into a canvas on load; captures when it pauses', () => {
        focused = true;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const onLoadImg = vi.fn();
        act(() => root.render(React.createElement(GifPlayer, { src: 'blob:x', onLoadImg })));
        loadImg(host);
        expect(drawImage).not.toHaveBeenCalled();
        expect(onLoadImg).toHaveBeenCalledTimes(1);
        // Window loses focus → paused → frozen frame captured (once).
        focused = false;
        act(() => root.render(React.createElement(GifPlayer, { src: 'blob:x', onLoadImg })));
        expect(drawImage).toHaveBeenCalledTimes(1);
        const canvas = host.querySelector('canvas') as HTMLCanvasElement;
        expect(canvas.width).toBe(480);
        expect(canvas.style.display).toBe('block');
        act(() => root.unmount());
    });

    it('a GIF that loads while paused is captured at load (it shows the canvas right away)', () => {
        focused = false;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => root.render(React.createElement(GifPlayer, { src: 'blob:y' })));
        loadImg(host);
        expect(drawImage).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
    });
});
