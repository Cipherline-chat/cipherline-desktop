/**
 * Shared @mention / custom-emoji wire-token parsing.
 *
 * This is the single source of truth for the inline token shapes embedded in
 * encrypted message text (see `packages/shared/content.ts`'s `MentionEntry`
 * doc comment, which documents the same format server-side):
 *
 *   <@u:USER_ID:username>   — user mention. `username` is the label captured
 *                             at SEND time — it is NOT re-resolved later, so
 *                             it can go stale if the sender renames.
 *   <@r:ROLE_ID:rolename>   — role mention.
 *   <:name:EMOJI_ID>        — custom server emoji (shares this pipeline —
 *                             see docs/custom-emoji-design.md).
 *   @everyone / @here       — special mentions, carry no id.
 *
 * `ChatPane.tsx`'s message renderer (JSX, click handlers, avatar/role-color
 * lookups) and the conversation-list preview (plain text, single truncated
 * line, no JSX) both need to walk this same token grammar — extracted here
 * so there is exactly one regex and one parser, not two copies that can
 * drift.
 */

import type { MentionEntry } from '@cipherline/shared';
import { stripBidiControls } from './fileSafety';

/**
 * The token grammar, as a regex. Every quantifier is BOUNDED, on purpose:
 * message text is chosen by the sender, and the unbounded form
 * (`[^:>]+:[^>]+>`) scanned to the end of the text from every `<` that never
 * closed, so a pass over `'<:a:'.repeat(25_000)` cost several seconds and the
 * scan runs with no click (notification body, conversation-list preview,
 * every render of the row).
 *
 * The bounds sit well above any real token: ids are UUIDs (36), usernames are
 * at most 32 characters, role and emoji names at most 50. A longer "token" is
 * not one a client produces and is shown as the text it is.
 *
 * Code that WALKS text uses `findMentionTokens` / `mentionTokenMatcher` below,
 * not this regex: even bounded, a backtracking engine still spends up to
 * ID_MAX + LABEL_MAX steps at every unclosed `<`, which is hundreds of
 * milliseconds on a 200k-character message. The scanner finds the same
 * matches in one linear pass. This regex stays as the grammar's reference
 * form (tests pin the scanner against it).
 */
export const MENTION_TOKEN_ID_MAX = 64;
export const MENTION_TOKEN_LABEL_MAX = 128;

const MENTION_TOKEN_RE = /(<@[ur]:[^:>]{1,64}:[^>]{1,128}>|<:[^:>]{1,64}:[^>]{1,128}>|@everyone|@here)/g;

export { MENTION_TOKEN_RE };

/** One token found in text: `index` and `[0]` mirror a RegExpExecArray. */
export interface MentionTokenMatch {
    index: number;
    0: string;
}

/**
 * Every token in `text`, left to right, non-overlapping: exactly the matches
 * `MENTION_TOKEN_RE` (or, with `'emoji'`, `EMOJI_TOKEN_RE`) finds with the `g`
 * flag, but in time linear in `text.length` whatever the content.
 *
 * Why it is linear: for a candidate `<` at `i`, the grammar's id runs to the
 * FIRST `:` after it and its label to the FIRST `>` after that (neither part
 * may contain its terminator), so each candidate has at most one possible
 * match. The scanner looks those terminators up with `indexOf` and caches
 * each answer while it is still ahead of the scan; every cache only moves
 * forward, so all lookups together read the text a constant number of times,
 * plus one character-by-character pass.
 */
