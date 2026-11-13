// @vitest-environment jsdom
/**
 * The per-participant volume row in the call context menu.
 *
 * Stored scale is a linear multiplier 0..2 (1 = 100%). The bug: ClSlider's
 * default bubble is Math.round(value), so on a 0..2 scale it read "0"/"1"/"2"
 * (always "1" around unity) and the % readout was derived from a snapshot
 * `volume` prop that does not re-render during a drag. Both must show 0..200%
 * live, and double-click must reset to 100%.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() { /* noop */ }, removeEventListener() { /* noop */ } });
});

import { PerUserVolumeSlider } from './PopoverMenu';
import { formatPerUserVolume, MAX_PER_USER_VOLUME } from '../../utils/volumeLimits';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
    (Element.prototype as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const W = 200;
function fire(el: Element, type: string, clientX = 0) {
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX })); });
}
function mount(value: number, onChange: (v: number) => void) {
    // `value` stays constant: the menu hands in a snapshot and never re-renders it.
    act(() => root.render(React.createElement(PerUserVolumeSlider, { label: 'Volume', value, onChange })));
    const el = host.querySelector('[role="slider"]') as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, right: W, top: 0, bottom: 30, width: W, height: 30, x: 0, y: 0, toJSON() { /* noop */ } });
    return el;
}
const readout = () => host.querySelector('.text-cl-lume')!.textContent;
const bubble = () => host.querySelector('.sbub')!.textContent;

describe('formatPerUserVolume', () => {
    it('maps the 0..2 multiplier onto 0..200%', () => {
        expect(formatPerUserVolume(0)).toBe('0%');
        expect(formatPerUserVolume(0.35)).toBe('35%');
        expect(formatPerUserVolume(1)).toBe('100%');
        expect(formatPerUserVolume(MAX_PER_USER_VOLUME)).toBe('200%');
    });
});

describe('PerUserVolumeSlider', () => {
    it('shows the stored gain as a percent at rest', () => {
        mount(1, vi.fn());
        expect(readout()).toBe('100%');
        expect(bubble()).toBe('100%');
    });

    it('updates the bubble and the readout live while dragging, not stuck at 1', () => {
        const onChange = vi.fn();
        const el = mount(1, onChange);
        fire(el, 'pointerdown', 50);   // 25% of track -> gain 0.5
        expect(bubble()).toBe('50%');
        fire(el, 'pointermove', 150);  // 75% of track -> gain 1.5
        expect(bubble()).toBe('150%');
        fire(el, 'pointermove', 200);  // end of track -> 200%
        expect(bubble()).toBe('200%');
        fire(el, 'pointerup', 200);
        expect(readout()).toBe('200%');
        expect(onChange).toHaveBeenLastCalledWith(2);
    });

    it('double-click resets to 100% (gain 1)', () => {
        const onChange = vi.fn();
        const el = mount(1, onChange);
        fire(el, 'pointerdown', 20); fire(el, 'pointerup', 20);
        fire(el, 'pointerdown', 20); fire(el, 'pointerup', 20);
        fire(el, 'dblclick', 20);
        expect(onChange).toHaveBeenLastCalledWith(1);
        expect(readout()).toBe('100%');
        expect(bubble()).toBe('100%');
    });
});
