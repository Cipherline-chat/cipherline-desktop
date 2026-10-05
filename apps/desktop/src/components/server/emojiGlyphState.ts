/**
 * The three-way state a custom-emoji token resolves to at render time.
 *
 * Shared by every fallback site that renders a `<:name:id>` token — the
 * reaction glyph, inline message text, and the jumbo standalone-emoji path
 * in ChatPane.tsx — so they can't independently drift on the resolved vs.
 * loading vs. unavailable split. That split is easy to get wrong: a naive
 * "not found -> show the fallback" check would flash the fallback for every
 * custom emoji on first paint, before the server's emoji list has loaded.
 *
 *  - `'resolved'`:    the emoji list has the token — render the real image.
 *  - `'loading'`:     the server's emoji list hasn't loaded yet, so it's not
 *                     yet known whether this token resolves. Must never be
 *                     conflated with `'unavailable'`.
 *  - `'unavailable'`: the list HAS loaded and the token genuinely isn't in
 *                     it — deleted from the server, or (no server at all,
 *                     e.g. a DM/group) simply not resolvable in this
 *                     context. This function only decides WHICH glyph to
 *                     render; callers decide the exact wording for that
 *                     case (see `MissingEmojiPlaceholder`'s `noServerContext`).
 */
export type EmojiGlyphState = 'resolved' | 'loading' | 'unavailable';

export function resolveEmojiGlyphState(
    /** The looked-up emoji record, or undefined/falsy if the token doesn't
     *  resolve (yet, or ever). Only truthiness is checked. */
    found: unknown,
    /** Whether the owning server's emoji list is still loading. */
    emojisLoading: boolean | undefined,
): EmojiGlyphState {
    if (found) return 'resolved';
    return emojisLoading ? 'loading' : 'unavailable';
}
