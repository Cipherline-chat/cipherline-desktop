// @vitest-environment jsdom
/**
 * The emoji picker's "Server emojis" / "My Emojis" tabs: category building
 * (both always present, empty ones carry a hidden placeholder), tab switching
 * against a fake emoji-mart shadow root, the empty-state panels, and a source
 * check that the single picker component is wired to all of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    EMOJI_TABS, MY_EMOJI_TAB, PLACEHOLDER_HIDE_CSS, SERVER_EMOJI_TAB, buildEmojiTabCategories, emptyTabForLabel, isEmptyPlaceholderId,
} from './emojiPickerTabs';
import { useEmptyTabOverlay } from './useEmptyTabOverlay';
import { EmojiPickerEmptyState } from './EmojiPickerEmptyState';
import { OPEN_SETTINGS_EVENT } from '../utils/openSettingsRequest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emoji = (id: string) => ({ id, name: id, src: `blob:${id}` });

describe('buildEmojiTabCategories', () => {
    it('in a server context yields both tabs, Server emojis first, each with an icon', () => {
        const { categories } = buildEmojiTabCategories([], [], 'ph', true);
        expect(categories.map(c => [c.id, c.name])).toEqual([['server_emojis', 'Server emojis'], ['my_emojis', 'My Emojis']]);
        for (const c of categories) expect(c.icon.svg).toMatch(/^<svg[^>]+viewBox="0 0 24 24"/);
        expect(new Set(categories.map(c => c.icon.svg)).size).toBe(2);
    });

    it('an empty tab holds one hidden, unsearchable placeholder and is reported as empty', () => {
        const { categories, emptyTabs } = buildEmojiTabCategories([], [emoji('p_1')], 'ph', true);
        expect(emptyTabs).toEqual(['server']);
        const only = categories[0].emojis as { id: string; search: string; skins: { src: string }[] }[];
        expect(only).toHaveLength(1);
        expect(isEmptyPlaceholderId(only[0].id)).toBe(true);
        expect(only[0].search).toBe(',');
        expect(only[0].skins[0].src).toBe('ph');
    });

    it('populated tabs list their emojis and are not empty', () => {
        const { categories, emptyTabs } = buildEmojiTabCategories([emoji('s1'), emoji('s2')], [emoji('p_1')], 'ph', true);
        expect(emptyTabs).toEqual([]);
        expect((categories[0].emojis as { id: string }[]).map(e => e.id)).toEqual(['s1', 's2']);
        expect((categories[1].emojis as { skins: { src: string }[] }[])[0].skins[0].src).toBe('blob:p_1');
    });

    it('both empty: both reported, in bar order', () => {
        expect(buildEmojiTabCategories([], [], 'ph', true).emptyTabs).toEqual(['server', 'mine']);
    });

    it('outside a server context (DM, group DM, status editor) the Server tab and its placeholder do not exist', () => {
        const { categories, emptyTabs } = buildEmojiTabCategories([], [], 'ph', false);
        expect(categories.map(c => c.id)).toEqual(['my_emojis']);
        // My Emojis stays; only IT can be reported empty, never 'server'.
        expect(emptyTabs).toEqual(['mine']);
        const ids = categories.flatMap(c => (c.emojis as { id: string }[]).map(e => e.id));
        expect(ids).not.toContain(SERVER_EMOJI_TAB.placeholder);
    });

    it('server emojis handed over without a server context are not shown (no server tab to hold them)', () => {
        const { categories } = buildEmojiTabCategories([emoji('s1')], [emoji('p_1')], 'ph', false);
        expect(categories.map(c => c.id)).toEqual(['my_emojis']);
        expect(JSON.stringify(categories)).not.toContain('s1');
    });

    it('in a server context an emoji-less server still gets its (empty) tab', () => {
        const { categories, emptyTabs } = buildEmojiTabCategories([], [emoji('p_1')], 'ph', true);
        expect(categories.map(c => c.id)).toEqual(['server_emojis', 'my_emojis']);
        expect(emptyTabs).toEqual(['server']);
    });

    it('real emoji ids are never mistaken for the placeholder', () => {
        expect(isEmptyPlaceholderId('p_' + 'a'.repeat(32))).toBe(false);
        expect(isEmptyPlaceholderId(undefined)).toBe(false);
        expect(isEmptyPlaceholderId('cl-empty-mine')).toBe(true);
    });

    it('the CSS that hides the placeholders names both', () => {
        for (const t of EMOJI_TABS) expect(PLACEHOLDER_HIDE_CSS).toContain(`button[title="${t.placeholder}"]`);
    });

    it('tab copy matches the spec', () => {
        expect(SERVER_EMOJI_TAB.emptyTitle).toBe('No server emojis here yet');
        expect(MY_EMOJI_TAB.emptyBody).toBe('Save emojis with right-click or add your own in Settings → Personalize.');
    });
});

describe('emptyTabForLabel', () => {
    it('matches only EMPTY tabs by their nav label', () => {
        expect(emptyTabForLabel('Server emojis', ['server'])).toBe(SERVER_EMOJI_TAB);
        expect(emptyTabForLabel('My Emojis', ['server'])).toBeNull();
        expect(emptyTabForLabel('My Emojis', ['server', 'mine'])).toBe(MY_EMOJI_TAB);
        expect(emptyTabForLabel('Smileys & People', ['server', 'mine'])).toBeNull();
        expect(emptyTabForLabel(null, ['server'])).toBeNull();
    });
});

// ── Tab switching against a stand-in for emoji-mart's shadow DOM ─────────────

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();

const rect = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

const Harness: React.FC<{ empty: ('server' | 'mine')[] }> = ({ empty }) => {
    const ref = React.useRef<HTMLDivElement>(null);
    const { overlay, dismiss } = useEmptyTabOverlay(ref, empty);
    return React.createElement('div', { ref, id: 'wrap' },
        React.createElement('em-emoji-picker'),
        overlay && React.createElement(EmojiPickerEmptyState, { overlay, onClose, onDismiss: dismiss }));
};

const NAV = ['Smileys & People', 'Server emojis', 'My Emojis'];
let shadow: ShadowRoot;
const mount = (empty: ('server' | 'mine')[]) => {
    act(() => root.render(React.createElement(Harness, { empty })));
    const picker = host.querySelector('em-emoji-picker')!;
    shadow = picker.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<div class="scroll"><input type="search"></div><nav id="nav">${NAV.map(n => `<button aria-label="${n}"></button>`).join('')}</nav>`;
    // jsdom has no layout: frame the wrapper (0..400), the grid (40..350).
    host.querySelector('#wrap')!.getBoundingClientRect = rect(0, 400);
    shadow.querySelector('.scroll')!.getBoundingClientRect = rect(40, 350);
    shadow.querySelector('input')!.getBoundingClientRect = rect(44, 72);
    // The hook polls for the shadow root (the element upgrades late in the app).
    act(() => { vi.advanceTimersByTime(40); });
};
const tab = (label: string) => act(() => { (shadow.querySelector(`#nav button[aria-label="${label}"]`) as HTMLButtonElement).click(); });
const panel = () => host.querySelector('[data-testid="emoji-picker-empty"]') as HTMLElement | null;

beforeEach(() => {
    vi.useFakeTimers();
    onClose.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

describe('empty tab panels', () => {
    it('choosing an empty Server emojis tab shows its empty state under the search row, with no button', () => {
        mount(['server']);
        expect(panel()).toBeNull();
        tab('Server emojis');
        expect(panel()!.textContent).toContain('No server emojis here yet');
        expect(panel()!.querySelector('button')).toBeNull();
        expect(panel()!.style.top).toBe('80px'); // below the search row (72 + 8)
        expect(panel()!.style.bottom).toBe('50px'); // above the nav bar
    });

    it('switching to a populated tab or another category hides it again', () => {
        mount(['server']);
        tab('Server emojis');
        expect(panel()).not.toBeNull();
        tab('My Emojis');
        expect(panel()).toBeNull();
        tab('Server emojis');
        tab('Smileys & People');
        expect(panel()).toBeNull();
    });

    it('a populated Server emojis tab never shows an empty state', () => {
        mount(['mine']);
        tab('Server emojis');
        expect(panel()).toBeNull();
    });

    it('typing in the search box hands the grid back; so does scrolling over the panel', () => {
        mount(['server', 'mine']);
        tab('My Emojis');
        expect(panel()).not.toBeNull();
        act(() => { shadow.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(panel()).toBeNull();
        tab('My Emojis');
        act(() => { panel()!.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); });
        expect(panel()).toBeNull();
    });

    it('My Emojis empty state explains saving, and its button opens Settings -> Personalize and closes the picker', () => {
        mount(['mine']);
        tab('My Emojis');
        expect(panel()!.textContent).toContain('Save emojis with right-click or add your own in Settings → Personalize.');
        const seen: string[] = [];
        const on = (e: Event) => seen.push((e as CustomEvent<{ pane: string }>).detail.pane);
        window.addEventListener(OPEN_SETTINGS_EVENT, on);
        act(() => panel()!.querySelector('button')!.click());
        window.removeEventListener(OPEN_SETTINGS_EVENT, on);
        expect(seen).toEqual(['personalize']);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('the one picker component uses all of it', () => {
    const src = readFileSync(resolve(__dirname, './EmojiPicker.tsx'), 'utf8');
    it('builds its categories through buildEmojiTabCategories and renders the empty state', () => {
        expect(src).toContain('buildEmojiTabCategories(');
        expect(src).toContain('<EmojiPickerEmptyState');
        expect(src).not.toContain("name: 'This Server'");
    });
    it('ignores a pick of the hidden placeholder and hides it in the shadow root', () => {
        expect(src).toMatch(/isEmptyPlaceholderId\(e\.id\)\) return/);
        expect(src).toContain('${PLACEHOLDER_HIDE_CSS}');
    });
    it('only the three ChatPane pickers pass serverContext (derived from the open server); the status editor never does', () => {
        const chat = readFileSync(resolve(__dirname, './ChatPane.tsx'), 'utf8');
        const status = readFileSync(resolve(__dirname, './CustomStatusInline.tsx'), 'utf8');
        expect(chat.match(/serverContext=\{!!emojiServerId\}/g)!.length).toBe(3);
        expect(status).not.toContain('serverContext');
        expect(src).toMatch(/serverContext = false/);
    });
    it('the picker counts the context menu as inside, and mounts the My Emojis menu', () => {
        expect(src).toContain("closest?.('.ctxm')");
        expect(src).toContain('useMyEmojiContextMenu(');
        expect(src).toContain('{myEmojiMenu}');
    });
    it('composer, reactions and the status editor all go through that same component', () => {
        const chat = readFileSync(resolve(__dirname, './ChatPane.tsx'), 'utf8');
        const status = readFileSync(resolve(__dirname, './CustomStatusInline.tsx'), 'utf8');
        expect(chat.match(/<EmojiPickerPopover/g)!.length).toBe(3);
        expect(status).toContain("from './emojiPickerLazy'");
    });
});
