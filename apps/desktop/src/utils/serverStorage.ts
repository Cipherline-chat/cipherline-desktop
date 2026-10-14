/**
 * Server channel storage - the local-cache side of Settings -> Storage -> Servers.
 *
 * WHERE SERVER HISTORY LIVES. A server channel's decrypted history is cached on
 * this device in `channelMessages` (Dashboard state), keyed by CHANNEL id, and
 * persisted one record per channel by messageStore
 * (`cipherline_channel_msgs_<uid>_<channelId>`). Unlike a DM envelope
 * (poll-then-ACK, deleted by the server once delivered) a channel message is a
 * durable `channel_messages` row that stays on the server until its own
 * `expires_at`; the local cache is a cache of it, and
 * `GET /v1/channels/:id/messages` can hand any of it back.
 *
 * So a server purge differs from a DM purge in two ways, both handled here and
 * in Dashboard.handlePurgeServerChannels:
 *   1. every dropped id is recorded in the retention tombstone ledger
 *      (utils/retentionTombstones.ts) or the next history fetch re-inserts it;
 *   2. pinned and server-SAVED messages are exempt. A saved message is
 *      server-stored with `expires_at NULL` - the server keeps it for everyone,
 *      so this device must too (same rule as the retention sweep).
 *
 * Nothing here talks to the server. It is pure: state in, plan out.
 */
import { calcConversationStorage } from './storageCalc';
import { retentionRuleFor, msgTimestamp } from './retentionSweeper';
import { attachmentToDeleteWithMessage } from './attachmentOnDelete';

/** The slice of a ServerInfo the storage list needs. */
export interface StorageServer {
    server_id: string;
    name: string;
    icon_attachment?: string | null;
    icon_key_b64?: string | null;
    icon_nonce_b64?: string | null;
}

/** The slice of a ChannelInfo the storage list needs. */
export interface StorageChannel {
    channel_id: string;
    name?: string;
}

export type ServerRowKind = 'joined' | 'left' | 'unknown';

export interface ServerStorageRow {
    /** Stable React key: the server id, or UNKNOWN_ROW_KEY. */
    rowKey: string;
    serverId: string | null;
    name: string;
    kind: ServerRowKind;
    /**
     * Every channel id this row covers - the set a purge acts on. For a joined
     * server that is all of its channels (not just those with data, so a
     * message that lands between render and confirm is still covered).
     */
    channelIds: string[];
    /** False while the server's channel list hasn't loaded: we cannot say which
     *  cached threads are its, so the row shows no size and cannot be purged. */
    channelsKnown: boolean;
    /** Channel names, for the subtitle of a left server (whose name is gone). */
    channelNames: string[];
    totalBytes: number;
    textBytes: number;
    attachmentBytes: number;
    messageCount: number;
    attachmentCount: number;
}

export const UNKNOWN_ROW_KEY = '__unknown_channels__';

export interface ServerStorageInput {
    servers: readonly StorageServer[];
    /** serverId -> channels. A server missing from this map has not loaded yet. */
    serverChannels: Readonly<Record<string, readonly StorageChannel[] | undefined>>;
    /** channelId -> cached messages (Dashboard's `channelMessages`). */
    channelMessages: Readonly<Record<string, readonly unknown[] | undefined>>;
    /** Channel lists of servers this account has LEFT, recovered from the
     *  on-device channel-list cache (serverId -> channels). */
    leftServerChannels?: Readonly<Record<string, readonly StorageChannel[] | undefined>>;
    /**
     * True once the server list is known to be complete (fetched, no error).
     * Until then `servers` may be empty or stale, so a cached thread that
     * "belongs to no server" may just belong to one we haven't heard of yet:
     * the Left / Other rows are withheld rather than offer to purge it.
     * Defaults to true.
     */
    serverListComplete?: boolean;
}

const hasMessages = (m: readonly unknown[] | undefined): m is readonly unknown[] => Array.isArray(m) && m.length > 0;

function emptyRow(over: Partial<ServerStorageRow> & Pick<ServerStorageRow, 'rowKey' | 'name' | 'kind'>): ServerStorageRow {
    return {
        serverId: null, channelIds: [], channelsKnown: true, channelNames: [],
        totalBytes: 0, textBytes: 0, attachmentBytes: 0, messageCount: 0, attachmentCount: 0,
        ...over,
    };
}

function addChannel(row: ServerStorageRow, channelId: string, msgs: readonly unknown[] | undefined): void {
    if (!hasMessages(msgs)) return;
    const s = calcConversationStorage(channelId, msgs as unknown[]);
    row.totalBytes += s.totalBytes;
    row.textBytes += s.textBytes;
    row.attachmentBytes += s.attachmentBytes;
    row.messageCount += s.messageCount;
    row.attachmentCount += s.attachmentCount;
}

