/**
 * Persistent system messages in a server channel — "X joined the server.",
 * "X left", "X was kicked by Y", "X was banned by Y".
 *
 * These are REAL history rows now (`channel_messages.kind = 'system'` on the
 * server), delivered the same two ways as any message: in `GET
 * /v1/channels/:id/messages?include_system=1` (so the joiner, members who were
 * offline, and anyone after a reload all see them) and live as a
 * `channel:system_message` event. This module turns either shape into the one
 * local row the thread stores, and is deliberately pure so both paths — and
 * their tests — share it.
 *
 * LOCAL ROW SHAPE. The server stores NO names, so the row keeps only ids:
 *
 *     { id, timestamp, conversation_id, sender_user_id: null, sender_device_id: '',
 *       content: { type: 'system', kind: 'member_event', event,
 *                  subject_user_id, actor_user_id } }
 *
 * `type: 'system'` is what every "local, never-encrypted" check in the app
 * already keys on (the key-wait page summary treats it as neutral; the DM/read
 * -receipt/unread scans skip it), so a member-event row can never read as an
 * undecryptable message. The text is built at RENDER time from the CURRENT
 * username (`memberEventText`), so a rename shows through, and a user the
 * client cannot resolve — deleted account, or never seen — reads "A former
 * member".
 *
 * EPHEMERAL FALLBACK. The API only WRITES these rows when it runs with
 * `SYSTEM_MESSAGE_ROWS_ENABLED=true` (staging and prod share one database and
 * prod's older API would serve the null-ciphertext rows to stable clients).
 * While it is off, the server still emits the legacy `channel:system_event`
 * live push, and this client renders THAT as a non-persisted local line
 * (`memberEventFromLegacy`, id prefixed `legacy-sys:`, ids only - the name is
 * resolved at render like any other member event). If a persisted twin of the
 * same (event, subject user) shows up within +-5 s - live or via history - the
 * ephemeral line is dropped, so exactly one row remains.
 */

import {
    isSystemMessageEvent,
    systemMessageText,
    type ChannelSystemMessageEvent,
    type SystemMessageEvent,
} from '@cipherline/shared';
import { resolveNotification, type NotifDecision, type NotifMode } from './notificationDecision';

export const MEMBER_EVENT_KIND = 'member_event' as const;

export interface MemberEventContent {
    type: 'system';
    kind: typeof MEMBER_EVENT_KIND;
    event: SystemMessageEvent;
    subject_user_id: string | null;
    actor_user_id: string | null;
}

/** The slice of a stored thread row this module produces. */
export interface MemberEventRow {
    id: string;
    content: MemberEventContent;
    sender_device_id: '';
    sender_user_id: null;
    timestamp: string;
    conversation_id: string;
}

/** A system row exactly as `GET /v1/channels/:id/messages?include_system=1` serves it. */
export interface RawSystemRow {
    id: string;
    kind: 'system';
    system_event: unknown;
    system_subject_user_id?: unknown;
    system_actor_user_id?: unknown;
    created_at: string;
}

/** True for a history row the server marked as a system row. */
export function isRawSystemRow(r: { kind?: unknown } | null | undefined): r is RawSystemRow {
    return !!r && r.kind === 'system';
}

const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function build(
    id: unknown, channelId: string, createdAt: unknown,
    event: unknown, subject: unknown, actor: unknown,
): MemberEventRow | null {
    // Validate at the trust boundary: an unknown event (a newer server), a
    // missing id or an unparseable time is dropped, never coerced into a row.
    if (typeof id !== 'string' || !id) return null;
    if (!isSystemMessageEvent(event)) return null;
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
    return {
        id,
        content: {
            type: 'system',
            kind: MEMBER_EVENT_KIND,
            event,
            subject_user_id: idOrNull(subject),
            actor_user_id: idOrNull(actor),
        },
        sender_device_id: '',
        sender_user_id: null,
        timestamp: createdAt,
        conversation_id: channelId,
    };
}

