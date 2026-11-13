/**
 * Typed `:name:` shortcodes -> custom-emoji wire tokens, at send time.
 *
 * The composer shows `:name:`; the encrypted payload carries `<:name:ID>`.
 * Picking an emoji (autocomplete row or the full picker) registers that
 * substitution in the composer's pick map (see utils/composerWireText.ts
 * buildEmojiWireText). A shortcode the person simply TYPED has no such
 * registration, and used to be sent as the literal text ":myemoji:" - which
 * is exactly what Enter did the moment the closing colon closed the
 * autocomplete popup. This module is the other half: it resolves a typed
 * shortcode against what the sender can actually use right now.
 *
 * RESOLUTION ORDER for one `:name:` (deterministic, documented):
 *   1. the person's explicit pick of that name in this conversation since the
 *      last send (applied earlier, by buildEmojiWireText, so by the time this
 *      runs the text already holds a token and is skipped here);
 *   2. My Emojis (the personal library) - theirs, usable in every chat; the
 *      autocomplete lists them first and de-duplicates by name the same way;
 *   3. the active server's emojis (only in a server channel - a server emoji
 *      is never usable in another server or a DM, docs/custom-emoji-design.md);
 *   4. otherwise the text is left exactly as typed.
 *   4. a standard emoji (`:red_heart:`, `:smile:`) -> its glyph, via the
 *      `nativeLookup` the caller passes (the loaded emoji-mart dataset; absent
 *      until it has loaded). This is only the SAFETY NET for text that was
 *      pasted or never converted live (utils/composerShortcodeTyping); a native
 *      shortcode must not directly follow a letter or digit, same as live.
 * Names are matched in SHORTCODE form (utils/emojiNames.toShortcode): case-
 * insensitive, and a space or dash counts as an underscore, so a name stored
 * before the underscore rule (`red heart`) still resolves. The token always
 * carries the canonical underscore name; the id is what identifies the emoji.
 * Nothing inside inline code or a code block is converted.
 *
 * Pure (no React, DOM or storage) so the whole rule is unit-tested.
 */
import { buildWireText, buildEmojiWireText } from './composerWireText';
import { toShortcode } from './emojiNames';
import { codeRanges } from './composerShortcodeTyping';

/** What a sender can use: only the fields identity needs. */
export interface ShortcodeSources {
    /** My Emojis whose image is on this device. */
    personal: ReadonlyArray<{ id: string; name: string }>;
    /** The ACTIVE channel's server emojis ([] outside a server channel). */
    server: ReadonlyArray<{ emoji_id: string; name: string }>;
    /** Standard emoji by typed name (any spelling) -> glyph. Optional. */
    nativeLookup?: (typed: string) => string | undefined;
}

export const emojiToken = (name: string, id: string) => `<:${name}:${id}>`;

/** name (lowercase) -> wire token. Personal overrides a same-named server emoji. */
export function buildShortcodeIndex(sources: ShortcodeSources): Map<string, string> {
    const index = new Map<string, string>();
    for (const e of sources.server) { const n = toShortcode(e.name); if (n) index.set(n, emojiToken(n, e.emoji_id)); }
    for (const e of sources.personal) { const n = toShortcode(e.name); if (n) index.set(n, emojiToken(n, e.id)); }
    return index;
}

// An existing mention / emoji token is consumed whole and left alone (so the
// `:name:` inside `<:name:ID>` is never re-matched); otherwise a shortcode.
// A name body may hold single spaces / dashes (old-style `red heart`): it only
// ever converts when the WHOLE span is a known name, so prose cannot mis-fire.
const SCAN = /<[@:][^<>]*>|:([A-Za-z0-9_+-]{1,32}(?: [A-Za-z0-9_+-]{1,32}){0,4}):/g;

/**
 * Replace every typed `:name:` that resolves in `index` with its wire token.
 * Unresolvable ones stay as typed. A purely numeric "shortcode" that touches
 * a preceding alphanumeric (`10:30:45` -> `:30:`) is a clock, not an emoji.
 */
export function resolveTypedShortcodes(
    text: string,
    index: ReadonlyMap<string, string>,
    nativeLookup?: (typed: string) => string | undefined,
): string {
    if ((index.size === 0 && !nativeLookup) || text.indexOf(':') < 0) return text;
    const code = codeRanges(text);
    const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
    const re = new RegExp(SCAN.source, 'g');
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (name === undefined) continue; // a whole existing token: skip it
        const afterWord = m.index > 0 && /[0-9A-Za-z]/.test(text[m.index - 1]);
        const clock = /^\d+$/.test(name) && afterWord;
        let token: string | undefined;
        if (name.length >= 2 && !clock && !inCode(m.index)) {
            token = index.get(toShortcode(name)) ?? (afterWord ? undefined : nativeLookup?.(name));
        }
        if (token === undefined) {
            // Not an emoji: let the closing colon open the next candidate
            // (`:nope:party:` must still find `:party:`).
            re.lastIndex = m.index + 1;
            continue;
        }
        out += text.slice(last, m.index) + token;
        last = m.index + m[0].length;
    }
    return last === 0 ? text : out + text.slice(last);
}

/**
 * The composer's whole display -> wire crossing for one outgoing text:
 * `@name` mentions, then emoji the person PICKED (`picked`: ":name:" -> token,
 * exact), then emoji they merely TYPED (resolved against `sources`). Pass-2
 * skips every token pass-1 produced, so the passes cannot double-convert.
 */
export function composerToWire(
    display: string,
    maps: { mentions: Record<string, string>; picked: Record<string, string> },
    sources: ShortcodeSources,
): string {
    const picked = buildEmojiWireText(buildWireText(display, maps.mentions), maps.picked);
    if (picked.indexOf(':') < 0) return picked;
    return resolveTypedShortcodes(picked, buildShortcodeIndex(sources), sources.nativeLookup);
}
