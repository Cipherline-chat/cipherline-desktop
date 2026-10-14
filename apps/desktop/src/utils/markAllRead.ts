/**
 * "Mark all as read" for the rail's Direct messages / Group chats buttons.
 *
 * There is no REST route for a DM/group read: opening a conversation reports
 * it with ONE `message:read` WS event naming the newest real message
 * (ChatPane's receipt effect -> utils/readReceipt.ts). The server turns that
 * into the durable cursor (conversation_read_states) and relays it to the
 * reader's other devices, so the badge clears on the phone too. A bulk mark-read
 * is therefore the same event, once per conversation that has unread —
 * nothing new on the server, no new endpoint.
 *
 * Read receipts: mirrored EXACTLY from opening. The user is choosing to mark
 * these read, so the other party sees "read" iff they would have after opening
 * the chat (privacy "show read receipts" on, and not a self chat); otherwise
 * the event is `self_only`. It is one event per conversation naming only the
 * latest message — never one per message — so there is no receipt storm; the
 * only fan-out is N conversations, which is paced below.
 *
 * Optimistic: badges clear first; any conversation whose event could not be
 * sent gets its counts put back and the caller is told to toast.
 */
import { clearCountsForIds, type CountMap } from './unreadBadges';
import { lastReadableMessageId, readReceiptToSend } from './readReceipt';

export type ConversationScope = 'dm' | 'group';

/**
 * The conversation ids that currently contribute to a rail button's badge:
 * everything with an unread or mention count, classified the way
 * `dmGroupRailBadges` classifies it — an id the client cannot classify yet
 * (its count arrived before the conversation did) belongs to the DM button.
 * Raw counts, so a muted conversation (hidden badge) can still be cleared —
 * same rule as the server rail's "Mark as Read".
 */
export function unreadConversationIds(
    unread: CountMap,
    mentions: CountMap,
    classify: (conversationId: string) => 'dm' | 'group' | undefined,
    scope: ConversationScope,
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const map of [unread, mentions]) {
        for (const [id, n] of Object.entries(map)) {
            if (!n || n <= 0 || seen.has(id)) continue;
            seen.add(id);
            if ((classify(id) ?? 'dm') === scope) out.push(id);
        }
    }
    return out;
}

/**
 * What to send for one conversation: the same call ChatPane makes on open, with
 * the window treated as attended (the user just clicked). `null` = nothing to
 * name (no real message loaded), in which case there is nothing to report.
 */
export function readEventFor(p: {
    messages: ReadonlyArray<{ id?: unknown; content?: { type?: unknown } | null }> | undefined;
    isSelfChat: boolean;
    showReadReceipts: boolean;
}): { id: string; selfOnly: boolean } | null {
    return readReceiptToSend({
        lastId: lastReadableMessageId(p.messages ?? []),
        lastSentId: null,
        attended: true,
        // A self chat never receipts to anyone: always the self-only form.
        showReadReceipts: p.showReadReceipts && !p.isSelfChat,
    });
}

/**
 * Put back what a failed mark-read cleared. ADDS the snapshot to whatever is
 * there now: messages that arrived while the request was in flight were
 * counted from 0, and they are still unread on top of the restored ones.
 */
export function restoreCounts(current: CountMap, prior: CountMap, ids: readonly string[]): CountMap {
    let changed = false;
    const next = { ...current };
    for (const id of ids) {
        const was = prior[id];
        if (!was || was <= 0) continue;
        next[id] = (next[id] ?? 0) + was;
        changed = true;
    }
    return changed ? next : current;
}

/** The gateway's per-socket bucket is 50 burst / 10 per s; stay well inside it. */
export const MARK_READ_BURST = 20;
export const MARK_READ_PACE_MS = 125;