/**
 * One row per joined server (always, even with no local data - the user asked
 * for a row per server), then a "Left" row per departed server that still has
 * cached messages, then one catch-all row for cached threads that map to no
 * server we can name.
 *
 * Joined rows are sorted by size, biggest first, ties by name. A thread is
 * attributed to exactly one row, so the rows' totals never double count.
 */
export function aggregateServerStorage(input: ServerStorageInput): ServerStorageRow[] {
    const { servers, serverChannels, channelMessages, leftServerChannels = {}, serverListComplete = true } = input;

    const claimed = new Set<string>();      // channel ids a joined server owns
    const joined: ServerStorageRow[] = [];
    let someChannelListPending = false;

    for (const s of servers) {
        const chs = serverChannels[s.server_id];
        const row = emptyRow({ rowKey: s.server_id, serverId: s.server_id, name: s.name || 'Unnamed server', kind: 'joined' });
        if (!chs) {
            row.channelsKnown = false;
            someChannelListPending = true;
        } else {
            for (const ch of chs) {
                if (claimed.has(ch.channel_id)) continue;
                claimed.add(ch.channel_id);
                row.channelIds.push(ch.channel_id);
                addChannel(row, ch.channel_id, channelMessages[ch.channel_id]);
            }
        }
        joined.push(row);
    }
    joined.sort((a, b) => (b.totalBytes - a.totalBytes) || a.name.localeCompare(b.name));

    // Anything cached that no joined server owns. While some joined server's
    // channel list is still loading we cannot tell its threads from a departed
    // server's, so we say nothing rather than mislabel (and offer to purge) them.
    const leftRows: ServerStorageRow[] = [];
    let unknownRow: ServerStorageRow | null = null;
    if (serverListComplete && !someChannelListPending) {
        const joinedIds = new Set(servers.map(s => s.server_id));
        const leftOwner = new Map<string, string>();            // channelId -> left serverId
        for (const [sid, chs] of Object.entries(leftServerChannels)) {
            if (joinedIds.has(sid) || !chs) continue;           // re-joined: it's a joined row now
            for (const ch of chs) if (!claimed.has(ch.channel_id) && !leftOwner.has(ch.channel_id)) leftOwner.set(ch.channel_id, sid);
        }
        const leftBy = new Map<string, ServerStorageRow>();
        for (const [channelId, msgs] of Object.entries(channelMessages)) {
            if (claimed.has(channelId) || !hasMessages(msgs)) continue;
            const sid = leftOwner.get(channelId);
            if (sid) {
                let row = leftBy.get(sid);
                if (!row) {
                    row = emptyRow({ rowKey: sid, serverId: sid, name: 'Left server', kind: 'left' });
                    leftBy.set(sid, row);
                }
                row.channelIds.push(channelId);
                const name = leftServerChannels[sid]?.find(c => c.channel_id === channelId)?.name;
                if (name) row.channelNames.push(name);
                addChannel(row, channelId, msgs);
            } else {
                unknownRow ??= emptyRow({ rowKey: UNKNOWN_ROW_KEY, name: 'Other channels', kind: 'unknown' });
                unknownRow.channelIds.push(channelId);
                addChannel(unknownRow, channelId, msgs);
            }
        }
        leftRows.push(...[...leftBy.values()].sort((a, b) => b.totalBytes - a.totalBytes));
    }

    return [...joined, ...leftRows, ...(unknownRow ? [unknownRow] : [])];
}

export function sumServerStorage(rows: readonly ServerStorageRow[]): { totalBytes: number; messageCount: number } {
    let totalBytes = 0, messageCount = 0;
    for (const r of rows) { totalBytes += r.totalBytes; messageCount += r.messageCount; }
    return { totalBytes, messageCount };
}

// ── Purge ────────────────────────────────────────────────────────────────

export interface ServerPurgeInput {
    channelMessages: Readonly<Record<string, readonly unknown[] | undefined>>;
    /** The channels to purge - and ONLY these are touched. */
    channelIds: readonly string[];
    /** Drop messages at least this old; 0 = everything. */
    olderThanMs: number;
    /** Message ids to keep for a channel: its pins, server saves, "save forever". */
    protectedIdsFor?: (channelId: string) => ReadonlySet<string> | undefined;
    /** Attachment ids the account saved forever. */
    protectedAttachmentIds?: ReadonlySet<string>;
    now?: number;
}

export interface ServerPurgePlan {
    /** channelId -> remaining messages, for the channels that changed ONLY. */
    next: Record<string, unknown[]>;
    /** channelId -> ids of the dropped messages (for the tombstone ledger). */
    purgedIds: Record<string, string[]>;
    /** Attachment ids whose local encrypted blob should now be removed. */
    attachmentIds: string[];
    /** How many messages the plan drops. */
    count: number;
}

