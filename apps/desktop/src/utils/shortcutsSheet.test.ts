// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildShortcutGroups, comboCaps, isTypingTarget, shouldOpenShortcutsSheet } from './shortcutsSheet';
import { ACTIONS, formatCombo, type KeybindMap } from '../hooks/useKeybinds';

const el = (html: string): HTMLElement => {
    const d = document.createElement('div');
    d.innerHTML = html;
    document.body.appendChild(d);
    return d.firstElementChild as HTMLElement;
};

describe('isTypingTarget', () => {
    it('is true for text fields, selects, content-editables and text-entry roles', () => {
        expect(isTypingTarget(el('<input type="text">'))).toBe(true);
        expect(isTypingTarget(el('<input type="search">'))).toBe(true);
        expect(isTypingTarget(el('<textarea></textarea>'))).toBe(true);
        expect(isTypingTarget(el('<select><option>a</option></select>'))).toBe(true);
        const ce = el('<div contenteditable="true">x</div>');
        Object.defineProperty(ce, 'isContentEditable', { value: true }); // jsdom does not compute this
        expect(isTypingTarget(ce)).toBe(true);
        expect(isTypingTarget(el('<div role="textbox"></div>'))).toBe(true);
        expect(isTypingTarget(el('<div role="combobox"></div>'))).toBe(true);
    });
    it('is false for the page, buttons and plain elements', () => {
        expect(isTypingTarget(document.body)).toBe(false);
        expect(isTypingTarget(el('<button>x</button>'))).toBe(false);
        expect(isTypingTarget(el('<div>x</div>'))).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
        expect(isTypingTarget(window)).toBe(false);
    });
});

describe('shouldOpenShortcutsSheet', () => {
    const body = document.body;
    it('opens on ? when not typing', () => {
        expect(shouldOpenShortcutsSheet({ key: '?' }, body)).toBe(true);
    });
    it('does not open while typing in a field', () => {
        expect(shouldOpenShortcutsSheet({ key: '?' }, el('<textarea></textarea>'))).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?' }, el('<input>'))).toBe(false);
    });
    it('ignores other keys, modified ?, repeats, composition and handled events', () => {
        expect(shouldOpenShortcutsSheet({ key: '/' }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: 'h' }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?', ctrlKey: true }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?', metaKey: true }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?', altKey: true }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?', repeat: true }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?', isComposing: true }, body)).toBe(false);
        expect(shouldOpenShortcutsSheet({ key: '?', defaultPrevented: true }, body)).toBe(false);
    });
});

describe('buildShortcutGroups', () => {
    const binds: KeybindMap = { 'toggle-mute': 'ctrl+shift+m', 'open-settings': 'ctrl+,', 'toggle-gif-picker': '' };
    const groups = buildShortcutGroups(binds, formatCombo);
    const rows = groups.flatMap(g => g.rows);

    it('groups controls, navigation, writing and the fixed anywhere keys, in that order', () => {
        expect(groups.map(g => g.id)).toEqual(['controls', 'navigation', 'writing', 'anywhere']);
    });
    it('lists every configurable action except the drawing-request pair', () => {
        const expected = ACTIONS.filter(a => !a.id.endsWith('annotation-request')).map(a => a.id);
        expect(rows.filter(r => expected.includes(r.id as never)).map(r => r.id).sort()).toEqual([...expected].sort());
        expect(rows.find(r => r.id === 'approve-annotation-request')).toBeUndefined();
    });
    it('shows the live combo as keycaps, and nothing for a cleared or missing bind', () => {
        expect(rows.find(r => r.id === 'toggle-mute')!.keys).toEqual(['Ctrl', 'Shift', 'M']);
        expect(rows.find(r => r.id === 'open-settings')!.keys).toEqual(['Ctrl', ',']);
        expect(rows.find(r => r.id === 'toggle-gif-picker')!.keys).toEqual([]);
        expect(rows.find(r => r.id === 'toggle-emoji-picker')!.keys).toEqual([]);
    });
    it('follows a rebind', () => {
        const g = buildShortcutGroups({ ...binds, 'toggle-mute': 'ctrl+alt+k' }, formatCombo).flatMap(x => x.rows);
        expect(g.find(r => r.id === 'toggle-mute')!.keys).toEqual(['Ctrl', 'Alt', 'K']);
    });
    it('adds push to talk only when it is on', () => {
        expect(rows.find(r => r.id === 'push-to-talk')).toBeUndefined();
        const withPtt = buildShortcutGroups(binds, formatCombo, 'space').flatMap(x => x.rows);
        expect(withPtt.find(r => r.id === 'push-to-talk')!.keys).toEqual(['Space']);
    });
    it('carries the fixed keys', () => {
        expect(rows.find(r => r.id === 'send')!.keys).toEqual(['Enter']);
        expect(rows.find(r => r.id === 'newline')!.keys).toEqual(['Shift', 'Enter']);
        expect(rows.find(r => r.id === 'esc')!.keys).toEqual(['Esc']);
        expect(rows.find(r => r.id === 'sheet')!.keys).toEqual(['?']);
    });
});

describe('comboCaps', () => {
    it('splits a formatted combo and tolerates empty', () => {
        expect(comboCaps('ctrl+shift+m', formatCombo)).toEqual(['Ctrl', 'Shift', 'M']);
        expect(comboCaps(undefined, formatCombo)).toEqual([]);
        expect(comboCaps('', formatCombo)).toEqual([]);
    });
});
