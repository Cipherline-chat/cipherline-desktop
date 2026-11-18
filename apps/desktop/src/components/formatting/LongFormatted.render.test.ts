// @vitest-environment jsdom
/**
 * A long FORMATTED message in the real LongMessageBody, wired the way ChatPane
 * wires it (renderText = renderFormatted, renderPreview = renderFormattedPreview):
 *  - a 60-line code paste collapses (line rule), its preview is a clipped code
 *    block (no copy button, no stray backticks), never the whole thing;
 *  - Expand shows the whole block with highlighting and the copy button;
 *  - the full-screen reader renders the formatting and Copy text copies the RAW text;
 *  - a preview cut inside a spoiler still hides it.
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
Element.prototype.scrollIntoView = function () {};

const writeToClipboard = vi.fn(async (_t: string) => {});
vi.mock('../../utils/clipboard', () => ({ writeToClipboard: (t: string) => writeToClipboard(t) }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));

const { LongMessageBody } = await import('../LongMessage');
const { renderFormatted, renderFormattedPreview } = await import('./FormattedText');
const { isLongMessage, longMessageExpansion } = await import('../../utils/longMessage');

// 120 lines (~3,500 characters): long by CHARACTERS since 2026-11-18 (the 30-line rule is gone; threshold 3,000).
const CODE_LINES = 120;
const CODE = '```ts\n' + Array.from({ length: CODE_LINES }, (_, i) => `const v${i} = ${i}; // line ${i}`).join('\n') + '\n```';
const MSG = `the whole module, **as asked**:\n${CODE}`;

const opts = {
    renderLeaf: (t: string) => React.createElement('span', { 'data-leaf': '' }, t),
    codeText: (s: string) => s,
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    longMessageExpansion.clear();
    writeToClipboard.mockClear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const mount = (text: string) => act(() => root.render(React.createElement(LongMessageBody, {
    id: 'm1', text, senderName: 'Dawson', timestamp: 'Today',
    renderText: (t: string) => renderFormatted(t, opts),
    renderPreview: (t: string) => renderFormattedPreview(t, opts),
    renderDeps: [],
})));
const settle = async (ms = 80) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
const button = (label: string, root: ParentNode = document) => [...root.querySelectorAll('button')].find(b => b.textContent?.includes(label))!;

describe('a long code message', () => {
    it('collapses (over 3,000 characters) and previews the first lines of the block, clipped', () => {
        expect(MSG.length).toBeGreaterThan(3000);
        expect(isLongMessage(MSG)).toBe(true);
        mount(MSG);
        const lm = host.querySelector('[data-long-message]')!;
        expect(lm.getAttribute('data-state')).toBe('collapsed');
        expect(lm.querySelector('strong')?.textContent).toBe('as asked');
        const pre = lm.querySelector('.cl-fmt-pre')!;
        expect(pre.hasAttribute('data-clipped')).toBe(true);
        expect(pre.querySelector('.cl-fmt-pre-copy')).toBeNull();
        const lines = pre.querySelector('code')!.textContent!.split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(3);
        expect(lines.length).toBeLessThan(12);
        expect(lm.textContent).not.toContain('```');
        expect(lm.querySelector('.lm-meta')?.textContent).toMatch(/Long message · [\d,]+ characters/);
    });

    it('Expand shows the whole block, highlighted, with its copy button', async () => {
        mount(MSG);
        click(button('Expand', host));
        const pre = host.querySelector('.cl-fmt-pre')!;
        expect(pre.hasAttribute('data-clipped')).toBe(false);
        expect(pre.querySelector('code')!.textContent!.split('\n')).toHaveLength(CODE_LINES);
        expect(pre.querySelector('.cl-hl-kw')?.textContent).toBe('const');
        click(pre.querySelector('.cl-fmt-pre-copy')!);
        await settle();
        expect(writeToClipboard).toHaveBeenCalledWith(CODE.slice(6, -4));
    });

    it('the full-screen reader renders the formatting and copies the RAW text', async () => {
        mount(MSG);
        click(button('Open full screen', host));
        await settle(120);
        const reader = document.querySelector('[role="dialog"] .lm-reader-text')!;
        expect(reader.querySelector('strong')?.textContent).toBe('as asked');
        expect(reader.querySelector('.cl-fmt-pre code')!.textContent!.split('\n')).toHaveLength(CODE_LINES);
        click(button('Copy text', document.querySelector('[role="dialog"]')!));
        await settle();
        expect(writeToClipboard).toHaveBeenCalledWith(MSG);
    });
});

describe('a long message with a spoiler at the cut', () => {
    it('the preview keeps the spoiler hidden', () => {
        const text = 'Ending below.\n||' + 'the butler did it. '.repeat(400) + '||';
        mount(text);
        const lm = host.querySelector('[data-long-message]')!;
        expect(lm.getAttribute('data-state')).toBe('collapsed');
        const sp = lm.querySelector('.cl-fmt-spoiler')!;
        expect(sp.querySelector('.cl-fmt-spoiler-inner')?.hasAttribute('inert')).toBe(true);
        // No text outside the spoiler carries the secret or a literal `||`.
        const outside = [...lm.querySelectorAll('.lm-text [data-leaf]')].filter(e => !e.closest('.cl-fmt-spoiler')).map(e => e.textContent).join('');
        expect(outside).not.toContain('butler');
        expect(outside).not.toContain('||');
    });
});