type Row = {
    id?: unknown; _pending?: unknown; send_state?: unknown;
    content?: { type?: unknown; attachment_id?: unknown };
};

/**
 * Would a manual purge drop this row? Keeps: unsent/in-flight rows, control
 * rows (edit / delete / reaction / pin / key material - not chat lines, and
 * deleting one could un-apply what it did; same carve-out as the retention
 * sweep), anything pinned / saved, and rows younger than the window.
 */
export function isServerPurgeable(
    m: unknown,
    olderThanMs: number,
    now: number,
    protectedIds?: ReadonlySet<string>,
    protectedAttachmentIds?: ReadonlySet<string>,
): boolean {
    const r = m as Row | null | undefined;
    if (!r) return false;
    if (r._pending || r.send_state === 'sending') return false;
    if (retentionRuleFor(r.content?.type) === 'keep') return false;
    if (typeof r.id === 'string' && protectedIds?.has(r.id)) return false;
    const attId = r.content?.type === 'attachment' ? r.content.attachment_id : undefined;
    if (typeof attId === 'string' && protectedAttachmentIds?.has(attId)) return false;
    if (olderThanMs === 0) return true;
    return (now - msgTimestamp(r)) >= olderThanMs;
}

/** What `planServerPurge` would drop, without building the result. Used by the
 *  menu's per-option counts so they cannot disagree with the delete. */
export function countServerPurge(input: ServerPurgeInput): number {
    const now = input.now ?? Date.now();
    let n = 0;
    for (const channelId of new Set(input.channelIds)) {
        const msgs = input.channelMessages[channelId];
        if (!Array.isArray(msgs)) continue;
        const prot = input.protectedIdsFor?.(channelId);
        for (const m of msgs) if (isServerPurgeable(m, input.olderThanMs, now, prot, input.protectedAttachmentIds)) n++;
    }
    return n;
}

export function planServerPurge(input: ServerPurgeInput): ServerPurgePlan {
    const now = input.now ?? Date.now();
    const next: Record<string, unknown[]> = {};
    const purgedIds: Record<string, string[]> = {};
    const attachmentIds = new Set<string>();
    let count = 0;
    for (const channelId of new Set(input.channelIds)) {
        const msgs = input.channelMessages[channelId];
        if (!Array.isArray(msgs)) continue;
        const prot = input.protectedIdsFor?.(channelId);
        const kept: unknown[] = [];
        const ids: string[] = [];
        let dropped = 0;
        for (const m of msgs) {
            if (!isServerPurgeable(m, input.olderThanMs, now, prot, input.protectedAttachmentIds)) { kept.push(m); continue; }
            dropped++;
            const id = (m as Row).id;
            if (typeof id === 'string' && id) ids.push(id);
            const att = attachmentToDeleteWithMessage(m);
            if (att) attachmentIds.add(att);
        }
        if (!dropped) continue;
        next[channelId] = kept;
        if (ids.length) purgedIds[channelId] = ids;
        count += dropped;
    }
    return { next, purgedIds, attachmentIds: [...attachmentIds], count };
}

/** Outcome of a server purge, for the inline status line under the row. */
export interface ServerPurgeResult {
    /** Messages removed from this device. */
    purged: number;
    /** Channels left untouched because their saved / pinned set could not be
     *  confirmed (offline) - deleting blind could take a saved message. */
    skippedChannels: number;
}

/** Confirm-dialog warning for a server purge. Accurate for server history,
 *  which (unlike a DM) still exists on the server for everyone else. */
export const SERVER_PURGE_WARNING =
    'This cannot be undone. It clears every channel of this server on this device only: other members and your other devices keep their copies. Pinned and saved messages are kept, and purged messages are not downloaded again.';

/**
 * Confirm-dialog warning for a server this account has LEFT (or threads that map
 * to no server we are in). Its saved / pinned set can no longer be read from the
 * server, so the "pinned and saved are kept" promise cannot be made - say so.
 * Only the account's own local "Save for me" pins (and any server-saved ids this
 * session already learned) are kept.
 */
export const LEFT_SERVER_PURGE_WARNING =
    'This cannot be undone. You are no longer in this server, so its saved messages can’t be checked: everything matching is cleared from this device except messages you pinned for yourself. Other members keep their copies.';

export function describePurgeResult(r: ServerPurgeResult): { tone: 'ok' | 'warn'; text: string } {
    const noun = r.purged === 1 ? 'message' : 'messages';
    const base = r.purged > 0 ? `Removed ${r.purged.toLocaleString()} ${noun} from this device.` : 'Nothing was removed.';
    if (r.skippedChannels > 0) {
        const ch = r.skippedChannels === 1 ? 'channel' : 'channels';
        return { tone: 'warn', text: `${base} ${r.skippedChannels} ${ch} skipped: couldn't confirm which messages are saved. Check your connection and try again.` };
    }
    return { tone: 'ok', text: base };
}
