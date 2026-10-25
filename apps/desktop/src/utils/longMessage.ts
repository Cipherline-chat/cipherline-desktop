/**
 * Long-message collapse: pure logic (no React, no DOM).
 *
 * A text message can be up to MAX_TEXT_MESSAGE_LENGTH (100 000) characters. Past
 * LONG_MESSAGE_THRESHOLD the chat shows only a short preview of it, with a
 * footer to expand it inline or open it in a full-screen reader
 * (components/LongMessage.tsx).
 *
 * WHY THE PREVIEW IS A SLICE OF THE TEXT, NOT A CSS CLIP OF THE FULL RENDER.
 * Collapsing by `max-height` alone would still build the React tree and the DOM
 * for all 100 000 characters of every long message on screen, which is exactly
 * the cost a collapsed message exists to avoid. So the collapsed view renders a
 * ~700-character prefix and the full text is rendered only on expand / open.
 * That is safe here because this app's message renderer has NO block-level
 * markup to break: the text is plain `white-space: pre-wrap` with four inline
 * constructs (mention / custom-emoji tokens, URLs, `#channel` references,
 * emoji), so there is no code fence or list to leave open. What a cut CAN do is
 * land inside one of those inline constructs and turn it into garbage ("<@u:12"
 * as text, half a URL as a link), so `collapsedPreview` never cuts inside them.
 *
 * Counts are UTF-16 code units (`string.length`), the same unit the composer's
 * 100 000-character cap and the server's limit use.
 */

/** A message strictly LONGER than this collapses. 5 000 itself does not. */
export const LONG_MESSAGE_THRESHOLD = 5_000;
/** Target preview length when collapsed. */
export const LONG_MESSAGE_PREVIEW_CHARS = 700;
/** The cut is never moved further back than this (so a preview is never a stub). */
const PREVIEW_MIN_CHARS = 420;
/** A protected construct longer than this is cut before, not after (no giant overshoot). */
const MAX_OVERSHOOT = 300;
/** Reading speed for the "~N min read" estimate. */
const WORDS_PER_MINUTE = 200;

export interface TextSpan { start: number; end: number }

export function isLongMessage(text: unknown): text is string {
    return typeof text === 'string' && text.length > LONG_MESSAGE_THRESHOLD;
}

// The inline constructs the renderer turns into something other than text.
// MENTION_RE mirrors utils/mentionTokens.ts MENTION_TOKEN_RE, URL_RE mirrors
// ChatPane's URL_REGEX; both are pinned by a test so they cannot drift silently.
const MENTION_RE = /<@[ur]:[^:>]{1,64}:[^>]{1,128}>|<:[^:>]{1,64}:[^>]{1,128}>|@everyone|@here/g;
const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

function protectedSpans(text: string, upTo: number, extra: readonly TextSpan[] | undefined): TextSpan[] {
    // Only the head can matter; scan a bounded window, not 100k characters.
    const window = text.slice(0, Math.min(text.length, upTo));
    const spans: TextSpan[] = [];
    for (const re of [MENTION_RE, URL_RE]) {
        const r = new RegExp(re.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = r.exec(window)) !== null) spans.push({ start: m.index, end: m.index + m[0].length });
    }
    if (extra) for (const s of extra) if (s.start < upTo) spans.push(s);
    return spans;
}

export interface CollapsedPreview {
    /** The text to render while collapsed (a prefix of the original). */
    preview: string;
    /** Characters left out of it. */
    hidden: number;
}

/**
 * The prefix to show while a long message is collapsed: about `target`
 * characters, ended on a line break if one is near, else on a word boundary,
 * and never inside a mention/emoji token, a URL, or a `#channel` span (pass
 * those as `extraSpans`), nor between the halves of a surrogate pair.
 * Text no longer than `target` comes back whole.
 */
