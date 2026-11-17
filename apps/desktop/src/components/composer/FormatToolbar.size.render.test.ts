// @vitest-environment jsdom
/**
 * The formatting bar's size picker (Small / Normal / Large) and its pressed
 * buttons — what the WYSIWYG box reports as on at the caret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageSize } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { FormatToolbar } = await import('./FormatToolbar');
const { isActionActive } = await import('./formatTools');
const { MARK } = await import('../../utils/formatting/richDoc');
const { __resetEscapeStackForTests } = await import('../../utils/escapeStack');
type Props = React.ComponentProps<typeof FormatToolbar>;

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

function Harness(p: Partial<Props> & { onSize?: (s: MessageSize | null) => void; withSize?: boolean }) {
    const [size, setSize] = React.useState<MessageSize | null | 'mixed'>(p.size ?? null);
    return React.createElement('form', { style: { position: 'relative' } },
        React.createElement('div', { 'data-box': '', tabIndex: 0 }),
        React.createElement(FormatToolbar, {
            open: true, onOpenChange: () => {}, onAction: p.onAction ?? vi.fn(), font: null, onFontChange: () => {},
            active: p.active ?? null,
            size,
            onSizeChange: p.withSize === false ? undefined : (s) => { setSize(s); p.onSize?.(s); },
            focusComposer: () => (document.querySelector('[data-box]') as HTMLElement).focus(),
            isMac: false,
        }));
}
const mount = (p: Parameters<typeof Harness>[0] = {}) => act(() => root.render(React.createElement(Harness, p)));
const sizeBtn = () => host.querySelector('[data-size-button]') as HTMLButtonElement | null;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('size picker', () => {
    it('sits after the font picker, shows Normal, and lists Small / Normal / Large as a radio menu', () => {
        mount();
        const font = host.querySelector('[data-font-button]')!;
        const btn = sizeBtn()!;
        expect(font.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(btn.getAttribute('aria-label')).toBe('Text size: Normal');
        expect(btn.getAttribute('aria-haspopup')).toBe('menu');
        click(btn);
        const items = [...host.querySelectorAll('[role="menu"][aria-label="Text size"] [role="menuitemradio"]')];
        expect(items.map(i => i.textContent?.replace(/A .*$/, '').trim().split(/(?=[A-Z])/)[0])).toEqual(['Small', 'Normal', 'Large']);
        expect(items.map(i => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
        // Each option previews its own size.
        const names = items.map(i => (i.querySelector('.fmt-menu-name') as HTMLElement).style.fontSize);
        expect(names).toEqual(['13.13px', '15px', '22.5px']);
    });

    it('picking Large reports it, closes the menu and updates the button', () => {
        const onSize = vi.fn();
        mount({ onSize });
        click(sizeBtn()!);
        click(host.querySelector('[data-size-id="large"]')!);
        expect(onSize).toHaveBeenCalledWith('large');
        expect(host.querySelector('[role="menu"]')).toBeNull();
        expect(sizeBtn()!.getAttribute('aria-label')).toBe('Text size: Large');
        click(sizeBtn()!);
        click(host.querySelector('[data-size-id="normal"]')!);
        expect(onSize).toHaveBeenLastCalledWith(null);
    });

    it('keyboard: Arrow keys reach it in the toolbar, ArrowDown opens it, Escape closes it', () => {
        mount();
        const font = host.querySelector('[data-font-button]') as HTMLButtonElement;
        act(() => font.focus());
        key(font, 'ArrowRight');
        expect(document.activeElement).toBe(sizeBtn());
        key(sizeBtn()!, 'ArrowDown');
        expect(host.querySelector('[role="menu"][aria-label="Text size"]')).not.toBeNull();
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(host.querySelector('[role="menu"]')).toBeNull();
    });

    it('a bar without onSizeChange has no size button (older callers)', () => {
        mount({ withSize: false });
        expect(sizeBtn()).toBeNull();
    });
});

describe('pressed buttons follow the caret', () => {
    it('bold / italic / code / lists / quote / heading / code block', () => {
        mount({ active: { marks: MARK.b | MARK.c, block: 'h2', quote: true } });
        const pressed = (a: string) => host.querySelector(`[data-action="${a}"]`)!.getAttribute('aria-pressed');
        expect(pressed('bold')).toBe('true');
        expect(pressed('code')).toBe('true');
        expect(pressed('italic')).toBe('false');
        expect(pressed('heading')).toBe('true');
        expect(pressed('quote')).toBe('true');
        expect(pressed('bullet')).toBe('false');
        // Link is an action, not a toggle.
        expect(host.querySelector('[data-action="link"]')!.hasAttribute('aria-pressed')).toBe(false);
    });

    it('isActionActive maps every toggle', () => {
        expect(isActionActive('bullet', { marks: 0, block: 'ul', quote: false })).toBe(true);
        expect(isActionActive('number', { marks: 0, block: 'ol', quote: false })).toBe(true);
        expect(isActionActive('codeBlock', { marks: 0, block: 'code', quote: false })).toBe(true);
        expect(isActionActive('spoiler', { marks: MARK.sp, block: 'p', quote: false })).toBe(true);
        expect(isActionActive('bold', null)).toBe(false);
    });
});
