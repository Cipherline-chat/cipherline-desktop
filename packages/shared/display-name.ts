/**
 * Display names — the rule for the free-form "what is this called" strings a
 * server member types for a CHANNEL, a CATEGORY or a CALL (and a Calls
 * channel's call-naming fixed name / template).
 *
 * ONE implementation, used by both sides:
 *   • the API refuses (400, never strips or coerces) anything it rejects;
 *   • the desktop runs the identical function for inline feedback while the
 *     user types, and trims before sending. A client that skips the mirror
 *     just gets the server's 400.
 *
 * ── ALLOWED ────────────────────────────────────────────────────────────────
 * Letters in any script (\p{L}), combining marks (\p{M}), numbers (\p{N}),
 * punctuation (\p{P}), symbols incl. emoji (\p{S}) and the ordinary space
 * U+0020. Emoji sequences work: skin-tone modifiers, flags (regional
 * indicator pairs), keycaps (1️⃣), variation selectors (VS15/VS16), ZWJ
 * sequences (👨\u200D👩\u200D👧) and tag sequences (🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}).
 *
 * ── REJECTED ───────────────────────────────────────────────────────────────
 *   • control characters (\p{Cc}: newlines, tabs, NUL, ...) and line/paragraph
 *     separators;
 *   • every other invisible / direction-control FORMAT character (\p{Cf}):
 *     bidi embeddings/overrides/isolates and the LRM/RLM/ALM marks (text
 *     spoofing), zero-width space/non-joiner/word-joiner/BOM, soft hyphen,
 *     invisible math operators ... The two exceptions are the ones emoji need,
 *     and ONLY in an emoji context: ZWJ (U+200D) between two pictographs, and
 *     tag characters (U+E0020-E007F) as a tag sequence on a pictograph that is
 *     closed by the cancel tag. A stray one anywhere else is refused
 *     (a run of tag characters is an invisible-text smuggling channel);
 *   • non-ASCII whitespace (NBSP, ideographic space, thin spaces, ...) and the
 *     blank-looking "filler" letters (Hangul fillers, braille blank, ...);
 *   • unassigned, private-use and surrogate code points. (A code point that is
 *     unassigned in this runtime's Unicode tables but sits in an emoji block
 *     is let through: the API's Node and a newer desktop Electron disagree
 *     about the newest emoji, and refusing one is worse than showing a tofu
 *     box for a reserved cell.);
 *   • leading / trailing whitespace (the client trims before sending);
 *   • "zalgo": more than MAX_MARKS_PER_BASE combining marks on one base
 *     character, or a mark with no base (start of the name / after a space);
 *   • names with nothing visible in them (empty, spaces only, marks only);
 *   • too long: measured in grapheme clusters (one emoji = 1) against the
 *     field's maximum, AND a hard cap on UTF-16 code units
 *     (DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME x the maximum) so one "character"
 *     of stacked ZWJ/tag material cannot blow up storage.
 *
 * Deliberate limits: ZWJ/ZWNJ are only accepted inside emoji, so Persian
 * half-spaces and Indic conjuncts that need U+200C/U+200D are refused, and
 * any-script names allow look-alike (homoglyph) letters. Both were accepted by
 * the owner as the price of "letters in any script, plus emoji".
 *
 * SERVER names and ROLE names use the same rule (aesthetic names such as
 * "✦ ꒰ Moonlit Café ꒱ ✦" or "『 𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬 』"): `serverNameError` (2-50 graphemes)
 * and `roleNameError` (1-50). Neither column has a database CHECK on its
 * content. Usernames are NOT governed by this file (they have their own
 * rules); neither are emoji-shortcode names.
 */

/** Combining marks allowed on a single base character. */
export const MAX_MARKS_PER_BASE = 3;
/** Hard UTF-16 code-unit allowance per grapheme of the field's maximum. */
export const DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME = 4;

/** Channel and category names: at most this many grapheme clusters. */
export const CHANNEL_NAME_MAX_GRAPHEMES = 50;
/** Server names: 2..SERVER_NAME_MAX_GRAPHEMES grapheme clusters. */
export const SERVER_NAME_MIN_GRAPHEMES = 2;
export const SERVER_NAME_MAX_GRAPHEMES = 50;
/** Role names: 1..ROLE_NAME_MAX_GRAPHEMES grapheme clusters. */
export const ROLE_NAME_MAX_GRAPHEMES = 50;
/** A call's name (rename, call-naming fixed name / template): grapheme clusters. */
export const CALL_DISPLAY_NAME_MAX_GRAPHEMES = 60;

/** One character a display name may be built from (besides the emoji
 *  joiners / selectors handled in context by `displayNameError`). */
export const DISPLAY_NAME_CHAR = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;

export interface DisplayNameOptions {
    /** Maximum length in grapheme clusters. */
    maxGraphemes: number;
    /** Minimum length in grapheme clusters (default 1). */
    minGraphemes?: number;
}

const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const TAG_FIRST = 0xe0020;
const TAG_LAST = 0xe007e;
const TAG_CANCEL = 0xe007f;