export function findMentionTokens(text: string, kind: 'all' | 'emoji' = 'all'): MentionTokenMatch[] {
    const out: MentionTokenMatch[] = [];
    if (typeof text !== 'string' || text.length === 0) return out;
    if (text.indexOf(kind === 'all' ? '<' : '<:') < 0 && (kind === 'emoji' || text.indexOf('@') < 0)) return out;
    const n = text.length;
    const all = kind === 'all';
    // Forward-only caches: the first `>` at/after the scan position, and the
    // first `:` at/after each id start (`i + 4` for <@u:/<@r:, `i + 2` for <:).
    // Each is only ever queried at a non-decreasing position, so a cached
    // answer that is still >= the query is still the answer.
    let gtAt = -1;
    let urColonAt = -1;
    let emColonAt = -1;

    let i = 0;
    while (i < n) {
        const ch = text.charCodeAt(i);
        let end = -1;
        if (ch === 0x3c /* < */) {
            const c1 = text.charCodeAt(i + 1);
            let idStart = -1;
            let colon = -1;
            if (c1 === 0x3a /* : */) {
                idStart = i + 2;
                if (emColonAt < idStart) { const k = text.indexOf(':', idStart); emColonAt = k < 0 ? n : k; }
                colon = emColonAt;
            } else if (all && c1 === 0x40 /* @ */) {
                const c2 = text.charCodeAt(i + 2);
                if ((c2 === 0x75 /* u */ || c2 === 0x72 /* r */) && text.charCodeAt(i + 3) === 0x3a /* : */) {
                    idStart = i + 4;
                    if (urColonAt < idStart) { const k = text.indexOf(':', idStart); urColonAt = k < 0 ? n : k; }
                    colon = urColonAt;
                }
            }
            if (idStart > 0) {
                // The first `>` after `<` is the first after the id start too.
                if (gtAt < i) { const k = text.indexOf('>', i); gtAt = k < 0 ? n : k; }
                const idLen = colon - idStart;
                const labelLen = gtAt - colon - 1;
                if (gtAt < n && colon < gtAt
                    && idLen >= 1 && idLen <= MENTION_TOKEN_ID_MAX
                    && labelLen >= 1 && labelLen <= MENTION_TOKEN_LABEL_MAX) {
                    end = gtAt + 1;
                }
            }
        } else if (all && ch === 0x40 /* @ */) {
            if (text.startsWith('@everyone', i)) end = i + 9;
            else if (text.startsWith('@here', i)) end = i + 5;
        }
        if (end > 0) {
            out.push({ index: i, 0: text.slice(i, end) });
            i = end;
        } else {
            i += 1;
        }
    }
    return out;
}

/**
 * A drop-in for the `const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
 * while ((m = re.exec(text)) !== null)` loop: `exec(text)` returns the next
 * token (with `index` and `[0]`) or null, from a linear `findMentionTokens`.
 */
export function mentionTokenMatcher(kind: 'all' | 'emoji' = 'all'): { exec(text: string): MentionTokenMatch | null } {
    let forText: string | null = null;
    let matches: MentionTokenMatch[] = [];
    let next = 0;
    return {
        exec(text: string): MentionTokenMatch | null {
            if (text !== forText) {
                forText = text;
                matches = findMentionTokens(text, kind);
                next = 0;
            }
            if (next >= matches.length) {
                // Like a global RegExp reaching the end: reset for the next walk.
                forText = null;
                return null;
            }
            return matches[next++];
        },
    };
}

export interface ParsedMentionToken {
    kind: 'user' | 'role' | 'everyone' | 'here' | 'emoji';
    id?: string;
    label: string;
}

/**
 * Parse a single mention/emoji token string and return structured data.
 * Returns null for unrecognised tokens (including anything the caller
 * matched some other way — this function does no matching of its own).
 */
export function parseMentionToken(token: string): ParsedMentionToken | null {
    if (token === '@everyone') return { kind: 'everyone', label: 'everyone' };
    if (token === '@here')     return { kind: 'here',     label: 'here' };
    // Labels are sender-chosen display text: bidi / control characters are
    // stripped (utils/fileSafety.ts) so a label cannot reorder the line.
    const userMatch = token.match(/^<@u:([^:>]{1,64}):([^>]{1,128})>$/);
    if (userMatch) return { kind: 'user', id: userMatch[1], label: stripBidiControls(userMatch[2]) };
    const roleMatch = token.match(/^<@r:([^:>]{1,64}):([^>]{1,128})>$/);
    if (roleMatch) return { kind: 'role', id: roleMatch[1], label: stripBidiControls(roleMatch[2]) };
    const emojiMatch = token.match(/^<:([^:>]{1,64}):([^>]{1,128})>$/);
    if (emojiMatch) return { kind: 'emoji', id: emojiMatch[2], label: stripBidiControls(emojiMatch[1]) };
    return null;
}

