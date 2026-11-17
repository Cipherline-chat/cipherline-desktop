import { mentionsToDisplayText } from './mentionTokens';
import { stripFormatting } from './formatting/plainText';

/**
 * Message text as a user SEES it, for every place that previews or searches a
 * message outside its own bubble: the reply quote above a message, the
 * "Replying to" bar over the composer, and the in-chat / channel / pinned
 * searches.
 *
 * Message text on the wire carries mention tokens (`<@u:ID:dawson>`,
 * `<@r:ID:Mods>`, `<:party:ID>`). Each of these surfaces used to read
 * `content.text` directly, so the reply quote and channel search excerpts
 * showed the raw token. Everything routes through `mentionsToDisplayText`
 * (the same form the OS notification and pinned panel already use) so a
 * preview always reads like the message it previews.
 *
 * Formatting syntax is removed too (utils/formatting/plainText.ts): a preview
 * of `**ship it**` reads "ship it", and a spoiler previews as "[spoiler]" —
 * never its hidden text — in every one of these surfaces. Copy Text and edit
 * keep the raw syntax (they use `displayTextOf`, which does not strip).
 *
 * Searching matches the DISPLAY text too. A user can search for "@dawson" and
 * find the message that reads "@dawson …", and a fragment of a user id no
 * longer matches messages because of the hidden token.
 */

/**
 * How much of a message any PREVIEW surface (conversation-list line, reply
 * quote, OS notification body, pinned-message row) ever looks at. Each of
 * them shows at most a few hundred characters, but they all ran the token
 * scanner over the WHOLE text first, and they run with no click: a large
 * message must not cost its full length on every list render or toast.
 * Cutting mid-token is harmless here: the cut is far past what is shown.
 */
export const PREVIEW_SCAN_MAX = 2000;

/** `text` cut to PREVIEW_SCAN_MAX (never between the halves of a surrogate pair); '' for a non-string. */
export function clipForPreview(text: unknown, max: number = PREVIEW_SCAN_MAX): string {
    if (typeof text !== 'string') return '';
    if (text.length <= max) return text;
    let cut = max;
    const prev = text.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
    return text.slice(0, cut);
}

export interface PlainTextOptions {
    /**
     * `'display'` (default): mention / emoji tokens become `@name` / `:name:`.
     * `'keep'`: tokens stay for a caller that resolves them itself (the
     * conversation list draws custom emoji as images).
     */
    tokens?: 'display' | 'keep';
    /** How much of the text is looked at (default PREVIEW_SCAN_MAX). */
    max?: number;
}

/**
 * THE plain-text form of a message, for every surface outside the rendered
 * message body: OS notifications, the conversation list, reply quotes and the
 * "Replying to" bar, the pinned / saved panel, search results and excerpts.
 *
 *   `**testing**`            -> "testing"
 *   `||secret||`             -> "[spoiler]"  (never the hidden text)
 *   ```` ```js\nx()\n``` ```` -> "x()"        (code is the message: its text stays)
 *   `[docs](https://…)`      -> "docs";  `<https://x.y>` -> "https://x.y"
 *   `# Title`, `> quote`, `- item`, `\*` escapes -> the words, with "• " for bullets
 *
 * Cut first (PREVIEW_SCAN_MAX), then the formatting syntax removed
 * (utils/formatting/plainText.ts), then tokens shown as display text.
 * `ChatPane.plainTextSites.test.ts` scans the source for every read of message
 * text and fails on one that reaches a preview surface without coming through
 * here.
 */
export function toPlainText(text: unknown, opts: PlainTextOptions = {}): string {
    const plain = stripFormatting(clipForPreview(text, opts.max));
    return opts.tokens === 'keep' ? plain : mentionsToDisplayText(plain);
}

/** `toPlainText` of a message's content, or undefined when it has no text. */
export function displayPreviewOf(content: { text?: unknown } | null | undefined): string | undefined {
    const text = content?.text;
    return typeof text === 'string' ? toPlainText(text) : undefined;
}

/** Display text of a message's content (formatting syntax KEPT — Copy Text, edit), or undefined when it has no text. */
export function displayTextOf(content: { text?: unknown } | null | undefined): string | undefined {
    const text = content?.text;
    return typeof text === 'string' ? mentionsToDisplayText(text) : undefined;
}

/** Case-insensitive substring match against the text as displayed. */
export function messageTextMatches(text: string | null | undefined, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (typeof text !== 'string' || !text) return false;
    return mentionsToDisplayText(stripFormatting(text)).toLowerCase().includes(q);
}

export interface SearchExcerpt {
    before: string;
    match: string;
    after: string;
}

/**
 * The excerpt a search result shows: up to `context` characters either side
 * of the first match, with ellipses where it was cut. Computed on the display
 * text, so the highlighted span lines up with what the user typed.
 */
export function searchExcerpt(text: string | null | undefined, query: string, context = 30): SearchExcerpt | null {
    const needle = query.trim().toLowerCase();
    if (!needle || typeof text !== 'string' || !text) return null;
    const shown = mentionsToDisplayText(stripFormatting(text));
    const i = shown.toLowerCase().indexOf(needle);
    if (i < 0) return null;
    const start = Math.max(0, i - context);
    const end = Math.min(shown.length, i + needle.length + context);
    return {
        before: (start > 0 ? '…' : '') + shown.slice(start, i),
        match: shown.slice(i, i + needle.length),
        after: shown.slice(i + needle.length, end) + (end < shown.length ? '…' : ''),
    };
}