/** A history row → the local row (null if it is not a well-formed system row). */
export function memberEventFromHistory(channelId: string, raw: RawSystemRow): MemberEventRow | null {
    return build(raw.id, channelId, raw.created_at, raw.system_event, raw.system_subject_user_id, raw.system_actor_user_id);
}

/** A live `channel:system_message` event → the SAME local row. */
export function memberEventFromLive(evt: Partial<ChannelSystemMessageEvent> | null | undefined): MemberEventRow | null {
    if (!evt || evt.kind !== 'system' || typeof evt.channel_id !== 'string') return null;
    return build(evt.message_id, evt.channel_id, evt.created_at, evt.system_event, evt.system_subject_user_id, evt.system_actor_user_id);
}

export function isMemberEventContent(c: unknown): c is MemberEventContent {
    const x = c as Partial<MemberEventContent> | null | undefined;
    return !!x && x.type === 'system' && x.kind === MEMBER_EVENT_KIND && isSystemMessageEvent(x.event);
}

/** Every user id a row needs a name for (to hydrate the roster map). */
export function memberEventUserIds(c: MemberEventContent): string[] {
    return [c.subject_user_id, c.actor_user_id].filter((v): v is string => !!v);
}

/**
 * The line to show. `nameOf` is the CURRENT username for an id, or undefined
 * when unknown — both an unknown id and a null id (deleted account) read as
 * "A former member". Never shows a raw id.
 */
export function memberEventText(
    c: MemberEventContent,
    nameOf: (userId: string) => string | null | undefined,
): string {
    const name = (id: string | null) => (id ? nameOf(id) : null);
    return systemMessageText(c.event, name(c.subject_user_id), name(c.actor_user_id));
}

/** Prefix of the id of a non-persisted line built from the legacy `channel:system_event`. */
export const EPHEMERAL_MEMBER_EVENT_PREFIX = 'legacy-sys:';
/** A persisted row and an ephemeral line for the same (event, subject) this close are the same occurrence. */
export const MEMBER_EVENT_DEDUPE_WINDOW_MS = 5_000;

/** True for the id of a line that exists only on this client (no server row: no reactions, no delete). */
export function isEphemeralMemberEventId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(EPHEMERAL_MEMBER_EVENT_PREFIX);
}

/** The legacy `channel:system_event` payload (usernames are ignored on purpose). */
export interface LegacySystemEventPayload {
    channel_id?: unknown;
    event_type?: unknown;
    user_id?: unknown;
    actor_id?: unknown;
    created_at?: unknown;
}

/**
 * A legacy `channel:system_event` -> a local, NON-persisted member-event row.
 * Built from user ids only (the roster supplies the CURRENT username at render
 * time). The id is deterministic - event + subject + time - so the same push
 * delivered twice is one row. Null for anything malformed (never coerced).
 */
export function memberEventFromLegacy(evt: LegacySystemEventPayload | null | undefined): MemberEventRow | null {
    if (!evt || typeof evt.channel_id !== 'string' || !evt.channel_id) return null;
    const subject = idOrNull(evt.user_id);
    if (!subject) return null;
    if (!isSystemMessageEvent(evt.event_type)) return null;
    if (typeof evt.created_at !== 'string' || Number.isNaN(Date.parse(evt.created_at))) return null;
    return build(
        `${EPHEMERAL_MEMBER_EVENT_PREFIX}${evt.event_type}:${subject}:${Date.parse(evt.created_at)}`,
        evt.channel_id, evt.created_at, evt.event_type, subject, evt.actor_id,
    );
}

type ThreadRow = { id: string; timestamp: string; content?: unknown };

const sameOccurrence = (a: MemberEventContent, at: string, b: MemberEventContent, bt: string): boolean =>
    a.event === b.event
    && a.subject_user_id === b.subject_user_id
    && Math.abs(Date.parse(at) - Date.parse(bt)) <= MEMBER_EVENT_DEDUPE_WINDOW_MS;

