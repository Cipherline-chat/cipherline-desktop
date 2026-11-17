// @vitest-environment jsdom
/**
 * The WYSIWYG composer box (RichComposer.tsx) in a real DOM: typing through
 * `beforeinput` (the path Chromium / Electron take), toolbar formatting,
 * typed shortcuts and their undo, the Enter rules, loading an edit / a draft,
 * paste / copy as plain text, IME composition, ARIA, and a 4,000-character
 * typing budget. jsdom has no layout and no getTargetRanges, so deletions use
 * the editor's own fallback; the browser path is covered by the Chromium
 * screenshots (concepts/composer-wysiwyg).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { detectChannelTrigger } from '../../utils/channelRefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RichComposer } = await import('./RichComposer');
type Handle = import('./RichComposer').RichComposerHandle;
type Props = import('./RichComposer').RichComposerProps;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

interface Harness {
    handle: () => Handle;
    box: () => HTMLDivElement;
    value: () => string;
    plain: () => string;
    setValue: (v: string) => void;
    changes: { value: string; plain: string; caret: number }[];
    rerender: (p: Partial<Props>) => void;
}

function mount(initial = '', extra: Partial<Props> = {}): Harness {
    const ref = React.createRef<Handle>();
    const changes: Harness['changes'] = [];
    let current = initial;
    let setOuter: (v: string) => void = () => {};
    let extraProps = extra;
    let bump: () => void = () => {};
    function H() {
        const [v, setV] = React.useState(initial);
        const [, setN] = React.useState(0);
        setOuter = setV;
        bump = () => setN(n => n + 1);
        current = v;
        return React.createElement(RichComposer, {
            ref,
            value: v,
            placeholder: 'Message…',
            onChange: (nv, info) => { changes.push({ value: nv, ...info }); setV(nv); },
            ...extraProps,
        });
    }
    act(() => root.render(React.createElement(H)));
    return {
        handle: () => ref.current!,
        box: () => host.querySelector('[data-rich-composer]') as HTMLDivElement,
        value: () => current,
        plain: () => ref.current!.getPlain(),
        setValue: (v) => act(() => setOuter(v)),
        changes,
        rerender: (p) => { extraProps = { ...extraProps, ...p }; act(() => bump()); },
    };
}

function focusEnd(h: Harness) {
    act(() => { h.handle().placeCaretAtEnd(); });
}

function input(h: Harness, inputType: string, data: string | null = null) {
    act(() => {
        h.box().dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));
    });
}

function type(h: Harness, text: string) {
    for (const ch of text) input(h, 'insertText', ch);
}

function key(h: Harness, k: string, mods: KeyboardEventInit = {}) {
    act(() => { h.box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })); });
}

/** A paste / copy event carrying a fake clipboard (jsdom has no DataTransfer). */
function clip(h: Harness, kind: 'paste' | 'copy' | 'cut', data: Record<string, string> = {}) {
    const store: Record<string, string> = { ...data };
    const ev = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
        value: {
            files: [],
            getData: (t: string) => store[t] ?? '',
            setData: (t: string, v: string) => { store[t] = v; },
            types: Object.keys(store),
        },
    });
    act(() => { h.box().dispatchEvent(ev); });
    return store;
}

const text = (h: Harness) => h.box().textContent ?? '';