export interface MarkAllReadOptions {
    ids: readonly string[];
    /** Counts at click time — the rollback snapshot. */
    unread: CountMap;
    mentions: CountMap;
    /** Optimistic: drop these ids' unread + mention counts. */
    clearLocal: (ids: string[]) => void;
    /** Rollback: add the snapshot counts back for these ids. */
    restoreLocal: (prior: { unread: CountMap; mentions: CountMap }, ids: string[]) => void;
    /** The per-conversation mark-read (same path as opening). false = not sent. */
    markRead: (conversationId: string) => boolean;
    /** Called once with every id that could not be marked. */
    onFailure: (failedIds: string[]) => void;
    burst?: number;
    paceMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

export async function markConversationsRead(o: MarkAllReadOptions): Promise<{ sent: string[]; failed: string[] }> {
    const ids = [...new Set(o.ids)];
    const sent: string[] = [];
    const failed: string[] = [];
    if (ids.length === 0) return { sent, failed };
    const burst = o.burst ?? MARK_READ_BURST;
    const paceMs = o.paceMs ?? MARK_READ_PACE_MS;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

    // Optimistic clear. The first burst below runs synchronously in the same
    // tick, so a socket that is down rolls back inside one React batch — no
    // flicker of the badge disappearing and reappearing.
    o.clearLocal(ids);

    const attempt = (id: string) => {
        let ok = false;
        try { ok = o.markRead(id); } catch { ok = false; }
        (ok ? sent : failed).push(id);
    };
    let i = 0;
    for (; i < ids.length && i < burst; i++) attempt(ids[i]);
    // The rest is paced: a user with hundreds of unread chats must not exhaust
    // the socket's token bucket (events past it are dropped, silently).
    for (; i < ids.length; i++) {
        await sleep(paceMs);
        attempt(ids[i]);
    }

    if (failed.length > 0) {
        o.restoreLocal({ unread: o.unread, mentions: o.mentions }, failed);
        o.onFailure(failed);
    }
    return { sent, failed };
}

type CountSetter = (update: (prev: CountMap) => CountMap) => void;

export interface RunMarkReadDeps {
    ids: readonly string[];
    /** Counts at call time — the rollback snapshot. */
    unread: CountMap;
    mentions: CountMap;
    setUnread: CountSetter;
    setMentions: CountSetter;
    messagesOf: (conversationId: string) => ReadonlyArray<{ id?: unknown; content?: { type?: unknown } | null }> | undefined;
    isSelfChat: (conversationId: string) => boolean;
    showReadReceipts: boolean;
    /** The socket sender (`useRealtime().sendReadReceipt`): false = not sent. */
    send: (conversationId: string, lastReadMessageId: string, opts?: { selfOnly?: boolean }) => boolean;
    notifyFailure: (message: string) => void;
    sleep?: MarkAllReadOptions['sleep'];
}

/**
 * THE mark-read for DM / group conversations — one call for a single
 * conversation (the sidebar's "Mark as Read") or many (the rail's "Mark all as
 * read"). Clears unread AND mention counts optimistically, sends the same
 * `message:read` opening the chat sends (receipt per the user's setting, else
 * self-only), rolls back + reports on failure.
 *
 * A conversation with no real message loaded has nothing to name, so nothing
 * is sent and the local clear stands; its read position is then not synced to
 * the user's other devices (same as opening a chat with no readable message).
 */
export function runMarkRead(d: RunMarkReadDeps): Promise<{ sent: string[]; failed: string[] }> {
    return markConversationsRead({
        ids: d.ids, unread: d.unread, mentions: d.mentions, sleep: d.sleep,
        clearLocal: cleared => {
            d.setUnread(prev => clearCountsForIds(prev, cleared));
            d.setMentions(prev => clearCountsForIds(prev, cleared));
        },
        restoreLocal: (prior, failed) => {
            d.setUnread(prev => restoreCounts(prev, prior.unread, failed));
            d.setMentions(prev => restoreCounts(prev, prior.mentions, failed));
        },
        markRead: id => {
            const ev = readEventFor({
                messages: d.messagesOf(id),
                isSelfChat: d.isSelfChat(id),
                showReadReceipts: d.showReadReceipts,
            });
            if (!ev) return true;
            return d.send(id, ev.id, ev.selfOnly ? { selfOnly: true } : undefined);
        },
        onFailure: failed => d.notifyFailure(
            `Couldn't mark ${failed.length === 1 ? '1 conversation' : `${failed.length} conversations`} as read. Check your connection and try again.`,
        ),
    });
}
