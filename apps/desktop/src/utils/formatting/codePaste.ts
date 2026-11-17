/**
 * Pasting source code (a snippet, a JSON blob, a stack trace, a log) into the
 * composer: offer "Paste as a code block?" and, on Format, wrap exactly the
 * pasted text in a ``` fence, with a language tag only when we are confident.
 *
 * Detection is deliberately CONSERVATIVE — offering to fence someone's prose
 * is worse than not offering on an odd snippet:
 *  - text already containing a ``` fence is never offered (it is fenced);
 *  - one line: only an unmistakable shell command (a known command word AND a
 *    flag, pipe, `&&` or redirect), or a line of minified JSON that parses;
 *  - several lines: at least 2 lines carry a strong code signal, those make up
 *    at least 60% of the non-blank lines, and the paste does not read as
 *    sentences (a prose line — words, spaces, ends in . ! ? — counts against).
 * A strong line signal is a structural one (brackets / `;` / `=>` at the end,
 * a language keyword opening the line, a JSON key, a stack-trace frame, a
 * timestamped log line, a SQL clause, an indented YAML key…). A single `;`,
 * a URL, a list of names, an address or a `:)` never is.
 *
 * Precedence with Markdown paste (markdownPaste.ts), so only ONE prompt ever
 * shows: text with a ``` fence goes to the Markdown path (it is Markdown with
 * code in it); otherwise code wins when it is detected — code is full of
 * characters Markdown would reinterpret (`#` comments, `*` pointers,
 * `__init__`), so formatting it as Markdown would mangle it; otherwise the
 * Markdown prompt is considered. See `pastePromptFor`.
 *
 * Linear: line by line with anchored, non-overlapping patterns.
 */
import { shouldOfferMarkdownConversion } from './markdownPaste';

export interface CodeGuess {
    /** Fence language when confident, else null (an untagged ``` block). */
    lang: string | null;
}

