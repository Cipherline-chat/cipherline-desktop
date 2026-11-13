import { findMentionTokens, parseMentionToken } from './mentionTokens';
import { isPersonalEmojiId } from './personalEmoji/token';

export type PreviewPart =
    | { kind: 'text'; text: string }
    | { kind: 'emoji'; id: string; label: string };

/**
 * Split message text into plain-text runs and drawable personal emojis.
 * Text runs still contain any mention / server-emoji tokens; the caller turns
 * those into plain text.
 */
export function previewParts(text: unknown): PreviewPart[] {
    if (typeof text !== 'string' || !text) return [];
    const out: PreviewPart[] = [];
    let last = 0;
    for (const m of findMentionTokens(text, 'emoji')) {
        const parsed = parseMentionToken(m[0]);
        if (!parsed || parsed.kind !== 'emoji' || !isPersonalEmojiId(parsed.id)) continue;
        if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
        out.push({ kind: 'emoji', id: parsed.id, label: parsed.label });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
}
