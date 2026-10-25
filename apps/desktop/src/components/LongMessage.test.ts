// @vitest-environment jsdom
/**
 * Long-message collapse, mounted for real (LongMessageBody + the full-screen
 * reader), plus the ChatPane wiring. What must hold:
 *   - collapsed: only the ~700-character preview is rendered (the renderer is
 *     never handed the full text), with the "Long message · N characters ·
 *     ~M min read" footer and aria-expanded=false;
 *   - Expand / Collapse toggles the whole text, aria-expanded follows, and the
 *     state is remembered per message id for the session;
 *   - Open full screen -> a dialog with the whole message + sender + time; the
 *     full text is built AFTER the dialog paints, not synchronously on click;
 *     Escape and Close dismiss it; Copy text writes the display text;
 *   - none of the reader's or footer's events reach the message row (a click
 *     there would toggle save);
 *   - an edit that crosses the threshold re-evaluates (long -> short -> long).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = function () {};

const writeToClipboard = vi.fn(async (_t: string) => {});
vi.mock('../utils/clipboard', () => ({ writeToClipboard: (t: string) => writeToClipboard(t) }));
const toastPush = vi.fn();
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: toastPush }) }));

const { LongMessageBody } = await import('./LongMessage');
const { isLongMessage, longMessageExpansion } = await import('../utils/longMessage');

const here = dirname(fileURLToPath(import.meta.url));

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const words = (n: number, tag = '') => {
    let s = '';
    for (let i = 0; s.length < n; i++) s += WORDS[i % WORDS.length] + ' ';
    return `${tag}${s.slice(0, n)}`;
};
const TAIL = 'ZZ-THE-VERY-LAST-WORDS';
const LONG = words(12_000) + TAIL;

let root: Root;
let host: HTMLDivElement;
const rowClick = vi.fn();
const rowFocus = vi.fn();

const fullRenderSawDialog: boolean[] = [];
const renderText = vi.fn((t: string) => {
    if (t === LONG) fullRenderSawDialog.push(!!document.querySelector('[role="dialog"] .lm-reader-text'));
    return t;
});

function Row(props: { id?: string; text: string }) {
    return React.createElement(
        'div',
        { id: 'row', onClick: rowClick, onFocus: rowFocus },
        isLongMessage(props.text)
            ? React.createElement(LongMessageBody, {
                id: props.id ?? 'm1', text: props.text, renderText, renderDeps: [], senderName: 'Mira', timestamp: 'Today at 9:41 AM',
            })
            : props.text,
    );
}

const mount = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const btn = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => (b.textContent ?? '').includes(label));
const settle = async (ms = 150) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const click = async (el: Element | undefined | null) => {
    expect(el).toBeTruthy();
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
};

beforeEach(() => {
    longMessageExpansion.clear();
    fullRenderSawDialog.length = 0;
    renderText.mockClear(); rowClick.mockClear(); rowFocus.mockClear();
    writeToClipboard.mockClear(); toastPush.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
});

describe('collapsed', () => {
    it('renders only the preview, never the full text, with the footer', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        const body = q('[data-long-message]')!;
        expect(body.getAttribute('data-state')).toBe('collapsed');
        expect(body.textContent).not.toContain(TAIL);
        expect(renderText).toHaveBeenCalledTimes(1);
        expect(renderText.mock.calls[0][0].length).toBeLessThanOrEqual(700);
        expect(renderText.mock.calls[0][0].length).toBeGreaterThan(400);
        expect(body.textContent).toContain(`Long message · ${LONG.length.toLocaleString('en-US')} characters · ~`);
        expect(body.textContent).toMatch(/~\d+ min read/);
        const expand = btn('Expand')!;
        expect(expand.getAttribute('aria-expanded')).toBe('false');
        expect(expand.getAttribute('aria-controls')).toBeTruthy();
        expect(q(`[id="${expand.getAttribute('aria-controls')}"]`)).toBeTruthy();
        expect(btn('Open full screen')!.getAttribute('aria-haspopup')).toBe('dialog');
    });

    it('a message at exactly the threshold is not collapsed at all', async () => {
        await mount(React.createElement(Row, { text: 'x'.repeat(5000) }));
        expect(q('[data-long-message]')).toBeNull();
        await mount(React.createElement(Row, { text: 'x'.repeat(5001) }));
        expect(q('[data-long-message]')).toBeTruthy();
    });
});

describe('expand / collapse', () => {
    it('Expand shows the whole text; Collapse returns to the preview; aria-expanded follows', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Expand'));
        const body = q('[data-long-message]')!;
        expect(body.getAttribute('data-state')).toBe('expanded');
        expect(body.textContent).toContain(TAIL);
        expect(renderText.mock.calls.some(c => c[0] === LONG)).toBe(true);
        const toggle = btn('Collapse')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(btn('Expand')).toBeUndefined();

        await click(toggle);
        expect(q('[data-long-message]')!.getAttribute('data-state')).toBe('collapsed');
        expect(q('[data-long-message]')!.textContent).not.toContain(TAIL);
        expect(btn('Expand')!.getAttribute('aria-expanded')).toBe('false');
    });

    it('is remembered per message for the session (remount keeps it; another message is unaffected)', async () => {
        await mount(React.createElement(Row, { id: 'm1', text: LONG }));
        await click(btn('Expand'));
        await act(async () => { root.unmount(); });
        root = createRoot(host);

        await mount(React.createElement(Row, { id: 'm1', text: LONG }));
        expect(q('[data-long-message]')!.getAttribute('data-state')).toBe('expanded');

        await mount(React.createElement(Row, { id: 'm2', text: LONG }));
        // same component instance, different id: it keeps ITS state, so remount for a fresh row
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(React.createElement(Row, { id: 'm2', text: LONG }));
        expect(q('[data-long-message]')!.getAttribute('data-state')).toBe('collapsed');
    });

    it('does not rebuild the rendered tree when only the row re-renders (hover)', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Expand'));
        const calls = renderText.mock.calls.length;
        await mount(React.createElement(Row, { text: LONG })); // same text, same deps
        expect(renderText.mock.calls.length).toBe(calls);
    });

    it('footer clicks do not reach the row (they would toggle save)', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Expand'));
        await click(btn('Open full screen'));
        expect(rowClick).not.toHaveBeenCalled();
    });
});

describe('full-screen reader', () => {
    it('opens a labelled dialog with sender, time, size and the whole message, built after first paint', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Open full screen'));
        const dialog = q('[role="dialog"]')!;
        expect(dialog).toBeTruthy();
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-label')).toBe('Message from Mira');
        expect(dialog.textContent).toContain('Mira');
        expect(dialog.textContent).toContain('Today at 9:41 AM');
        expect(dialog.textContent).toContain(`${LONG.length.toLocaleString('en-US')} characters`);

        await settle();
        // the heavy text was built only once the dialog was already in the DOM (first paint came first)
        expect(fullRenderSawDialog).toEqual([true]);
        expect(q('.lm-reader-scroll')!.getAttribute('aria-busy')).toBe('false');
        expect(q('.lm-reader-text')!.textContent).toContain(TAIL);
        expect(renderText.mock.calls.filter(c => c[0] === LONG).length).toBe(1);
        // its own scroll container, focusable for keyboard scrolling
        expect(q('.lm-reader-scroll')!.getAttribute('tabindex')).toBe('0');
    });

    it('Escape closes it', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Open full screen'));
        await settle();
        expect(q('[role="dialog"]')).toBeTruthy();
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        await settle(400); // ClModal's exit transition
        expect(q('[role="dialog"]')).toBeNull();
    });

    it('the header X and the Close button close it', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        for (const label of ['Close full message', 'Close']) {
            await click(btn('Open full screen'));
            await settle();
            const target = label === 'Close'
                ? Array.from(document.querySelectorAll<HTMLButtonElement>('.dlg-foot button')).find(b => b.textContent === 'Close')
                : q('button[aria-label="Close full message"]');
            await click(target);
            await settle(400);
            expect(q('[role="dialog"]')).toBeNull();
        }
    });

    it('Copy text writes the message as displayed (mention tokens resolved) and confirms', async () => {
        const withMention = `hello <@u:abc-123:dawson> ${words(6000)}`;
        await mount(React.createElement(Row, { text: withMention }));
        await click(btn('Open full screen'));
        await settle();
        await click(btn('Copy text'));
        expect(writeToClipboard).toHaveBeenCalledTimes(1);
        const copied = writeToClipboard.mock.calls[0][0];
        expect(copied.startsWith('hello @dawson ')).toBe(true);
        expect(copied.includes('<@u:')).toBe(false);
        expect(copied.length).toBeGreaterThan(5000);
        await settle(20);
        expect(btn('Copied')).toBeTruthy();
    });

    it('a failed copy tells the user instead of failing silently', async () => {
        writeToClipboard.mockRejectedValueOnce(new Error('denied'));
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Open full screen'));
        await settle();
        await click(btn('Copy text'));
        await settle(20);
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    });

    it('nothing in the reader reaches the message row (click would toggle save, focus would pin the hover bar)', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        await click(btn('Open full screen'));
        await settle();
        await click(q('.lm-reader-text'));
        await click(q('.mcard'));
        await act(async () => { q('.lm-reader-scroll')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(rowClick).not.toHaveBeenCalled();
        expect(rowFocus).not.toHaveBeenCalled();
    });
});

describe('editing across the threshold', () => {
    it('long -> short drops the collapse; short -> long collapses again; long -> long keeps expansion', async () => {
        await mount(React.createElement(Row, { text: LONG }));
        expect(q('[data-long-message]')).toBeTruthy();

        await mount(React.createElement(Row, { text: words(4999) }));
        expect(q('[data-long-message]')).toBeNull();
        expect(q('#row')!.textContent!.length).toBe(4999);

        await mount(React.createElement(Row, { text: words(5001) }));
        expect(q('[data-long-message]')!.getAttribute('data-state')).toBe('collapsed');

        await click(btn('Expand'));
        await mount(React.createElement(Row, { text: LONG })); // edited again, still long
        expect(q('[data-long-message]')!.getAttribute('data-state')).toBe('expanded');
        expect(q('[data-long-message]')!.textContent).toContain(TAIL);
    });

    it('the collapsed preview follows an edit of the opening words', async () => {
        await mount(React.createElement(Row, { text: words(6000, 'FIRST-VERSION ') }));
        expect(q('[data-long-message]')!.textContent).toContain('FIRST-VERSION');
        await mount(React.createElement(Row, { text: words(6000, 'SECOND-VERSION ') }));
        expect(q('[data-long-message]')!.textContent).toContain('SECOND-VERSION');
        expect(q('[data-long-message]')!.textContent).not.toContain('FIRST-VERSION');
    });
});

describe('ChatPane / PinnedMessagesPanel wiring (source scan)', () => {
    const chat = readFileSync(join(here, 'ChatPane.tsx'), 'utf8');
    const pinned = readFileSync(join(here, 'PinnedMessagesPanel.tsx'), 'utf8');

    it('the message body goes through isLongMessage -> LongMessageBody with the shared renderer', () => {
        expect(chat).toContain("import { isLongMessage, previewSnippet } from '../utils/longMessage';");
        expect(chat).toContain('const longMsg = isLongMessage(rawText);');
        expect(chat).toMatch(/<LongMessageBody[\s\S]{0,200}text=\{rawText\}[\s\S]{0,120}renderText=\{renderBody\}/);
        // the very same renderer draws short messages
        expect(chat).toContain(': renderBody(rawText)}');
        // an emoji-only check never applies to a collapsed message
        expect(chat).toContain('const emojiOnly = !longMsg && isEmojiOnly(trimmed);');
    });

    it('the reply quote and the composer reply bar cap what they lay out', () => {
        // displayPreviewOf = displayTextOf on the first PREVIEW_SCAN_MAX chars (utils/messagePreviewText).
        expect(chat).toContain("previewSnippet(displayPreviewOf(replyTarget?.content) ?? '') || 'Original message'");
        expect(chat).toContain("const replyText   = previewSnippet(displayPreviewOf(replyTarget?.content) ?? '')");
    });

    it('the pinned list clamps the text it hands to the browser', () => {
        expect(pinned).toContain("previewSnippet(textContent ?? '')");
    });

    it('does not touch the cl/ primitives the website imports', () => {
        const lm = readFileSync(join(here, 'LongMessage.tsx'), 'utf8');
        // reuses ClModal / DialogFrame by import only
        expect(lm).toContain("import { ClModal } from './cl';");
    });
});
