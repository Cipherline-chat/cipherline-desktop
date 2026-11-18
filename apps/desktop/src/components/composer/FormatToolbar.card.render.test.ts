// @vitest-environment jsdom
/**
 * "Style this message" in the formatting bar (FormatToolbar `card`): the
 * button opens the card editor, a styled message shows a chip beside "Aa"
 * even with the bar closed (with a one-click remove), and when the composer
 * gate says no (no STYLE_MESSAGES here, or the server turned styles off) the
 * control isn't offered at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { FormatToolbar } = await import('./FormatToolbar');
const { resolveCard } = await import('../../utils/cardStyle/cardStyleReact');
const { CARD_STYLE_TEMPLATES } = await import('../../utils/cardStyle/cardStyleTemplates');
const { __resetEscapeStackForTests } = await import('../../utils/escapeStack');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    __resetEscapeStackForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

type Props = React.ComponentProps<typeof FormatToolbar>;
const mount = (p: Partial<Props>) => act(() => root.render(React.createElement(FormatToolbar, {
    open: false, onOpenChange: () => {}, onAction: () => {}, font: null, onFontChange: () => {},
    focusComposer: () => {}, isMac: false, ...p,
} as Props)));
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });

describe('Style this message', () => {
    it('the bar offers it, and it opens the editor', () => {
        const onOpen = vi.fn();
        mount({ open: true, card: { label: null, preview: null, onOpen, onClear: vi.fn() } });
        const btn = host.querySelector('[data-card-button]') as HTMLButtonElement;
        expect(btn).not.toBeNull();
        expect(btn.getAttribute('aria-label')).toBe('Style this message');
        click(btn);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('a styled message shows a chip beside Aa with the bar closed; x removes the style', () => {
        const onOpen = vi.fn();
        const onClear = vi.fn();
        const rules = CARD_STYLE_TEMPLATES[0].style;
        mount({ open: false, card: { label: 'Rules', preview: resolveCard(rules, 'static'), onOpen, onClear } });
        const chip = host.querySelector('[data-card-chip]') as HTMLElement;
        expect(chip).not.toBeNull();
        expect(chip.textContent).toContain('Rules');
        expect(chip.querySelector('[data-card-style]')).not.toBeNull(); // live swatch
        click(chip.querySelector('.cmp-card-chip-open')!);
        expect(onOpen).toHaveBeenCalled();
        click(chip.querySelector('.cmp-card-chip-x')!);
        expect(onClear).toHaveBeenCalled();
    });

    it('not offered when the composer gate says no (card prop absent)', () => {
        mount({ open: true });
        expect(host.querySelector('[data-card-button]')).toBeNull();
        expect(host.querySelector('[data-card-chip]')).toBeNull();
    });

    it('the button joins the bar\'s roving tab order (arrow keys reach it)', () => {
        mount({ open: true, onSizeChange: () => {}, card: { label: null, preview: null, onOpen: vi.fn(), onClear: vi.fn() } });
        const bar = host.querySelector('[role="toolbar"]') as HTMLElement;
        (host.querySelector('[data-action]') as HTMLElement).focus();
        act(() => { bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
        expect(document.activeElement).toBe(host.querySelector('[data-card-button]'));
    });
});
