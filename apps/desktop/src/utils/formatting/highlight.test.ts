/**
 * The in-house code-block highlighter (utils/formatting/highlight.ts).
 */
import { describe, it, expect } from 'vitest';
import { highlight, highlighterFor, HIGHLIGHT_MAX_CHARS, type HlSegment } from './highlight';

const kinds = (segs: HlSegment[]) => segs.filter(s => s.kind).map(s => `${s.kind}:${s.text}`);
const joined = (segs: HlSegment[]) => segs.map(s => s.text).join('');

describe('highlight', () => {
    it('never changes the text, only splits it', () => {
        const code = 'const a = "x"; // hi\nfunction f(b) { return 42 }';
        expect(joined(highlight(code, 'js'))).toBe(code);
        const html = '<a href="x">y</a><!-- c -->';
        expect(joined(highlight(html, 'html'))).toBe(html);
    });

    it('JavaScript / TypeScript', () => {
        const k = kinds(highlight('const a = "x"; // note\nreturn foo(1.5) && true', 'ts'));
        expect(k).toEqual(expect.arrayContaining(['kw:const', 'str:"x"', 'com:// note', 'kw:return', 'fn:foo', 'num:1.5', 'lit:true']));
    });

    it('Python', () => {
        const k = kinds(highlight("@app.route\ndef hi(x):\n    return None  # done\n", 'py'));
        expect(k).toEqual(expect.arrayContaining(['meta:@app', 'kw:def', 'fn:hi', 'kw:return', 'lit:None', 'com:# done']));
    });

    it('JSON keys vs values, SQL case-insensitively, diff lines', () => {
        expect(kinds(highlight('{"a": "b", "n": 1}', 'json'))).toEqual(['prop:"a"', 'str:"b"', 'prop:"n"', 'num:1']);
        expect(kinds(highlight('SELECT id FROM t', 'sql'))).toEqual(['kw:SELECT', 'kw:FROM']);
        expect(kinds(highlight('+added\n-removed\n same', 'diff'))).toEqual(['add:+added\n', 'del:-removed\n']);
    });

    it('unknown / missing language, and huge blocks, are left plain', () => {
        expect(highlight('x', 'brainfudge')).toEqual([{ text: 'x', kind: null }]);
        expect(highlight('x', null)).toEqual([{ text: 'x', kind: null }]);
        expect(highlight('a'.repeat(HIGHLIGHT_MAX_CHARS + 1), 'js')).toHaveLength(1);
    });

    it('aliases', () => {
        expect(highlighterFor('TypeScript')).toBe('js');
        expect(highlighterFor('c++')).toBe('c');
        expect(highlighterFor('yml')).toBe('yaml');
        expect(highlighterFor('zz')).toBeNull();
    });

    it('unterminated strings and comments end safely', () => {
        expect(joined(highlight('"abc\nnext', 'js'))).toBe('"abc\nnext');
        expect(kinds(highlight('/* never closed', 'c'))).toEqual(['com:/* never closed']);
    });
});