describe('typing', () => {
    it('characters go in through beforeinput and come out as the value', () => {
        const h = mount();
        focusEnd(h);
        type(h, 'hello');
        expect(text(h)).toBe('hello');
        expect(h.value()).toBe('hello');
        expect(h.changes.at(-1)).toMatchObject({ plain: 'hello', caret: 5 });
    });

    it('the browser\'s own edit is cancelled (the model renders the DOM)', () => {
        const h = mount();
        focusEnd(h);
        const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
        act(() => { h.box().dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
    });

    it('Backspace removes a character (fallback without target ranges)', () => {
        const h = mount();
        focusEnd(h);
        type(h, 'abc');
        input(h, 'deleteContentBackward');
        expect(text(h)).toBe('ab');
    });
});

describe('toolbar formatting shows as formatting — no markers in the box', () => {
    it('Bold on a selection makes it bold; the wire text has the markers', () => {
        const h = mount('make this bold');
        focusEnd(h);
        act(() => { h.handle().setSelection(10, 14); h.handle().applyFormat('bold'); });
        const strong = h.box().querySelector('strong');
        expect(strong?.textContent).toBe('bold');
        expect(text(h)).toBe('make this bold');
        expect(text(h)).not.toContain('*');
        expect(h.value()).toBe('make this **bold**');
    });

    it('a pending style does not survive deleting a selection (Ctrl+A, Backspace — selectionchange comes late)', () => {
        const h = mount('');
        focusEnd(h);
        act(() => h.handle().applyFormat('bold'));
        type(h, 'old');
        expect(h.value()).toBe('**old**');
        // Select all in the DOM only (no selectionchange reaches the box first), then delete.
        act(() => { const sel = document.getSelection()!; sel.selectAllChildren(h.box()); });
        input(h, 'deleteContentBackward');
        expect(h.value()).toBe('');
        type(h, 'new');
        expect(h.value()).toBe('new');
        expect(h.box().querySelector('strong')).toBeNull();
    });

    it('Italic and underline, together, nest in the box', () => {
        const h = mount('x');
        focusEnd(h);
        act(() => { h.handle().setSelection(0, 1); h.handle().applyFormat('italic'); h.handle().applyFormat('underline'); });
        expect(h.box().querySelector('u em, em u')?.textContent).toBe('x');
        expect(['__*x*__', '*__x__*']).toContain(h.value());
    });

    it('with nothing selected, Bold styles what you type next', () => {
        const h = mount('a ');
        focusEnd(h);
        act(() => h.handle().applyFormat('bold'));
        type(h, 'bc');
        expect(h.box().querySelector('strong')?.textContent).toBe('bc');
        expect(h.value()).toBe('a **bc**');
    });

    it('spoiler, inline code and a code block render with their own look', () => {
        const h = mount('||hidden|| `code`\n```js\nlet a = 1;\n```');
        expect(h.box().querySelector('.rc-spoiler')?.textContent).toBe('hidden');
        expect(h.box().querySelector('code.rc-icode')?.textContent).toBe('code');
        const block = h.box().querySelector('.rc-code');
        expect(block?.textContent).toBe('let a = 1;');
        expect(block?.getAttribute('data-lang')).toBe('js');
    });

    it('the H button makes a heading (shown as a heading style), sent as `# `', () => {
        const h = mount('Title');
        focusEnd(h);
        act(() => h.handle().applyFormat('heading'));
        expect(h.box().querySelector('.rc-h1')?.textContent).toBe('Title');
        expect(text(h)).toBe('Title');
        expect(h.value()).toBe('# Title');
    });

    it('lists show a real bullet / number (drawn by CSS), not a typed dash', () => {
        const h = mount('one\ntwo');
        focusEnd(h);
        act(() => { h.handle().setSelection(0, 7); h.handle().applyFormat('bullet'); });
        const items = h.box().querySelectorAll('.rc-ul');
        expect(items).toHaveLength(2);
        expect(text(h)).not.toContain('-');
        expect(h.value()).toBe('- one\n- two');
        act(() => { h.handle().setSelection(0, 7); h.handle().applyFormat('number'); });
        expect([...h.box().querySelectorAll('.rc-ol')].map(e => e.getAttribute('data-n'))).toEqual(['1.', '2.']);
    });

    it('the toolbar learns what is on at the caret (pressed buttons)', async () => {
        const onFormats = vi.fn();
        const h = mount('**b** x\n- item', { onFormats });
        const frame = () => act(async () => { await new Promise(res => requestAnimationFrame(() => res(null))); });
        act(() => { h.handle().focus(); h.handle().setSelection(1, 1); });
        await frame();
        expect(onFormats.mock.calls.at(-1)?.[0]).toMatchObject({ marks: 1, block: 'p' });
        act(() => h.handle().setSelection(4, 4));
        await frame();
        expect(onFormats.mock.calls.at(-1)?.[0]).toMatchObject({ marks: 0 });
        act(() => h.handle().setSelection(9, 9));
        await frame();
        expect(onFormats.mock.calls.at(-1)?.[0]).toMatchObject({ block: 'ul' });
    });
});

describe('typed shortcuts convert on space / punctuation, and undo brings the text back', () => {
    it('**bold** + space -> bold, markers gone; Ctrl+Z -> the literal text', () => {
        const h = mount();
        focusEnd(h);
        type(h, 'hi **bold** ');
        expect(h.box().querySelector('strong')?.textContent).toBe('bold');
        expect(text(h)).toBe('hi bold ');
        expect(h.value()).toBe('hi **bold** ');
        key(h, 'z', { ctrlKey: true });
        expect(h.box().querySelector('strong')).toBeNull();
        expect(text(h)).toBe('hi **bold** ');
        // ...which now sends literally (escaped), exactly as it shows
        expect(h.value()).toBe('hi \\*\\*bold\\*\\* ');
        // Ctrl+Y redoes the conversion
        key(h, 'y', { ctrlKey: true });
        expect(h.box().querySelector('strong')?.textContent).toBe('bold');
    });

    it('every inline marker: *i* _i_ __u__ ~~s~~ ||sp|| `c`', () => {
        const h = mount();
        focusEnd(h);
        type(h, '*a* _b_ __c__ ~~d~~ ||e|| `f`.');
        expect(text(h)).toBe('a b c d e f.');
        expect(h.box().querySelectorAll('em')).toHaveLength(2);
        expect(h.box().querySelector('u')?.textContent).toBe('c');
        expect(h.box().querySelector('s')?.textContent).toBe('d');
        expect(h.box().querySelector('.rc-spoiler')?.textContent).toBe('e');
        expect(h.box().querySelector('code')?.textContent).toBe('f');
    });

    it('`- ` makes a bullet with a dot, `1. ` a numbered item, `> ` a quote', () => {
        const h = mount();
        focusEnd(h);
        type(h, '- item');
        expect(h.box().querySelector('.rc-ul')?.textContent).toBe('item');
        expect(h.value()).toBe('- item');
        const n = mount();
        focusEnd(n);
        type(n, '1. first');
        expect(n.box().querySelector('.rc-ol')?.getAttribute('data-n')).toBe('1.');
        const q = mount();
        focusEnd(q);
        type(q, '> said');
        expect(q.box().querySelector('.rc-q')?.textContent).toBe('said');
    });

    it('`# ` stays `# ` (never a heading), and `#` is in the plain text the channel menu reads', () => {
        const h = mount();
        focusEnd(h);
        type(h, '# hello');
        expect(h.box().querySelector('.rc-h1, .rc-h2, .rc-h3')).toBeNull();
        expect(text(h)).toBe('# hello');
        expect(h.value()).toBe('\\# hello');
        const g = mount();
        focusEnd(g);
        type(g, 'see #gen');
        const last = g.changes.at(-1)!;
        expect(detectChannelTrigger(last.plain.slice(0, last.caret))).toEqual({ query: 'gen', start: 4 });
        // the trigger also fires inside bold text: the plain text has no markers in front of the `#`
        const bold = mount('**x **');
        act(() => { bold.handle().focus(); bold.handle().setSelection(2, 2); });
        type(bold, '#ge');
        const lb = bold.changes.at(-1)!;
        expect(detectChannelTrigger(lb.plain.slice(0, lb.caret))?.query).toBe('ge');
        // positive control: in the serialised text the bold markers would hide it
        expect(detectChannelTrigger('**x #ge'.slice(0, 7))?.query).toBe('ge');
        expect(detectChannelTrigger('**#ge')).toBeNull();
    });
});

describe('the Enter rules (Enter sends — ChatPane; Shift+Enter is newline())', () => {
    it('Shift+Enter continues a list; on an empty item it ends the list', () => {
        const h = mount('- a');
        focusEnd(h);
        act(() => h.handle().newline());
        expect(h.box().querySelectorAll('.rc-ul')).toHaveLength(2);
        act(() => h.handle().newline());
        expect(h.box().querySelectorAll('.rc-ul')).toHaveLength(1);
        expect(h.box().querySelectorAll('.rc-p')).toHaveLength(1);
        type(h, 'after');
        expect(h.value()).toBe('- a\nafter');
    });

    it('Shift+Enter elsewhere is a plain new line', () => {
        const h = mount('one');
        focusEnd(h);
        act(() => h.handle().newline());
        type(h, 'two');
        expect(h.value()).toBe('one\ntwo');
    });

    it('``` + Enter starts a code block instead of sending; plain Enter does not claim it', () => {
        const h = mount();
        focusEnd(h);
        type(h, '```js');
        let took = false;
        act(() => { took = h.handle().enterShortcut(); });
        expect(took).toBe(true);
        expect(h.box().querySelector('.rc-code')).not.toBeNull();
        type(h, 'x()');
        expect(h.value()).toBe('```js\nx()\n```');
        const p = mount('hello');
        focusEnd(p);
        act(() => { took = p.handle().enterShortcut(); });
        expect(took).toBe(false);
    });

    it('a shortcut typed right up to Enter is converted before sending (commitPending)', () => {
        const h = mount();
        focusEnd(h);
        type(h, 'so **bold**');
        let did = false;
        act(() => { did = h.handle().commitPending(); });
        expect(did).toBe(true);
        expect(h.value()).toBe('so **bold**');
        expect(h.box().querySelector('strong')?.textContent).toBe('bold');
    });

    it('Backspace at the start of a bullet takes the bullet off instead of joining lines', () => {
        const h = mount('- a');
        act(() => { h.handle().focus(); h.handle().setSelection(0, 0); });
        input(h, 'deleteContentBackward');
        expect(h.box().querySelector('.rc-ul')).toBeNull();
        expect(h.value()).toBe('a');
    });
});

describe('loading text: an edit, a draft, a clear after send', () => {
    it('an existing message loads formatted, with no markers in the box', () => {
        const h = mount();
        h.setValue('**Plan**\n- one\n- two\n> note');
        expect(h.box().querySelector('strong')?.textContent).toBe('Plan');
        expect(h.box().querySelectorAll('.rc-ul')).toHaveLength(2);
        expect(h.box().querySelector('.rc-q')?.textContent).toBe('note');
        expect(text(h)).not.toMatch(/[*>-]/);
        // and saving it unchanged sends the same text
        focusEnd(h);
        type(h, '!');
        expect(h.value()).toBe('**Plan**\n- one\n- two\n> note!');
    });

    it('a restored draft keeps its formatting and its empty bullet', () => {
        const h = mount('*draft* text\n- ');
        expect(h.box().querySelector('em')?.textContent).toBe('draft');
        expect(h.box().querySelectorAll('.rc-ul')).toHaveLength(1);
        expect(h.plain()).toBe('draft text\n');
    });

    it('clearing the value (after a send) empties the box, drops pending styles and its undo history', () => {
        const h = mount('x');
        focusEnd(h);
        act(() => h.handle().applyFormat('bold'));
        h.setValue('');
        expect(text(h)).toBe('');
        expect(h.box().hasAttribute('data-empty')).toBe(true);
        type(h, 'next');
        expect(h.box().querySelector('strong')).toBeNull();
        key(h, 'z', { ctrlKey: true });
        expect(text(h)).toBe('');
        key(h, 'z', { ctrlKey: true });
        expect(text(h)).toBe('');
    });
});

describe('clipboard: in and out as plain text', () => {
    it('paste reads text/plain only — HTML on the clipboard can never bring markup in', () => {
        const onPasted = vi.fn();
        const h = mount('', { onPasted });
        focusEnd(h);
        clip(h, 'paste', { 'text/html': '<b style="color:red" onclick="x()">evil</b><img src=x>', 'text/plain': 'evil' });
        expect(text(h)).toBe('evil');
        expect(h.box().querySelector('b, img, [style*="red"], [onclick]')).toBeNull();
        expect(onPasted).toHaveBeenCalledWith(0, 'evil', 'evil');
        const only = mount();
        focusEnd(only);
        clip(only, 'paste', { 'text/html': '<b>x</b>' });
        expect(text(only)).toBe('');
        expect(only.box().querySelector('b')).toBeNull();
    });

    it('pasted Markdown goes in literally (the prompt offers formatting); multi-line keeps its lines', () => {
        const h = mount();
        focusEnd(h);
        clip(h, 'paste', { 'text/plain': '# Title\n**bold**' });
        expect(text(h)).toBe('# Title**bold**');
        expect(h.plain()).toBe('# Title\n**bold**');
        expect(h.box().querySelector('strong, .rc-h1')).toBeNull();
        // "Format" on the prompt swaps the range for the formatted content
        act(() => h.handle().replaceWithWire(0, h.plain().length, '# Title\n**bold**'));
        expect(h.box().querySelector('.rc-h1')?.textContent).toBe('Title');
        expect(h.box().querySelector('strong')?.textContent).toBe('bold');
    });

    it('the code prompt puts exactly the pasted range into a code block', () => {
        const h = mount('see: ');
        focusEnd(h);
        clip(h, 'paste', { 'text/plain': 'const a = 1;\nconsole.log(a);' });
        act(() => h.handle().replaceWithCodeBlock(5, h.plain().length, 'js'));
        expect(h.box().querySelector('.rc-code')?.textContent).toBe('const a = 1;\nconsole.log(a);');
        expect(h.value()).toBe('see: \n```js\nconst a = 1;\nconsole.log(a);\n```');
    });

    it('the parent can take a paste over (files): nothing is typed', () => {
        const h = mount('', { onPaste: () => true });
        focusEnd(h);
        clip(h, 'paste', { 'text/plain': 'nope' });
        expect(text(h)).toBe('');
    });

    it('copy gives plain text: no markers, bullets as •', () => {
        const h = mount('**a**\n- one\n- two');
        act(() => { h.handle().focus(); h.handle().setSelection(0, h.plain().length); });
        const out = clip(h, 'copy');
        expect(out['text/plain']).toBe('a\n• one\n• two');
    });
});

describe('IME composition', () => {
    it('the browser composes in the DOM; the model catches up when it commits', () => {
        const h = mount('ab');
        focusEnd(h);
        act(() => { h.box().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        // A composition beforeinput is NOT cancelled.
        const ev = new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: 'に', bubbles: true, cancelable: true });
        act(() => { h.box().dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(false);
        // What the IME does to the DOM:
        const tn = h.box().querySelector('.rc-b')!.firstChild as Text;
        tn.data = 'abにほん';
        const sel = document.getSelection()!;
        sel.collapse(tn, 5);
        expect(h.value()).toBe('ab');
        act(() => { h.box().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'にほん' })); });
        expect(h.value()).toBe('abにほん');
        expect(h.plain()).toBe('abにほん');
        expect(text(h)).toBe('abにほん');
        expect(h.handle().getSelection()).toEqual({ start: 5, end: 5 });
        // and typing continues normally
        type(h, '!');
        expect(h.value()).toBe('abにほん!');
    });

    it('positive control: without the composition guard the beforeinput would have been cancelled', () => {
        const h = mount('ab');
        focusEnd(h);
        const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
        act(() => { h.box().dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
    });
});

describe('accessibility, font and size preview, limits', () => {
    it('is a multi-line textbox with a label and a placeholder, RTL-aware, spellchecked', () => {
        const h = mount();
        const box = h.box();
        expect(box.getAttribute('role')).toBe('textbox');
        expect(box.getAttribute('aria-multiline')).toBe('true');
        expect(box.getAttribute('aria-placeholder')).toBe('Message…');
        expect(box.getAttribute('aria-label')).toBe('Message…');
        expect(box.getAttribute('dir')).toBe('auto');
        expect(box.getAttribute('spellcheck')).toBe('true');
        expect(box.getAttribute('contenteditable')).toBe('true');
        expect(box.hasAttribute('data-chat-input')).toBe(true);
        expect(box.hasAttribute('data-empty')).toBe(true);
        const line = mount('שלום');
        expect(line.box().querySelector('.rc-b')?.getAttribute('dir')).toBe('auto');
    });

    it('previews the message font and size', () => {
        const h = mount('x', { fontFamily: 'Lora, serif', scale: 1.25, dataFont: 'serif', dataSize: 'large' });
        expect(h.box().style.fontFamily).toContain('Lora');
        expect(h.box().style.getPropertyValue('--cl-msg-scale')).toBe('1.25');
        expect(h.box().getAttribute('data-msg-size')).toBe('large');
        h.rerender({ scale: 1, dataSize: undefined, fontFamily: undefined, dataFont: undefined });
        expect(h.box().style.getPropertyValue('--cl-msg-scale')).toBe('');
        expect(h.box().hasAttribute('data-msg-size')).toBe(false);
    });

    it('disabled: not editable, input ignored', () => {
        const h = mount('x', { disabled: true });
        expect(h.box().getAttribute('contenteditable')).toBe('false');
        expect(h.box().getAttribute('aria-disabled')).toBe('true');
        input(h, 'insertText', 'y');
        expect(h.value()).toBe('x');
    });

    it('maxLength cuts typing and pasting at the cap', () => {
        const h = mount('', { maxLength: 5 });
        focusEnd(h);
        clip(h, 'paste', { 'text/plain': 'abcdefgh' });
        expect(h.value()).toBe('abcde');
        type(h, 'z');
        expect(h.value()).toBe('abcde');
    });
});

describe('performance', () => {
    it('typing stays instant in a 4,000-character formatted message', () => {
        let big = '';
        while (big.length < 4000) big += 'Some **bold** words and *italic* bits, a `code` span and plain text. ';
        big += '\n- a list item\n- another';
        const h = mount(big);
        focusEnd(h);
        type(h, 'warm');
        const t0 = performance.now();
        const N = 30;
        type(h, 'x'.repeat(N));
        const per = (performance.now() - t0) / N;
        expect(h.value().endsWith('warmxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe(true);
        // jsdom is far slower than Chromium; measured ~3-8 ms here under load.
        expect(per).toBeLessThan(40);
    });
});
