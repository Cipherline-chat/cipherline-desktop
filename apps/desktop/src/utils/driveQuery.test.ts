import { describe, it, expect } from 'vitest';
import { escapeDriveQueryLiteral as main } from '../../electron/drive-query';

/**
 * Parse a Drive-style single-quoted literal the way the server does: `\x` is
 * an escaped `x`, an unescaped `'` ends the literal. Returns the decoded value,
 * or null if the literal does not end exactly at the end of the input.
 */
function parseQuoted(src: string): string | null {
    if (src[0] !== "'") return null;
    let out = '';
    for (let i = 1; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { out += src[++i] ?? ''; continue; }
        if (c === "'") return i === src.length - 1 ? out : null;
        out += c;
    }
    return null;
}

const CASES: Array<[string, string]> = [
    ['plain', 'plain'],
    ["it's", "it\\'s"],
    ['back\\slash', 'back\\\\slash'],
    ['trailing\\', 'trailing\\\\'],
    ["\\'", "\\\\\\'"],
    ["' or name contains '", "\\' or name contains \\'"],
    ['', ''],
];

describe.each([['main', main]] as const)('escapeDriveQueryLiteral (%s copy)', (_n, escape) => {
    it.each(CASES)('escapes %j', (input, expected) => {
        expect(escape(input)).toBe(expected);
    });

    it('round-trips: the server decodes exactly the original value, for hostile inputs', () => {
        for (const v of ['a\\', "a\\'", "\\' or trashed=false or name='", "\\\\", "'", "x' in parents or 'y"]) {
            expect(parseQuoted(`'${escape(v)}'`)).toBe(v);
        }
    });

    it('negative control: the pre-fix output (quote escaped, backslash untouched) is a malformed literal', () => {
        // The old quote-only escape turned the value  a\  into  a\  (unchanged), so the
        // closing quote of the literal became an escaped quote. Written out literally:
        const preFixOutputForTrailingBackslash = 'a\\';
        expect(parseQuoted("'" + preFixOutputForTrailingBackslash + "'")).toBeNull();
        // ...whereas the fixed escape round-trips the same value.
        expect(parseQuoted("'" + escape('a\\') + "'")).toBe('a\\');
    });
});
