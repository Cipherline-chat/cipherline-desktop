// @vitest-environment jsdom
/**
 * FormattedText in a real DOM: the element each syntax becomes, that sender
 * text never becomes markup, spoilers (hidden + inert until revealed), masked
 * links (real destination on hover, the shared leaving-Cipherline dialog before
 * opening, the label/destination mismatch line),
 * headings without a size change, and leaves handed back to the caller.
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

const openExternal = vi.fn(() => Promise.resolve());
const writeClipboard = vi.fn(() => Promise.resolve());
(window as unknown as { electronAPI: unknown }).electronAPI = { openExternal, writeClipboard };

const { renderFormatted } = await import('./FormattedText');
const { default: LeavingCipherlineHost } = await import('../LeavingCipherlineDialog');
const { setUserGestureProbeForTests } = await import('../../utils/externalLinks/shellOpen');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    openExternal.mockClear();
    writeClipboard.mockClear();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const leafCalls: { text: string; inLink: boolean }[] = [];
const opts = {
    renderLeaf: (text: string, _key: string, ctx: { inLink: boolean }) => {
        leafCalls.push({ text, inLink: ctx.inLink });
        return React.createElement('span', { 'data-leaf': ctx.inLink ? 'link' : 'text' }, text);
    },
    codeText: (s: string) => s.replace(/<@u:[^:>]+:([^>]+)>/g, '@$1'),
};

function mount(text: string, extra: Partial<typeof opts> & { truncated?: boolean } = {}) {
    leafCalls.length = 0;
    act(() => root.render(React.createElement('div', null, renderFormatted(text, { ...opts, ...extra }))));
    return host;
}
const settle = async (ms = 50) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const click = (el: Element) => act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('elements', () => {
    it('each syntax becomes its element', () => {
        const h = mount('**b** *i* __u__ ~~s~~ `c`');
        expect(h.querySelector('strong.cl-fmt-b')?.textContent).toBe('b');
        expect(h.querySelector('em.cl-fmt-i')?.textContent).toBe('i');
        expect(h.querySelector('u.cl-fmt-u')?.textContent).toBe('u');
        expect(h.querySelector('s.cl-fmt-s')?.textContent).toBe('s');
        expect(h.querySelector('code.cl-fmt-code')?.textContent).toBe('c');
    });

    it('lists, quotes and headings', () => {
        const h = mount('# Title\n> quoted\n- a\n  - a1\n3. three');
        const head = h.querySelector('[role="heading"]')!;
        expect(head.getAttribute('aria-level')).toBe('3');
        expect(head.className).toContain('cl-fmt-h1');
        expect(h.querySelector('blockquote.cl-fmt-quote')?.textContent).toBe('quoted');
        expect(h.querySelectorAll('ul.cl-fmt-list').length).toBe(2);
        expect(h.querySelector('ol.cl-fmt-list')?.getAttribute('start')).toBe('3');
    });

    it('headings never set a font size (structure, not size)', () => {
        const h = mount('# One\n## Two\n### Three');
        for (const el of h.querySelectorAll<HTMLElement>('[role="heading"]')) {
            expect(el.style.fontSize).toBe('');
        }
    });

    it('sender text never becomes markup', () => {
        const h = mount('**<img src=x onerror="alert(1)">** <script>alert(2)</script> `<b>x</b>`');
        expect(h.querySelector('img')).toBeNull();
        expect(h.querySelector('script')).toBeNull();
        expect(h.querySelector('code b')).toBeNull();
        expect(h.textContent).toContain('<img src=x onerror="alert(1)">');
        expect(h.innerHTML).not.toContain('<img');
    });

    it('a plain message is just the leaf (no wrapper), escapes resolved', () => {
        const h = mount('2 \\* 3 = 6');
        expect(h.querySelector('.cl-fmt')).toBeNull();
        expect(h.querySelector('[data-leaf]')?.textContent).toBe('2 * 3 = 6');
    });

    it('plain runs are handed to the caller (mentions / linkify live there); code is not', () => {
        mount('hi **<@u:1:dawson>** `<@u:2:sam>`');
        expect(leafCalls.map(c => c.text)).toEqual(['hi ', '<@u:1:dawson>', ' ']);
        expect(host.querySelector('code')?.textContent).toBe('@sam');
    });

    it('code block: highlighted spans and a copy button', async () => {
        const h = mount('```js\nconst a = 1;\n```');
        expect(h.querySelector('.cl-fmt-pre-lang')?.textContent).toBe('js');
        expect(h.querySelector('pre .cl-hl-kw')?.textContent).toBe('const');
        expect(h.querySelector('pre')?.textContent).toBe('const a = 1;');
        click(h.querySelector('.cl-fmt-pre-copy')!);
        await settle();
        expect(writeClipboard).toHaveBeenCalledWith('const a = 1;');
    });

    it('a truncated preview closes a dangling fence', () => {
        const h = mount('intro\n```js\nlet x', { truncated: true });
        expect(h.querySelector('pre')?.textContent).toBe('let x');
        const h2 = mount('intro\n```js\nlet x');
        expect(h2.querySelector('pre')).toBeNull();
    });
});

describe('spoilers', () => {
    it('hidden, inert and aria-hidden until clicked', () => {
        const h = mount('the end: ||he was a ghost||');
        const sp = h.querySelector('.cl-fmt-spoiler')!;
        expect(sp.getAttribute('role')).toBe('button');
        const inner = sp.querySelector('.cl-fmt-spoiler-inner')!;
        expect(inner.getAttribute('aria-hidden')).toBe('true');
        expect(inner.hasAttribute('inert')).toBe(true);
        click(sp);
        const shown = h.querySelector('.cl-fmt-spoiler')!;
        expect(shown.hasAttribute('data-revealed')).toBe(true);
        expect(shown.querySelector('.cl-fmt-spoiler-inner')).toBeNull();
        expect(shown.textContent).toBe('he was a ghost');
    });

    it('Enter reveals too', () => {
        const h = mount('||x||');
        key(h.querySelector('.cl-fmt-spoiler')!, 'Enter');
        expect(h.querySelector('.cl-fmt-spoiler')!.hasAttribute('data-revealed')).toBe(true);
    });
});

describe('masked links', () => {
    it('label leaves are text-only; the destination is on the element', () => {
        const h = mount('[read **this**](https://example.com/a)');
        const a = h.querySelector('.cl-fmt-link')!;
        expect(a.getAttribute('role')).toBe('link');
        expect(a.getAttribute('data-href')).toBe('https://example.com/a');
        expect(leafCalls.every(c => c.inLink)).toBe(true);
        expect(a.querySelector('strong')?.textContent).toBe('this');
    });

    // The shared "You're leaving Cipherline" dialog (components/LeavingCipherlineDialog
    // .tsx), mounted the way App.tsx mounts it; a click needs a live user gesture.
    let hostRoot: Root;
    let dialogHost: HTMLDivElement;
    beforeEach(() => {
        setUserGestureProbeForTests(() => true);
        dialogHost = document.createElement('div');
        document.body.appendChild(dialogHost);
        hostRoot = createRoot(dialogHost);
        act(() => hostRoot.render(React.createElement(LeavingCipherlineHost)));
    });
    afterEach(() => {
        act(() => hostRoot.unmount());
        setUserGestureProbeForTests(null);
    });

    it('clicking asks first, showing the full destination with the site in bold; Visit opens it', async () => {
        const h = mount('[docs](https://example.com/docs)');
        click(h.querySelector('.cl-fmt-link')!);
        await settle(150);
        const dlg = document.querySelector('[role="dialog"]')!;
        expect(dlg.textContent).toContain('You’re leaving Cipherline');
        expect(dlg.querySelector('[data-lcd-url]')?.textContent).toBe('https://example.com/docs');
        expect(dlg.querySelector('[data-lcd-site]')?.textContent).toBe('example.com');
        expect(dlg.querySelector('[data-lcd-mismatch]')).toBeNull();
        expect(openExternal).not.toHaveBeenCalled();
        const visit = [...dlg.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Visit site')!;
        click(visit);
        await settle();
        expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    });

    it('a label that names another site gets the mismatch line and no trust box', async () => {
        const h = mount('[https://paypal.com](https://paypa1.example/login)');
        click(h.querySelector('.cl-fmt-link')!);
        await settle(150);
        const dlg = document.querySelector('[role="dialog"]')!;
        expect(dlg.querySelector('[data-lcd-mismatch]')?.textContent).toBe('The link text says paypal.com but it goes to paypa1.example.');
        expect(dlg.querySelector('.lcd-trust')).toBeNull();
        expect([...dlg.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Visit anyway')).toBe(true);
    });

    it('a masked link to a TRUSTED site that claims another still asks', async () => {
        const h = mount('[paypal.com](https://cipherline.chat/x)');
        click(h.querySelector('.cl-fmt-link')!);
        await settle(150);
        expect(document.querySelector('[data-lcd-mismatch]')?.textContent).toBe('The link text says paypal.com but it goes to cipherline.chat.');
        expect(openExternal).not.toHaveBeenCalled();
    });

    it('a masked link to cipherline.chat whose text names no other site opens directly', async () => {
        const h = mount('[our changelog](https://cipherline.chat/changelog)');
        click(h.querySelector('.cl-fmt-link')!);
        await settle(150);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(openExternal).toHaveBeenCalledWith('https://cipherline.chat/changelog');
    });

    it('cancel opens nothing; focus starts on Cancel', async () => {
        const h = mount('[docs](https://example.com/docs)');
        click(h.querySelector('.cl-fmt-link')!);
        await settle(150);
        expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
        const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent?.trim() === 'Cancel')!;
        click(cancel);
        await settle(300);
        expect(openExternal).not.toHaveBeenCalled();
    });

    it('without a user gesture nothing opens and no dialog appears', async () => {
        setUserGestureProbeForTests(() => false);
        const h = mount('[docs](https://example.com/docs)');
        click(h.querySelector('.cl-fmt-link')!);
        await settle(150);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(openExternal).not.toHaveBeenCalled();
    });
});