/**
 * Remove every ephemeral line that a PERSISTED row of the same occurrence
 * (event + subject user, within +-5 s) has superseded. Returns the SAME array
 * when nothing was removed, so callers can bail out of a re-render.
 */
export function dropShadowedEphemeralRows<T extends ThreadRow>(thread: readonly T[]): readonly T[] {
    const persisted: Array<{ c: MemberEventContent; t: string }> = [];
    for (const r of thread) {
        if (!isEphemeralMemberEventId(r.id) && isMemberEventContent(r.content)) persisted.push({ c: r.content, t: r.timestamp });
    }
    if (persisted.length === 0) return thread;
    const kept = thread.filter(r => {
        if (!isEphemeralMemberEventId(r.id) || !isMemberEventContent(r.content)) return true;
        const ec = r.content;
        return !persisted.some(p => sameOccurrence(p.c, p.t, ec, r.timestamp));
    });
    return kept.length === thread.length ? thread : kept;
}

/**
 * Add a member-event row to a thread, once. Returns the SAME array when the id
 * is already present, so a live event and the history fetch that delivers the
 * same row can race in either order without a duplicate (or a re-render).
 * The result is chronological. Adding a PERSISTED row also removes any
 * ephemeral line it supersedes (see `dropShadowedEphemeralRows`).
 */
export function addMemberEventRow<T extends ThreadRow>(thread: readonly T[], row: T): T[] | readonly T[] {
    if (thread.some(t => t.id === row.id)) return thread;
    const merged = [...thread, row].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return isEphemeralMemberEventId(row.id) ? merged : dropShadowedEphemeralRows(merged);
}

/**
 * Add the ephemeral line built from a legacy `channel:system_event`. A no-op
 * (same array) when it is already there OR when a persisted row for the same
 * occurrence is - the persisted row wins, whichever arrived first.
 */
export function addEphemeralMemberEventRow<T extends ThreadRow>(thread: readonly T[], row: T): T[] | readonly T[] {
    if (thread.some(t => t.id === row.id)) return thread;
    if (isMemberEventContent(row.content)) {
        const c = row.content;
        const shadowed = thread.some(t =>
            !isEphemeralMemberEventId(t.id) && isMemberEventContent(t.content) && sameOccurrence(t.content, t.timestamp, c, row.timestamp));
        if (shadowed) return thread;
    }
    return [...thread, row].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/** Does this event concern the viewer themself (their own join / leave, or
 *  a kick/ban they carried out)? Those are never "unread news" for them. */
export function memberEventIsMine(c: MemberEventContent, userId: string | null | undefined): boolean {
    return !!userId && (c.subject_user_id === userId || c.actor_user_id === userId);
}

/**
 * What an arriving system row does to the unread badge — the system twin of
 * `decideChannelMessage`, built on the same `resolveNotification` so the
 * notification level is respected EXACTLY as for a plain message:
 *
 *   - counts as unread when the user is not looking at the channel and the
 *     level is not "nothing" (@mentions-only still counts, quietly — same as a
 *     plain message);
 *   - NEVER a mention (no text, no keywords, no direct ping, no @everyone);
 *   - NEVER a sound or an OS notification: someone joining a server is context,
 *     not a message anyone should be pinged for (and in a busy server it would
 *     be a ding per join).
 *
 * Returns null for the viewer's own event.
 */
export function decideChannelSystemRow(input: {
    content: MemberEventContent;
    userId: string | null | undefined;
    mode: NotifMode;
    windowFocused: boolean;
    isActiveConversation: boolean;
}): NotifDecision | null {
    if (memberEventIsMine(input.content, input.userId)) return null;
    const d = resolveNotification({
        text: '',
        directMention: false,
        keywords: [],
        mode: input.mode,
        windowFocused: input.windowFocused,
        isActiveConversation: input.isActiveConversation,
        suppressWhenActiveConv: false,
        dndActive: false,
        dndLetMentionsThrough: false,
    });
    return { isMention: false, countsMention: false, countsUnread: d.countsUnread, playsSound: false, showsToast: false };
}
