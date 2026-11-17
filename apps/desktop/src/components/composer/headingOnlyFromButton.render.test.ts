// @vitest-environment jsdom
/**
 * Owner, 2026-11-16: headings come ONLY from the toolbar's heading button.
 * Nothing typed makes one — not "H", "h", "H " at a line start, "# ",
 * "## ", "### ", nor any other sequence, at a line start or mid-line, with
 * Enter or Shift+Enter after it — and no keyboard shortcut (bare letter or
 * modifier combo) maps to it. The button has a heading icon (H1 / H2 / H3),
 * never a bare letter, its tooltip is "Heading" and so is its accessible name.
 *
 * "No heading" is checked twice: nothing in the box is styled as one, AND the
 * text the box would send parses with no heading in it (markdown.ts, the
 * renderer every reader uses).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseMessage, type BlockNode } from '../../utils/formatting/markdown';
import { shortcutAction } from '../../utils/formatting/composerFormat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { RichComposer } = await import('./RichComposer');
const { FormatToolbar } = await import('./FormatToolbar');
const { __resetEscapeStackForTests } = await import('../../utils/escapeStack');
type Handle = import('./RichComposer').RichComposerHandle;

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

function mountBox(initial = '') {
    const ref = React.createRef<Handle>();
    let value = initial;
    function H() {
        const [v, setV] = React.useState(initial);
        value = v;
        return React.createElement(RichComposer, { ref, value: v, onChange: (nv: string) => setV(nv) });
    }
    act(() => root.render(React.createElement(H)));
    const box = () => host.querySelector('[data-rich-composer]') as HTMLDivElement;
    act(() => ref.current!.placeCaretAtEnd());
    return { ref, box, value: () => value };
}
const fire = (box: HTMLElement, inputType: string, data: string | null = null) =>
    act(() => { box.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true })); });
const typeInto = (box: HTMLElement, text: string) => { for (const ch of text) fire(box, 'insertText', ch); };

const hasHeadingNode = (blocks: readonly BlockNode[]): boolean =>
    blocks.some(b => b.t === 'heading' || (b.t === 'quote' && hasHeadingNode(b.c)));
const headingInBox = (box: HTMLElement) => box.querySelector('.rc-h1, .rc-h2, .rc-h3');

/** Every typed input the owner named, and then some. */
const INPUTS = [
    'H', 'h', 'H ', 'h ', 'H hello', 'h hello', 'H1 ', 'h1 ', 'H2 x', 'Heading ', 'heading hello', 'HH ', 'H#',
    '#', '# ', '# hello', '## ', '## hello', '### ', '### hello', '#### deep', '#hello', '# # x', ' # x', '\\# x',
    '-# small', '> # q', '- # item', '1. # item', 'Title', '===', '---',
];

describe('nothing typed makes a heading', () => {
    for (const input of INPUTS) {
        it(`"${input}" at a line start, then space / Shift+Enter / Enter`, () => {
            const { ref, box, value } = mountBox();
            typeInto(box(), input);
            typeInto(box(), ' ');
            expect(headingInBox(box()), 'after typing').toBeNull();
            act(() => ref.current!.newline());                        // Shift+Enter
            typeInto(box(), 'next line');
            act(() => { ref.current!.enterShortcut(); });              // Enter (only ``` claims it)
            act(() => { ref.current!.commitPending(); });              // what a send runs first
            expect(headingInBox(box())).toBeNull();
            expect(hasHeadingNode(parseMessage(value())), JSON.stringify(value())).toBe(false);
        });
    }

    it('mid-line and on a second line, every input', () => {
        for (const input of INPUTS) {
            const { box, ref, value } = mountBox('first line');
            typeInto(box(), ` ${input} `);
            act(() => ref.current!.newline());
            typeInto(box(), `${input} and more`);
            expect(headingInBox(box()), input).toBeNull();
            expect(hasHeadingNode(parseMessage(value())), `${input}: ${JSON.stringify(value())}`).toBe(false);
            act(() => root.render(React.createElement('div')));
        }
    });

    it('inside a list item and a quote', () => {
        for (const prefix of ['- ', '1. ', '> ']) {
            const { box, value } = mountBox();
            typeInto(box(), `${prefix}# not a heading`);
            expect(headingInBox(box()), prefix).toBeNull();
            expect(hasHeadingNode(parseMessage(value())), `${prefix}: ${value()}`).toBe(false);
            act(() => root.render(React.createElement('div')));
        }
    });

    it('positive control: the heading BUTTON does make one (so the checks above can see a heading)', () => {
        const { ref, box, value } = mountBox();
        typeInto(box(), 'Title');
        act(() => ref.current!.applyFormat('heading'));
        expect(headingInBox(box())).not.toBeNull();
        expect(hasHeadingNode(parseMessage(value()))).toBe(true);
    });
});

