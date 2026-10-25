// @vitest-environment jsdom
/**
 * The settings "i" (InfoTip): the explanation a row used to print inline, now
 * one hover / click / Tab away. Pins what makes it usable and accessible: a
 * real button named "About <setting>", aria-expanded + aria-describedby while
 * the note shows, hover with a grace period, click to pin, focus to show,
 * Escape through the shared escape stack (so it closes before Settings does),
 * and a portal to <body> so the settings scroll container cannot clip it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InfoTip } from './InfoTip';
import { pushEscapeLayer, escapeLayerCount, __resetEscapeStackForTests } from '../../utils/escapeStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    __resetEscapeStackForTests();
    host = document.createElement('div');
    // a clipping scroll container, like .sd-main
    host.style.overflow = 'auto';
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    __resetEscapeStackForTests();
});

const render = () => act(() => root.render(
    React.createElement('div', { className: 'vv-lab' },
        React.createElement('b', null, 'Voice gate'),
        React.createElement(InfoTip, { label: 'Voice gate', children: 'Only sends your mic when it is louder than the marker.' }),
    ),
));
const btn = () => host.querySelector('button.vv-info') as HTMLButtonElement;
const tip = () => document.querySelector('[role="tooltip"]') as HTMLElement | null;

/** React derives pointerenter/leave from pointerover/out; jsdom has no PointerEvent. */
function pointer(el: Element, type: 'pointerover' | 'pointerout', related: Element | null) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: related });
    Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    act(() => { el.dispatchEvent(ev); });
}
const escape = () => act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

describe('<InfoTip>', () => {
    it('is a real button named "About <setting>", closed by default with no description wired', () => {
        render();
        const b = btn();
        expect(b.tagName).toBe('BUTTON');
        expect(b.type).toBe('button');
        expect(b.getAttribute('aria-label')).toBe('About Voice gate');
        expect(b.getAttribute('aria-expanded')).toBe('false');
        expect(b.hasAttribute('aria-describedby')).toBe(false);
        expect(tip()).toBeNull();
        // the icon adds no text, so the row label still reads as exactly the
        // setting's name for the settings search (revealSetting matches text)
        expect(host.querySelector('.vv-lab')!.textContent).toBe('Voice gate');
    });

    it('hover shows the note in a <body> portal (outside the scroll container), wired by aria-describedby', () => {
        render();
        pointer(btn(), 'pointerover', document.body);
        const t = tip()!;
        expect(t).not.toBeNull();
        expect(host.contains(t)).toBe(false);
        expect(t.parentElement).toBe(document.body);
        expect(t.style.position).toBe('fixed');
        expect(t.textContent).toBe('Only sends your mic when it is louder than the marker.');
        expect(btn().getAttribute('aria-expanded')).toBe('true');
        expect(btn().getAttribute('aria-describedby')).toBe(t.id);
    });

    it('leaving hides it after a short grace, and moving onto the note keeps it (WCAG 1.4.13)', () => {
        vi.useFakeTimers();
        render();
        pointer(btn(), 'pointerover', document.body);
        pointer(btn(), 'pointerout', tip());
        pointer(tip()!, 'pointerover', btn());
        act(() => { vi.advanceTimersByTime(500); });
        expect(tip()).not.toBeNull();
        pointer(tip()!, 'pointerout', document.body);
        act(() => { vi.advanceTimersByTime(500); });
        expect(tip()).toBeNull();
        expect(btn().getAttribute('aria-expanded')).toBe('false');
    });

    it('click pins it open past pointer-leave; a second click closes it', () => {
        vi.useFakeTimers();
        render();
        pointer(btn(), 'pointerover', document.body);
        act(() => { btn().click(); });
        pointer(btn(), 'pointerout', document.body);
        act(() => { vi.advanceTimersByTime(1000); });
        expect(tip()).not.toBeNull();
        act(() => { btn().click(); });
        expect(tip()).toBeNull();
    });

    it('tap / click without hover (touch) opens it too', () => {
        render();
        act(() => { btn().click(); });
        expect(tip()).not.toBeNull();
    });

    it('keyboard focus shows it; blur hides it', () => {
        render();
        act(() => { btn().focus(); });
        expect(tip()).not.toBeNull();
        expect(btn().getAttribute('aria-expanded')).toBe('true');
        act(() => { btn().blur(); });
        expect(tip()).toBeNull();
    });

    it('Escape closes the note first and leaves the layer beneath (Settings) alone', () => {
        const settingsClose = vi.fn();
        const popSettings = pushEscapeLayer(settingsClose);
        render();
        act(() => { btn().click(); });
        expect(tip()).not.toBeNull();
        expect(escapeLayerCount()).toBe(2);
        escape();
        expect(tip()).toBeNull();
        expect(settingsClose).not.toHaveBeenCalled();
        expect(escapeLayerCount()).toBe(1);
        // the next Escape is Settings'
        escape();
        expect(settingsClose).toHaveBeenCalledTimes(1);
        popSettings();
    });

    it('pressing on the note does not steal focus (so a pinned note does not blur-close)', () => {
        render();
        act(() => { btn().focus(); });
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        act(() => { tip()!.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
        expect(tip()).not.toBeNull();
    });

    it('registers no escape layer while closed', () => {
        render();
        expect(escapeLayerCount()).toBe(0);
    });
});