export interface MentionsToPlainTextOptions {
    /**
     * What to do with a user mention `resolveUsername` could not resolve.
     *
     *   'unknown'     — render `@unknown` (the default, and what the
     *                   conversation-list preview wants: that list has no
     *                   per-server roster, so an unresolved id there really is
     *                   a stranger).
     *   'token-label' — render `@<the label embedded in the token>`. This is
     *                   what ChatPane's inline renderer already does for EVERY
     *                   user mention, so it is the right choice anywhere the
     *                   text is a preview OF a message the user is about to
     *                   read in ChatPane — a notification body, a pinned-message
     *                   row. Rendering `@unknown` there would contradict the
     *                   message itself two clicks later.
     *
     * Neither option ever emits the raw user id.
     */
    unresolvedUser?: 'unknown' | 'token-label';
}

/**
 * Render message text with @mention / custom-emoji tokens replaced by plain,
 * privacy-safe text. No JSX, no click handlers — this is the "single
 * truncated line" shape the conversation-list preview needs, as opposed to
 * `renderTextWithMentions` in ChatPane.tsx which builds interactive React
 * nodes for the full message view.
 *
 * Resolution rules:
 *   - `@everyone` / `@here` render as themselves — they aren't people, there's
 *     nothing to resolve.
 *   - A user mention resolves via `resolveUsername(id)` — the CALLER's own
 *     notion of "currently known users" (e.g. an accepted-friends map), not
 *     the label embedded in the token. This is deliberate: the embedded
 *     label is a snapshot from whenever the message was sent and is exactly
 *     as trustworthy as the sender's client claimed it was, and re-deriving
 *     "known" independently is what lets an unknown/departed user resolve to
 *     a neutral placeholder rather than leaking their raw id into UI text.
 *     Unresolvable → `@unknown`, never the id.
 *   - A role mention renders using the label embedded in its own token —
 *     roles aren't personal-identifying, and there is no live per-role
 *     roster available in every context this runs in (e.g. the conversation
 *     list has no notion of "which server was this role in").
 *   - A custom-emoji token renders as its plain `:name:` shortcode.
 *   - Anything the token grammar doesn't recognise (including a malformed
 *     near-miss that fails to match `MENTION_TOKEN_RE` at all) passes
 *     through unchanged — it was never structured data to begin with, so
 *     there's nothing to resolve or hide.
 */
export function mentionsToPlainText(
    text: string,
    resolveUsername: (userId: string) => string | undefined,
    opts: MentionsToPlainTextOptions = {},
): string {
    // Callers pass `content.text` from decrypted, sender-chosen content; a
    // non-string there must not throw out of a render.
    if (typeof text !== 'string') return '';
    if (!text) return text;
    let out = '';
    let lastIndex = 0;
    for (const m of findMentionTokens(text)) {
        out += text.slice(lastIndex, m.index);
        const parsed = parseMentionToken(m[0]);
        if (!parsed) {
            out += m[0];
        } else if (parsed.kind === 'everyone') {
            out += '@everyone';
        } else if (parsed.kind === 'here') {
            out += '@here';
        } else if (parsed.kind === 'user') {
            const name = parsed.id ? resolveUsername(parsed.id) : undefined;
            const fallback = opts.unresolvedUser === 'token-label' && parsed.label
                ? `@${parsed.label}`
                : '@unknown';
            out += name ? `@${name}` : fallback;
        } else if (parsed.kind === 'role') {
            out += `@${parsed.label}`;
        } else {
            // Custom emoji — plain shortcode form.
            out += `:${parsed.label}:`;
        }
        lastIndex = m.index + m[0].length;
    }
    out += text.slice(lastIndex);
    return out;
}

/**
 * The form a message takes anywhere it is shown as PLAIN TEXT but is still
 * "this message" rather than "a summary of it" — an OS notification body, a
 * pinned-message row, the composer when an edit is opened.
 *
 * It renders exactly what ChatPane's inline renderer renders, minus the JSX:
 * `<@u:ID:Shinobi>` -> `@Shinobi`, `<@r:ID:Mods>` -> `@Mods`,
 * `<:party:ID>` -> `:party:`, `@everyone` / `@here` unchanged.
 *
 * This exists because the raw wire token leaked to users in three separate
 * places at once (the OS toast, the pinned panel, and the edit composer), each
 * of which had independently reached for `content.text` and rendered it
 * directly. The token grammar is an implementation detail of the wire format
 * and a user should never see one; the fix for "somewhere new is showing
 * `<@u:...>`" is to route it through here, not to add a fourth regex.
 *
 * It deliberately takes no resolver. These surfaces are previews of a specific
 * message, so the label captured at send time — the same one ChatPane shows —
 * is the correct and consistent answer, and a resolver would let the
 * notification disagree with the message it is announcing.
 */
