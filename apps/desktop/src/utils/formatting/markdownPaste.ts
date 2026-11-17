/**
 * Pasting Markdown from elsewhere (ChatGPT, GitHub, a README, Obsidian…).
 *
 * `looksLikeMarkdown` decides whether to offer "Paste as formatted text?".
 * It scores STRUCTURE — headings, fenced code, lists, tables, links, paired
 * emphasis — and needs more than one weak signal, so ordinary chat text that
 * happens to contain an asterisk (`2 * 3`, `*sigh*`, a footnote star) never
 * triggers it.
 *
 * `convertMarkdown` rewrites CommonMark / GitHub-flavoured Markdown into the
 * Discord-style syntax our renderer speaks. The two agree on most things; the
 * ones that matter:
 *   - GFM `__bold__` means BOLD, ours means underline   -> `**bold**`
 *   - GFM `_italic_`                                      -> `*italic*`
 *   - `####`-`######` headings (we stop at ###)          -> `###`
 *   - setext headings (`Title` over `===` / `---`)       -> `#` / `##`
 *   - `+ item`, `1) item`, task lists `- [ ] / - [x]`     -> `- item`, `1. item`, ☐ / ☑
 *   - horizontal rules                                   -> a blank line
 *   - tables                                             -> an aligned code block
 *   - images `![alt](url)`                               -> a link
 *   - `~~~` fences                                       -> ``` fences
 *   - a few inline HTML tags (<b>, <i>, <u>, <s>, <code>, <br>)
 *   - nested `> >` quotes                                -> one level (we have one)
 * Code (fenced and inline) is never rewritten.
 *
 * The prompt is only offered when converting would actually change something:
 * Markdown that is already in our syntax renders formatted as it is.
 * All of this is linear: line-by-line, with regexes whose classes cannot
 * overlap their own terminators.
 */

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^(#{1,6})[ \t]+(\S.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE_RE = /^ {0,3}>/;

/** `Title ##` -> `Title` (an ATX heading's optional closing hashes), without a backtracking regex. */
function stripClosingHashes(s: string): string {
    let end = s.length;
    while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
    let h = end;
    while (h > 0 && s[h - 1] === '#') h--;
    if (h < end && (h === 0 || s[h - 1] === ' ' || s[h - 1] === '\t')) end = h;
    while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
    return s.slice(0, end) || s;
}

/** Split a table row on unescaped pipes outside inline code. */
function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells: string[] = [];
    let cur = '';
    let inCode = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
        if (c === '`') inCode = !inCode;
        if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    cells.push(cur.trim());
    return cells;
}

function isTableStart(lines: string[], i: number): boolean {
    const head = lines[i];
    const sep = lines[i + 1];
    if (sep === undefined || !head.includes('|')) return false;
    if (sep.length > 4000 || !TABLE_SEP_RE.test(sep) || !sep.includes('-')) return false;
    const cols = splitRow(head).length;
    return cols >= 2 && splitRow(sep).length === cols;
}

/** Inline Markdown reduced to plain text for a table cell (a code block shows text literally). */
function cellPlain(cell: string): string {
    return cell
        .replace(/!?\[([^[\]\n]*)\]\(([^)\s]*)\)/g, '$1')
        .replace(/`([^`\n]*)`/g, '$1')
        .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2')
        .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?!\w)/g, '$1$2')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1');
}

/** Display width: wide (CJK / emoji) code points count as 2 so columns line up in a monospace font. */
function width(s: string): number {
    let w = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
            || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
            || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1;
    }
    return w;
}

function pad(s: string, w: number, align: 'l' | 'c' | 'r'): string {
    const gap = Math.max(0, w - width(s));
    if (align === 'r') return ' '.repeat(gap) + s;
    if (align === 'c') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
    return s + ' '.repeat(gap);
}

/** A GFM table as the lines of an aligned ``` block. */
function tableToCodeBlock(rows: string[][], aligns: ('l' | 'c' | 'r')[]): string[] {
    const cols = aligns.length;
    const cells = rows.map(r => Array.from({ length: cols }, (_, i) => cellPlain(r[i] ?? '')));
    const widths = Array.from({ length: cols }, (_, i) => Math.max(1, ...cells.map(r => width(r[i]))));
    const fmt = (r: string[]) => r.map((c, i) => pad(c, widths[i], aligns[i])).join(' │ ').replace(/\s+$/, '');
    const rule = widths.map(w => '─'.repeat(w)).join('─┼─');
    return ['```', fmt(cells[0]), rule, ...cells.slice(1).map(fmt), '```'];
}

/** Inline rewrites on one line of NON-code text (code spans are passed through). */
function convertInline(line: string): string {
    // Split out inline code spans so nothing inside them changes.
    const parts = line.split(/(`+[^`]*`+)/);
    return parts.map((p, i) => {
        if (i % 2 === 1) return p;
        return p
            // Images become links (the link card / image embed takes it from there).
            .replace(/!\[([^[\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt: string, url: string) => `[${alt || 'image'}](${url})`)
            // GFM strong with underscores is BOLD here (ours would underline).
            .replace(/(^|[^\w\\])__(?=\S)([^_\n]*?\S)__(?![\w_])/g, '$1**$2**')
            // GFM emphasis with underscores -> asterisks (ours would also italicise
            // `_x_`, but `*x*` is the one form both grammars read the same way).
            .replace(/(^|[^\w\\_])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?![\w_])/g, '$1*$2*')
            // A few inline HTML tags, AFTER the underscore rules so <u> stays underline.
            .replace(/<\/?(?:b|strong)>/gi, '**')
            .replace(/<\/?(?:i|em)>/gi, '*')
            .replace(/<\/?u>/gi, '__')
            .replace(/<\/?(?:s|del|strike)>/gi, '~~')
            .replace(/<\/?code>/gi, '`')
            .replace(/<br\s*\/?>/gi, '\n')
            // Two trailing spaces were a hard break; a newline already is one.
            .replace(/ {2,}$/, '');
    }).join('');
}

