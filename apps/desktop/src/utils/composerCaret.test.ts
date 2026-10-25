// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeCaretAtEnd } from './composerCaret';

function composer(value: string, scrollHeight = 0) {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.value = value;
    // jsdom has no layout; model the browser's content height.
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    return ta;
}

describe('placeCaretAtEnd', () => {
    it('moves a caret sitting at the START (the reported bug) to the end', () => {
        const ta = composer('fix the typo in this message');
        ta.setSelectionRange(0, 0);                       // control: starts at 0
        expect(ta.selectionStart).toBe(0);
        placeCaretAtEnd(ta);
        expect(ta.selectionStart).toBe(ta.value.length);
        expect(ta.selectionEnd).toBe(ta.value.length);
    });

    it('collapses a selection rather than extending it', () => {
        const ta = composer('hello world');
        ta.setSelectionRange(0, 5);
        placeCaretAtEnd(ta);
        expect(ta.selectionStart).toBe(11);
        expect(ta.selectionEnd).toBe(11);
    });

    it('focuses the field', () => {
        const ta = composer('x');
        expect(document.activeElement).not.toBe(ta);
        placeCaretAtEnd(ta);
        expect(document.activeElement).toBe(ta);
    });

    it('a restored draft gets the caret at the end WITHOUT stealing focus (focus: false)', () => {
        const ta = composer('restored draft text');
        ta.setSelectionRange(0, 0);
        placeCaretAtEnd(ta, { focus: false });
        expect(document.activeElement).not.toBe(ta);
        expect(ta.selectionStart).toBe(ta.value.length);
    });

    it('scrolls a long message so its end is in view', () => {
        const ta = composer('line\n'.repeat(80), 1600);
        // jsdom has no layout and clamps scrollTop to 0, so record what is set.
        let scrolledTo = 0;
        Object.defineProperty(ta, 'scrollTop', { configurable: true, get: () => scrolledTo, set: (v: number) => { scrolledTo = v; } });
        placeCaretAtEnd(ta);
        expect(scrolledTo).toBe(1600);                    // to the bottom
        expect(ta.style.height).toBe('260px');            // grown to the cap, not unbounded
    });

    it('grows a short message to its content height, below the cap', () => {
        const ta = composer('short', 40);
        placeCaretAtEnd(ta);
        expect(ta.style.height).toBe('40px');
    });

    it('handles an empty edit and a missing element', () => {
        const ta = composer('');
        expect(() => placeCaretAtEnd(ta)).not.toThrow();
        expect(ta.selectionStart).toBe(0);
        expect(() => placeCaretAtEnd(null)).not.toThrow();
        expect(() => placeCaretAtEnd(undefined)).not.toThrow();
    });
});

/**
 * ChatPane has no render harness, so the wiring is pinned at the source level:
 * every way into edit mode must funnel through startEdit, and startEdit must
 * request the end-of-text caret.
 */
describe('ChatPane edit entry points all place the caret at the end', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
    const startEdit = src.slice(src.indexOf('const startEdit = (msg: any)'), src.indexOf('const cancelEdit = () =>'));

    it('startEdit requests the end-of-text caret', () => {
        expect(startEdit).toContain('caretToEndRef.current = true;');
        expect(startEdit).toContain('placeCaretAtEnd(inputRef.current)');
    });

    it('a layout effect applies it after the new value commits', () => {
        const effect = src.slice(src.indexOf('const caretToEndRef = useRef(false);'), src.indexOf('const startEdit = (msg: any)'));
        expect(effect).toContain('useLayoutEffect(');
        expect(effect).toContain('placeCaretAtEnd(ta);');
    });

    it('the hover Edit button, the context menu and Up-arrow each call startEdit', () => {
        expect(src).toContain('<MsgBarBtn icon={<Edit2 />} label="Edit" onClick={() => startEdit(msg)} />');
        expect(src).toContain('onSelect: () => startEdit(msg),');
        expect(src).toMatch(/if \(open && candidate\) \{\s*e\.preventDefault\(\);\s*startEdit\(candidate\);/);
    });

    it('nothing else enters edit mode by setting editingId to a message id', () => {
        const setters = [...src.matchAll(/setEditingId\(([^)]*)\)/g)].map(m => m[1]);
        // null (leaving edit) and the single startEdit call (msg.id) only.
        expect(setters.filter(a => a !== 'null')).toEqual(['msg.id']);
    });
});
