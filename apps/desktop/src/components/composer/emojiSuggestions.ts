import type { EmojiSuggestion } from '../emojiSearch';
import { searchEmoji } from '../emojiSearch';
import { toShortcode, toShortcodeQuery } from '../../utils/emojiNames';

/** A My Emojis library entry, reduced to what a suggestion needs. */
export interface PersonalCandidate { id: string; name: string }

/** A server emoji, reduced to what a suggestion needs (key material included). */
export interface ServerCandidate {
    emoji_id: string;
    name: string;
    attachment_id: string;
    key_b64: string;
    nonce_b64: string;
}

export interface SuggestionOptions {
    limit?: number;
    /** Ids of My Emojis whose image is on this device. A library entry whose
     *  picture is not here can neither render nor be sent (the receiver gets
     *  no bytes), so it is not offered. `null` = do not filter. */
    availablePersonalIds?: ReadonlySet<string> | null;
    /** Native-glyph search for the remaining slots (injected for tests). */
    nativeSearch?: (query: string, limit: number) => EmojiSuggestion[];
}

/** 0 exact name, 1 prefix, 2 anywhere in the name. */
const tier = (name: string, q: string) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
const byRelevance = (q: string) => (a: { name: string }, b: { name: string }) =>
    tier(a.name, q) - tier(b.name, q) || a.name.localeCompare(b.name);

/** One usable custom row: its canonical (underscore) name and the menu row. */
interface UsableCustom { name: string; suggestion: EmojiSuggestion }

/**
 * The custom emojis the viewer may actually use right now - THE rule the
 * autocomplete, the live `:name:` conversion and the space-to-underscore test
 * all share, so they can never disagree about what exists:
 *  - My Emojis: only ones whose picture is on this device;
 *  - server emojis: only the ones passed in (the ACTIVE channel's server - a
 *    server emoji is never usable in another server or a DM), with image key
 *    material, and not shadowed by a same-named My Emoji;
 *  - de-duplicated by id.
 * Names are canonicalised (`toShortcode`), so a name stored before the
 * underscore rule still resolves as `:a_b:`.
 */
function usableCustom(
    customEmojis: ReadonlyArray<ServerCandidate>,
    personal: ReadonlyArray<PersonalCandidate>,
    available: ReadonlySet<string> | null,
): { personal: UsableCustom[]; server: UsableCustom[] } {
    const seenIds = new Set<string>();
    const personalOut: UsableCustom[] = [];
    for (const e of personal) {
        if (seenIds.has(e.id) || (available && !available.has(e.id))) continue;
        const name = toShortcode(e.name);
        if (!name) continue;
        seenIds.add(e.id);
        personalOut.push({ name, suggestion: { id: e.id, native: '', name, personal: true } });
    }
    // The whole library's names, not just the matching rows: a same-named
    // server emoji is hidden whenever the personal one exists.
    const personalAll = new Set(personalOut.map(p => p.name));

    const serverOut: UsableCustom[] = [];
    for (const e of customEmojis) {
        const name = toShortcode(e.name);
        if (!name || seenIds.has(e.emoji_id) || personalAll.has(name)) continue;
        if (!e.attachment_id || !e.key_b64 || !e.nonce_b64) continue;
        seenIds.add(e.emoji_id);
        serverOut.push({
            name,
            suggestion: {
                id: e.emoji_id,
                native: '',
                name,
                custom: { attachmentId: e.attachment_id, keyB64: e.key_b64, nonceB64: e.nonce_b64 },
            },
        });
    }
    return { personal: personalOut, server: serverOut };
}

/**
 * The composer's `:query` autocomplete rows: My Emojis, then this server's
 * emojis, then the native set - with every row a distinct, usable emoji.
 *
 * What is NOT offered (each was a way to show "two of the same emoji", one of
 * them dead):
 *  - the same emoji twice - de-duplicated by its stable id (a server list can
 *    briefly hold one emoji twice: a create response racing the refetch the
 *    same create triggers);
 *  - a server emoji whose list entry lacks its image key material - it can
 *    never render;
 *  - a My Emoji whose picture is not on this device (see availablePersonalIds);
 *  - a server emoji with the same shortcode as one of My Emojis. A shortcode
 *    in the box is only `:name:`, so two rows with the same name would insert
 *    identical text, and which one it meant was whichever was picked last.
 *    "Save to My Emojis" on a server emoji copies its name verbatim, which is
 *    how this happens in practice. My Emojis wins (the same order the send
 *    path resolves in - utils/composerEmojiShortcodes.ts); the full picker
 *    still offers the server's one.
 *
 * Within each group an exact name match sorts first, then prefix, then
 * substring, then alphabetical - so typing the whole name puts that emoji
 * under the highlight, not an alphabetically earlier longer name.
 *
 * The query is compared in SHORTCODE form (spaces and dashes are underscores),
 * so `red_he`, `red-he` and `red he` all find `red_heart`.
 */
export function searchEmojiWithCustom(
    query: string,
    customEmojis: ReadonlyArray<ServerCandidate>,
    personal: ReadonlyArray<PersonalCandidate> = [],
    opts: SuggestionOptions = {},
): EmojiSuggestion[] {
    const limit = opts.limit ?? 8;
    const native = opts.nativeSearch ?? searchEmoji;
    const q = toShortcodeQuery(query);
    const usable = usableCustom(customEmojis, personal, opts.availablePersonalIds ?? null);

    const matching = (rows: UsableCustom[]) =>
        rows.filter(r => r.name.includes(q)).sort(byRelevance(q)).map(r => r.suggestion);

    const mine = [...matching(usable.personal), ...matching(usable.server)].slice(0, limit);
    if (mine.length >= limit) return mine;
    return [...mine, ...native(query, limit - mine.length)];
}

/** What a complete typed name resolves to: a standard emoji (its glyph) or a
 *  custom one (the very row picking it from the menu would insert). */
export type ExactEmoji =
    | { kind: 'native'; glyph: string }
    | { kind: 'custom'; suggestion: EmojiSuggestion };

export interface ExactOptions {
    availablePersonalIds?: ReadonlySet<string> | null;
    /** Standard-emoji lookup (any spelling of a name -> glyph). Injected so
     *  tests need no dataset; absent = no standard emoji. */
    nativeLookup?: (typed: string) => string | undefined;
}

/**
 * The emoji a COMPLETE typed name means, by the precedence the autocomplete
 * lists them in and the send path resolves them in: My Emojis, then this
 * server's, then the standard set. `undefined` = not an emoji the viewer can
 * use (unknown, another server's, no image on this device): the text stays as
 * typed, exactly as the menu would not offer it.
 */
export function resolveExactEmoji(
    typed: string,
    customEmojis: ReadonlyArray<ServerCandidate>,
    personal: ReadonlyArray<PersonalCandidate> = [],
    opts: ExactOptions = {},
): ExactEmoji | undefined {
    const name = toShortcode(typed);
    if (!name) return undefined;
    const usable = usableCustom(customEmojis, personal, opts.availablePersonalIds ?? null);
    const hit = usable.personal.find(r => r.name === name) ?? usable.server.find(r => r.name === name);
    if (hit) return { kind: 'custom', suggestion: hit.suggestion };
    const glyph = opts.nativeLookup?.(typed);
    return glyph ? { kind: 'native', glyph } : undefined;
}
