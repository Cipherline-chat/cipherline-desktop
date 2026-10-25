// @vitest-environment jsdom
/**
 * Right-click in the emoji picker: a My Emojis emoji offers "Remove from My
 * Emojis" (no confirmation, Undo toast, same service call as Settings); anything
 * else keeps the browser/app default. Runs against a stand-in for emoji-mart's
 * shadow DOM, with the real ContextMenu primitive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EmojiEntry } from '../utils/personalEmoji/library';

const push = vi.fn();
const lib = { remove: vi.fn(), restore: vi.fn() };
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push }) }));
vi.mock('../utils/personalEmoji/service', () => ({ personalEmojis: () => lib }));

import { resolveMyEmojiEntry, useMyEmojiContextMenu } from './useMyEmojiContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: string, name: string, order = 0): EmojiEntry =>
    ({ id, name, mime: 'image/png', animated: false, size: 10, order, at: 1, addedAt: 1 });
const ENTRIES = [entry('p_a', 'pepe', 0), entry('p_b', 'shrug', 1)];
const URLS = { p_a: 'blob:a', p_b: 'blob:b' };

const grid = (cat: string, name: string, src = 'blob:a') =>
    `<div class="category" data-id="${cat}"><button title="${name}"><img src="${src}"></button></div>`;

let root: Root;
let host: HTMLDivElement;
let shadow: ShadowRoot;

const Harness: React.FC<{ entries: EmojiEntry[] }> = ({ entries }) => {
    const ref = React.useRef<HTMLDivElement>(null);
    const { menu } = useMyEmojiContextMenu(ref, entries, URLS);
    return React.createElement('div', { ref }, React.createElement('em-emoji-picker'), menu);
};

const mount = (html: string) => {
    act(() => root.render(React.createElement(Harness, { entries: ENTRIES })));
    shadow = host.querySelector('em-emoji-picker')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = html;
    act(() => { vi.advanceTimersByTime(40); });
};
const rightClick = (selector: string) => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 30, clientY: 40 });
    act(() => { shadow.querySelector(selector)!.dispatchEvent(ev); });
    return ev;
};
const menuRows = () => Array.from(document.body.querySelectorAll('.ctxm [role="menuitem"]')) as HTMLElement[];

beforeEach(() => {
    vi.useFakeTimers();
    push.mockReset();
    lib.remove.mockReset();
    lib.restore.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

describe('resolveMyEmojiEntry', () => {
    const btn = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.querySelector('button')!; };
    it('finds a My Emojis grid button by its title', () => {
        expect(resolveMyEmojiEntry(btn(grid('my_emojis', 'shrug')), ENTRIES, URLS)?.id).toBe('p_b');
    });
    it('ignores server emojis, unicode and unknown names, even when the name matches a personal one', () => {
        expect(resolveMyEmojiEntry(btn(grid('server_emojis', 'pepe')), ENTRIES, URLS)).toBeNull();
        expect(resolveMyEmojiEntry(btn(grid('people', 'grinning')), ENTRIES, URLS)).toBeNull();
        expect(resolveMyEmojiEntry(btn(grid('my_emojis', 'nope')), ENTRIES, URLS)).toBeNull();
        expect(resolveMyEmojiEntry(btn(grid('my_emojis', 'cl-empty-mine')), ENTRIES, URLS)).toBeNull();
        expect(resolveMyEmojiEntry(null, ENTRIES, URLS)).toBeNull();
    });
    it('in search results (no category) matches by the resolved blob URL, not the name', () => {
        expect(resolveMyEmojiEntry(btn('<button title="pepe"><img src="blob:b"></button>'), ENTRIES, URLS)?.id).toBe('p_b');
        // A server emoji with a personal emoji's name has a different image.
        expect(resolveMyEmojiEntry(btn('<button title="pepe"><img src="blob:server"></button>'), ENTRIES, URLS)).toBeNull();
        expect(resolveMyEmojiEntry(btn('<button title="pepe"><img src="data:image/svg+xml,x"></button>'), ENTRIES, URLS)).toBeNull();
    });
});

describe('picker right-click menu', () => {
    it('opens "Remove from My Emojis" on a My Emojis emoji and takes over the event', () => {
        mount(grid('my_emojis', 'pepe'));
        const ev = rightClick('button');
        expect(ev.defaultPrevented).toBe(true);
        expect(menuRows().map(r => r.textContent)).toEqual(['Remove from My Emojis']);
    });

    it('leaves right-clicks on other emojis alone (no menu, event not prevented)', () => {
        mount(grid('server_emojis', 'pepe') + grid('people', 'grinning'));
        const ev = rightClick('.category[data-id="server_emojis"] button');
        expect(ev.defaultPrevented).toBe(false);
        expect(menuRows()).toHaveLength(0);
        rightClick('.category[data-id="people"] button');
        expect(menuRows()).toHaveLength(0);
    });

    it('Remove calls the library once with the id, with no confirmation, and offers Undo', () => {
        mount(grid('my_emojis', 'shrug'));
        rightClick('button');
        act(() => { menuRows()[0].click(); vi.advanceTimersByTime(400); });
        expect(lib.remove).toHaveBeenCalledTimes(1);
        expect(lib.remove).toHaveBeenCalledWith('p_b');
        expect(push).toHaveBeenCalledTimes(1);
        const toast = push.mock.calls[0][0];
        expect(toast.message).toContain(':shrug:');
        expect(toast.action.label).toBe('Undo');
        expect(menuRows()).toHaveLength(0); // menu closed; nothing else (picker) was touched
    });

    it('Undo restores the very entry that was removed; a failed restore reports an error', async () => {
        mount(grid('my_emojis', 'shrug'));
        rightClick('button');
        act(() => { menuRows()[0].click(); vi.advanceTimersByTime(400); });
        lib.restore.mockResolvedValueOnce({ ok: true });
        await act(async () => { push.mock.calls[0][0].action.onClick(); });
        expect(lib.restore).toHaveBeenCalledWith(ENTRIES[1]);
        expect(push).toHaveBeenCalledTimes(1);

        lib.restore.mockResolvedValueOnce({ ok: false, error: 'not_an_image' });
        await act(async () => { push.mock.calls[0][0].action.onClick(); });
        expect(push).toHaveBeenCalledTimes(2);
        expect(push.mock.calls[1][0].kind).toBe('error');
    });
});
