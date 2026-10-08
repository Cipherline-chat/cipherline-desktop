// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RailScrollbar } from './RailScrollbar';
import { SCROLL_SHOW_MS } from './railScrollbarMath';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Overlay-scrollbar visibility STATE (the CSS keyed on it is asserted in
// railOverflowTitlebar.test.ts; the painted result in the browser harness).
let root: Root | null = null;
let host: HTMLDivElement;
let scroller: HTMLDivElement;

function mount() {
    host = document.createElement('div');
    scroller = document.createElement('div');
    host.appendChild(scroller);
    document.body.appendChild(host);
    const ref = { current: scroller };
    root = createRoot(host.appendChild(document.createElement('div')));
    act(() => { root!.render(React.createElement(RailScrollbar, { target: ref })); });
}
const strip = () => host.querySelector<HTMLElement>('[data-testid="rail-scrollbar"]')!;
const thumb = () => host.querySelector<HTMLElement>('[data-testid="rail-scrollbar-thumb"]')!;
const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });

beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no pointer capture
    (HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    (HTMLElement.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
    mount();
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.useRealTimers();
});

describe('RailScrollbar overlay visibility', () => {
    it('hidden at rest: no scrolling / drag class until something happens', () => {
        expect(strip().classList.contains('is-scrolling')).toBe(false);
        expect(strip().classList.contains('is-drag')).toBe(false);
    });

    it('shown while scrolling, then cleared SCROLL_SHOW_MS after the LAST scroll', () => {
        act(() => { scroller.dispatchEvent(new Event('scroll')); });
        expect(strip().classList.contains('is-scrolling')).toBe(true);
        act(() => { vi.advanceTimersByTime(SCROLL_SHOW_MS - 100); });
        act(() => { scroller.dispatchEvent(new Event('scroll')); }); // still scrolling: timer restarts
        act(() => { vi.advanceTimersByTime(SCROLL_SHOW_MS - 100); });
        expect(strip().classList.contains('is-scrolling')).toBe(true);
        act(() => { vi.advanceTimersByTime(150); });
        expect(strip().classList.contains('is-scrolling')).toBe(false);
    });

    it('positive control: without a scroll event the class never appears', () => {
        act(() => { vi.advanceTimersByTime(SCROLL_SHOW_MS * 3); });
        expect(strip().classList.contains('is-scrolling')).toBe(false);
    });

    it('a thumb drag keeps it shown + expanded (is-drag) until release, wherever the pointer goes', () => {
        fire(thumb(), 'pointerdown', { clientY: 10 });
        expect(strip().classList.contains('is-drag')).toBe(true);
        fire(thumb(), 'pointermove', { clientY: 400 });  // far outside the strip
        expect(strip().classList.contains('is-drag')).toBe(true);
        fire(thumb(), 'pointerup', { clientY: 400 });
        expect(strip().classList.contains('is-drag')).toBe(false);
    });

    it('a wheel over the strip scrolls the list (the strip sits over, not inside, the scroller)', () => {
        let top = 0;
        Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: v => { top = v; }, configurable: true });
        act(() => { strip().dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })); });
        expect(top).toBe(120);
    });
});
