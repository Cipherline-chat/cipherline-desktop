/**
 * A small, in-house syntax highlighter for fenced code blocks.
 *
 * Why not a library: none is installed in this repo, adding one is a new
 * dependency (licence check, bundle weight, and highlight grammars are a
 * classic ReDoS surface when fed sender-controlled text). Discord-level
 * highlighting only needs keywords, strings, numbers, comments and a couple of
 * extras, which one linear scanner covers for the common languages.
 *
 * The output is a list of `{ text, kind }` segments; FormattedText renders each
 * as a React <span>. No HTML is produced. Every scan step either consumes at
 * least one character or ends the line, so the whole pass is linear, and
 * blocks above HIGHLIGHT_MAX_CHARS are left plain so a huge paste cannot make
 * a feed re-render expensive.
 */

export type TokenKind = 'kw' | 'str' | 'num' | 'com' | 'lit' | 'fn' | 'type' | 'prop' | 'tag' | 'attr' | 'add' | 'del' | 'meta' | null;

export interface HlSegment { text: string; kind: TokenKind }

export const HIGHLIGHT_MAX_CHARS = 20_000;

interface LangSpec {
    keywords: ReadonlySet<string>;
    literals: ReadonlySet<string>;
    types?: ReadonlySet<string>;
    line?: readonly string[];
    block?: readonly [string, string][];
    quotes: string;
    /** Capitalised identifiers read as types (Java/TS/Rust/Go/C#…). */
    capsAreTypes?: boolean;
    /** `#include`-style preprocessor / decorator lines. */
    metaPrefix?: string;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = words(`await break case catch class const continue debugger default delete do else enum export extends
    finally for from function if import in instanceof let new of return static super switch this throw try typeof var
    void while with yield async get set as interface type implements private protected public readonly declare
    namespace abstract keyof satisfies infer is`);
const JS_LIT = words('true false null undefined NaN Infinity');

const C_LIKE_KW = words(`auto break case char const continue default do double else enum extern float for goto if inline int
    long register return short signed sizeof static struct switch typedef union unsigned void volatile while class
    namespace template typename public private protected virtual override new delete this throw try catch using
    operator friend constexpr nullptr bool include define`);

const SPECS: Record<string, LangSpec> = {
    js: { keywords: JS_KW, literals: JS_LIT, line: ['//'], block: [['/*', '*/']], quotes: '\'"`', capsAreTypes: true },
    python: {
        keywords: words(`and as assert async await break class continue def del elif else except finally for from global if
            import in is lambda nonlocal not or pass raise return try while with yield match case print self`),
        literals: words('True False None'), line: ['#'], quotes: '\'"', capsAreTypes: true, metaPrefix: '@',
    },
    rust: {
        keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move
            mut pub ref return self Self static struct super trait type unsafe use where while macro_rules`),
        literals: words('true false None Some Ok Err'), line: ['//'], block: [['/*', '*/']], quotes: '"', capsAreTypes: true, metaPrefix: '#',
    },
    go: {
        keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map
            package range return select struct switch type var`),
        literals: words('true false nil iota'), line: ['//'], block: [['/*', '*/']], quotes: '"`\'', capsAreTypes: true,
    },
    java: {
        keywords: words(`abstract assert boolean break byte case catch char class const continue default do double else enum
            extends final finally float for goto if implements import instanceof int interface long native new package
            private protected public return short static strictfp super switch synchronized this throw throws transient
            try void volatile while var record sealed permits yield fun val when object companion data override open
            internal lateinit`),
        literals: words('true false null'), line: ['//'], block: [['/*', '*/']], quotes: '\'"', capsAreTypes: true, metaPrefix: '@',
    },
    c: { keywords: C_LIKE_KW, literals: words('true false NULL nullptr'), line: ['//'], block: [['/*', '*/']], quotes: '\'"', capsAreTypes: true, metaPrefix: '#' },
    cs: {
        keywords: words(`abstract as async await base bool break byte case catch char checked class const continue decimal default
            delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int
            interface internal is lock long namespace new object operator out override params private protected public
            readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof
            uint ulong unchecked unsafe ushort using var virtual void volatile while record get set init`),
        literals: words('true false null'), line: ['//'], block: [['/*', '*/']], quotes: '\'"', capsAreTypes: true, metaPrefix: '#',
    },
    sh: {
        keywords: words(`if then else elif fi for while until do done case esac in function return exit export local readonly
            echo cd sudo set unset source alias shift`),
        literals: words('true false'), line: ['#'], quotes: '\'"', metaPrefix: '$',
    },
    sql: {
        keywords: words(`select from where insert into values update set delete create table index view drop alter add column
            primary key foreign references join left right inner outer full on group by order having limit offset as
            distinct and or not null is in exists between like union all case when then else end begin commit rollback
            returning default constraint unique check cascade with recursive desc asc`),
        literals: words('true false null'), line: ['--'], block: [['/*', '*/']], quotes: '\'"',
    },
    css: {
        keywords: words('important media supports keyframes import from to and not only screen'),
        literals: words(''), block: [['/*', '*/']], quotes: '\'"',
    },
    json: { keywords: words(''), literals: words('true false null'), quotes: '"' },
    yaml: { keywords: words(''), literals: words('true false null yes no on off ~'), line: ['#'], quotes: '\'"' },
    lua: {
        keywords: words('and break do else elseif end for function goto if in local not or repeat return then until while'),
        literals: words('true false nil'), line: ['--'], quotes: '\'"',
    },
};

