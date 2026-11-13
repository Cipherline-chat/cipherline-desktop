import type { EmojiMartData } from '@emoji-mart/data';
import { toShortcode } from './emojiNames';
import { getLoadedEmojiData } from '../components/emojiSearch';

/**
 * The standard (Unicode) emoji's `:shortcode:` names, built from the emoji-mart
 * dataset the autocomplete already uses.
 *
 * Every emoji answers to, in priority order:
 *   1. its id, exactly as emoji-mart spells it (`heart`, `+1`, `-1`,
 *      `man-walking`);
 *   2. that id with dashes as underscores (`man_walking`);
 *   3. an emoji-mart alias (`satisfied` -> laughing);
 *   4. its display name as a shortcode: `Red Heart` -> `red_heart`,
 *      `Flag: United States` -> `flag_united_states`.
 * The first emoji to claim a key keeps it (ids beat names), then dataset order,
 * so a lookup never depends on iteration luck. Keys are lowercase.
 *
 * Pure given a dataset (the loader is the only impure part, and it never
 * triggers a load: until the dataset has arrived nothing converts, exactly as
 * the autocomplete returns nothing until then).
 */
export interface NativeShortcodeIndex {
    /** shortcode -> glyph */
    byName: ReadonlyMap<string, string>;
}

export function buildNativeShortcodeIndex(data: Pick<EmojiMartData, 'emojis' | 'aliases'>): NativeShortcodeIndex {
    const byName = new Map<string, string>();
    const claim = (key: string, glyph: string) => {
        if (key && !byName.has(key)) byName.set(key, glyph);
    };
    const list = Object.values(data.emojis ?? {});
    const glyphOf = (e: { skins?: { native?: string }[] }) => e.skins?.[0]?.native ?? '';
    for (const e of list) claim(e.id.toLowerCase(), glyphOf(e));
    for (const e of list) claim(toShortcode(e.id), glyphOf(e));
    for (const [alias, id] of Object.entries(data.aliases ?? {})) {
        const target = data.emojis?.[id];
        if (target) { claim(alias.toLowerCase(), glyphOf(target)); claim(toShortcode(alias), glyphOf(target)); }
    }
    for (const e of list) claim(toShortcode(e.name), glyphOf(e));
    for (const [k, g] of byName) if (!g) byName.delete(k);
    return { byName };
}

let cached: { data: EmojiMartData; index: NativeShortcodeIndex } | null = null;

/** The index for the loaded dataset, or null while it has not loaded. */
export function getNativeShortcodeIndex(): NativeShortcodeIndex | null {
    const data = getLoadedEmojiData();
    if (!data) return null;
    if (!cached || cached.data !== data) cached = { data, index: buildNativeShortcodeIndex(data) };
    return cached.index;
}

/** Glyph for a typed name (any spelling: spaces, dashes, case), or undefined. */
export function lookupNativeShortcode(index: NativeShortcodeIndex | null, typed: string): string | undefined {
    if (!index) return undefined;
    return index.byName.get(typed.toLowerCase()) ?? index.byName.get(toShortcode(typed));
}
