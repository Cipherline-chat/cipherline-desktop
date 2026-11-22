import { graphemesOf } from '@cipherline/shared';

const HAS_SUBSTANCE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * The 1-2 character stand-in shown when a server has no icon. Works on
 * grapheme clusters, never UTF-16 units: `"🌙 Moon"[0]` is half a surrogate
 * pair and draws a replacement box. Decorative words that are only symbols
 * (`✦`, `『`, `꒰`) are skipped when a real word exists, so "✦ Moonlit Café ✦"
 * reads "MC", not "✦M".
 */
export function serverAbbreviation(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    const solid = words.filter(w => HAS_SUBSTANCE.test(w));
    const pool = solid.length > 0 ? solid : words;
    // Within a word, skip leading decoration too ("『Aesthetic』" -> "A").
    const lead = (w: string): string => {
        const gs = graphemesOf(w);
        return gs.find(g => HAS_SUBSTANCE.test(g)) ?? gs[0] ?? '';
    };
    if (pool.length === 1) {
        const gs = graphemesOf(pool[0]);
        const start = Math.max(0, gs.findIndex(g => HAS_SUBSTANCE.test(g)));
        return gs.slice(start, start + 2).join('').toUpperCase();
    }
    return (lead(pool[0]) + lead(pool[1])).toUpperCase();
}

/** One grapheme of `serverAbbreviation` (a single-letter badge). */
export function serverInitial(name: string): string {
    return graphemesOf(serverAbbreviation(name))[0] ?? '?';
}
