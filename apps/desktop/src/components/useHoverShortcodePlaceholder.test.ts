// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { pickerButtonShortcode, useHoverShortcodePlaceholder } from './useHoverShortcodePlaceholder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in for emoji-mart's element: same shadow-root shape the hook reads. */
function buildPicker(host: HTMLElement): ShadowRoot {
    const picker = document.createElement('em-emoji-picker');
    host.appendChild(picker);
    const root = picker.attachShadow({ mode: 'open' });
    root.innerHTML = `
        <div class="search"><input type="search" placeholder="Search"><button class="delete">x</button></div>
        <div class="category" data-id="people">
            <button aria-posinset="1" title="Fire Engine" id="fire"><span>🚒</span></button>
            <button aria-posinset="2" title="tough_ass_emoji" id="mine"><img src="blob:x"></button>
            <button aria-posinset="3" title="cl-empty-mine" id="ph"></button>
        </div>
        <div id="nav"><button aria-label="Smileys" id="tab">☺</button></div>`;
    return root;
}

function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useHoverShortcodePlaceholder(ref);
    return React.createElement('div', { ref, id: 'wrap' });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const over = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));

describe('pickerButtonShortcode', () => {
    it('standard emoji name -> underscore shortcode; custom name kept; non-emoji buttons -> null', () => {
        const b = (attrs: Record<string, string>) => {
            const el = document.createElement('button');
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
            return el;
        };
        expect(pickerButtonShortcode(b({ 'aria-posinset': '1', title: 'Fire Engine' }))).toBe(':fire_engine:');
        expect(pickerButtonShortcode(b({ 'aria-posinset': '1', title: 'tough_ass_emoji' }))).toBe(':tough_ass_emoji:');
        expect(pickerButtonShortcode(b({ 'aria-posinset': '1', title: 'cl-empty-mine' }))).toBeNull();
        expect(pickerButtonShortcode(b({ title: 'Smileys' }))).toBeNull();
        expect(pickerButtonShortcode(null)).toBeNull();
    });
});

describe('useHoverShortcodePlaceholder', () => {
    it('hovering an emoji shows its shortcode as the placeholder; leaving restores "Search"', async () => {
        act(() => root.render(React.createElement(Harness)));
        const shadow = buildPicker(host.querySelector('#wrap') as HTMLElement);
        await act(async () => { await new Promise(r => setTimeout(r, 40)); });   // the hook polls for the shadow root
        const input = shadow.querySelector('input') as HTMLInputElement;

        act(() => { over(shadow.querySelector('#fire span')!); });
        expect(input.placeholder).toBe(':fire_engine:');
        act(() => { over(shadow.querySelector('#mine')!); });
        expect(input.placeholder).toBe(':tough_ass_emoji:');
        act(() => { over(shadow.querySelector('#tab')!); });            // a nav tab is not an emoji
        expect(input.placeholder).toBe('Search');
        act(() => { over(shadow.querySelector('#fire')!); });
        act(() => { shadow.host.dispatchEvent(new MouseEvent('mouseleave')); });
        expect(input.placeholder).toBe('Search');
    });

    it('never changes a typed query, only the placeholder', async () => {
        act(() => root.render(React.createElement(Harness)));
        const shadow = buildPicker(host.querySelector('#wrap') as HTMLElement);
        await act(async () => { await new Promise(r => setTimeout(r, 40)); });
        const input = shadow.querySelector('input') as HTMLInputElement;
        input.value = 'fire';
        act(() => { over(shadow.querySelector('#fire')!); });
        expect(input.value).toBe('fire');
        expect(input.placeholder).toBe(':fire_engine:');
    });
});
