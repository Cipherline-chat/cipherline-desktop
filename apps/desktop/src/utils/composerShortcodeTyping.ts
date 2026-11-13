/**
 * What the composer does WHILE a `:shortcode:` is being typed (the pure half;
 * hooks/useComposerShortcodes.ts wires it to the textarea).
 *
 *  1. CLOSING COLON  - typing the `:` that completes a known name turns
 *     `:red_heart:` into the emoji in the box, before the message is sent.
 *  2. CODE           - nothing in inline code or a code block is touched.
 *
 * Space is NOT handled here: in the message bar it is always an ordinary
 * space (the owner's rule - the space-to-underscore behaviour belongs to the
 * emoji NAME inputs only, utils/emojiNames.sanitizeEmojiNameInput). A typed
 * `:red heart:` is converted on its closing colon only because the whole span
 * between the colons is a complete known name; any other text with spaces
 * stays as typed.
 *
 * Every rule here is about WHEN to act; WHAT a name means (standard / server /
 * My Emoji, and whether the viewer may use it) is decided once, in
 * components/composer/emojiSuggestions.ts, the same code the autocomplete uses.
 *
 * Pure: strings in, plans out. No DOM, React or storage, so the whole rule is
 * unit-tested, including the negatives (`12:30`, `note: hi`, `:)`, `::`).
 */
import type { ExactEmoji } from '../components/composer/emojiSuggestions';

/** A shortcode body: name words joined by ONE space each (old-style `red heart`),
 *  dash or underscore. Never starts or ends with a space, never holds a colon. */
const BODY_RE = /^[A-Za-z0-9_+-]+(?: [A-Za-z0-9_+-]+){0,4}$/;
const MAX_BODY = 64;
const ALNUM = /[A-Za-z0-9]/;

/**
 * Code ranges in `text` as [start, end) pairs: ``` fences (an unclosed one runs
 * to the end) and `inline` spans (these never cross a line break, so a stray
 * backtick cannot silence the rest of the message).
 */
export function codeRanges(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    if (text.indexOf('`') < 0) return out;
    let i = 0;
    while (i < text.length) {
        if (text.startsWith('```', i)) {
            const close = text.indexOf('```', i + 3);
            const end = close < 0 ? text.length : close + 3;
            out.push([i, end]);
            i = end;
        } else if (text[i] === '`') {
            const nl = text.indexOf('\n', i + 1);
            const lineEnd = nl < 0 ? text.length : nl;
            const close = text.indexOf('`', i + 1);
            if (close >= 0 && close < lineEnd) { out.push([i, close + 1]); i = close + 1; }
            else { out.push([i, lineEnd]); i = lineEnd; } // unclosed: to the end of this line
        } else {
            i++;
        }
    }
    return out;
}

/** Is the character at `index` inside code (so literal text)? */
export function isInsideCode(text: string, index: number): boolean {
    for (const [s, e] of codeRanges(text)) if (index >= s && index < e) return true;
    return false;
}

/** Is `index` an opening colon that really starts a shortcode (not `12:30`,
 *  `note:x`, `http://x`)? The colon may follow a space, punctuation, an emoji,
 *  the start, or another colon (`:a::b:`) - never a letter or digit. */
function opensShortcodeAt(text: string, index: number): boolean {
    if (index > 0 && ALNUM.test(text[index - 1])) return false;
    return !isInsideCode(text, index);
}

export interface TypedShortcode {
    /** index of the opening colon */
    start: number;
    /** index just past the closing colon (the caret) */
    end: number;
    /** the text between the colons, as typed */
    body: string;
}

/**
 * The complete `:name:` whose CLOSING colon is the character just before
 * `caret` - or null. Looks only at the nearest preceding colon, so a clock
 * (`10:30:45`), a label (`note: hi`), `::`, `:)` and any text with a space at
 * the colon never qualify, however it is spelled.
 */
export function findTypedShortcode(text: string, caret: number): TypedShortcode | null {
    if (caret < 4 || text[caret - 1] !== ':') return null;
    const open = text.lastIndexOf(':', caret - 2);
    if (open < 0) return null;
    const body = text.slice(open + 1, caret - 1);
    if (body.length < 2 || body.length > MAX_BODY || !BODY_RE.test(body)) return null;
    if (!opensShortcodeAt(text, open)) return null;
    if (isInsideCode(text, caret - 1)) return null;
    return { start: open, end: caret, body };
}

export interface LiveConversion {
    start: number;
    end: number;
    /** the text that should sit at [start, end) afterwards (== the old slice when only a pick is registered) */
    replacement: string;
    /** custom emojis stay `:name:` in the box; this is the wire token the send maps it to */
    pick?: { display: string; token: string };
}

/**
 * What typing the closing colon should do, given how a name resolves for this
 * viewer (`resolve` is the autocomplete's own rule - utils of
 * components/composer/emojiSuggestions.resolveExactEmoji). null = leave the
 * text exactly as typed (unknown name, or one the viewer may not use).
 *
 *  - standard emoji      -> the glyph replaces `:name:`;
 *  - server / My Emoji   -> a textarea cannot hold a picture, so, exactly like
 *    picking from the menu, the box keeps `:name:` (canonical spelling, so
 *    `:Red-Heart:` becomes `:red_heart:`) and the wire token is registered.
 */
export function planLiveConversion(
    text: string,
    caret: number,
    resolve: (typed: string) => ExactEmoji | undefined,
): LiveConversion | null {
    const m = findTypedShortcode(text, caret);
    if (!m) return null;
    const hit = resolve(m.body);
    if (!hit) return null;
    if (hit.kind === 'native') return { start: m.start, end: m.end, replacement: hit.glyph };
    const { name, id } = hit.suggestion;
    const display = `:${name}:`;
    return { start: m.start, end: m.end, replacement: display, pick: { display, token: `<:${name}:${id}>` } };
}
