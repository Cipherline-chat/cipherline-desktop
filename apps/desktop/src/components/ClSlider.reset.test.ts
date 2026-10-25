// @vitest-environment jsdom
/**
 * Double-click-to-default on the shared slider.
 *
 * The thing worth pinning is not "dblclick calls onChange" but the ORDER and
 * the DOM: ClSlider paints the thumb straight onto the DOM during a pointer
 * gesture (no React state), and a double-click is pointerdown/up, pointerdown/
 * up, THEN dblclick. So the two clicks have already moved the thumb and
 * committed the clicked value by the time the reset runs; the reset must be the
 * LAST thing committed (a debounced save ends on the default) and must repaint
 * the thumb even when the parent never re-renders it (a debounced setter, or the
 * call-bar menu's snapshot `value`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// The kit's physics module reads matchMedia at import time; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() { /* noop */ }, removeEventListener() { /* noop */ } });
});

import { ClSlider } from './ClSlider';
import { resolveSliderReset, SLIDER_RESET_HINT } from './sliderReset';
import { ResetSlider } from './ResetSlider';
import { DEFAULT_VOICE_SETTINGS, MIC_VOLUME_MAX, SPEAKER_VOLUME_MAX } from '../hooks/useVoiceSettings';
import { DEFAULT_PER_USER_VOLUME, MAX_PER_USER_VOLUME } from '../utils/volumeLimits';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
    // jsdom has no PointerEvent / pointer capture.
    (Element.prototype as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const TRACK_W = 200;
/** Fire a pointer event at clientX (a MouseEvent carries clientX; React maps by type). */
function fire(el: Element, type: string, clientX = 0) {
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX })); });
}
/** One full click at `x` px along a 200px track. */
function click(el: Element, x: number) {
    fire(el, 'pointerdown', x);
    fire(el, 'pointerup', x);
}
function dblclickAt(el: Element, x: number) {
    click(el, x);
    click(el, x);
    fire(el, 'dblclick', x);
}
function track(): HTMLElement {
    const el = host.querySelector('[role="slider"]') as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, right: TRACK_W, top: 0, bottom: 30, width: TRACK_W, height: 30, x: 0, y: 0, toJSON() { /* noop */ } });
    return el;
}
const fillWidth = () => (host.querySelector('.sfill') as HTMLElement).style.width;
const thumbLeft = () => (host.querySelector('.sthw') as HTMLElement).style.left;
const bubble = () => (host.querySelector('.sbub') as HTMLElement).textContent;

function renderSlider(props: Partial<React.ComponentProps<typeof ClSlider>> & { onChange: (v: number) => void }) {
    // `value` is held constant on purpose: the parent that never re-renders the
    // slider (debounced write / snapshot menu) is the case that goes wrong.
    act(() => root.render(React.createElement(ClSlider, { value: 100, min: 0, max: 200, step: 1, formatLabel: (v: number) => `${v}%`, ...props })));
    return track();
}