describe('no keyboard shortcut makes a heading', () => {
    const KEYS = [...'abcdefghijklmnopqrstuvwxyz0123456789#'];
    const MODS = [
        {}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
        { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true, altKey: true },
        { ctrlKey: true, shiftKey: true, altKey: true }, { metaKey: true, altKey: true },
    ];

    it('the shortcut table never returns "heading" for any key / modifier / platform', () => {
        for (const k of KEYS) for (const m of MODS) for (const isMac of [false, true]) {
            const ev = { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m, code: /[a-z]/.test(k) ? `Key${k.toUpperCase()}` : undefined };
            expect(shortcutAction(ev, isMac), `${k} ${JSON.stringify(m)} mac=${isMac}`).not.toBe('heading');
        }
        // H in particular maps to nothing at all.
        for (const m of MODS) expect(shortcutAction({ key: 'h', code: 'KeyH', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m }, false)).toBeNull();
    });

    it('key presses on the box itself (h / H / # with any modifiers) never make one', () => {
        const { box, value } = mountBox('Title');
        for (const k of ['h', 'H', '#', '1', '2', '3']) for (const m of MODS) {
            act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...m })); });
        }
        // and the browser's own block-format input types are ignored
        for (const t of ['formatSetBlockTextDirection', 'formatHeading', 'formatBlock', 'insertHorizontalRule']) fire(box(), t, 'h1');
        expect(headingInBox(box())).toBeNull();
        expect(hasHeadingNode(parseMessage(value()))).toBe(false);
    });
});

describe('the heading button', () => {
    function mountBar(active: import('./RichComposer').ActiveFormats | null = null) {
        const onAction = vi.fn();
        act(() => root.render(React.createElement(FormatToolbar, {
            open: true, onOpenChange: () => {}, onAction, active, font: null, onFontChange: () => {},
            focusComposer: () => {}, isMac: false,
        })));
        return { onAction, btn: () => host.querySelector('[data-action="heading"]') as HTMLButtonElement };
    }

    it('shows a heading icon (H1 / H2 / H3 for the level at the caret), never a bare letter', () => {
        const { btn } = mountBar();
        expect(btn().textContent).toBe('');
        expect(btn().querySelector('svg.lucide-heading-1')).not.toBeNull();
        mountBar({ marks: 0, block: 'h2', quote: false });
        expect(btn().querySelector('svg.lucide-heading-2')).not.toBeNull();
        mountBar({ marks: 0, block: 'h3', quote: false });
        expect(btn().querySelector('svg.lucide-heading-3')).not.toBeNull();
    });

    it('accessible name "Heading", tooltip "Heading", no keyboard shortcut', async () => {
        const { btn, onAction } = mountBar();
        expect(btn().getAttribute('aria-label')).toBe('Heading');
        expect(btn().hasAttribute('aria-keyshortcuts')).toBe(false);
        act(() => btn().focus());
        await act(async () => { await new Promise(r => setTimeout(r, 60)); });
        const tips = [...document.body.querySelectorAll('[role="tooltip"]')].map(t => t.textContent);
        expect(tips).toContain('Heading');
        act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
        expect(onAction).toHaveBeenCalledWith('heading', false);
    });
});
