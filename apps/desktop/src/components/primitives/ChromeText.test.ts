// @vitest-environment jsdom
/**
 * Dragging across message text must not pick up the disappearing-message
 * expiry ("· 3d", "Deletes in 3 days") or "(edited)". ChromeText paints those
 * from a data attribute (CSS ::before), so the characters are not in the DOM
 * and cannot be in a selection or copy; `user-select: none` is set as well.
 * Screen readers still get the expiry through an aria-label.
 */
import { describe, it, expect } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChromeText } from './ChromeText';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactElement): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => createRoot(host).render(node));
    return host;
}

/** What a user gets from select-all + copy over `el` (the selection's text). */
function copiedText(el: HTMLElement): string {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    return sel.toString();
}

const h = React.createElement;

function row(chrome: boolean) {
    const expiry = chrome
        ? h(ChromeText, { text: '· 3d', label: 'Deletes in 3 days', className: 'badge' })
        : h('span', { className: 'badge' }, '· 3d');
    const tip = chrome
        ? h(ChromeText, { text: 'Deletes in 3 days', className: 'tip' })
        : h('span', { className: 'tip' }, 'Deletes in 3 days');
    const edited = chrome
        ? h(ChromeText, { text: '(edited)', label: 'edited', className: 'edited' })
        : h('span', { className: 'edited' }, '(edited)');
    return h('div', { id: 'row' },
        h('span', { className: 'name' }, 'alice'),
        expiry, tip,
        h('div', { className: 'body' }, 'meet at noon', edited),
    );
}

describe('ChromeText keeps message chrome out of selections and copies', () => {
    it('copied text is just the message: no expiry, tooltip or (edited)', () => {
        const host = mount(row(true));
        const copied = copiedText(host.querySelector('#row') as HTMLElement);
        expect(copied).toContain('meet at noon');
        expect(copied).toContain('alice');
        expect(copied).not.toMatch(/3d|Deletes in|edited/);
        expect((host.querySelector('#row') as HTMLElement).textContent).not.toMatch(/3d|Deletes in|edited/);
    });

    it('NEGATIVE CONTROL: the same row with plain spans DOES copy the chrome (the test can fail)', () => {
        const host = mount(row(false));
        const copied = copiedText(host.querySelector('#row') as HTMLElement);
        expect(copied).toMatch(/3d/);
        expect(copied).toMatch(/Deletes in 3 days/);
        expect(copied).toMatch(/\(edited\)/);
    });

    it('the element is user-select: none (inline, independent of the stylesheet)', () => {
        const host = mount(h(ChromeText, { text: '· 3d', label: 'Deletes in 3 days' }));
        const el = host.querySelector('.cl-chrome-text') as HTMLElement;
        expect(el.style.userSelect).toBe('none');
        expect(el.getAttribute('style')).toMatch(/user-select:\s*none/);
    });

    it('the painted text is carried in data-chrome-text for the ::before rule', () => {
        const host = mount(h(ChromeText, { text: '· 3d', label: 'Deletes in 3 days' }));
        expect((host.querySelector('.cl-chrome-text') as HTMLElement).dataset.chromeText).toBe('· 3d');
    });

    it('screen readers still announce the expiry: role=img with an aria-label', () => {
        const host = mount(h(ChromeText, { text: '· 3d', label: 'Deletes in 3 days' }));
        const el = host.querySelector('.cl-chrome-text') as HTMLElement;
        expect(el.getAttribute('role')).toBe('img');
        expect(el.getAttribute('aria-label')).toBe('Deletes in 3 days');
        expect(el.getAttribute('aria-hidden')).toBeNull();
    });

    it('a decorative duplicate (the tooltip) is aria-hidden so it is not announced twice', () => {
        const host = mount(h(ChromeText, { text: 'Deletes in 3 days' }));
        const el = host.querySelector('.cl-chrome-text') as HTMLElement;
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.getAttribute('role')).toBeNull();
    });

    it('index.css paints the text from the attribute and sets user-select: none', () => {
        const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
        expect(css).toMatch(/\.cl-chrome-text::before\s*\{\s*content:\s*attr\(data-chrome-text\)/);
        expect(css).toMatch(/\.cl-chrome-text\s*\{[^}]*user-select:\s*none/);
    });
});

describe('ChatPane renders its expiry / edited chrome through ChromeText', () => {
    const src = readFileSync(resolve(__dirname, '../ChatPane.tsx'), 'utf8');

    it('no raw expiry or (edited) text nodes remain in the message row', () => {
        expect(src).not.toMatch(/>\s*\{compactExpiry\}\s*</);
        expect(src).not.toMatch(/·\s*\{inlineBadge\}/);
        expect(src).not.toMatch(/<span[^>]*>\s*\(edited\)\s*<\/span>/);
        expect(src).not.toMatch(/<span[^>]*group-hover\/cd[^>]*>\s*\{deletionText\}/);
    });

    it('uses ChromeText for the gutter expiry, header badge, tooltip and both (edited) markers', () => {
        const uses = src.match(/<ChromeText\b/g) ?? [];
        expect(uses.length).toBe(5);
        expect(src).toMatch(/<ChromeText[^>]*text=\{compactExpiry!\}/);
        expect(src).toMatch(/<ChromeText[^>]*text=\{`· \$\{inlineBadge\}`\}[^>]*label=\{deletionText\}/);
    });
});