describe('ClSlider double-click reset', () => {
    it('commits the default LAST, through the same onChange a drag uses', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, resetValue: 100 });
        dblclickAt(el, 30); // 30/200 of the track = 30 on a 0..200 slider
        expect(onChange).toHaveBeenCalled();
        const values = onChange.mock.calls.map(c => c[0]);
        // The clicks committed the clicked value first...
        expect(values[0]).toBe(30);
        // ...and the reset is what any debounced save finally lands on.
        expect(values[values.length - 1]).toBe(100);
    });

    it('repaints the thumb, fill, bubble and aria-valuenow to the default even if the parent never re-renders', () => {
        const el = renderSlider({ onChange: vi.fn(), resetValue: 100 });
        dblclickAt(el, 30);
        expect(fillWidth()).toBe('50%');
        expect(thumbLeft()).toBe('50%');
        expect(bubble()).toBe('100%');
        expect(el.getAttribute('aria-valuenow')).toBe('100');
    });

    it('a pending animation-frame commit from the click cannot land after the reset', async () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, resetValue: 100 });
        // pointerdown schedules an RAF commit; dblclick arrives before it runs.
        fire(el, 'pointerdown', 40);
        fire(el, 'pointerup', 40);
        fire(el, 'dblclick', 40);
        await new Promise(r => setTimeout(r, 50));
        expect(onChange.mock.calls.at(-1)?.[0]).toBe(100);
    });

    it('does nothing without a resetValue', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange });
        fire(el, 'dblclick');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does nothing while disabled', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, resetValue: 100, disabled: true });
        fire(el, 'dblclick');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('clamps a default outside the range instead of painting off the track', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, resetValue: 999 });
        fire(el, 'dblclick');
        expect(onChange).toHaveBeenLastCalledWith(200);
        expect(fillWidth()).toBe('100%');
    });

    it('keyboard is untouched: arrows still step, no reset binding', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, resetValue: 100, value: 50 });
        act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        expect(onChange).toHaveBeenLastCalledWith(51);
        act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
        act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })); });
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});

describe('resolveSliderReset', () => {
    it('is null when there is nothing to reset to', () => {
        expect(resolveSliderReset(undefined, 0, 10)).toBeNull();
        expect(resolveSliderReset(5, 0, 10, true)).toBeNull();
        expect(resolveSliderReset(Number.NaN, 0, 10)).toBeNull();
    });
    it('returns the default, clamped to the range', () => {
        expect(resolveSliderReset(5, 0, 10)).toBe(5);
        expect(resolveSliderReset(-3, 0, 10)).toBe(0);
        expect(resolveSliderReset(30, 0, 10)).toBe(10);
    });
    it('the hint wording is the one the wiring test and users see', () => {
        expect(SLIDER_RESET_HINT).toBe('Double-click to reset');
    });
});

describe('the volume sliders reset to the real defaults', () => {
    it('input and output volume default to 100% (unity), inside their ceiling', () => {
        expect(DEFAULT_VOICE_SETTINGS.micVolume).toBe(100);
        expect(DEFAULT_VOICE_SETTINGS.speakerVolume).toBe(100);
        expect(MIC_VOLUME_MAX).toBeGreaterThanOrEqual(100);
        expect(SPEAKER_VOLUME_MAX).toBeGreaterThanOrEqual(100);
    });

    it('input volume: dblclick lands on 100 from anywhere on the track', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, min: 0, max: MIC_VOLUME_MAX, resetValue: DEFAULT_VOICE_SETTINGS.micVolume });
        dblclickAt(el, 170);
        expect(onChange.mock.calls.at(-1)?.[0]).toBe(100);
    });

    it('output volume: dblclick lands on 100 from anywhere on the track', () => {
        const onChange = vi.fn();
        const el = renderSlider({ onChange, min: 0, max: SPEAKER_VOLUME_MAX, resetValue: DEFAULT_VOICE_SETTINGS.speakerVolume });
        dblclickAt(el, 10);
        expect(onChange.mock.calls.at(-1)?.[0]).toBe(100);
    });

    it('per-participant volume (ResetSlider, 0..2 step 0.05): dblclick lands on 1', () => {
        const onChange = vi.fn();
        act(() => root.render(React.createElement(ResetSlider, {
            min: 0, max: MAX_PER_USER_VOLUME, step: 0.05, value: 1, resetValue: DEFAULT_PER_USER_VOLUME, onChangeValue: onChange,
        })));
        const el = track();
        dblclickAt(el, 20);
        expect(onChange.mock.calls[0][0]).toBeCloseTo(0.2, 5); // the clicks moved it first
        expect(onChange.mock.calls.at(-1)?.[0]).toBe(1);
        // one reset commit, not two (the wrapper no longer double-fires)
        expect(onChange.mock.calls.filter(c => c[0] === 1)).toHaveLength(1);
    });
});
