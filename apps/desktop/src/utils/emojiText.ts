/**
 * Emoji detection for message bodies: whether a message is emoji-only (and so
 * renders at the jumbo size tiers), how many emoji it holds, and the patterns
 * the renderers split text on. Moved out of ChatPane.tsx so it can be tested.
 */

/**
 * One emoji:
 *  - a flag — two regional indicators (U+1F1E6..U+1F1FF), e.g. the US flag;
 *  - a keycap — `0-9`, `#` or `*`, optional VS16 (U+FE0F), then U+20E3;
 *  - a pictographic base with an optional VS16/keycap mark and an optional
 *    SKIN-TONE modifier, ZWJ-joined (U+200D) to more of the same, plus any
 *    trailing tag characters (U+E0020..U+E007F — subdivision flags such as
 *    England's).
 *
 * The previous pattern matched only the pictographic base with an optional
 * VS16/keycap mark, so a skin tone was left over (thumbs-up + medium skin was
 * "not emoji-only"), and a country flag or a digit keycap never matched at
 * all — those emoji-only messages rendered at body size, never jumbo. Same
 * pattern and cases as mobile's fix (cipherline-mobile
 * src/features/chat/logic/richText.ts). Plain digits and `#`/`*` without
 * U+20E3 are NOT emoji ("12" stays text). Written with escapes, never literal
 * invisible characters, so the pattern can be reviewed.
 */
export const EMOJI_RE = /(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?\p{Emoji_Modifier}?)*[\u{E0020}-\u{E007F}]*)/gu;

/** Matches only the custom-emoji token shape — used where mentions are
 *  irrelevant (the jumbo emoji-only render, and the emoji-only detector). */
export const EMOJI_TOKEN_RE = /<:[^:>]+:[^>]+>/g;

/** Returns true when the string contains only emoji — native and/or custom
 *  server-emoji tokens (`<:name:id>`, see the mention/emoji token section of
 *  ChatPane) — and optional whitespace. A custom token can't render as a bare
 *  glyph, so the jumbo call site branches on whether one is present; this
 *  function only decides WHETHER the message qualifies as emoji-only. */
export function isEmojiOnly(text: string): boolean {
    if (!text.trim()) return false;
    return text.replace(EMOJI_RE, '').replace(EMOJI_TOKEN_RE, '').trim() === '';
}

/** Counts native emoji AND custom-emoji tokens — each token counts as one
 *  "emoji" toward the jumbo size tiers, same as a native glyph. */
export function countEmojis(text: string): number {
    return (text.match(EMOJI_RE) ?? []).length + (text.match(EMOJI_TOKEN_RE) ?? []).length;
}
