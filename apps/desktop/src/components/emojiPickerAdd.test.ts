// @vitest-environment jsdom
/**
 * The emoji picker's "+" for adding a personal emoji: the pure state (the
 * 100-emoji cap), the file rule shared with Settings, the button injected into
 * emoji-mart's shadow DOM (and re-attached when the grid rebuilds), the
 * empty-state button, and the wiring that keeps the dialog above the picker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addEmojiButtonState, MY_EMOJI_TAB } from './emojiPickerTabs';
import { emojiFileProblem } from '../utils/personalEmoji/pickFile';
import { PERSONAL_EMOJI_LIBRARY_MAX } from '../utils/personalEmoji/token';
import { ADD_BUTTON_CLASS, useMyEmojiAddButton, type AddButtonState } from './useMyEmojiAddButton';
import { EmojiPickerEmptyState } from './EmojiPickerEmptyState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (...a: any[]) => React.ReactElement;
const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('addEmojiButtonState', () => {
    it('is enabled up to the cap and disabled (with the reason) at and past it', () => {
        expect(PERSONAL_EMOJI_LIBRARY_MAX).toBe(100);
        expect(addEmojiButtonState(0, 100).disabled).toBe(false);
        expect(addEmojiButtonState(99, 100).disabled).toBe(false);
        const full = addEmojiButtonState(100, 100);
        expect(full.disabled).toBe(true);
        expect(full.tooltip).toContain('full (100)');
        expect(addEmojiButtonState(101, 100).disabled).toBe(true);
        expect(addEmojiButtonState(5, 100).tooltip).not.toContain('full');
    });
});

describe('emojiFileProblem (shared with Settings -> Activity & Style -> My Emojis)', () => {
    it('accepts pictures up to 25 MB and refuses the rest', () => {
        expect(emojiFileProblem({ type: 'image/png', size: 1000 })).toBeNull();
        expect(emojiFileProblem({ type: 'image/gif', size: 25 * 1024 * 1024 })).toBeNull();
        expect(emojiFileProblem({ type: 'image/png', size: 25 * 1024 * 1024 + 1 })).toContain('25 MB');
        expect(emojiFileProblem({ type: 'image/svg+xml', size: 10 })).toContain('Pick a picture');
        expect(emojiFileProblem({ type: 'text/plain', size: 10 })).toContain('Pick a picture');
        expect(emojiFileProblem({ type: '', size: 10 })).toContain('Pick a picture');
    });
});

// ── the injected header button, against a fake emoji-mart shadow root ──────────
let host: HTMLDivElement;
let root: Root;
let shadow: ShadowRoot;

const header = () => shadow.querySelector('.category[data-id="my_emojis"] .sticky') as HTMLElement;
const addBtn = () => shadow.querySelector(`button.${ADD_BUTTON_CLASS}`) as HTMLButtonElement | null;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 40)); });
const renderGrid = () => {
    shadow.innerHTML = `<div class="scroll"><div class="category" data-id="my_emojis"><div class="sticky padding-small align-l">My Emojis</div><div class="relative"></div></div></div>`;
};

const Probe: React.FC<{ state: AddButtonState; onClick: () => void; expose: (f: () => boolean) => void }> = ({ state, onClick, expose }) => {
    const wrap = React.useRef<HTMLDivElement>(null);
    const { focus } = useMyEmojiAddButton(wrap, state, onClick);
    React.useEffect(() => { expose(focus); });
    return h('div', { ref: wrap }, h('em-emoji-picker'));
};
const probe = (state: AddButtonState, onClick: () => void, expose: (f: () => boolean) => void = () => {}) => h(Probe, { state, onClick, expose });

const enabled: AddButtonState = { disabled: false, label: 'Add an emoji', tooltip: 'Add an emoji to My Emojis' };
const full: AddButtonState = addEmojiButtonState(100, 100);

const mount = async (state: AddButtonState, onClick: () => void, expose: (f: () => boolean) => void = () => {}) => {
    await act(async () => { root.render(probe(state, onClick, expose)); });
    const picker = host.querySelector('em-emoji-picker') as HTMLElement;
    shadow = picker.attachShadow({ mode: 'open' });
    renderGrid();
    await flush();
};

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('useMyEmojiAddButton', () => {
    it('puts a labelled, focusable "+" in the My Emojis section header only', async () => {
        const onClick = vi.fn();
        await mount(enabled, onClick);
        const b = addBtn()!;
        expect(b).not.toBeNull();
        expect(header().contains(b)).toBe(true);
        expect(shadow.querySelectorAll(`button.${ADD_BUTTON_CLASS}`)).toHaveLength(1);
        expect(b.getAttribute('aria-label')).toBe('Add an emoji');
        expect(b.getAttribute('title')).toBe('Add an emoji to My Emojis');
        expect(b.getAttribute('aria-disabled')).toBe('false');
        expect(b.type).toBe('button');
        expect(b.tabIndex).toBe(0);
        b.click();
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('re-attaches the button when emoji-mart rebuilds the grid', async () => {
        await mount(enabled, vi.fn());
        expect(addBtn()).not.toBeNull();
        renderGrid(); // the old header (and our button) are gone
        expect(addBtn()).toBeNull();
        await flush();
        expect(addBtn()).not.toBeNull();
        expect(shadow.querySelectorAll(`button.${ADD_BUTTON_CLASS}`)).toHaveLength(1);
    });

    it('at the cap: still focusable, aria-disabled, tooltip says why, click does nothing', async () => {
        const onClick = vi.fn();
        await mount(full, onClick);
        const b = addBtn()!;
        expect(b.getAttribute('aria-disabled')).toBe('true');
        expect(b.getAttribute('title')).toContain('full (100)');
        expect(b.hasAttribute('disabled')).toBe(false);
        b.click();
        expect(onClick).not.toHaveBeenCalled();
    });

    it('follows the state when the library crosses the cap', async () => {
        const onClick = vi.fn();
        await mount(enabled, onClick);
        await act(async () => { root.render(probe(full, onClick)); });
        await flush();
        expect(addBtn()!.getAttribute('aria-disabled')).toBe('true');
        await act(async () => { root.render(probe(enabled, onClick)); });
        await flush();
        expect(addBtn()!.getAttribute('aria-disabled')).toBe('false');
    });

    it('focus() moves focus to the button, and reports false when there is none', async () => {
        let focus: () => boolean = () => false;
        await mount(enabled, vi.fn(), f => { focus = f; });
        expect(focus()).toBe(true);
        expect(shadow.activeElement).toBe(addBtn());
        shadow.innerHTML = '';
        expect(focus()).toBe(false);
    });

    it('removes its button when the picker unmounts', async () => {
        await mount(enabled, vi.fn());
        const s = shadow;
        act(() => root.render(h('div')));
        expect(s.querySelector(`button.${ADD_BUTTON_CLASS}`)).toBeNull();
    });
});

describe('the empty My Emojis panel', () => {
    const overlay = { tab: MY_EMOJI_TAB, top: 40, bottom: 40 };
    const mountPanel = (props: Partial<React.ComponentProps<typeof EmojiPickerEmptyState>>) =>
        act(() => { root.render(h(EmojiPickerEmptyState, { overlay, onClose: () => {}, onDismiss: () => {}, ...props })); });

    it('offers "Add an emoji" next to "Manage in Settings" and calls it', () => {
        const onAddEmoji = vi.fn();
        mountPanel({ onAddEmoji, addState: addEmojiButtonState(0, 100) });
        const b = host.querySelector('[data-testid="emoji-picker-empty-add"]') as HTMLButtonElement;
        expect(b.textContent).toContain('Add an emoji');
        expect(host.textContent).toContain('Manage in Settings');
        act(() => b.click());
        expect(onAddEmoji).toHaveBeenCalledTimes(1);
    });

    it('when full the button is aria-disabled with the tooltip and does not fire', () => {
        const onAddEmoji = vi.fn();
        mountPanel({ onAddEmoji, addState: full });
        const b = host.querySelector('[data-testid="emoji-picker-empty-add"]') as HTMLButtonElement;
        expect(b.getAttribute('aria-disabled')).toBe('true');
        expect(b.getAttribute('title')).toContain('full (100)');
        act(() => b.click());
        expect(onAddEmoji).not.toHaveBeenCalled();
    });

    it('has no add button for the Server emojis panel, and none without a handler', () => {
        mountPanel({ onAddEmoji: vi.fn(), overlay: { ...overlay, tab: { ...MY_EMOJI_TAB, id: 'server' } } });
        expect(host.querySelector('[data-testid="emoji-picker-empty-add"]')).toBeNull();
        mountPanel({});
        expect(host.querySelector('[data-testid="emoji-picker-empty-add"]')).toBeNull();
    });
});

describe('wiring', () => {
    const picker = src('./EmojiPicker.tsx');
    it('the one picker (composer, reactions, status editor) mounts the add flow, the button and the empty-state hook-up', () => {
        expect(picker).toContain('useAddMyEmoji(');
        expect(picker).toContain('useMyEmojiAddButton(');
        expect(picker).toContain('{addEmoji.node}');
        expect(picker).toContain('onAddEmoji={addEmoji.open}');
        expect(picker).toContain('ADD_BUTTON_CSS');
    });
    it('a click inside the dialog (a portal to <body>) does not count as outside the picker', () => {
        expect(picker).toMatch(/closest\?\.\('\.mod'\)/);
    });
    it('reuses the Settings dialog, raised above the picker, and the shared file rule', () => {
        const hook = src('./useAddMyEmoji.tsx');
        expect(hook).toContain("from './settings/panes/AddEmojiDialog'");
        expect(hook).toContain('zIndex: 10050');
        expect(hook).toContain('emojiFileProblem');
        expect(src('./settings/panes/PersonalizePane.tsx')).toContain('emojiFileProblem');
        expect(src('./settings/panes/AddEmojiDialog.tsx')).toContain('overlayStyle={overlayStyle}');
        // No second copy of the processing pipeline.
        expect(hook).not.toContain('processEmojiImage');
    });
});
