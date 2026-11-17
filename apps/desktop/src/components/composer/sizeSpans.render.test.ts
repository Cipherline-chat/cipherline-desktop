// @vitest-environment jsdom
/**
 * Size spans in a real DOM: the feed renders `[small]` / `[large]` at an
 * absolute 15px x scale (also inside a message with the old per-message
 * field), the box applies a size to a selection or to what is typed next and
 * previews it, and the picker shows the size at the caret or "Mixed".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageSize } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { RichComposer } = await import('./RichComposer');
const { FormatToolbar } = await import('./FormatToolbar');
const { renderFormatted } = await import('../formatting/FormattedText');
const { spanFontSize } = await import('../../utils/formatting/messageSize');
const { __resetEscapeStackForTests } = await import('../../utils/escapeStack');
type Handle = import('./RichComposer').RichComposerHandle;
type Formats = import('./RichComposer').ActiveFormats;

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

const frame = () => act(async () => { await new Promise(res => requestAnimationFrame(() => res(null))); });

describe('the feed renders size spans', () => {
    const render = (text: string, bodyScale?: number) => act(() => root.render(React.createElement('div', {
        'data-body': '',
        style: { fontSize: `${15 * (bodyScale ?? 1)}px`, ...(bodyScale ? { ['--cl-msg-scale' as string]: String(bodyScale) } : {}) },
    }, renderFormatted(text, { renderLeaf: (t: string) => t }))));

    it('each span is absolute: 1em x scale / the message scale, and re-sets the scale for code inside', () => {
        render('a [large]big[/large] b [small]tiny[/small]');
        const spans = [...host.querySelectorAll('.cl-fmt-size')] as HTMLElement[];
        expect(spans.map(s => s.dataset.size)).toEqual(['large', 'small']);
        // (jsdom's CSS parser drops a var() inside font-size, so the formula is checked on
        // spanFontSize and the computed px in Chromium: harness/composer-span-size-shots.mjs)
        expect(spanFontSize('large')).toBe('calc(1em * 1.5 / var(--cl-msg-scale, 1))');
        expect(spanFontSize('small')).toBe('calc(1em * 0.875 / var(--cl-msg-scale, 1))');
        expect((spans[0].firstElementChild as HTMLElement).style.getPropertyValue('--cl-msg-scale')).toBe('1.5');
        expect(host.textContent).toBe('a big b tiny');
    });

    it('headings, code and spoilers inside a span stay inside it', () => {
        render('# [large]Title[/large]\n[large]`x` ||y||[/large]');
        expect(host.querySelector('[role="heading"] .cl-fmt-size, h1 .cl-fmt-size, .cl-fmt-h .cl-fmt-size')).not.toBeNull();
        expect(host.querySelector('.cl-fmt-size code.cl-fmt-code')?.textContent).toBe('x');
        expect(host.querySelector('.cl-fmt-size .cl-fmt-spoiler')).not.toBeNull();
    });

    it('an old message with only the per-message field renders exactly as before (no span)', () => {
        render('plain old large message', 1.5);
        expect(host.querySelector('.cl-fmt-size')).toBeNull();
        const body = host.querySelector('[data-body]') as HTMLElement;
        expect(body.style.fontSize).toBe('22.5px');
        expect(body.style.getPropertyValue('--cl-msg-scale')).toBe('1.5');
    });
});

function mountBox(initial = '') {
    const ref = React.createRef<Handle>();
    let value = initial;
    const onFormats = vi.fn();
    function H() {
        const [v, setV] = React.useState(initial);
        value = v;
        return React.createElement(RichComposer, { ref, value: v, onChange: (nv: string) => setV(nv), onFormats });
    }
    act(() => root.render(React.createElement(H)));
    const box = () => host.querySelector('[data-rich-composer]') as HTMLDivElement;
    return { ref, box, value: () => value, onFormats };
}
const typeInto = (box: HTMLElement, text: string) => {
    for (const ch of text) act(() => { box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true })); });
};

describe('the box: size on a selection, or on what is typed next', () => {
    it('a selection becomes Large / Small; the box previews it; the text carries the span', () => {
        const { ref, box, value } = mountBox('one two three');
        act(() => { ref.current!.focus(); ref.current!.setSelection(0, 3); ref.current!.applySize('large'); });
        act(() => { ref.current!.setSelection(8, 13); ref.current!.applySize('small'); });
        expect(box().querySelector('.rc-lg')?.textContent).toBe('one');
        expect(box().querySelector('.rc-sm')?.textContent).toBe('three');
        expect(value()).toBe('[large]one[/large] two [small]three[/small]');
        // back to Normal
        act(() => { ref.current!.setSelection(0, 3); ref.current!.applySize(null); });
        expect(box().querySelector('.rc-lg')).toBeNull();
        expect(value()).toBe('one two [small]three[/small]');
    });

    it('nothing selected: the size applies to what you type next, and other styles stack on it', () => {
        const { ref, box, value } = mountBox('a ');
        act(() => { ref.current!.placeCaretAtEnd(); ref.current!.applySize('large'); ref.current!.applyFormat('bold'); });
        typeInto(box(), 'BIG');
        expect(box().querySelector('.rc-lg strong')?.textContent).toBe('BIG');
        expect(value()).toBe('a [large]**BIG**[/large]');
    });

    it('an armed size survives a typed shortcut at the line start (`**x** ` and `- `)', () => {
        const a = mountBox();
        act(() => { a.ref.current!.placeCaretAtEnd(); a.ref.current!.applySize('large'); });
        typeInto(a.box(), '**3 PM** with more');
        expect(a.value()).toBe('[large]**3 PM** with more[/large]');
        act(() => root.render(React.createElement('div')));
        const b = mountBox();
        act(() => { b.ref.current!.placeCaretAtEnd(); b.ref.current!.applySize('small'); });
        typeInto(b.box(), '- and snacks');
        expect(b.value()).toBe('- [small]and snacks[/small]');
    });

    it('the picker state: the size at the caret, or "mixed" across a mixed selection', async () => {
        const { ref, onFormats } = mountBox('[large]big[/large] normal');
        act(() => { ref.current!.focus(); ref.current!.setSelection(1, 1); });
        await frame();
        expect(onFormats.mock.calls.at(-1)?.[0].size).toBe('large');
        act(() => ref.current!.setSelection(0, 10));
        await frame();
        expect(onFormats.mock.calls.at(-1)?.[0].size).toBe('mixed');
        act(() => ref.current!.setSelection(6, 10));
        await frame();
        expect(onFormats.mock.calls.at(-1)?.[0].size).toBeNull();
    });

    it('nothing sticks: an armed size is gone once the box is cleared (after a send)', () => {
        let setV: (v: string) => void = () => {};
        const ref = React.createRef<Handle>();
        let value = '';
        function H() {
            const [v, sv] = React.useState('');
            setV = sv; value = v;
            return React.createElement(RichComposer, { ref, value: v, onChange: (nv: string) => sv(nv) });
        }
        act(() => root.render(React.createElement(H)));
        const box = host.querySelector('[data-rich-composer]') as HTMLDivElement;
        act(() => { ref.current!.placeCaretAtEnd(); ref.current!.applySize('large'); });
        typeInto(box, 'sent');
        expect(value).toBe('[large]sent[/large]');
        act(() => setV(''));
        typeInto(box, 'next');
        expect(value).toBe('next');
        expect(box.querySelector('.rc-lg')).toBeNull();
    });
});

describe('the picker', () => {
    const mountBar = (size: MessageSize | null | 'mixed', active: Formats | null = null) => {
        const onSizeChange = vi.fn();
        act(() => root.render(React.createElement(FormatToolbar, {
            open: true, onOpenChange: () => {}, onAction: () => {}, active, font: null, onFontChange: () => {},
            size, onSizeChange, focusComposer: () => {}, isMac: false,
        })));
        return { onSizeChange, btn: () => host.querySelector('[data-size-button]') as HTMLButtonElement };
    };

    it('shows "Mixed" for a mixed selection, with no option checked', () => {
        const { btn } = mountBar('mixed');
        expect(btn().textContent).toContain('Mixed');
        expect(btn().getAttribute('aria-label')).toBe('Text size: Mixed');
        act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
        const checked = [...host.querySelectorAll('[role="menuitemradio"]')].map(e => e.getAttribute('aria-checked'));
        expect(checked).toEqual(['false', 'false', 'false']);
    });

    it('shows the size at the caret and reports a pick', () => {
        const { btn, onSizeChange } = mountBar('large');
        expect(btn().textContent).toContain('Large');
        act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
        act(() => { (host.querySelector('[data-size-id="small"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
        expect(onSizeChange).toHaveBeenCalledWith('small');
    });
});