export function mentionsToDisplayText(text: string): string {
    return mentionsToPlainText(text, () => undefined, { unresolvedUser: 'token-label' });
}

/**
 * Walk message text and extract a deduplicated `MentionEntry[]` array.
 * Used when building the outgoing `ClientContent` so the server can route
 * push notifications without decrypting the message body.
 *
 * A custom-emoji token is skipped entirely: it is not a mention and there is
 * nothing for the server to route from it. This guard matters because the
 * chains below were written when only user/role/everyone/here existed. An
 * emoji token used to fall through to the final `else` and was sent as a ROLE
 * mention carrying the emoji's id, and its dedupe key fell through to 'here',
 * so a real `@here` later in the same message was dropped as a duplicate.
 * Mirrors mobile's `extractMentionEntries` (`src/features/chat/logic/mentions.ts`).
 */
export function extractMentionsFromText(text: string): MentionEntry[] {
    if (typeof text !== 'string') return [];
    const seen = new Set<string>();
    const entries: MentionEntry[] = [];
    for (const m of findMentionTokens(text)) {
        const parsed = parseMentionToken(m[0]);
        if (!parsed || parsed.kind === 'emoji') continue;
        const key =
            parsed.kind === 'user'     ? `u:${parsed.id}` :
            parsed.kind === 'role'     ? `r:${parsed.id}` :
            parsed.kind;
        if (seen.has(key)) continue;
        seen.add(key);
        if (parsed.kind === 'everyone') entries.push({ type: 'everyone' });
        else if (parsed.kind === 'here')  entries.push({ type: 'here' });
        else if (parsed.kind === 'user')  entries.push({ type: 'user', id: parsed.id! });
        else                              entries.push({ type: 'role', id: parsed.id! });
    }
    return entries;
}

/**
 * Returns true if `text` mentions the given user ID or contains @everyone / @here.
 *
 * Lives here (pure, DOM-free) rather than in ChatPane.tsx so the channel
 * mention path can be tested without importing a 7k-line component; ChatPane
 * re-exports it under the same name.
 */
export function messageTextMentionsUser(text: string, userId: string): boolean {
    if (typeof text !== 'string') return false;
    if (text.includes('@everyone') || text.includes('@here')) return true;
    return text.includes(`<@u:${userId}:`);
}

/**
 * Returns true if `text` contains a role-mention token (`<@r:ROLE_ID:…>`)
 * for any role ID in `myRoleIds`.
 */
export function messageTextMentionsRole(text: string, myRoleIds: ReadonlySet<string>): boolean {
    if (myRoleIds.size === 0 || typeof text !== 'string') return false;
    // The linear scanner, not a regex (see MENTION_TOKEN_RE for why).
    if (!text.includes('<@r:')) return false;
    for (const m of findMentionTokens(text)) {
        const parsed = parseMentionToken(m[0]);
        if (parsed?.kind === 'role' && parsed.id && myRoleIds.has(parsed.id)) return true;
    }
    return false;
}

/**
 * The ONE "does this server-channel message ping me directly" test, run on
 * DECRYPTED text only — never on anything the server can read. Shared by the
 * live `channel:message_new` path, the boot/reconnect mention reconcile and
 * the late-key recovery, which used to carry their own copies of the same OR.
 *
 * A direct ping is a `<@u:ME:…>` token, `@everyone` / `@here` (in the text, or
 * the row's `mentions_everyone` flag), or a `<@r:ROLE:…>` token for a role the
 * viewer holds in that server. User KEYWORDS are not here on purpose:
 * notificationDecision.resolveNotification folds them in for every surface.
 */
export function channelTextMentionsViewer(p: {
    text: string;
    userId: string | null | undefined;
    mentionsEveryone?: boolean;
    myRoleIds: ReadonlySet<string>;
}): boolean {
    if (!p.userId) return false;
    return messageTextMentionsUser(p.text, p.userId)
        || !!p.mentionsEveryone
        || messageTextMentionsRole(p.text, p.myRoleIds);
}
