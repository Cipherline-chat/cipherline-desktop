/**
 * Pure text edits behind the composer's formatting bar and shortcuts.
 *
 * Every function takes the textarea's value and selection and returns the new
 * value and selection, so the component only has to apply the result (as an
 * undoable edit). Since the WYSIWYG composer (components/composer/RichComposer)
 * the BOX no longer uses these string edits for styling (it edits its document
 * model); shortcutAction / labels / insertLink are still shared. Nothing
 * here touches the DOM, which is what lets the toggling rules be unit-tested.
 *
 * Inline styles wrap the selection — or, with nothing selected, drop an empty
 * pair with the caret inside — and toggle OFF when the selection is already
 * wrapped (markers just outside it, or included in it). Line styles (quote,
 * lists, heading) prefix every line the selection touches and toggle off when
 * every one of them already has it.
 */

export interface ComposerEdit {
    value: string;
    selStart: number;
    selEnd: number;
}

export type InlineStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler';
export type LineStyle = 'quote' | 'bullet' | 'number' | 'heading';

export const INLINE_MARKERS: Record<InlineStyle, string> = {
    bold: '**',
    italic: '*',
    underline: '__',
    strike: '~~',
    code: '`',
    spoiler: '||',
};

/** Length of the run of `ch` ending at `end` (exclusive) going left. */
function runLeft(s: string, end: number, ch: string): number {
    let n = 0;
    while (end - n - 1 >= 0 && s[end - n - 1] === ch) n++;
    return n;
}

/** Length of the run of `ch` starting at `start`. */
function runRight(s: string, start: number, ch: string): number {
    let n = 0;
    while (start + n < s.length && s[start + n] === ch) n++;
    return n;
}

/**
 * Whether a run of `run` copies of the marker char carries this style. Bold
 * and italic share `*`: italic is an odd run (1 or 3), bold a run of 2+, so
 * `***x***` is both and either can be peeled off independently.
 */
function runHas(style: InlineStyle, run: number): boolean {
    if (style === 'italic') return run % 2 === 1;
    if (style === 'bold') return run >= 2;
    return run >= INLINE_MARKERS[style].length;
}

/** Toggle an inline style around the selection. */
export function toggleInline(value: string, selStart: number, selEnd: number, style: InlineStyle): ComposerEdit {
    const marker = INLINE_MARKERS[style];
    const ch = marker[0];
    const m = marker.length;
    let s = Math.min(selStart, selEnd);
    let e = Math.max(selStart, selEnd);

    // Whitespace at the edges of a selection stays outside the markers:
    // `** bold**` would not render.
    while (s < e && /\s/.test(value[s])) s++;
    while (e > s && /\s/.test(value[e - 1])) e--;

    // Already wrapped from the outside: `**|sel|**` -> peel.
    const left = runLeft(value, s, ch);
    const right = runRight(value, e, ch);
    if (runHas(style, left) && runHas(style, right)) {
        const next = value.slice(0, s - m) + value.slice(s, e) + value.slice(e + m);
        return { value: next, selStart: s - m, selEnd: e - m };
    }

    // Wrapped from the inside: `|**sel**|` -> peel.
    if (e - s >= 2 * m + 1) {
        const inLeft = runRight(value, s, ch);
        const inRight = runLeft(value, e, ch);
        if (inLeft === inRight && runHas(style, inLeft) && value.slice(s, e).length > inLeft * 2) {
            const inner = value.slice(s + m, e - m);
            const next = value.slice(0, s) + inner + value.slice(e);
            return { value: next, selStart: s, selEnd: s + inner.length };
        }
    }

    // Nothing selected (or only whitespace): an empty pair with the caret inside.
    if (s >= e) {
        const at = Math.min(selStart, selEnd);
        const next = value.slice(0, at) + marker + marker + value.slice(at);
        return { value: next, selStart: at + m, selEnd: at + m };
    }

    // Code keeps a selection's newlines inside a code BLOCK instead.
    if (style === 'code' && value.slice(s, e).includes('\n')) return toggleCodeBlock(value, s, e);

    const next = value.slice(0, s) + marker + value.slice(s, e) + marker + value.slice(e);
    return { value: next, selStart: s + m, selEnd: e + m };
}

/** Wrap the selection in a ``` block on its own lines, or unwrap one. */
export function toggleCodeBlock(value: string, selStart: number, selEnd: number): ComposerEdit {
    const s = Math.min(selStart, selEnd);
    const e = Math.max(selStart, selEnd);
    const sel = value.slice(s, e);
    // Unwrap: the selection is exactly a fenced block.
    const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(sel);
    if (fenced) {
        const inner = fenced[1];
        return { value: value.slice(0, s) + inner + value.slice(e), selStart: s, selEnd: s + inner.length };
    }
    const before = value.slice(0, s);
    const after = value.slice(e);
    const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n';
    const trail = after.length === 0 || after.startsWith('\n') ? '' : '\n';
    const open = `${lead}\`\`\`\n`;
    const close = `\n\`\`\`${trail}`;
    const next = before + open + sel + close + after;
    const innerStart = s + open.length;
    return { value: next, selStart: innerStart, selEnd: innerStart + sel.length };
}