const ALIASES: Record<string, string> = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js',
    py: 'python', python: 'python', python3: 'python',
    rs: 'rust', rust: 'rust',
    go: 'go', golang: 'go',
    java: 'java', kt: 'java', kotlin: 'java', scala: 'java', swift: 'java', dart: 'java',
    c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cxx: 'c', objc: 'c',
    cs: 'cs', csharp: 'cs', 'c#': 'cs',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', ps1: 'sh', powershell: 'sh',
    sql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
    css: 'css', scss: 'css', less: 'css',
    json: 'json', jsonc: 'json', json5: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
    lua: 'lua',
    html: 'html', xml: 'html', svg: 'html', vue: 'html',
    diff: 'diff', patch: 'diff',
};

/** The canonical highlighter for a fence language, or null when we have none (rendered plain). */
export function highlighterFor(lang: string | null | undefined): string | null {
    if (!lang) return null;
    return ALIASES[lang.toLowerCase()] ?? null;
}

function push(out: HlSegment[], text: string, kind: TokenKind): void {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
}

const IDENT_START = /[A-Za-z_$À-￿]/;
const IDENT_STICKY = /[A-Za-z0-9_$À-￿]+/y;
const NUM_STICKY = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,4}/y;

function scanCode(code: string, spec: LangSpec, out: HlSegment[]): void {
    const n = code.length;
    let i = 0;
    let lineStart = true;
    while (i < n) {
        const ch = code[i];
        if (ch === '\n') { push(out, ch, null); i++; lineStart = true; continue; }
        if (lineStart && spec.metaPrefix && ch === spec.metaPrefix && spec.metaPrefix !== '$') {
            // `#include` / `@decorator` / `#[derive]`: to the end of the word.
            IDENT_STICKY.lastIndex = i + 1;
            const m = IDENT_STICKY.exec(code);
            const end = i + 1 + (m ? m[0].length : 0);
            push(out, code.slice(i, end), 'meta');
            i = end;
            lineStart = false;
            continue;
        }
        if (ch !== ' ' && ch !== '\t') lineStart = false;
        let matched = false;
        for (const lc of spec.line ?? []) {
            if (code.startsWith(lc, i)) {
                let end = code.indexOf('\n', i);
                if (end < 0) end = n;
                push(out, code.slice(i, end), 'com');
                i = end;
                matched = true;
                break;
            }
        }
        if (matched) continue;
        for (const [open, close] of spec.block ?? []) {
            if (code.startsWith(open, i)) {
                let end = code.indexOf(close, i + open.length);
                end = end < 0 ? n : end + close.length;
                push(out, code.slice(i, end), 'com');
                i = end;
                matched = true;
                break;
            }
        }
        if (matched) continue;
        if (spec.quotes.includes(ch)) {
            // To the matching quote (backslash escapes), or the end of the line
            // for anything but a backtick template.
            let j = i + 1;
            while (j < n && code[j] !== ch) {
                if (code[j] === '\\') j += 2;
                else if (code[j] === '\n' && ch !== '`') break;
                else j++;
            }
            const end = Math.min(n, j < n && code[j] === ch ? j + 1 : j);
            const text = code.slice(i, end);
            // A JSON / YAML object key reads differently from a value.
            let k = end;
            while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
            push(out, text, code[k] === ':' && (spec === SPECS.json || spec === SPECS.yaml) ? 'prop' : 'str');
            i = end;
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            NUM_STICKY.lastIndex = i;
            const m = NUM_STICKY.exec(code);
            if (m) { push(out, m[0], 'num'); i += m[0].length; continue; }
        }
        if (IDENT_START.test(ch)) {
            IDENT_STICKY.lastIndex = i;
            const m = IDENT_STICKY.exec(code);
            const word = m ? m[0] : ch;
            const end = i + word.length;
            let kind: TokenKind = null;
            const lower = spec === SPECS.sql ? word.toLowerCase() : word;
            if (spec.keywords.has(lower)) kind = 'kw';
            else if (spec.literals.has(lower)) kind = 'lit';
            else {
                let k = end;
                while (k < n && code[k] === ' ') k++;
                if (code[k] === '(') kind = 'fn';
                else if (spec === SPECS.yaml && code[k] === ':') kind = 'prop';
                else if (spec.capsAreTypes && word[0] >= 'A' && word[0] <= 'Z' && word.length > 1) kind = 'type';
            }
            push(out, word, kind);
            i = end;
            continue;
        }
        push(out, ch, null);
        i++;
    }
}

