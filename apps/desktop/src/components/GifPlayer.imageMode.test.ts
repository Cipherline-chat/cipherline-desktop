// @vitest-environment jsdom
/**
 * Settings → Accessibility → Animated images, as GifPlayer shows it:
 *   Always      -> the <img> plays, no badge
 *   On hover    -> frozen (canvas) until hovered or its badge is focused; badge is a button
 *   Never       -> frozen even when hovered; the badge button plays / pauses that one GIF
 * (A play control is keyboard operable: it is a real <button> with a label.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

let mode: 'always' | 'hover' | 'never' = 'always';
vi.mock('../hooks/useWindowFocus', () => ({ useWindowFocus: () => true }));
vi.mock('../utils/a11y/motionPrefs', async (orig) => ({ ...(await orig<typeof import('../utils/a11y/motionPrefs')>()), useImageMode: () => mode }));

import { GifPlayer } from './GifPlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
});

function mount(onClick?: () => void) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(React.createElement(GifPlayer, { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', alt: 'a gif', onClick })); });
    const img = host.querySelector('img') as HTMLImageElement;
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 480, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 270, configurable: true });
    act(() => { img.dispatchEvent(new Event('load')); });
    return host;
}
const playing = (host: HTMLElement) => (host.querySelector('img') as HTMLElement).style.display !== 'none';
const badge = (host: HTMLElement) => host.querySelector('button.gif-play-badge') as HTMLButtonElement | null;
const hover = (host: HTMLElement, on: boolean) => act(() => {
    (host.firstElementChild as HTMLElement).dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true }));
});

describe('GifPlayer animated-image modes', () => {
    it('always: plays, no badge (positive control)', () => {
        mode = 'always';
        const host = mount();
        expect(playing(host)).toBe(true);
        expect(badge(host)).toBeNull();
    });

    it('hover: frozen with a labelled button badge; hover plays; leaving freezes; focusing the badge plays', () => {
        mode = 'hover';
        const host = mount();
        expect(playing(host)).toBe(false);
        const b = badge(host)!;
        expect(b.getAttribute('aria-label')).toBe('Play animation');
        hover(host, true);
        expect(playing(host)).toBe(true);
        hover(host, false);
        expect(playing(host)).toBe(false);
        act(() => { badge(host)!.focus(); badge(host)!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(playing(host)).toBe(true);
    });

    it('never: frozen even while hovered; the button plays then pauses this one GIF', () => {
        mode = 'never';
        const host = mount();
        expect(playing(host)).toBe(false);
        hover(host, true);
        expect(playing(host)).toBe(false);
        act(() => { badge(host)!.click(); });
        expect(playing(host)).toBe(true);
        expect(badge(host)!.getAttribute('aria-label')).toBe('Pause animation');
        act(() => { badge(host)!.click(); });
        expect(playing(host)).toBe(false);
    });

    it('the badge click does not bubble to the GIF (it would open the viewer)', () => {
        mode = 'never';
        const onClick = vi.fn();
        const host = mount(onClick);
        act(() => { badge(host)!.click(); });
        expect(onClick).not.toHaveBeenCalled();
    });
});