export function collapsedPreview(
    text: string,
    target: number = LONG_MESSAGE_PREVIEW_CHARS,
    extraSpans?: readonly TextSpan[],
): CollapsedPreview {
    if (text.length <= target) return { preview: text, hidden: 0 };

    const spans = protectedSpans(text, target + MAX_OVERSHOOT + 4_000, extraSpans);
    const straddling = (pos: number): TextSpan | null => {
        let hit: TextSpan | null = null;
        for (const s of spans) {
            if (s.start < pos && pos < s.end && (!hit || s.start < hit.start)) hit = s;
        }
        return hit;
    };
    // Pull `pos` to the left edge of any construct it falls inside. Monotone
    // decreasing, so it terminates; the bound is belt and braces.
    const outside = (pos: number): number => {
        for (let i = 0; i < 64; i++) {
            const s = straddling(pos);
            if (!s) return pos;
            pos = s.start;
        }
        return pos;
    };

    const min = Math.min(PREVIEW_MIN_CHARS, target);
    let cut = outside(target);

    if (cut < min) {
        // A construct covers the whole target window. Prefer finishing it if it
        // is short enough, otherwise cut where the target says and accept it.
        const s = straddling(target);
        cut = s && s.end - target <= MAX_OVERSHOOT ? s.end : target;
    } else {
        // Prefer ending on a line break, then a word boundary, inside [min, cut].
        const nl = text.lastIndexOf('\n', cut - 1);
        if (nl >= min) {
            cut = nl;
        } else {
            let i = cut;
            while (i > min && !/\s/.test(text[i - 1])) i--;
            if (i > min) cut = i;
        }
        cut = outside(cut);
    }

    // Never split a surrogate pair.
    if (cut > 0 && cut < text.length) {
        const prev = text.charCodeAt(cut - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
    }

    const preview = text.slice(0, cut).trimEnd();
    return { preview, hidden: text.length - preview.length };
}

/** Whitespace-delimited word count, without allocating an array for 100k chars. */
export function wordCount(text: string): number {
    let words = 0;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        const space = c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029;
        if (space) inWord = false;
        else if (!inWord) { inWord = true; words++; }
    }
    return words;
}

/** Whole minutes to read `text`, at least 1. */
export function readMinutes(text: string): number {
    return Math.max(1, Math.round(wordCount(text) / WORDS_PER_MINUTE));
}

export interface LongMessageStats { chars: number; minutes: number }

export function longMessageStats(text: string): LongMessageStats {
    return { chars: text.length, minutes: readMinutes(text) };
}

/** "Long message · 12,345 characters · ~3 min read" */
export function longMessageLabel(stats: LongMessageStats): string {
    return `Long message · ${stats.chars.toLocaleString('en-US')} characters · ~${stats.minutes} min read`;
}

/**
 * A short single-purpose excerpt for surfaces that show a message in one or a
 * few clamped lines (reply quote, pinned list): the CSS clamp still does the
 * visual truncation, this just stops a 100k-character string from being handed
 * to the layout engine to clamp.
 */
export function previewSnippet(text: string, max: number = 400): string {
    if (text.length <= max) return text;
    let cut = max;
    const prev = text.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
    return text.slice(0, cut);
}

// ── per-session expand state ────────────────────────────────────────────────
// Which long messages the user has expanded inline. Module scope on purpose: a
// chat switch unmounts the rows, and coming back should find them as left. It
// lives only in memory (no persistence) and is bounded.
const EXPANDED_CAP = 500;
const expanded = new Set<string>();

export const longMessageExpansion = {
    has(id: string): boolean { return expanded.has(id); },
    set(id: string, open: boolean): void {
        if (open) {
            expanded.delete(id); // re-insert so the oldest is the first to go
            expanded.add(id);
            if (expanded.size > EXPANDED_CAP) {
                const oldest = expanded.values().next().value;
                if (oldest !== undefined) expanded.delete(oldest);
            }
        } else {
            expanded.delete(id);
        }
    },
    clear(): void { expanded.clear(); },
};
