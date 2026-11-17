/**
 * Composer formatting edits (utils/formatting/composerFormat.ts): the toolbar
 * buttons, the keyboard shortcuts, and list continuation.
 *
 * `run('a [b] c', 'bold')` applies an action to "a b c" with "b" selected and
 * returns the result with the new selection drawn in brackets (a single `|`
 * for a caret when there is no bracketed selection).
 */
import { describe, it, expect } from 'vitest';
import { applyFormat, continueList, enterAction, shortcutAction, shortcutLabel, ariaShortcut, type FormatAction, type ComposerEdit } from './composerFormat';

function parse(marked: string): { value: string; s: number; e: number } {
    // A `[...]` selection wins (its text may itself contain `|`, e.g. a spoiler).
    const caret = marked.includes('[') ? -1 : marked.indexOf('|');
    if (caret >= 0) return { value: marked.replace('|', ''), s: caret, e: caret };
    const s = marked.indexOf('[');
    const e = marked.indexOf(']') - 1;
    return { value: marked.replace('[', '').replace(']', ''), s, e };
}

function draw(r: ComposerEdit): string {
    if (r.selStart === r.selEnd) return r.value.slice(0, r.selStart) + '|' + r.value.slice(r.selStart);
    return r.value.slice(0, r.selStart) + '[' + r.value.slice(r.selStart, r.selEnd) + ']' + r.value.slice(r.selEnd);
}

const run = (marked: string, action: FormatAction) => {
    const { value, s, e } = parse(marked);
    return draw(applyFormat(value, s, e, action));
};

describe('inline toggles', () => {
    it('wrap the selection and keep it selected', () => {
        expect(run('a [b] c', 'bold')).toBe('a **[b]** c');
        expect(run('a [b] c', 'italic')).toBe('a *[b]* c');
        expect(run('a [b] c', 'underline')).toBe('a __[b]__ c');
        expect(run('a [b] c', 'strike')).toBe('a ~~[b]~~ c');
        expect(run('a [b] c', 'code')).toBe('a `[b]` c');
        expect(run('a [b] c', 'spoiler')).toBe('a ||[b]|| c');
    });

    it('toggle OFF when already wrapped (markers outside or inside the selection)', () => {
        expect(run('a **[b]** c', 'bold')).toBe('a [b] c');
        expect(run('a [**b**] c', 'bold')).toBe('a [b] c');
        expect(run('a ||[b]|| c', 'spoiler')).toBe('a [b] c');
    });

    it('bold and italic share * without clobbering each other', () => {
        expect(run('**[b]**', 'italic')).toBe('***[b]***');
        expect(run('***[b]***', 'italic')).toBe('**[b]**');
        expect(run('***[b]***', 'bold')).toBe('*[b]*');
        expect(run('*[b]*', 'bold')).toBe('***[b]***');
        // Italic is NOT "already on" inside bold.
        expect(run('**[b]**', 'italic')).not.toBe('*[b]*');
    });

    it('whitespace at the selection edges stays outside the markers', () => {
        expect(run('a[ b ]c', 'bold')).toBe('a **[b]** c');
    });

    it('with no selection: an empty pair with the caret inside, and again removes it', () => {
        expect(run('hi |', 'bold')).toBe('hi **|**');
        expect(run('hi **|**', 'bold')).toBe('hi |');
        expect(run('|', 'code')).toBe('`|`');
    });

    it('code on a multi-line selection becomes a code block', () => {
        expect(run('[a\nb]', 'code')).toBe('```\n[a\nb]\n```');
    });
});

describe('code block', () => {
    it('fences go on their own lines', () => {
        expect(run('see [x()] now', 'codeBlock')).toBe('see \n```\n[x()]\n```\n now');
        expect(run('|', 'codeBlock')).toBe('```\n|\n```');
    });
    it('toggles off on an exactly-fenced selection', () => {
        expect(run('[```\ncode\n```]', 'codeBlock')).toBe('[code]');
    });
});

describe('link', () => {
    it('selected words become the label, the placeholder URL is selected to paste over', () => {
        expect(run('[docs]', 'link')).toBe('[docs]([https://])');
    });
    it('a selected URL becomes the destination, with the label selected', () => {
        expect(run('[https://example.com]', 'link')).toBe('[[link text]](https://example.com)');
        expect(run('[www.example.com]', 'link')).toBe('[[link text]](https://www.example.com)');
    });
    it('no selection: the label placeholder is selected', () => {
        expect(run('|', 'link')).toBe('[[link text]](https://)');
    });
});

describe('line prefixes', () => {
    it('quote / bullet / number on every selected line, and off again', () => {
        expect(run('[a\nb]', 'quote')).toBe('[> a\n> b]');
        expect(run('[> a\n> b]', 'quote')).toBe('[a\nb]');
        expect(run('[a\nb]', 'bullet')).toBe('[- a\n- b]');
        expect(run('[- a\n- b]', 'bullet')).toBe('[a\nb]');
        expect(run('[a\nb\nc]', 'number')).toBe('[1. a\n2. b\n3. c]');
    });
    it('switching list kinds replaces the marker', () => {
        expect(run('[- a\n- b]', 'number')).toBe('[1. a\n2. b]');
        expect(run('[1. a\n2. b]', 'bullet')).toBe('[- a\n- b]');
    });
    it('a caret applies to its line and keeps its place in the text', () => {
        expect(run('one\ntw|o', 'bullet')).toBe('one\n- tw|o');
    });
    it('heading cycles # -> ## -> ### -> off', () => {
        expect(run('ti|tle', 'heading')).toBe('# ti|tle');
        expect(run('# ti|tle', 'heading')).toBe('## ti|tle');
        expect(run('## ti|tle', 'heading')).toBe('### ti|tle');
        expect(run('### ti|tle', 'heading')).toBe('ti|tle');
    });
});

