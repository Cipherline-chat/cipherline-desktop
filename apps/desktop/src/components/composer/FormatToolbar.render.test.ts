// @vitest-environment jsdom
/**
 * The composer's formatting bar (components/composer/FormatToolbar.tsx) and
 * the Markdown paste prompt, in a real DOM: toggle state, every button and its
 * shortcut in ARIA, toolbar keyboard navigation, Escape, the font menu, and
 * that mouse use never steals the text box's selection.
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
const { TOOL_GROUPS } = await import('./formatTools');
const { MarkdownPastePrompt } = await import('./MarkdownPastePrompt');
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
function Harness(p: Partial<Props> & { onAction: Props['onAction']; onFontChange?: Props['onFontChange'] }) {
    const [open, setOpen] = React.useState(p.open ?? false);
    const [font, setFont] = React.useState<Props['font']>(p.font ?? null);
    return React.createElement('form', { style: { position: 'relative' } },
        React.createElement('textarea', { 'data-ta': '' }),
        React.createElement(FormatToolbar, {
            open, onOpenChange: setOpen, onAction: p.onAction, font,
            onFontChange: (f) => { setFont(f); p.onFontChange?.(f); },
            focusComposer: () => (document.querySelector('[data-ta]') as HTMLTextAreaElement).focus(),
            isMac: p.isMac ?? false,
        }));
}
const mount = (p: Parameters<typeof Harness>[0]) => act(() => root.render(React.createElement(Harness, p)));
const toggle = () => host.querySelector('.fmt-toggle') as HTMLButtonElement;
const bar = () => host.querySelector('[role="toolbar"]') as HTMLElement | null;
const btn = (action: string) => host.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
const click = (el: Element, detail = 1) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('toggle', () => {
    it('opens and closes the bar, with aria-expanded / aria-controls', () => {
        mount({ onAction: vi.fn() });
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(bar()).toBeNull();
        click(toggle());
        expect(toggle().getAttribute('aria-expanded')).toBe('true');
        expect(bar()).not.toBeNull();
        expect(toggle().getAttribute('aria-controls')).toBe(bar()!.id);
        click(toggle());
        expect(bar()).toBeNull();
    });

    it('mousedown on the toggle and the buttons is swallowed (the text box keeps its selection)', () => {
        mount({ onAction: vi.fn(), open: true });
        for (const el of [toggle(), btn('bold')]) {
            const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
            el.dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(true);
        }
    });
});

describe('bar', () => {
    it('has every tool, each with a label and its shortcut in aria-keyshortcuts', () => {
        mount({ onAction: vi.fn(), open: true });
        const actions = TOOL_GROUPS.flat().map(t => t.action);
        expect(actions).toEqual(['bold', 'italic', 'underline', 'strike', 'link', 'bullet', 'number', 'quote', 'code', 'codeBlock', 'spoiler', 'heading']);
        for (const a of actions) expect(btn(a)?.getAttribute('aria-label')).toBeTruthy();
        expect(btn('bold').getAttribute('aria-keyshortcuts')).toBe('Control+B');
        expect(btn('strike').getAttribute('aria-keyshortcuts')).toBe('Control+Shift+X');
        expect(btn('codeBlock').getAttribute('aria-keyshortcuts')).toBe('Control+Shift+C');
        expect(btn('link').getAttribute('aria-keyshortcuts')).toBe('Control+K');
        expect(bar()!.getAttribute('aria-label')).toBe('Text formatting');
    });

    it('each button\'s tooltip names its shortcut, and stays open across re-renders', async () => {
        mount({ onAction: vi.fn(), open: true });
        act(() => btn('strike').focus());
        await act(async () => { await new Promise(r => setTimeout(r, 60)); });
        const tipText = () => [...document.body.querySelectorAll('[role="tooltip"], .cl-tip2')].map(t => t.textContent).join('|');
        expect(tipText()).toContain('Strikethrough · Ctrl+Shift+X');
        // A re-render of the bar (moving the roving tab stop) must not detach + close it.
        key(btn('strike'), 'ArrowRight');
        act(() => btn('strike').focus());
        await act(async () => { await new Promise(r => setTimeout(r, 60)); });
        expect(tipText()).toContain('Strikethrough · Ctrl+Shift+X');
    });

    it('the list buttons explain the Enter rule (Shift+Enter continues, Enter sends)', async () => {
        mount({ onAction: vi.fn(), open: true });
        act(() => btn('bullet').focus());
        await act(async () => { await new Promise(r => setTimeout(r, 60)); });
        const tips = [...document.body.querySelectorAll('[role="tooltip"]')].map(t => t.textContent).join('|');
        expect(tips).toContain('Bulleted list · Shift+Enter adds the next item, Enter sends');
    });

    it('macOS names Cmd', () => {
        mount({ onAction: vi.fn(), open: true, isMac: true });
        expect(btn('italic').getAttribute('aria-keyshortcuts')).toBe('Meta+I');
    });

    it('a click reports its action (mouse), Enter-activated clicks report keyboard', () => {
        const onAction = vi.fn();
        mount({ onAction, open: true });
        click(btn('bold'));
        expect(onAction).toHaveBeenLastCalledWith('bold', false);
        click(btn('spoiler'), 0);
        expect(onAction).toHaveBeenLastCalledWith('spoiler', true);
    });

    it('roving tabindex: one tab stop; arrows / Home / End move focus', () => {
        mount({ onAction: vi.fn(), open: true });
        const tabbable = [...bar()!.querySelectorAll('button')].filter(b => b.tabIndex === 0);
        expect(tabbable).toHaveLength(1);
        btn('bold').focus();
        key(btn('bold'), 'ArrowRight');
        expect(document.activeElement).toBe(btn('italic'));
        key(btn('italic'), 'ArrowLeft');
        expect(document.activeElement).toBe(btn('bold'));
        key(btn('bold'), 'ArrowLeft'); // wraps to the font button at the end
        expect((document.activeElement as HTMLElement).hasAttribute('data-font-button')).toBe(true);
        key(document.activeElement!, 'Home');
        expect(document.activeElement).toBe(btn('bold'));
        key(btn('bold'), 'End');
        expect((document.activeElement as HTMLElement).hasAttribute('data-font-button')).toBe(true);
    });

    it('Escape inside the bar closes it and returns to the text box; Escape in the text box leaves it open', () => {
        mount({ onAction: vi.fn(), open: true });
        const ta = host.querySelector('[data-ta]') as HTMLTextAreaElement;
        ta.focus();
        key(ta, 'Escape');
        expect(bar()).not.toBeNull();
        btn('underline').focus();
        key(btn('underline'), 'Escape');
        // The focused button's tooltip may take the first Escape (house escape stack).
        if (bar()) key(document.activeElement ?? btn('underline'), 'Escape');
        expect(bar()).toBeNull();
        expect(document.activeElement).toBe(ta);
    });
});

describe('font menu', () => {
    it('lists the fonts as radio items, marks the current one, and picks', () => {
        const onFontChange = vi.fn();
        mount({ onAction: vi.fn(), open: true, onFontChange });
        const fb = host.querySelector('[data-font-button]') as HTMLButtonElement;
        expect(fb.getAttribute('aria-haspopup')).toBe('menu');
        expect(fb.textContent).toContain('Default');
        click(fb);
        const menu = host.querySelector('[role="menu"]')!;
        const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
        expect(items.map(i => i.getAttribute('data-font-id'))).toEqual(['default', 'serif', 'mono', 'hand', 'typewriter', 'marker', 'readable']);
        expect(items[0].getAttribute('aria-checked')).toBe('true');
        // Each name is drawn in its own face (bundled faces, never a URL).
        expect((items[1].querySelector('.fmt-menu-name') as HTMLElement).style.fontFamily).toContain('Cipherline Lora');
        expect((items[3].querySelector('.fmt-menu-name') as HTMLElement).style.fontFamily).toContain('Cipherline Caveat');
        click(items[3]);
        expect(onFontChange).toHaveBeenCalledWith('hand');
        expect(host.querySelector('[role="menu"]')).toBeNull();
        expect(toggle().getAttribute('data-font')).toBe('hand');
        expect((host.querySelector('[data-font-button]') as HTMLElement).textContent).toContain('Handwritten');
    });

    it('arrow keys move through the menu; Escape closes it back to the font button', () => {
        mount({ onAction: vi.fn(), open: true });
        const fb = host.querySelector('[data-font-button]') as HTMLButtonElement;
        // Focus first (its own commit, as a real keypress is), then open the menu.
        act(() => fb.focus());
        key(fb, 'ArrowDown');
        const items = () => [...host.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
        expect(document.activeElement).toBe(items()[0]);
        key(items()[0], 'ArrowDown');
        expect(document.activeElement).toBe(items()[1]);
        key(items()[1], 'Escape');
        expect(host.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(fb);
        // The bar itself is still open.
        expect(bar()).not.toBeNull();
    });
});

describe('MarkdownPastePrompt', () => {
    it('the code variant asks about a code block and names the language', () => {
        act(() => root.render(React.createElement(MarkdownPastePrompt, { onFormat: vi.fn(), onKeep: vi.fn(), kind: 'code', lang: 'python' })));
        const g = host.querySelector('[data-md-paste-prompt]')!;
        expect(g.getAttribute('data-kind')).toBe('code');
        expect(g.getAttribute('aria-label')).toBe('Pasted code');
        expect(g.textContent).toContain('Paste as a code block?');
        expect(g.textContent).toContain('python code');
    });

    it('Format and Keep as plain report; Escape keeps it plain', () => {
        const onFormat = vi.fn();
        const onKeep = vi.fn();
        act(() => root.render(React.createElement(MarkdownPastePrompt, { onFormat, onKeep })));
        const b = [...host.querySelectorAll('button')];
        expect(b.map(x => x.textContent)).toEqual(['Format', 'Keep as plain']);
        click(b[0]);
        expect(onFormat).toHaveBeenCalledTimes(1);
        click(b[1]);
        expect(onKeep).toHaveBeenCalledTimes(1);
        key(document.body, 'Escape');
        expect(onKeep).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain('Paste as formatted text?');
    });
});