const URLISH = /^(?:https?:\/\/|www\.)\S+$/i;
const LINK_PLACEHOLDER = 'https://';

/**
 * `[selection](https://)` with the placeholder URL selected, ready to paste
 * over. A selected URL becomes the destination instead, with "link text"
 * selected for the label.
 */
export function insertLink(value: string, selStart: number, selEnd: number): ComposerEdit {
    const s = Math.min(selStart, selEnd);
    const e = Math.max(selStart, selEnd);
    const sel = value.slice(s, e).trim();
    if (sel && URLISH.test(sel)) {
        const url = /^www\./i.test(sel) ? `https://${sel}` : sel;
        const label = 'link text';
        const ins = `[${label}](${url})`;
        return { value: value.slice(0, s) + ins + value.slice(e), selStart: s + 1, selEnd: s + 1 + label.length };
    }
    const label = sel || 'link text';
    const ins = `[${label}](${LINK_PLACEHOLDER})`;
    const urlStart = s + label.length + 3;
    if (!sel) {
        // No selection: select the label placeholder first (type the words, then the URL).
        return { value: value.slice(0, s) + ins + value.slice(e), selStart: s + 1, selEnd: s + 1 + label.length };
    }
    return { value: value.slice(0, s) + ins + value.slice(e), selStart: urlStart, selEnd: urlStart + LINK_PLACEHOLDER.length };
}