describe('list continuation (the newline key)', () => {
    const cont = (marked: string) => {
        const { value, s, e } = parse(marked);
        const r = continueList(value, s, e);
        return r ? draw(r) : null;
    };
    it('continues bullets and counts numbers up, keeping the indent', () => {
        expect(cont('- milk|')).toBe('- milk\n- |');
        expect(cont('* milk|')).toBe('* milk\n* |');
        expect(cont('1. one|')).toBe('1. one\n2. |');
        expect(cont('  - nested|')).toBe('  - nested\n  - |');
    });
    it('splits an item at the caret', () => {
        expect(cont('- ab|cd')).toBe('- ab\n- |cd');
    });
    it('an empty item ends the list (marker removed)', () => {
        expect(cont('- a\n- |')).toBe('- a\n|');
    });
    it('not a list line, a selection, or a caret inside the marker: plain newline', () => {
        expect(cont('hello|')).toBeNull();
        expect(cont('-# sub|')).toBeNull();
        expect(cont('[- a]')).toBeNull();
        expect(cont('-| a')).toBeNull();
    });
});

describe('shortcuts', () => {
    const k = (key: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}, code?: string) => ({
        key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, code,
    });
    it('Ctrl on Windows/Linux', () => {
        expect(shortcutAction(k('b', { ctrl: true }), false)).toBe('bold');
        expect(shortcutAction(k('i', { ctrl: true }), false)).toBe('italic');
        expect(shortcutAction(k('u', { ctrl: true }), false)).toBe('underline');
        expect(shortcutAction(k('e', { ctrl: true }), false)).toBe('code');
        expect(shortcutAction(k('k', { ctrl: true }), false)).toBe('link');
        expect(shortcutAction(k('X', { ctrl: true, shift: true }, 'KeyX'), false)).toBe('strike');
        expect(shortcutAction(k('C', { ctrl: true, shift: true }, 'KeyC'), false)).toBe('codeBlock');
    });
    it('Cmd on macOS, and Ctrl there is not ours', () => {
        expect(shortcutAction(k('b', { meta: true }), true)).toBe('bold');
        expect(shortcutAction(k('b', { ctrl: true }), true)).toBeNull();
    });
    it('plain keys, Alt combos and unrelated letters do nothing', () => {
        expect(shortcutAction(k('b'), false)).toBeNull();
        expect(shortcutAction(k('b', { ctrl: true, alt: true }), false)).toBeNull();
        expect(shortcutAction(k('c', { ctrl: true }), false)).toBeNull(); // copy stays copy
        expect(shortcutAction(k('v', { ctrl: true }), false)).toBeNull();
        expect(shortcutAction(k('B', { ctrl: true, shift: true }, 'KeyB'), false)).toBeNull();
    });
    it('a non-Latin layout uses the physical key', () => {
        expect(shortcutAction(k('и', { ctrl: true }, 'KeyB'), false)).toBe('bold');
    });
    it('labels for tooltips and aria-keyshortcuts', () => {
        expect(shortcutLabel('strike', false)).toBe('Ctrl+Shift+X');
        expect(shortcutLabel('bold', true)).toBe('⌘B');
        expect(ariaShortcut('codeBlock', false)).toBe('Control+Shift+C');
        expect(shortcutLabel('quote', false)).toBeNull();
    });
});

describe('Enter / Shift+Enter (owner: "shift enter to continue a list, if it is not a list enter will send, shift enter starts a new line")', () => {
    it('Enter always sends — on a list line too', () => {
        for (const v of ['hello', '- milk', '1. one', '']) {
            expect(enterAction({ key: 'Enter', shiftKey: false }, v, v.length, v.length)).toEqual({ kind: 'send' });
        }
    });
    it('Shift+Enter on a list line continues it; on an empty item ends it', () => {
        expect(enterAction({ key: 'Enter', shiftKey: true }, '- milk', 6, 6)).toEqual({ kind: 'continue', edit: { value: '- milk\n- ', selStart: 9, selEnd: 9 } });
        expect(enterAction({ key: 'Enter', shiftKey: true }, '- a\n- ', 6, 6)).toEqual({ kind: 'continue', edit: { value: '- a\n', selStart: 4, selEnd: 4 } });
    });
    it('Shift+Enter anywhere else is a plain new line', () => {
        expect(enterAction({ key: 'Enter', shiftKey: true }, 'hello', 5, 5)).toEqual({ kind: 'newline' });
        expect(enterAction({ key: 'Enter', shiftKey: true, ctrlKey: true }, '- milk', 6, 6)).toEqual({ kind: 'newline' });
    });
    it('other keys and IME composition are not ours', () => {
        expect(enterAction({ key: 'a', shiftKey: false }, '', 0, 0)).toBeNull();
        expect(enterAction({ key: 'Enter', shiftKey: false, isComposing: true }, 'x', 1, 1)).toBeNull();
    });
});
