/**
 * The composer's DISPLAY-text <-> WIRE-text boundary.
 *
 * The textarea shows what a person types and reads — `@admin`, `:party:`. The
 * encrypted payload carries structured tokens — `<@r:ID:admin>`,
 * `<:party:ID>` — which is what the renderer colourises and what the server
 * routes notifications from (`utils/mentionTokens.ts` owns that grammar).
 * These three functions are the whole crossing, in both directions.
 *
 * They live here rather than inside ChatPane.tsx because they are pure and
 * DOM-free, and the property that matters is a ROUND TRIP: text that came out
 * of a sent message must go back in unchanged if the user did not touch those
 * mentions. That was not true until `tokenMapsFromWireText` existed — opening
 * an edit silently downgraded every mention in the message to plain text on
 * save — and it is not a property you can check by reading a 6k-line
 * component.
 */
import { MENTION_TOKEN_RE, parseMentionToken } from './mentionTokens';

/**
 * Transform display-text mentions (`@label`) into wire-format mention tokens
 * (`<@u:ID:label>` / `<@r:ID:label>`) using a pre-built lookup map.
 *
 * This lets the textarea show clean `@admin` text while the encrypted wire
 * payload carries the structured token the renderer can colorise and the server
 * can route notifications from.
 *
 * If a label isn't in the map (hand-typed `@word` with no match) it's left as
 * plain text — gracefully degrades without data loss.
 */
export function buildWireText(displayText: string, tokenMap: Record<string, string>): string {
    if (Object.keys(tokenMap).length === 0) return displayText;
    // Build a single regex from the known labels (sorted longest-first so that
    // "Server Admin" is tried before "Server" when both exist in the map).
    // Each label is regex-escaped so special chars in names don't break the pattern.
    const labels = Object.keys(tokenMap).sort((a, b) => b.length - a.length);
    const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`@(${escaped.join('|')})(?=[\\s<>@'"!?.,;:)\\]}]|$)`, 'g');
    return displayText.replace(re, (_match, label) => tokenMap[label] ?? _match);
}

/**
 * Same job as buildWireText, for custom-emoji display tokens (":name:") →
 * the full wire token (<:name:id>). Simpler than the mention version: the
 * map's keys already include their own leading/trailing colons as literal
 * delimiters, so there's no risk of matching a substring of a longer word —
 * no lookahead/word-boundary logic needed, just an exact alternation match.
 */
export function buildEmojiWireText(displayText: string, tokenMap: Record<string, string>): string {
    const keys = Object.keys(tokenMap);
    if (keys.length === 0) return displayText;
    const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(escaped.join('|'), 'g');
    return displayText.replace(re, (match) => tokenMap[match] ?? match);
}

/**
 * Recover the composer's label -> wire-token maps from an already-sent message.
 *
 * `buildWireText` / `buildEmojiWireText` turn `@label` and `:name:` back into
 * wire tokens at send time, and they can only substitute labels present in
 * those maps — normally populated as the user picks from the autocomplete. An
 * EDIT starts with text nobody picked anything for, so without this the edit
 * would round-trip every mention in the message down to plain text: the
 * mention would render as literal `@name`, stop being a mention, and stop
 * notifying whoever it named. Silently, on save.
 *
 * Seeding from the message itself makes the round-trip exact for anything the
 * user leaves alone, and still lets them delete a mention by deleting its text.
 * `@everyone` / `@here` need no entry — they are literal in the wire format,
 * so they survive the trip untouched.
 */
export function tokenMapsFromWireText(text: string): {
    mentions: Record<string, string>;
    emojis: Record<string, string>;
} {
    const mentions: Record<string, string> = {};
    const emojis: Record<string, string> = {};
    const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const parsed = parseMentionToken(m[0]);
        if (!parsed) continue;
        if (parsed.kind === 'user' || parsed.kind === 'role') mentions[parsed.label] = m[0];
        else if (parsed.kind === 'emoji') emojis[`:${parsed.label}:`] = m[0];
    }
    return { mentions, emojis };
}
