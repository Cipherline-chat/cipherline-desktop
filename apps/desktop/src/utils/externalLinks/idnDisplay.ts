/**
 * Should an internationalised hostname be SHOWN in Unicode, or in its raw
 * `xn--` punycode form?
 *
 * The rule is the browser's, the same shape Chromium's IDN spoof checker
 * (components/url_formatter/spoof_checks) applies before its address bar
 * shows Unicode. A host is shown in Unicode only when every label passes; any
 * failing label makes the WHOLE host show as punycode. Per label:
 *
 *   1. It decodes cleanly and canonically (punycode.ts).
 *   2. Only letters, combining marks, ASCII digits and hyphens. Symbols,
 *      invisible/format characters, non-ASCII digits and a short list of
 *      letters that imitate punctuation (ǀ ǁ ǂ ǃ, modifier letters such as
 *      ː ˈ ʻ ʼ, U+0338) all fail.
 *   3. One script (plus Common/Inherited), except the three CJK combinations
 *      ICU's "highly restrictive" profile allows: Latin+Han+Hiragana+Katakana,
 *      Latin+Han+Bopomofo, Latin+Han+Hangul. So `аpple` (Cyrillic а + Latin)
 *      fails as mixed-script.
 *   4. Whole-script confusables: a label written ENTIRELY in Cyrillic (or
 *      Greek) letters that look like Latin ones — `аррӏе` — fails unless the
 *      TLD is one where that script is expected (.ru, .рф, .gr, .ελ, …).
 *
 * What this deliberately does NOT reproduce from Chromium: the skeleton
 * comparison against a list of popular domains (it would need that list
 * shipped and kept fresh) and its per-TLD Kana/Han tweaks. Both only ever
 * turn MORE hosts into punycode, so the gap here is a single-script Latin
 * look-alike with accents, such as `gõogle.com`: shown in Unicode, as a
 * visibly different spelling. The dialog bolds the registrable domain so that
 * spelling is what the eye lands on.
 */
import { labelToUnicode } from './punycode';

export type IdnVerdict =
    | 'ascii'                      // no internationalised label at all
    | 'unicode'                    // IDN that passes: shown in Unicode
    | 'invalid'                    // an xn-- label that does not decode
    | 'disallowed-character'
    | 'mixed-script'
    | 'whole-script-confusable';

export interface HostDisplay {
    /** The host as the browser/OS will use it (lowercase ASCII, punycode). */
    ascii: string;
    /** The host to SHOW: Unicode when `verdict === 'unicode'`, else `ascii`. */
    shown: string;
    /** Unicode form when every label decodes (even if it is not shown). */
    unicode: string | null;
    verdict: IdnVerdict;
}

/** Shown as punycode because the Unicode form could imitate another site. */
export function isSpoofVerdict(v: IdnVerdict): boolean {
    return v === 'invalid' || v === 'disallowed-character' || v === 'mixed-script' || v === 'whole-script-confusable';
}

const SCRIPTS = [
    'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana',
    'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada',
    'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian', 'Hangul',
    'Ethiopic', 'Cherokee', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han',
    'Tifinagh', 'Canadian_Aboriginal',
] as const;
type Script = typeof SCRIPTS[number];
const SCRIPT_RES: ReadonlyArray<[Script, RegExp]> = SCRIPTS.map(s => [s, new RegExp(`^\\p{Script=${s}}$`, 'u')]);
const COMMON_OR_INHERITED_RE = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
const ALLOWED_CHAR_RE = /^[\p{L}\p{M}0-9-]$/u;

/** Letters that pass `\p{L}` but read as punctuation or other letters. */
const BLOCKED_CHARS = new Set<number>([
    0x01c0, 0x01c1, 0x01c2, 0x01c3, // ǀ ǁ ǂ ǃ (click letters: look like l, ||, ‡, !)
    0x0338,                         // combining long solidus overlay (fake slash)
    0x05c3, 0x05f4, 0x06d4, 0x0702, // Hebrew/Arabic/Syriac punctuation look-alikes
    0x3007, 0x30fb,                 // 〇 (looks like o), ・ (looks like a dot)
]);
/** Modifier letters (ˈ ː ʻ ʼ …) look like apostrophes/colons; only the
 *  Japanese prolonged-sound mark is a real letter in a domain. */
