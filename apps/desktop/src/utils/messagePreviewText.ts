import { mentionsToDisplayText } from './mentionTokens';

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
 * Searching matches the DISPLAY text too. A user can search for "@dawson" and
 * find the message that reads "@dawson …", and a fragment of a user id no
 * longer matches messages because of the hidden token.
 */

/** Display text of a message's content, or undefined when it has no text. */
export function displayTextOf(content: { text?: unknown } | null | undefined): string | undefined {
    const text = content?.text;
    return typeof text === 'string' ? mentionsToDisplayText(text) : undefined;
}

/** Case-insensitive substring match against the text as displayed. */
export function messageTextMatches(text: string | null | undefined, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (typeof text !== 'string' || !text) return false;
    return mentionsToDisplayText(text).toLowerCase().includes(q);
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
    const shown = mentionsToDisplayText(text);
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
