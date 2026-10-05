/**
 * mentionKeywords — user-defined trigger words that fire a mention-level
 * notification even on messages that don't @ping you directly.
 *
 * Matching rules:
 *   - Case-insensitive
 *   - Word-boundary aware: "deploy" matches "deploy!" but not "redeployment"
 *   - Returns the first matching keyword (for logging / UI feedback), or null
 */

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if `text` contains any of the `keywords` as whole-ish words.
 * Returns the first matched keyword string, or null.
 */
export function matchesKeyword(text: string, keywords: string[]): string | null {
    if (!keywords.length || !text) return null;
    const lower = text.toLowerCase();
    for (const kw of keywords) {
        if (!kw.trim()) continue;
        // Use a word-boundary-flavoured pattern: match if the keyword is
        // preceded and followed by a non-word character or start/end of string.
        const re = new RegExp(`(?:^|\\W)${escapeRegex(kw.trim().toLowerCase())}(?:\\W|$)`);
        if (re.test(lower)) return kw;
    }
    return null;
}