function scanMarkup(code: string, out: HlSegment[]): void {
    const n = code.length;
    let i = 0;
    while (i < n) {
        if (code.startsWith('<!--', i)) {
            let end = code.indexOf('-->', i + 4);
            end = end < 0 ? n : end + 3;
            push(out, code.slice(i, end), 'com');
            i = end;
            continue;
        }
        if (code[i] === '<' && /[A-Za-z/!?]/.test(code[i + 1] ?? '')) {
            // Tag name, then attributes and quoted values, to the closing `>`.
            let j = i + 1;
            while (j < n && /[A-Za-z0-9/!?:._-]/.test(code[j])) j++;
            push(out, code.slice(i, j), 'tag');
            while (j < n && code[j] !== '>') {
                const c = code[j];
                if (c === '"' || c === '\'') {
                    let k = code.indexOf(c, j + 1);
                    k = k < 0 ? n : k + 1;
                    push(out, code.slice(j, k), 'str');
                    j = k;
                } else if (/[A-Za-z_:@-]/.test(c)) {
                    let k = j;
                    while (k < n && /[A-Za-z0-9_:.@-]/.test(code[k])) k++;
                    push(out, code.slice(j, k), 'attr');
                    j = k;
                } else {
                    push(out, c, null);
                    j++;
                }
            }
            if (j < n) { push(out, '>', 'tag'); j++; }
            i = j;
            continue;
        }
        let j = code.indexOf('<', i + 1);
        if (j < 0) j = n;
        push(out, code.slice(i, j), null);
        i = j;
    }
}

function scanDiff(code: string, out: HlSegment[]): void {
    for (const line of code.split(/(?<=\n)/)) {
        const c = line[0];
        push(out, line, c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'meta' : null);
    }
}

/** Segments for a code block, or a single plain segment when there is no highlighter (or it is too big). */
export function highlight(code: string, lang: string | null | undefined): HlSegment[] {
    const which = highlighterFor(lang);
    if (!which || code.length > HIGHLIGHT_MAX_CHARS) return [{ text: code, kind: null }];
    const out: HlSegment[] = [];
    if (which === 'html') scanMarkup(code, out);
    else if (which === 'diff') scanDiff(code, out);
    else scanCode(code, SPECS[which], out);
    return out;
}
