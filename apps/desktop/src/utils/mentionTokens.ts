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

const MENTION_TOKEN_RE = /(<@[ur]:[^:>]+:[^>]+>|<:[^:>]+:[^>]+>|@everyone|@here)/g;

export { MENTION_TOKEN_RE };

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
    const userMatch = token.match(/^<@u:([^:>]+):([^>]+)>$/);
    if (userMatch) return { kind: 'user', id: userMatch[1], label: userMatch[2] };
    const roleMatch = token.match(/^<@r:([^:>]+):([^>]+)>$/);
    if (roleMatch) return { kind: 'role', id: roleMatch[1], label: roleMatch[2] };
    const emojiMatch = token.match(/^<:([^:>]+):([^>]+)>$/);
    if (emojiMatch) return { kind: 'emoji', id: emojiMatch[2], label: emojiMatch[1] };
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
    if (!text) return text;
    let out = '';
    let lastIndex = 0;
    const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
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
    const seen = new Set<string>();
    const entries: MentionEntry[] = [];
    const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
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
