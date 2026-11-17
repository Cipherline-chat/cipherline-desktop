import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The caret behaviour itself (RichComposer.placeCaretAtEnd: caret to the end,
 * scrolled into view, with or without taking focus) is driven in a real DOM
 * in components/composer/RichComposer.render.test.ts.
 */
/**
 * ChatPane has no render harness, so the wiring is pinned at the source level:
 * every way into edit mode must funnel through startEdit, and startEdit must
 * request the end-of-text caret.
 */
describe('ChatPane edit entry points all place the caret at the end', () => {
    const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
    const startEdit = src.slice(src.indexOf('const startEdit = (msg: any)'), src.indexOf('const cancelEdit = () =>'));

    it('startEdit requests the end-of-text caret', () => {
        expect(startEdit).toContain('caretToEndRef.current = true;');
        expect(startEdit).toContain('inputRef.current?.placeCaretAtEnd();');
    });

    it('a layout effect applies it after the new value commits', () => {
        const effect = src.slice(src.indexOf('const caretToEndRef = useRef(false);'), src.indexOf('const startEdit = (msg: any)'));
        expect(effect).toContain('useLayoutEffect(');
        expect(effect).toContain('ta.placeCaretAtEnd();');
        // A restored draft: caret to its end without taking focus.
        expect(effect).toContain('ta.placeCaretAtEnd({ focus: false });');
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