const QUOTE_RE = /^> ?/;
const BULLET_RE = /^(\s*)[-*] /;
const NUMBER_RE = /^(\s*)\d{1,9}\. /;
const HEADING_RE = /^(#{1,3}) /;

function lineBounds(value: string, s: number, e: number): { from: number; to: number } {
    const from = value.lastIndexOf('\n', s - 1) + 1;
    // A selection ending right at a line start does not include that line.
    const endAt = e > s && value[e - 1] === '\n' ? e - 1 : e;
    let to = value.indexOf('\n', endAt);
    if (to < 0) to = value.length;
    return { from, to };
}

/** Toggle a line prefix on every line the selection touches. Heading cycles # -> ## -> ### -> none. */
export function toggleLinePrefix(value: string, selStart: number, selEnd: number, style: LineStyle): ComposerEdit {
    const s = Math.min(selStart, selEnd);
    const e = Math.max(selStart, selEnd);
    const { from, to } = lineBounds(value, s, e);
    const lines = value.slice(from, to).split('\n');

    let out: string[];
    if (style === 'heading') {
        // Cycle on the first line's level; every line follows it.
        const level = HEADING_RE.exec(lines[0])?.[1].length ?? 0;
        const nextLevel = level >= 3 ? 0 : level + 1;
        out = lines.map(l => {
            const bare = l.replace(HEADING_RE, '');
            return nextLevel === 0 ? bare : `${'#'.repeat(nextLevel)} ${bare}`;
        });
    } else {
        const re = style === 'quote' ? QUOTE_RE : style === 'bullet' ? BULLET_RE : NUMBER_RE;
        const nonEmpty = lines.filter(l => l.trim() !== '');
        const allHave = nonEmpty.length > 0 && nonEmpty.every(l => re.test(l));
        if (allHave) {
            out = lines.map(l => l.replace(re, (_all, indent?: string) => (typeof indent === 'string' ? indent : '')));
        } else {
            let n = 0;
            out = lines.map(l => {
                if (l.trim() === '' && lines.length > 1) return l;
                // Switching list kinds replaces the other marker instead of stacking.
                const bare = style === 'quote' ? l.replace(QUOTE_RE, '') : l.replace(BULLET_RE, '$1').replace(NUMBER_RE, '$1');
                const indent = /^\s*/.exec(bare)?.[0] ?? '';
                const rest = bare.slice(indent.length);
                if (style === 'quote') return `> ${bare}`;
                n++;
                return `${indent}${style === 'bullet' ? '- ' : `${n}. `}${rest}`;
            });
        }
    }
    const replaced = out.join('\n');
    const next = value.slice(0, from) + replaced + value.slice(to);
    const delta = replaced.length - (to - from);
    if (s === e) {
        // Caret: keep it at the same place in the line's text, past any new prefix.
        const caret = Math.max(from, Math.min(from + replaced.length, s + (lines.length === 1 ? delta : 0)));
        return { value: next, selStart: caret, selEnd: caret };
    }
    return { value: next, selStart: from, selEnd: from + replaced.length };
}

// ── List continuation (the newline key inside a list) ───────────────────────

const LIST_ITEM_RE = /^(\s*)([-*]|(\d{1,9})\.) (.*)$/;

/**
 * What the newline key (Shift+Enter) does on a list line, or null when the
 * caret is not on one and the textarea should insert a plain newline.
 *
 *  - an item with text: break the line at the caret and start the next item
 *    (same indent; a numbered list counts up);
 *  - an EMPTY item: end the list — the marker goes, the line stays empty.
 *
 * Enter on its own still sends, exactly as before this feature: the newline
 * key is what continues a list, the way it already makes a new line.
 */
export function continueList(value: string, selStart: number, selEnd: number): ComposerEdit | null {
    if (selStart !== selEnd) return null;
    const caret = selStart;
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = value.indexOf('\n', caret);
    if (lineEnd < 0) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const m = LIST_ITEM_RE.exec(line);
    if (!m) return null;
    const [, indent, marker, num, rest] = m;
    const prefixLen = indent.length + marker.length + 1;
    if (caret < lineStart + prefixLen) return null;
    if (rest.trim() === '') {
        const next = value.slice(0, lineStart) + value.slice(lineEnd);
        return { value: next, selStart: lineStart, selEnd: lineStart };
    }
    const nextMarker = num !== undefined ? `${parseInt(num, 10) + 1}.` : marker;
    const ins = `\n${indent}${nextMarker} `;
    const next = value.slice(0, caret) + ins + value.slice(caret);
    return { value: next, selStart: caret + ins.length, selEnd: caret + ins.length };
}

/** What a key press of Enter does in the composer (owner, 2026-11-16). */
export type EnterAction =
    | { kind: 'send' }
    | { kind: 'continue'; edit: ComposerEdit }
    | { kind: 'newline' };

/**
 * The composer's Enter rule, as the owner put it: "shift enter to continue a
 * list, if it is not a list enter will send, shift enter starts a new line."
 *  - Enter (no Shift) ALWAYS sends — on a list line too;
 *  - Shift+Enter on a list line adds the next item (an empty item ends the list);
 *  - Shift+Enter anywhere else is a plain new line (the textarea's own).
 * null: not Enter, or an IME composition owns the key.
 */
export function enterAction(
    k: { key: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean },
    value: string, selStart: number, selEnd: number,
): EnterAction | null {
    if (k.key !== 'Enter' || k.isComposing) return null;
    if (!k.shiftKey) return { kind: 'send' };
    if (k.ctrlKey || k.metaKey || k.altKey) return { kind: 'newline' };
    const edit = continueList(value, selStart, selEnd);
    return edit ? { kind: 'continue', edit } : { kind: 'newline' };
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

export type FormatAction = InlineStyle | LineStyle | 'codeBlock' | 'link';

export interface ShortcutKey {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    /** KeyboardEvent.code, used for the letter so Shift / layouts don't matter. */
    code?: string;
}

/** The formatting action for a key combo in the composer, or null. Ctrl on Windows/Linux, Cmd on macOS. */
export function shortcutAction(e: ShortcutKey, isMac: boolean): FormatAction | null {
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey) return null;
    const letter = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    if (e.shiftKey) {
        if (letter === 'x') return 'strike';
        if (letter === 'c') return 'codeBlock';
        return null;
    }
    switch (letter) {
        case 'b': return 'bold';
        case 'i': return 'italic';
        case 'u': return 'underline';
        case 'e': return 'code';
        case 'k': return 'link';
        default: return null;
    }
}

/** Apply any formatting action to a value + selection. */
export function applyFormat(value: string, selStart: number, selEnd: number, action: FormatAction): ComposerEdit {
    switch (action) {
        case 'codeBlock': return toggleCodeBlock(value, selStart, selEnd);
        case 'link': return insertLink(value, selStart, selEnd);
        case 'quote':
        case 'bullet':
        case 'number':
        case 'heading':
            return toggleLinePrefix(value, selStart, selEnd, action);
        default:
            return toggleInline(value, selStart, selEnd, action);
    }
}

/** Human label for a shortcut, for tooltips and aria-keyshortcuts. */
export function shortcutLabel(action: FormatAction, isMac: boolean): string | null {
    const mod = isMac ? '⌘' : 'Ctrl+';
    const shift = isMac ? '⇧' : 'Shift+';
    switch (action) {
        case 'bold': return `${mod}B`;
        case 'italic': return `${mod}I`;
        case 'underline': return `${mod}U`;
        case 'strike': return `${mod}${shift}X`;
        case 'code': return `${mod}E`;
        case 'codeBlock': return `${mod}${shift}C`;
        case 'link': return `${mod}K`;
        default: return null;
    }
}

/** aria-keyshortcuts value (WAI-ARIA wants `Control+B` / `Meta+B`). */
export function ariaShortcut(action: FormatAction, isMac: boolean): string | undefined {
    const mod = isMac ? 'Meta' : 'Control';
    switch (action) {
        case 'bold': return `${mod}+B`;
        case 'italic': return `${mod}+I`;
        case 'underline': return `${mod}+U`;
        case 'strike': return `${mod}+Shift+X`;
        case 'code': return `${mod}+E`;
        case 'codeBlock': return `${mod}+Shift+C`;
        case 'link': return `${mod}+K`;
        default: return undefined;
    }
}
