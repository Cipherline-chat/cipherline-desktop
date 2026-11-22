/**
 * mentionSuggestions — pure matching / ranking / row-text rules for the
 * composer's @mention autocomplete (extracted from ChatPane so they can be
 * unit-tested).
 *
 * Nicknames are DISPLAY ONLY. A candidate's `label` is always the username:
 * it is what gets inserted into the textarea (`@label`) and what the wire
 * token `<@u:id:label>` carries, exactly as before. `nickname` only widens
 * what the typed query can match and changes which text is the row's primary
 * label; it never reaches the wire.
 */
import { padDiscriminator } from '@cipherline/shared';

export interface MentionMatchable {
    type: 'everyone' | 'here' | 'user' | 'role';
    /** Username / role name / "everyone" / "here" — the inserted + wire label. */
    label: string;
    /** `user` rows in a server channel only: the member's server nickname. */
    nickname?: string | null;
    discriminator?: number | null;
}

/** Small-capital Latin letters (ᴀʙᴄ...) have no Unicode compatibility
 *  decomposition, so NFKD alone leaves "ᴀᴇsᴛʜᴇᴛɪᴄ" unmatched by "aesthetic". */
const SMALL_CAPS: Record<string, string> = {
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i',
    'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ꜱ': 's',
    'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

/**
 * Lowercase + strip combining marks so "jose" finds "José". Compatibility
 * folding (NFKD) also lets plain typing find decorative names: 𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬,
 * 𝐁𝐨𝐥𝐝, Ⓐ and fullwidth letters fold to ASCII, and small caps are mapped by
 * hand. Never throws.
 */
export function foldForMatch(s: string): string {
    let out = s;
    try { out = out.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { /* keep raw */ }
    out = out.replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, c => SMALL_CAPS[c] ?? c);
    return out.toLowerCase();
}

/** The nickname if it is a non-blank string, else null. */
export function cleanNickname(n: string | null | undefined): string | null {
    if (typeof n !== 'string') return null;
    const t = n.trim();
    return t.length > 0 ? t : null;
}

/** Primary text for a row: nickname for a nicknamed user, otherwise the label. */
export function mentionDisplayName(c: MentionMatchable): string {
    return (c.type === 'user' ? cleanNickname(c.nickname) : null) ?? c.label;
}

/**
 * 0 = a name starts with the query, 1 = a name contains it, -1 = no match.
 * A user is matched on BOTH nickname and username (best tier wins).
 */
function matchTier(c: MentionMatchable, q: string): number {
    const names = [c.label];
    const nick = c.type === 'user' ? cleanNickname(c.nickname) : null;
    if (nick) names.push(nick);
    let best = -1;
    for (const n of names) {
        const f = foldForMatch(n);
        if (f.startsWith(q)) return 0;
        if (f.includes(q)) best = 1;
    }
    return best;
}

/**
 * Filter + rank. Empty query keeps the input order (first `limit`). Otherwise
 * prefix matches come before substring matches, each tier in input order
 * (so @everyone / @here, passed first, stay ahead of members on a tie).
 */
export function rankMentionCandidates<T extends MentionMatchable>(
    candidates: readonly T[],
    rawQuery: string,
    limit = 10,
): T[] {
    const q = foldForMatch(rawQuery).trim();
    if (q === '') return candidates.slice(0, limit);
    const prefix: T[] = [];
    const contains: T[] = [];
    for (const c of candidates) {
        const t = matchTier(c, q);
        if (t === 0) prefix.push(c);
        else if (t === 1) contains.push(c);
    }
    return prefix.concat(contains).slice(0, limit);
}

export interface MentionRowText {
    /** Primary text, without the leading "@". */
    primary: string;
    /** Secondary text (username for nicknamed users, `#disc` for look-alikes), if any. */
    secondary?: string;
}

/**
 * Primary/secondary text for a `user` row, given every row currently visible.
 * A nicknamed member shows the nickname with the username beside it; rows that
 * would still look identical (same shown name [+ same username]) are told
 * apart by their discriminator, so a nickname that collides with another
 * member's username renders as two distinct rows.
 */
export function describeMentionUserRow(row: MentionMatchable, visible: readonly MentionMatchable[]): MentionRowText {
    const userRows = visible.filter(v => v.type === 'user');
    const primary = mentionDisplayName(row);
    const secondaryName = (r: MentionMatchable): string => {
        const n = cleanNickname(r.nickname);
        return n !== null && foldForMatch(n) !== foldForMatch(r.label) ? r.label : '';
    };
    const key = (r: MentionMatchable) => `${foldForMatch(mentionDisplayName(r))}|${foldForMatch(secondaryName(r))}`;
    const username = secondaryName(row);
    const sameKey = userRows.filter(r => key(r) === key(row)).length;
    const sameDisplay = userRows.filter(r => foldForMatch(mentionDisplayName(r)) === foldForMatch(primary)).length;
    // A nicknamed row is already told apart by its username unless that pair
    // repeats; a bare row needs the discriminator as soon as its name repeats.
    const needsDisc = (username ? sameKey > 1 : sameDisplay > 1) && row.discriminator != null;
    const secondary = [username, needsDisc ? `#${padDiscriminator(row.discriminator as number)}` : '']
        .filter(Boolean).join(' ');
    return { primary, secondary: secondary || undefined };
}