const SHELL_CMDS = /^(?:\$\s+|sudo\s+)?(?:npm|npx|yarn|pnpm|bun|git|docker|docker-compose|kubectl|helm|curl|wget|ssh|scp|rsync|ls|cat|grep|rg|find|sed|awk|rm|mv|cp|mkdir|chmod|chown|tar|unzip|ps|kill|systemctl|journalctl|python3?|pip3?|node|deno|cargo|rustc|go|make|cmake|brew|apt|apt-get|dnf|pacman|ffmpeg|openssl|terraform|gh|az|aws|gcloud|dotnet|java|mvn|gradle|psql|mysql|redis-cli|tail|head|export|echo|cd|set|source|unset)\b/;
const SHELL_SHAPE = /(?:^|\s)--?[A-Za-z][\w-]*|\s\|\s|&&|\|\||\s>>?\s|\$\(|`/;

const KEYWORD_START = /^\s*(?:import\s+[\w{*]|from\s+[\w.]+\s+import\b|export\s+(?:default|const|function|class|interface|type|async)\b|(?:async\s+)?function\s*[\w(]|(?:const|let|var)\s+[\w{[]+\s*[=:]|class\s+\w+[\s:({<]|interface\s+\w+|type\s+\w+\s*=|def\s+\w+\s*\(|return\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|else\b|elif\b.*:$|try\s*[:{]|catch\s*\(|except\b.*:$|finally\s*[:{]|#include\s*[<"]|#define\s|using\s+[\w.]+;|namespace\s+\w|package\s+[\w.]+;?$|public\s+|private\s+|protected\s+|static\s+|fn\s+\w+|let\s+mut\s|impl\b|func\s+\w|struct\s+\w|enum\s+\w|@\w+(?:\(|$)|print\(|console\.\w+\(|System\.out\.)/;
const LINE_END = /(?:[;{}]|=>|\)\s*\{|\):|\]\s*,?|\}\s*,?|\)\s*;?|,)\s*$/;
const OPERATORS = /===|!==|=>|->|::|\+=|-=|\|\||&&|<\/?[a-z][\w-]*[\s>/]/;
const JSON_KEY = /^\s*"[^"\n]{1,80}"\s*:\s*(?:["{[\dtfn-]|$)/;
const YAML_NESTED_KEY = /^\s{2,}[\w.-]+:(?:\s|$)/;
const YAML_KEY = /^[\w.-]+:(?:\s|$)/;
const STACK_FRAME = /^\s+at\s+\S.*:\d+(?::\d+)?\)?$|^\s+at\s+[\w$.]+\(.*\)$|^\s*File\s+".+",\s+line\s+\d+|^Traceback \(most recent call last\):|^\s*[\w.]+(?:Error|Exception)(?::|$)/;
const LOG_LINE = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?|^\[?\d{2}:\d{2}:\d{2}(?:\.\d+)?\]?\s+\[?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|^(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)[\s:[]/;
const SQL_CLAUSE = /^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW|UNIQUE)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|WITH\s+\w+\s+AS|FROM|WHERE|JOIN|LEFT\s+JOIN|INNER\s+JOIN|GROUP\s+BY|ORDER\s+BY|LIMIT|VALUES|SET)\b/;
const C_PREPROC = /^\s*#(?:include|define|ifdef|ifndef|endif|pragma)\b/;
const SHEBANG = /^#!\//;
/** A line that reads as a sentence: words and spaces, ending like prose. */
const PROSE = /^[\s"'(]*[A-Za-z][A-Za-z'’,-]*(?:\s+[A-Za-z0-9'’,;:()"-]+){3,}[.!?…]["')]*\s*$/;
const COMMENT = /^\s*(?:#(?!!)|\/\/|--\s)/;
const ASSIGNMENT = /^\s*[A-Za-z_$][\w$.]*(?:\[[^\]\n]{0,40}\])?\s*[-+*/%|&]?=\s*[^=\s]/;
const EMOTICON_ONLY_END = /[:;][-']?[()DPp3]\s*$/;

function strongLine(line: string): boolean {
    if (EMOTICON_ONLY_END.test(line) && !/[{};]\s*[:;][-']?[()DPp]/.test(line)) return false;
    return KEYWORD_START.test(line) || JSON_KEY.test(line) || STACK_FRAME.test(line) || LOG_LINE.test(line)
        || C_PREPROC.test(line) || SHEBANG.test(line) || YAML_NESTED_KEY.test(line)
        || (SQL_CLAUSE.test(line) && /[A-Z]{3,}/.test(line))
        || (LINE_END.test(line) && /[(){}[\];=]/.test(line) && !PROSE.test(line))
        || (OPERATORS.test(line) && !PROSE.test(line))
        || (SHELL_CMDS.test(line.trim()) && SHELL_SHAPE.test(line))
        || /^\s*[}\])]+[;,)]*\s*$/.test(line);
}

function guessLang(text: string, lines: string[]): string | null {
    const t = text.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200_000) {
        try { JSON.parse(t); return 'json'; } catch { /* not JSON */ }
    }
    const has = (re: RegExp) => lines.some(l => re.test(l));
    const count = (re: RegExp) => lines.filter(l => re.test(l)).length;
    if (has(/^Traceback \(most recent call last\):/) || has(/^\s*File ".+", line \d+/)) return 'python';
    if (has(STACK_FRAME) || count(LOG_LINE) >= Math.ceil(lines.length / 2)) return null;
    if (SHEBANG.test(lines[0]) && /sh\b/.test(lines[0])) return 'bash';
    if (has(C_PREPROC)) return has(/std::|cout|template\s*</) ? 'cpp' : 'c';
    if (has(/^\s*(?:def\s+\w+\(|from\s+[\w.]+\s+import\b|import\s+[\w.]+(?:\s+as\s+\w+)?\s*$|elif\b|if\s+__name__\s*==|class\s+\w+(?:\(.*\))?:\s*$)/) && !has(/[;{]\s*$/)) return 'python';
    if (has(/^\s*fn\s+\w+|let\s+mut\s|impl\b|println!/)) return 'rust';
    if (has(/^\s*package\s+\w+\s*$/) && has(/^\s*func\s/)) return 'go';
    if (has(/^\s*using\s+System|namespace\s+\w+|Console\.Write/)) return 'cs';
    if (has(/System\.out\.|public\s+(?:static\s+)?(?:class|void)\b/)) return 'java';
    if (count(SQL_CLAUSE) >= Math.ceil(lines.length / 2)) return 'sql';
    if (has(/^\s*(?:import|export)\s.*from\s+['"]|=>|\bconst\s+\w|\blet\s+\w|\bfunction\b|console\.\w+\(/)) {
        return has(/:\s*(?:string|number|boolean|unknown|any|void)\b|\binterface\s+\w|\btype\s+\w+\s*=|<\w+>\(/) ? 'ts' : 'js';
    }
    if (lines.every(l => SHELL_CMDS.test(l.trim()) || /^\s*#/.test(l))) return 'bash';
    if (count(YAML_KEY) + count(YAML_NESTED_KEY) + count(/^\s*-\s+\w/) >= lines.length - 1 && has(YAML_NESTED_KEY)) return 'yaml';
    if (has(/^\s*<[a-zA-Z!]/) && has(/<\/[a-z]/)) return 'html';
    return null;
}

/** Whether pasted text is (very probably) source code / a log / a trace, and its language if clear. */
export function looksLikeCode(text: string): CodeGuess | null {
    if (typeof text !== 'string') return null;
    const src = text.replace(/\r\n?/g, '\n');
    if (src.includes('```') || src.trim().length < 6 || src.length > 100_000) return null;
    const lines = src.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) return null;

    if (lines.length === 1) {
        const line = lines[0].trim();
        if (SHELL_CMDS.test(line) && SHELL_SHAPE.test(line) && !PROSE.test(line)) return { lang: 'bash' };
        if ((line.startsWith('{') || line.startsWith('[')) && line.length >= 8) {
            try { JSON.parse(line); return { lang: 'json' }; } catch { /* not JSON */ }
        }
        return null;
    }

    // Context: once the paste is clearly shell, a bare command line (`npm ci`)
    // is shell too; comment lines (`# …`, `// …`) are neutral, not evidence
    // either way; an assignment (`self.x = 1`) is code.
    const shell = lines.some(l => SHEBANG.test(l) || (SHELL_CMDS.test(l.trim()) && SHELL_SHAPE.test(l)));
    let strong = 0;
    let prose = 0;
    let comments = 0;
    for (const l of lines) {
        if (strongLine(l) || (shell && SHELL_CMDS.test(l.trim())) || ASSIGNMENT.test(l)) strong++;
        else if (COMMENT.test(l)) comments++;
        else if (PROSE.test(l)) prose++;
    }
    const counted = lines.length - comments;
    // YAML is all `key: value` lines; it needs nesting to be told apart from a contact card.
    const yamlish = lines.filter(l => YAML_KEY.test(l) || YAML_NESTED_KEY.test(l) || /^\s*-\s+\S/.test(l)).length;
    if (yamlish === lines.length && lines.some(l => YAML_NESTED_KEY.test(l)) && lines.length >= 3) {
        strong = Math.max(strong, yamlish);
    }
    if (strong < 2) return null;
    if (strong / Math.max(1, counted) < 0.6) return null;
    if (prose > strong / 2) return null;
    return { lang: guessLang(src, lines) };
}

/** Wrap a paste in a fence (the pasted text's own trailing newline stays outside). */
export function fenceCode(text: string, lang: string | null): string {
    const body = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return `\`\`\`${lang ?? ''}\n${body}\n\`\`\``;
}

export type PastePrompt = { kind: 'markdown' } | { kind: 'code'; lang: string | null };

/**
 * The ONE prompt a paste gets, or null. A ``` fence means Markdown (the code
 * is already marked); otherwise detected code wins over Markdown; otherwise
 * Markdown when converting it would change something.
 */
export function pastePromptFor(text: string): PastePrompt | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    if (!text.includes('```')) {
        const code = looksLikeCode(text);
        if (code) return { kind: 'code', lang: code.lang };
    }
    return shouldOfferMarkdownConversion(text) ? { kind: 'markdown' } : null;
}
