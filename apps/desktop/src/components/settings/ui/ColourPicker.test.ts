// @vitest-environment jsdom
/**
 * The in-app colour picker: slider semantics + keyboard, hex field (applies on
 * Enter/blur, never coerces garbage), swatches, drag, hue kept at zero
 * saturation, and the popover wrapper (opens a labelled dialog, focus in/out,
 * Escape closes only it, commits once and records a recent colour).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const kv = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('../../../utils/secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => kv.map.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.map.set(k, v); },
    },
}));

import { ColourPickerPanel, ColourSwatchButton } from './ColourPicker';

const BRAND_PRESETS = ['#25e0c8', '#3bead6', '#5e8ee0', '#ffc94d', '#ff6b5e', '#ff8fb1', '#4ade80', '#a78bfa', '#f4f7ff', '#243056'];
import { __resetRecentColoursForTests, pushRecentColour } from '../../../utils/recentColours';
import { useEscape } from '../../../hooks/useEscape';
import { __resetEscapeStackForTests } from '../../../utils/escapeStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (...a: any[]) => React.ReactElement;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    kv.map.clear();
    __resetRecentColoursForTests();
    __resetEscapeStackForTests();
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof window.requestAnimationFrame;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const keyOn = (el: Element, key: string, init: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
const pressWindow = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
const typeInto = (input: HTMLInputElement, text: string) => act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
});
const pointer = (el: Element, type: string, x: number, y: number) =>
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })); });
const mockRect = (el: HTMLElement, w: number, hgt: number) => {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: hgt, width: w, height: hgt, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
};

describe('<ColourPickerPanel>', () => {
    it('exposes a named group, two sliders with value semantics, and a hex field', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#ff0000', onChange, label: 'Primary colour' }));
        expect(q('[role="group"][aria-label="Primary colour"]')).not.toBeNull();
        const sv = q('.cp-sv');
        expect(sv.getAttribute('role')).toBe('slider');
        expect(sv.getAttribute('aria-roledescription')).toBe('2D slider');
        expect(sv.getAttribute('aria-valuetext')).toBe('saturation 100%, brightness 100%');
        const hue = q('.cp-hue');
        expect(hue.getAttribute('role')).toBe('slider');
        expect(hue.getAttribute('aria-valuemin')).toBe('0');
        expect(hue.getAttribute('aria-valuemax')).toBe('360');
        expect(hue.getAttribute('aria-valuenow')).toBe('0');
        expect(q<HTMLInputElement>('input.cp-hex').value).toBe('ff0000');
    });

    it('treats an invalid value as the fallback and tolerates uppercase', () => {
        render(h(ColourPickerPanel, { value: 'banana', onChange: vi.fn(), label: 'c' }));
        expect(q<HTMLInputElement>('input.cp-hex').value).toBe('25e0c8');
        act(() => root.render(h(ColourPickerPanel, { value: '#ABCDEF', onChange: vi.fn(), label: 'c' })));
        expect(q<HTMLInputElement>('input.cp-hex').value).toBe('abcdef');
    });

    it('arrow keys move the area by 1% and Shift+Arrow by 10%, firing onChange live', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#ff0000', onChange, label: 'c' }));
        const sv = q('.cp-sv');
        keyOn(sv, 'ArrowLeft');
        expect(sv.getAttribute('aria-valuetext')).toBe('saturation 99%, brightness 100%');
        keyOn(sv, 'ArrowDown', { shiftKey: true });
        expect(sv.getAttribute('aria-valuetext')).toBe('saturation 99%, brightness 90%');
        keyOn(sv, 'ArrowUp');
        keyOn(sv, 'ArrowRight', { shiftKey: true });   // clamps at 100
        expect(sv.getAttribute('aria-valuetext')).toBe('saturation 100%, brightness 91%');
        expect(onChange).toHaveBeenCalledTimes(4);
        expect(onChange.mock.calls[0][0]).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('hue slider: arrows 1deg, Shift 10, Page 30, Home/End', () => {
        render(h(ColourPickerPanel, { value: '#ff0000', onChange: vi.fn(), label: 'c' }));
        const hue = q('.cp-hue');
        keyOn(hue, 'ArrowRight');
        expect(hue.getAttribute('aria-valuenow')).toBe('1');
        keyOn(hue, 'ArrowUp', { shiftKey: true });
        expect(hue.getAttribute('aria-valuenow')).toBe('11');
        keyOn(hue, 'PageUp');
        expect(hue.getAttribute('aria-valuenow')).toBe('41');
        keyOn(hue, 'PageDown');
        keyOn(hue, 'ArrowLeft');
        expect(hue.getAttribute('aria-valuenow')).toBe('10');
        keyOn(hue, 'End');
        expect(hue.getAttribute('aria-valuenow')).toBe('360');
        keyOn(hue, 'Home');
        expect(hue.getAttribute('aria-valuenow')).toBe('0');
        keyOn(hue, 'ArrowLeft');                         // clamps at 0
        expect(hue.getAttribute('aria-valuenow')).toBe('0');
    });

    it('keeps the hue when saturation is dragged to 0', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#25e0c8', onChange, label: 'c' }));
        const hue = q('.cp-hue');
        const before = hue.getAttribute('aria-valuenow');
        const sv = q('.cp-sv');
        for (let i = 0; i < 10; i++) keyOn(sv, 'ArrowLeft', { shiftKey: true });
        expect(sv.getAttribute('aria-valuetext')).toMatch(/^saturation 0%/);
        expect(onChange.mock.calls.at(-1)![0]).toMatch(/^#([0-9a-f]{2})\1\1$/);   // a grey
        expect(hue.getAttribute('aria-valuenow')).toBe(before);
        keyOn(sv, 'ArrowRight', { shiftKey: true });
        expect(onChange.mock.calls.at(-1)![0]).not.toMatch(/^#([0-9a-f]{2})\1\1$/); // colour is back, same hue
    });

    it('dragging the area with the pointer updates live from the pointer position', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#ff0000', onChange, label: 'c' }));
        const sv = q('.cp-sv');
        mockRect(sv, 200, 100);
        pointer(sv, 'pointerdown', 100, 50);
        expect(sv.getAttribute('aria-valuetext')).toBe('saturation 50%, brightness 50%');
        pointer(sv, 'pointermove', 500, -40);          // clamped to the box
        expect(sv.getAttribute('aria-valuetext')).toBe('saturation 100%, brightness 100%');
        pointer(sv, 'pointerup', 500, -40);
        const calls = onChange.mock.calls.length;
        pointer(sv, 'pointermove', 0, 100);            // not dragging any more
        expect(onChange.mock.calls.length).toBe(calls);
    });

    it('dragging the hue track maps x to 0..360', () => {
        render(h(ColourPickerPanel, { value: '#ff0000', onChange: vi.fn(), label: 'c' }));
        const hue = q('.cp-hue');
        mockRect(hue, 360, 12);
        pointer(hue, 'pointerdown', 120, 6);
        expect(hue.getAttribute('aria-valuenow')).toBe('120');
        pointer(hue, 'pointerup', 120, 6);
    });

    it('hex field applies 3 or 6 digits on Enter, with or without #', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#ff0000', onChange, label: 'c' }));
        const input = q<HTMLInputElement>('input.cp-hex');
        typeInto(input, '#ABC');
        expect(onChange).not.toHaveBeenCalled();
        keyOn(input, 'Enter');
        expect(onChange).toHaveBeenLastCalledWith('#aabbcc');
        expect(input.value).toBe('aabbcc');
        typeInto(input, '123456');
        expect(onChange).toHaveBeenLastCalledWith('#123456');
    });

    it('hex field flags invalid input, never applies it, and reverts on blur', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#ff0000', onChange, label: 'c' }));
        const input = q<HTMLInputElement>('input.cp-hex');
        typeInto(input, 'zz');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        keyOn(input, 'Enter');
        expect(onChange).not.toHaveBeenCalled();
        typeInto(input, '12');                           // a valid prefix is quiet until submitted
        expect(input.getAttribute('aria-invalid')).toBeNull();
        keyOn(input, 'Enter');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(onChange).not.toHaveBeenCalled();
        expect(input.value).toBe('ff0000');
        expect(input.getAttribute('aria-invalid')).toBeNull();
    });

    it('hex field applies a valid draft on blur', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#ff0000', onChange, label: 'c' }));
        const input = q<HTMLInputElement>('input.cp-hex');
        typeInto(input, 'fa0');
        act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(onChange).toHaveBeenLastCalledWith('#ffaa00');
    });

    it('renders the default brand presets as pressable buttons; clicking one applies it', () => {
        const onChange = vi.fn();
        render(h(ColourPickerPanel, { value: '#25E0C8', onChange, label: 'c' }));
        const sw = qa('.cp-swatch');
        expect(sw).toHaveLength(BRAND_PRESETS.length);
        expect(sw[0].getAttribute('aria-label')).toBe('Use #25e0c8');
        expect(sw[0].getAttribute('aria-pressed')).toBe('true');
        expect(sw[1].getAttribute('aria-pressed')).toBe('false');
        act(() => sw[3].click());
        expect(onChange).toHaveBeenLastCalledWith('#ffc94d');
        expect(qa('.cp-swatch')[3].getAttribute('aria-pressed')).toBe('true');
        expect(qa('.cp-swatch')[0].getAttribute('aria-pressed')).toBe('false');
    });

    it('custom presets are normalised and de-duplicated; invalid ones are dropped', () => {
        render(h(ColourPickerPanel, { value: '#000', onChange: vi.fn(), label: 'c', presets: ['#FFF', '#ffffff', 'nope', '#123456'] }));
        expect(qa('.cp-swatch').map(s => s.getAttribute('aria-label'))).toEqual(['Use #ffffff', 'Use #123456']);
    });

    it('follows a new value from the parent', () => {
        render(h(ColourPickerPanel, { value: '#ff0000', onChange: vi.fn(), label: 'c' }));
        act(() => root.render(h(ColourPickerPanel, { value: '#0000ff', onChange: vi.fn(), label: 'c' })));
        expect(q<HTMLInputElement>('input.cp-hex').value).toBe('0000ff');
        expect(q('.cp-hue').getAttribute('aria-valuenow')).toBe('240');
    });

    it('shows a Recent row only when there are recents and showRecent is on', () => {
        render(h(ColourPickerPanel, { value: '#ff0000', onChange: vi.fn(), label: 'c' }));
        expect(q('[aria-label="Recent colors"]')).toBeNull();
        act(() => pushRecentColour('#010203'));
        expect(qa('[aria-label="Recent colors"] .cp-swatch').map(s => s.getAttribute('aria-label'))).toEqual(['Use #010203']);
        act(() => root.render(h(ColourPickerPanel, { value: '#ff0000', onChange: vi.fn(), label: 'c', showRecent: false })));
        expect(q('[aria-label="Recent colors"]')).toBeNull();
    });

    it('never touches raw localStorage', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem');
        render(h(ColourPickerPanel, { value: '#ff0000', onChange: vi.fn(), label: 'c' }));
        keyOn(q('.cp-sv'), 'ArrowLeft');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('<ColourSwatchButton>', () => {
    const underneath = vi.fn();
    const Page: React.FC<{ onCommit: (hex: string) => void; onChange?: (hex: string) => void; disabled?: boolean }> = ({ onCommit, onChange, disabled }) => {
        useEscape(() => { underneath(); }, true);   // stands in for Settings' own Escape
        return h('div', null,
            h(ColourSwatchButton, { value: '#25e0c8', label: 'Primary colour', onCommit, onChange, disabled }),
            h('button', { id: 'elsewhere' }, 'elsewhere'));
    };
    const trigger = () => q<HTMLButtonElement>('button.cp-trigger');

    beforeEach(() => { underneath.mockClear(); });

    it('shows a labelled round swatch of the value, closed by default', () => {
        render(h(Page, { onCommit: vi.fn() }));
        expect(trigger().getAttribute('aria-label')).toBe('Primary colour: #25e0c8');
        expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(q<HTMLElement>('.cp-trigger-fill').style.background).not.toBe('');
        expect(q('[role="dialog"]')).toBeNull();
    });

    it('opens a named dialog portaled to <body>, with focus on the colour area', () => {
        render(h(Page, { onCommit: vi.fn() }));
        act(() => trigger().click());
        const dlg = q('[role="dialog"]');
        expect(dlg.getAttribute('aria-label')).toBe('Primary colour');
        expect(dlg.parentElement).toBe(document.body);
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(q('.cp-sv'));
    });

    it('Escape closes only the popover, returns focus, and commits the change once (and records it as recent)', () => {
        const onCommit = vi.fn();
        const onChange = vi.fn();
        render(h(Page, { onCommit, onChange }));
        act(() => trigger().click());
        keyOn(q('.cp-sv'), 'ArrowLeft', { shiftKey: true });
        keyOn(q('.cp-sv'), 'ArrowLeft', { shiftKey: true });
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(onCommit).not.toHaveBeenCalled();
        pressWindow('Escape');
        expect(q('[role="dialog"]')).toBeNull();
        expect(underneath).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger());
        expect(onCommit).toHaveBeenCalledTimes(1);
        const committed = onCommit.mock.calls[0][0] as string;
        expect(committed).toBe(onChange.mock.calls[1][0]);
        expect(JSON.parse(kv.map.get('cipherline_recent_colours')!)).toEqual([committed]);
    });

    it('does not commit when it closes with the value it opened with', () => {
        const onCommit = vi.fn();
        render(h(Page, { onCommit }));
        act(() => trigger().click());
        pressWindow('Escape');
        expect(onCommit).not.toHaveBeenCalled();
        expect(kv.map.has('cipherline_recent_colours')).toBe(false);
        // ...and a pick that lands back on the original colour is not a change.
        act(() => trigger().click());
        keyOn(q('.cp-sv'), 'ArrowLeft');
        keyOn(q('.cp-sv'), 'ArrowRight');
        pressWindow('Escape');
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('a second Escape reaches the surface underneath', () => {
        render(h(Page, { onCommit: vi.fn() }));
        act(() => trigger().click());
        pressWindow('Escape');
        pressWindow('Escape');
        expect(underneath).toHaveBeenCalledTimes(1);
    });

    it('a click outside closes it and commits', () => {
        const onCommit = vi.fn();
        render(h(Page, { onCommit }));
        act(() => trigger().click());
        keyOn(q('.cp-sv'), 'ArrowLeft', { shiftKey: true });
        act(() => { q('#elsewhere').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); });
        expect(q('[role="dialog"]')).toBeNull();
        expect(onCommit).toHaveBeenCalledTimes(1);
        // The closing click is swallowed (it must not reach what is behind); let it through so it cannot leak into the next test.
        const behind = vi.fn();
        q('#elsewhere').addEventListener('click', behind);
        act(() => q('#elsewhere').click());
        expect(behind).not.toHaveBeenCalled();
    });

    it('clicking the trigger again closes it', () => {
        render(h(Page, { onCommit: vi.fn() }));
        act(() => trigger().click());
        act(() => trigger().click());
        expect(q('[role="dialog"]')).toBeNull();
    });

    it('commits a pick still pending when the whole thing unmounts', () => {
        const onCommit = vi.fn();
        render(h(Page, { onCommit }));
        act(() => trigger().click());
        keyOn(q('.cp-sv'), 'ArrowLeft', { shiftKey: true });
        act(() => root.render(h('div')));
        expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it('a disabled trigger does not open', () => {
        render(h(Page, { onCommit: vi.fn(), disabled: true }));
        expect(trigger().disabled).toBe(true);
        act(() => trigger().click());
        expect(q('[role="dialog"]')).toBeNull();
    });

    it('renders custom trigger content, size and aria-label when given', () => {
        render(h(ColourSwatchButton, { value: '#ff0000', label: 'x', onCommit: vi.fn(), size: 28, triggerLabel: 'Pick one', className: 'cp-trigger--dashed' }, h('span', null, '+')));
        const t = trigger();
        expect(t.textContent).toBe('+');
        expect(t.getAttribute('aria-label')).toBe('Pick one');
        expect(t.style.width).toBe('28px');
        expect(t.className).toContain('cp-trigger--dashed');
    });
});