/** Convert pasted CommonMark / GFM to our syntax (see the file comment). */
export function convertMarkdown(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let fence: { char: string; len: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const f = FENCE_RE.exec(line);
        if (fence) {
            if (f && f[2][0] === fence.char && f[2].length >= fence.len && f[3].trim() === '') {
                out.push('```');
                fence = null;
            } else {
                out.push(line);
            }
            continue;
        }
        if (f) {
            fence = { char: f[2][0], len: f[2].length };
            out.push('```' + f[3].trim().split(/\s+/)[0]);
            continue;
        }
        if (isTableStart(lines, i)) {
            const aligns = splitRow(lines[i + 1]).map(c => {
                const l = c.startsWith(':');
                const r = c.endsWith(':');
                return (l && r ? 'c' : r ? 'r' : 'l') as 'l' | 'c' | 'r';
            });
            const rows = [splitRow(line)];
            let j = i + 2;
            while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
                rows.push(splitRow(lines[j]));
                j++;
            }
            out.push(...tableToCodeBlock(rows, aligns));
            i = j - 1;
            continue;
        }
        // Setext heading: a text line underlined by === or ---.
        const next = lines[i + 1];
        if (next !== undefined && line.trim() !== '' && SETEXT_RE.test(next) && !LIST_RE.test(line) && !QUOTE_RE.test(line)) {
            out.push(`${next.trim()[0] === '=' ? '#' : '##'} ${convertInline(line.trim())}`);
            i++;
            continue;
        }
        if (HR_RE.test(line)) { out.push(''); continue; }
        const h = ATX_RE.exec(line);
        if (h) {
            out.push(`${'#'.repeat(Math.min(3, h[1].length))} ${convertInline(stripClosingHashes(h[2]))}`);
            continue;
        }
        if (QUOTE_RE.test(line)) {
            const body = line.replace(/^ {0,3}(?:>[ \t]?)+/, '');
            out.push(body.trim() === '' ? '>' : `> ${convertInline(body)}`);
            continue;
        }
        const li = LIST_RE.exec(line);
        if (li) {
            const indent = li[1].replace(/\t/g, '  ');
            const ordered = /\d/.test(li[2]);
            let body = li[3];
            const task = TASK_RE.exec(body);
            if (task) body = (task[1] === ' ' ? '☐ ' : '☑ ') + body.slice(task[0].length);
            const marker = ordered ? `${parseInt(li[2], 10)}.` : '-';
            out.push(`${indent}${marker} ${convertInline(body)}`);
            continue;
        }
        out.push(convertInline(line));
    }
    if (fence) out.push('```');
    return out.join('\n');
}

/** A paste shorter than this is never offered conversion (a word or two of chat). */
const MIN_LENGTH = 12;
/** Score needed to offer conversion. */
const THRESHOLD = 3;

/**
 * Whether pasted text is (very probably) Markdown. Each structural signal adds
 * to a score; a lone emphasis or a single list-looking line is not enough.
 */
export function looksLikeMarkdown(text: string): boolean {
    if (typeof text !== 'string' || text.length < MIN_LENGTH) return false;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let score = 0;
    let listLines = 0;
    let fences = 0;
    for (let i = 0; i < lines.length && score < THRESHOLD + 3; i++) {
        const line = lines[i];
        if (FENCE_RE.test(line)) { fences++; continue; }
        if (/^#{1,6}[ \t]+\S/.test(line)) score += 2;
        if (LIST_RE.test(line) && !/^\s*\*[ \t]+\S.*\*\s*$/.test(line)) listLines++;
        if (TASK_RE.test(line.replace(/^\s*[-*+][ \t]+/, ''))) score += 2;
        if (isTableStart(lines, i)) score += 4;
        if (/^ {0,3}>[ \t]?\S/.test(line)) score += 1;
        if (/\[[^[\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(line)) score += 2;
        if (/(^|[^\w*])\*\*(?=\S)[^*\n]*\S\*\*(?!\*)/.test(line) || /(^|[^\w_])__(?=\S)[^_\n]*\S__(?![\w_])/.test(line)) score += 1;
        if (/(^|[^`])`[^`\n]+`(?!`)/.test(line)) score += 1;
        if (HR_RE.test(line) && i > 0) score += 1;
    }
    if (fences >= 2) score += 3;
    if (listLines >= 2) score += Math.min(3, listLines);
    return score >= THRESHOLD;
}

/** Offer "Paste as formatted text?" only when the text is Markdown AND converting it would change it. */
export function shouldOfferMarkdownConversion(text: string): boolean {
    return looksLikeMarkdown(text) && convertMarkdown(text) !== text.replace(/\r\n?/g, '\n');
}
