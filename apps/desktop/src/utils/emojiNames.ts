/**
 * The ONE place the desktop client decides what a custom-emoji name (a server
 * emoji or a My Emoji) may be, and how a typed `:shortcode:` is normalised for
 * lookup.
 *
 * THE RULE: letters, numbers and underscores only - 2 to 32 characters. No
 * spaces, no dashes. A name is stored lowercase. The API enforces the same
 * thing on create and rename (CreateEmojiDto / UpdateEmojiDto in
 * apps/api/src/servers/dto/server.dto.ts, `^[a-z0-9_]{2,32}$` case-insensitive,
 * lowercased before storage); personal emojis are client-side only
 * (utils/personalEmoji/token.ts re-exports these).
 *
 * Pure and dependency-free so it is unit-tested and the composer, the picker,
 * the name inputs and the library loader all agree.
 */

export const EMOJI_NAME_MIN = 2;
export const EMOJI_NAME_MAX = 32;
export const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;

export function isEmojiName(name: unknown): name is string {
    return typeof name === 'string' && EMOJI_NAME_RE.test(name);
}

/**
 * What a name <input> should hold after the person typed or pasted `raw`.
 * Applied on EVERY change: a space or a dash (any whitespace, any dash-like
 * character) becomes an underscore right there, so "red heart" and "red-heart"
 * never reach validation as something to reject; anything else outside
 * `[a-z0-9_]` is dropped; capped at 32. Deliberately 1:1 for separators (no
 * collapsing, no trimming) so the caret never jumps while someone types.
 */
export function sanitizeEmojiNameInput(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[\s‐-―−﹘﹣－-]/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, EMOJI_NAME_MAX);
}

/**
 * Repair a STORED name that predates the rule (or arrived from another device
 * or an import) into a valid one WITHOUT losing the entry: separators become
 * single underscores, junk is dropped, edges are trimmed, and a name that ends
 * up too short is padded. A name that is already valid is returned unchanged.
 * Uniqueness is the caller's job (the library's `normalise` adds `_2`, `_3`).
 */
export function repairEmojiName(raw: string): string {
    if (isEmojiName(raw)) return raw;
    let n = String(raw ?? '')
        .toLowerCase()
        .replace(/[\s‐-―−﹘﹣－-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, EMOJI_NAME_MAX)
        .replace(/_+$/, '');
    if (n.length < EMOJI_NAME_MIN) n = (n + '_emoji').slice(0, EMOJI_NAME_MAX);
    return n;
}

/**
 * The lookup form of ANY emoji name or typed shortcode body - standard,
 * server or personal. Case-insensitive; spaces and dashes are the same as
 * underscores; punctuation inside a standard name ("Man's Shoe",
 * "Flag: United States") is dropped; runs collapse; edges trim. So
 * `Red Heart`, `red-heart`, `red heart` and `red_heart` all give `red_heart`.
 */
export function toShortcode(raw: string): string {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/['’.,!?:;()&"*/\\]/g, '')
        .replace(/[\s‐-―−-]+/g, '_')
        .replace(/[^a-z0-9_+]/g, '')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * A search query in its comparable form: like toShortcode but KEEPS a trailing
 * underscore (the person is mid-name: `red_` must still find `red_heart`).
 */
export function toShortcodeQuery(raw: string): string {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/[\s‐-―−-]+/g, '_')
        .replace(/[^a-z0-9_+]/g, '')
        .replace(/_{2,}/g, '_');
}