const MODIFIER_LETTER_RE = /^\p{Lm}$/u;
const MODIFIER_LETTERS_ALLOWED = new Set<number>([0x30fc, 0x3005, 0x309d, 0x309e, 0x30fd, 0x30fe]);

/** Chromium's "Latin-alike Cyrillic" set: every one of these reads as a Latin letter. */
const CYRILLIC_LATIN_ALIKE = new Set([...'асԁеһіјӏорԛѕԝхуъЬҽпгѵѡ']);
const CYRILLIC_TLDS = new Set(['bg', 'by', 'kz', 'pyc', 'ru', 'su', 'ua', 'uz']);
/** Greek lower-case letters that read as Latin ones (α→a, ο→o, ρ→p, ν→v …). */
const GREEK_LATIN_ALIKE = new Set([...'αβεικνοπρτυχγωϲϳ']);
const GREEK_TLDS = new Set(['gr', 'cy']);

const ALLOWED_MIXES: ReadonlyArray<ReadonlySet<Script>> = [
    new Set<Script>(['Latin', 'Han', 'Hiragana', 'Katakana']),
    new Set<Script>(['Latin', 'Han', 'Bopomofo']),
    new Set<Script>(['Latin', 'Han', 'Hangul']),
];

function scriptOf(ch: string): Script | 'common' | 'unknown' {
    if (COMMON_OR_INHERITED_RE.test(ch)) return 'common';
    for (const [s, re] of SCRIPT_RES) if (re.test(ch)) return s;
    return 'unknown';
}

function tldIsScript(tldUnicode: string, script: 'Cyrillic' | 'Greek'): boolean {
    if (script === 'Cyrillic' && CYRILLIC_TLDS.has(tldUnicode)) return true;
    if (script === 'Greek' && GREEK_TLDS.has(tldUnicode)) return true;
    // An internationalised TLD in that script (.рф, .бг, .ελ …).
    const chars = [...tldUnicode];
    return chars.length > 0 && chars.every(c => scriptOf(c) === script);
}

type LabelVerdict = Exclude<IdnVerdict, 'ascii' | 'unicode' | 'invalid'> | null;

function checkLabel(label: string, tldUnicode: string): LabelVerdict {
    const scripts = new Set<Script>();
    for (const ch of label) {
        const cp = ch.codePointAt(0)!;
        if (!ALLOWED_CHAR_RE.test(ch) || BLOCKED_CHARS.has(cp)) return 'disallowed-character';
        if (MODIFIER_LETTER_RE.test(ch) && !MODIFIER_LETTERS_ALLOWED.has(cp)) return 'disallowed-character';
        const s = scriptOf(ch);
        if (s === 'unknown') return 'disallowed-character';
        if (s !== 'common') scripts.add(s);
    }
    if (scripts.size > 1 && !ALLOWED_MIXES.some(mix => [...scripts].every(s => mix.has(s)))) return 'mixed-script';
    if (scripts.size === 1) {
        const only = [...scripts][0];
        const letters = [...label].filter(c => /\p{L}/u.test(c));
        if (only === 'Cyrillic' && letters.every(c => CYRILLIC_LATIN_ALIKE.has(c)) && !tldIsScript(tldUnicode, 'Cyrillic')) return 'whole-script-confusable';
        if (only === 'Greek' && letters.every(c => GREEK_LATIN_ALIKE.has(c)) && !tldIsScript(tldUnicode, 'Greek')) return 'whole-script-confusable';
    }
    return null;
}

/** Decide how to show an ASCII (already URL-parsed) hostname. */
export function hostDisplay(asciiHost: string): HostDisplay {
    const ascii = asciiHost.toLowerCase();
    const labels = ascii.split('.');
    if (!labels.some(l => l.startsWith('xn--'))) return { ascii, shown: ascii, unicode: null, verdict: 'ascii' };

    const decoded = labels.map(labelToUnicode);
    if (decoded.some(l => l === null)) return { ascii, shown: ascii, unicode: null, verdict: 'invalid' };
    const uLabels = decoded as string[];
    const unicode = uLabels.join('.');
    const tld = uLabels[uLabels.length - 1];
    for (let i = 0; i < labels.length; i++) {
        if (!labels[i].startsWith('xn--')) continue;
        const v = checkLabel(uLabels[i], tld);
        if (v) return { ascii, shown: ascii, unicode, verdict: v };
    }
    return { ascii, shown: unicode, unicode, verdict: 'unicode' };
}