const CC = /\p{Cc}/u;
const CF = /\p{Cf}/u;
const CS_CO = /[\p{Cs}\p{Co}]/u;
const CN = /\p{Cn}/u;
const EXT_PICT = /\p{Extended_Pictographic}/u;
const MARK = /\p{M}/u;
const ZS = /\p{Zs}/u;
const ZL_ZP = /[\p{Zl}\p{Zp}]/u;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/** Blank-looking letters/marks that \p{L}/\p{S}/\p{M} let through. */
const FILLERS = new Set([0x115f, 0x1160, 0x17b4, 0x17b5, 0x2800, 0x3164, 0xffa0]);

const chr = (cp: number): string => String.fromCodePoint(cp);
const isPict = (cp: number): boolean => EXT_PICT.test(chr(cp));
const isSkinTone = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isTag = (cp: number): boolean => cp >= TAG_FIRST && cp <= TAG_LAST;

/** May a ZWJ sit between `prev` and `next`? Only inside an emoji sequence. */
const zwjJoins = (prev: number | undefined, next: number | undefined): boolean =>
    prev !== undefined && next !== undefined
    && (isPict(prev) || isSkinTone(prev) || prev === VS16)
    && isPict(next);

/** Number of grapheme clusters (Intl.Segmenter; code points where it is missing). */
export function graphemeLength(s: string): number {
    return graphemesOf(s).length;
}

/** The grapheme clusters of `s`. */
export function graphemesOf(s: string): string[] {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment);
    return Array.from(s);
}

/**
 * Shorten `s` to at most `maxGraphemes` grapheme clusters (and the matching
 * code-unit allowance) WITHOUT cutting an emoji sequence in half.
 */
export function clipGraphemes(s: string, maxGraphemes: number): string {
    const maxUnits = maxGraphemes * DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME;
    let out = '';
    let n = 0;
    for (const g of graphemesOf(s)) {
        if (n >= maxGraphemes || out.length + g.length > maxUnits) break;
        out += g;
        n++;
    }
    return out.trimEnd();
}

/**
 * Validate a display name. Returns a short, user-facing reason, or null when
 * the name is fine. Pure; never throws. Does NOT trim: leading/trailing
 * whitespace is an error here (callers that want leniency, like a live input,
 * pass `raw.trim()`).
 */
export function displayNameError(raw: unknown, opts: DisplayNameOptions): string | null {
    if (typeof raw !== 'string') return 'Name must be text';
    const { maxGraphemes } = opts;
    const minGraphemes = opts.minGraphemes ?? 1;
    // Cheap guard first: never segment an absurd input.
    if (raw.length > maxGraphemes * DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME) {
        return `Keep it to ${maxGraphemes} characters`;
    }
    if (raw.length === 0 || raw.trim().length === 0) return 'Enter a name';
    if (raw !== raw.trim()) return 'A name cannot start or end with a space';

    const cps = Array.from(raw, ch => ch.codePointAt(0) as number);
    let prevBase: number | null = null; // last non-mark, non-selector code point
    let marks = 0;
    let tagRun = false; // inside a tag sequence not yet closed by the cancel tag

    for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        const prev = i > 0 ? cps[i - 1] : undefined;
        const ch = chr(c);

        // A tag sequence must be closed: anything but the next tag ends it badly.
        if (tagRun && !isTag(c) && c !== TAG_CANCEL) return 'Names cannot contain hidden characters';

        if (c === 0x20) { prevBase = c; marks = 0; continue; }

        if (c === ZWJ) {
            if (!zwjJoins(prev, cps[i + 1])) return 'Names cannot contain hidden joiner characters outside an emoji';
            marks = 0;
            continue;
        }
        if (isTag(c)) {
            if (!(tagRun || (prev !== undefined && isPict(prev)))) return 'Names cannot contain hidden characters';
            tagRun = true;
            continue;
        }
        if (c === TAG_CANCEL) {
            if (!tagRun) return 'Names cannot contain hidden characters';
            tagRun = false;
            continue;
        }
        if (c === VS15 || c === VS16) {
            if (prevBase === null || prevBase === 0x20 || (prev !== undefined && (prev === VS15 || prev === VS16))) {
                return 'Names cannot contain stray variation selectors';
            }
            continue;
        }

        if (CC.test(ch) || ZL_ZP.test(ch)) return 'Names cannot contain line breaks or control characters';
        if (CF.test(ch)) return 'Names cannot contain hidden or direction-control characters';
        if (CS_CO.test(ch)) return 'Names contain characters that are not allowed';
        if (CN.test(ch) && !isPict(c)) return 'Names contain characters that are not allowed';
        if (ZS.test(ch)) return 'Use regular spaces only';
        if (FILLERS.has(c)) return 'Names cannot contain blank-looking characters';

        if (MARK.test(ch)) {
            if (prevBase === null || prevBase === 0x20) return 'Names cannot start a word with a combining mark';
            marks++;
            if (marks > MAX_MARKS_PER_BASE) return 'Too many stacked accents or marks';
            continue;
        }
        if (!DISPLAY_NAME_CHAR.test(ch) && !(CN.test(ch) && isPict(c))) return 'Names contain characters that are not allowed';
        prevBase = c;
        marks = 0;
    }
    if (tagRun) return 'Names cannot contain hidden characters';
    if (!cps.some(c => VISIBLE.test(chr(c)))) return 'Enter a name';

    const n = graphemeLength(raw);
    if (n < minGraphemes) return minGraphemes <= 1 ? 'Enter a name' : `Use at least ${minGraphemes} characters`;
    if (n > maxGraphemes) return `Keep it to ${maxGraphemes} characters`;
    return null;
}

