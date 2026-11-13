/**
 * Deleting join / leave / kick / ban lines ("system messages").
 *
 * Three kinds of line exist and each is deleted by the rule that matches how it
 * lives (see docs/system-messages.md):
 *
 *   'server' - a PERSISTED member-event row in a server channel
 *              (`channel_messages.kind = 'system'`). It is shared state, so it
 *              goes through the normal `delete` action and the server demands
 *              MANAGE_MESSAGES (channel-messages.service). Server owner/admins/mods
 *              hold it; everyone else
 *              cannot delete it and sees no control.
 *   'local'  - a line that exists only on this client: the ephemeral line drawn
 *              from the legacy `channel:system_event` (flag off, i.e. prod
 *              today) and the "X added Y / X left" text lines of group chats.
 *              The server never stored them, so there is nothing to delete for
 *              everyone; the viewer hides it from THEIR view, remembered per
 *              account in secureLocalStore. Any member may do that: it changes
 *              nobody else's screen.
 *   null     - not a deletable system line (undecryptable placeholder, ...).
 *
 * The client mirrors the server rule for UX only; the server enforces it.
 */
import { isMemberEventContent, isEphemeralMemberEventId } from './systemMessages';

export type SystemRowDeleteMode = 'server' | 'local' | null;

export const HIDDEN_SYSTEM_ROWS_KEY_PREFIX = 'cipherline_hidden_system_rows_';
/** Newest N ids are remembered; older lines are long gone from history anyway. */
export const HIDDEN_SYSTEM_ROWS_CAP = 500;

export function hiddenSystemRowsKey(userId: string): string {
    return `${HIDDEN_SYSTEM_ROWS_KEY_PREFIX}${userId}`;
}

interface RowLike { id?: unknown; content?: unknown }

export function systemRowDeleteMode(
    row: RowLike | null | undefined,
    perms: { canManageMessages: boolean; isServerChannel: boolean },
): SystemRowDeleteMode {
    const c = row?.content as { type?: unknown; kind?: unknown; text?: unknown } | null | undefined;
    if (!row || typeof row.id !== 'string' || !c || c.type !== 'system') return null;
    if (isMemberEventContent(c)) {
        if (isEphemeralMemberEventId(row.id)) return 'local';
        return perms.isServerChannel && perms.canManageMessages ? 'server' : null;
    }
    // Plain text line from the group-chat events (no `kind`).
    if (c.kind === undefined && typeof c.text === 'string' && c.text.length > 0) return 'local';
    return null;
}

/** Right-click menu label. A stored row is simply "Delete message" (it goes for
 *  everyone with access to the channel); a client-only line is hidden locally. */
export function systemRowDeleteLabel(mode: Exclude<SystemRowDeleteMode, null>): string {
    return mode === 'server' ? 'Delete message' : 'Remove from my view';
}

/** Parse the stored JSON defensively; anything malformed reads as empty. */
export function parseHiddenSystemRows(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        if (!Array.isArray(v)) return [];
        return v.filter((x): x is string => typeof x === 'string').slice(-HIDDEN_SYSTEM_ROWS_CAP);
    } catch { return []; }
}

/** Add an id (deduped, newest last, capped). */
export function addHiddenSystemRow(list: string[], id: string): string[] {
    const next = list.filter(x => x !== id);
    next.push(id);
    return next.slice(-HIDDEN_SYSTEM_ROWS_CAP);
}