/** Convenience boolean over `displayNameError`. */
export function isValidDisplayName(raw: unknown, opts: DisplayNameOptions): boolean {
    return displayNameError(raw, opts) === null;
}

/** Channel / category name rule. */
export const channelNameError = (raw: unknown): string | null =>
    displayNameError(raw, { maxGraphemes: CHANNEL_NAME_MAX_GRAPHEMES });

/** Server name rule (create + rename). */
export const serverNameError = (raw: unknown): string | null =>
    displayNameError(raw, { maxGraphemes: SERVER_NAME_MAX_GRAPHEMES, minGraphemes: SERVER_NAME_MIN_GRAPHEMES });

/** Role name rule (create + rename). */
export const roleNameError = (raw: unknown): string | null =>
    displayNameError(raw, { maxGraphemes: ROLE_NAME_MAX_GRAPHEMES });

/** Call name rule (manual rename; call-naming literals). */
export const callNameError = (raw: unknown): string | null =>
    displayNameError(raw, { maxGraphemes: CALL_DISPLAY_NAME_MAX_GRAPHEMES });

/**
 * Remove the characters `displayNameError` would refuse for hidden-text
 * reasons from a string that is NOT user-typed against the rule (a member's
 * nickname or a channel name substituted into a call-name template): control
 * and separator characters, every format character except an in-context ZWJ /
 * tag sequence, then whitespace is collapsed. Lenient on purpose: it never
 * rejects, it only guarantees nothing invisible survives.
 */
export function stripHiddenCharacters(s: string): string {
    // Tag characters survive only as a complete tag sequence on a pictograph.
    const cps = vetTagRuns(Array.from(s, ch => ch.codePointAt(0) as number));
    let out = '';
    let prevKept: number | undefined;
    for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        const ch = chr(c);
        let keep = true;
        if (c === ZWJ) keep = zwjJoins(prevKept, cps[i + 1]);
        else if (isTag(c) || c === TAG_CANCEL) keep = true; // vetted by the pass above
        else if (CC.test(ch) || CF.test(ch) || ZL_ZP.test(ch)) keep = false;
        if (keep) { out += ch; prevKept = c; }
    }
    return out.replace(/\s+/g, ' ').trim();
}

const isTagOrCancel = (cp: number): boolean => cp >= TAG_FIRST && cp <= TAG_CANCEL;

/**
 * Drop every tag character (U+E0020..U+E007F) that is not part of a tag
 * sequence on a pictograph, in ONE linear pass over each maximal run of tag
 * characters:
 *   - a run that does not directly follow an Extended_Pictographic is dropped;
 *   - on a pictograph, everything after the run's LAST cancel tag (U+E007F) is
 *     dropped (an unterminated sequence), and so is a cancel tag that opens the
 *     run or follows another cancel tag; the rest is kept.
 *
 * This replaces the regex
 *   /(?<![\p{Extended_Pictographic}\u{E0020}-\u{E007F}])[\u{E0020}-\u{E007F}]+
 *    |[\u{E0020}-\u{E007E}]+(?![\u{E0020}-\u{E007F}])
 *    |(?<![\u{E0020}-\u{E007E}])\u{E007F}/gu
 * which produced exactly this output but backtracked quadratically on a long
 * run of tags followed by a cancel tag (CodeQL js/polynomial-redos: 16k code
 * points took ~2.3 s), reachable from third-party text such as a Discord
 * template's channel names on the API. `displayName.test.ts` pins the
 * equivalence against that regex on random and adversarial input.
 */
function vetTagRuns(cps: number[]): number[] {
    const out: number[] = [];
    let i = 0;
    while (i < cps.length) {
        if (!isTagOrCancel(cps[i])) { out.push(cps[i]); i++; continue; }
        let end = i;
        let lastCancel = -1;
        while (end < cps.length && isTagOrCancel(cps[end])) {
            if (cps[end] === TAG_CANCEL) lastCancel = end;
            end++;
        }
        if (i > 0 && isPict(cps[i - 1])) {
            for (let j = i; j <= lastCancel; j++) {
                if (cps[j] === TAG_CANCEL && (j === i || cps[j - 1] === TAG_CANCEL)) continue;
                out.push(cps[j]);
            }
        }
        i = end;
    }
    return out;
}
