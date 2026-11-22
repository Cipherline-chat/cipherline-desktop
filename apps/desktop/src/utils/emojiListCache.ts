/**
 * Session-memory store of each server's custom-emoji LIST (the rows from
 * GET /servers/:id/emojis, key material included). Memory only — never
 * persisted — and cleared on sign-out (useServerEmojis with no token) or for
 * a server that answers 403.
 *
 * It exists so switching back to a server renders its emojis immediately
 * (stale-while-revalidate) instead of placeholders until the list refetch
 * lands. It is an external store (subscribe/notify) so every component
 * showing the same server — the chat pane, server settings — sees one list,
 * and a late response for a server the user already left updates the cache
 * without touching what is on screen.
 *
 * `createServerListCache` is the generic store; server STICKERS
 * (utils/stickers/serverStickers.ts) are a second instance of it, keyed by
 * sticker_id.
 */
import type { ServerEmoji } from '../hooks/useServerEmojis';

/** One entry per id (first wins) - a list never shows an item twice. */
function dedupeBy<T>(list: T[], idOf: (t: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const e of list) {
        const id = idOf(e);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(e);
    }
    return out.length === list.length ? list : out;
}

/** Insert or replace by id. Idempotent. */
function upsertBy<T>(list: T[], item: T, idOf: (t: T) => string): T[] {
    const id = idOf(item);
    return list.some(e => idOf(e) === id)
        ? list.map(e => (idOf(e) === id ? item : e))
        : [...list, item];
}

/** One entry per emoji_id (first wins) - a list never shows an emoji twice. */
export function dedupeEmojis(list: ServerEmoji[]): ServerEmoji[] {
    return dedupeBy(list, e => e.emoji_id);
}

/** Insert or replace by emoji_id. Idempotent: a create response that arrives
 *  after the refetch its own realtime event triggered must not add a second
 *  copy of the same emoji. */
export function upsertEmoji(list: ServerEmoji[], emoji: ServerEmoji): ServerEmoji[] {
    return upsertBy(list, emoji, e => e.emoji_id);
}

export interface ServerListCache<T> {
    get(serverId: string): T[] | undefined;
    has(serverId: string): boolean;
    setLocal(serverId: string, list: T[]): void;
    find(id: string): T | undefined;
    epoch(serverId: string): number;
    set(serverId: string, list: T[]): void;
    delete(serverId: string): void;
    markSettled(serverId: string): void;
    isSettled(serverId: string): boolean;
    clear(): void;
    /** Every server id with a list (stickers' "by server" picker). */
    serverIds(): string[];
    upsert(list: T[], item: T): T[];
    subscribe(cb: () => void): () => void;
}

export function createServerListCache<T>(idOf: (t: T) => string): ServerListCache<T> {
    const lists = new Map<string, T[]>();
    /** Servers whose fetch has completed at least once (success or failure). */
    const settled = new Set<string>();
    const subscribers = new Set<() => void>();
    /** Bumped by every LOCAL write (create/rename/remove response). A background
     *  fetch that started before one finished carries a list older than that
     *  write - applying it would revert the change on screen. */
    const epochs = new Map<string, number>();
    const notify = () => { for (const cb of [...subscribers]) cb(); };

    const cache: ServerListCache<T> = {
        get: serverId => lists.get(serverId),
        has: serverId => lists.has(serverId),
        /** A write made by THIS client (a mutation's response): stamps the epoch. */
        setLocal(serverId, list) {
            epochs.set(serverId, (epochs.get(serverId) ?? 0) + 1);
            cache.set(serverId, list);
        },
        /** The item with this id in ANY server list seen this session (the report
         *  dialog's preview: a reported message's server emoji, wherever it is from). */
        find(id) {
            for (const list of lists.values()) {
                const hit = list.find(e => idOf(e) === id);
                if (hit) return hit;
            }
            return undefined;
        },
        epoch: serverId => epochs.get(serverId) ?? 0,
        set(serverId, list) {
            lists.set(serverId, dedupeBy(list, idOf));
            settled.add(serverId);
            notify();
        },
        delete(serverId) {
            lists.delete(serverId);
            notify();
        },
        /** A fetch finished without a list (network error) — stop "loading". */
        markSettled(serverId) {
            if (settled.has(serverId)) return;
            settled.add(serverId);
            notify();
        },
        isSettled: serverId => settled.has(serverId),
        clear() {
            if (lists.size === 0 && settled.size === 0) return;
            lists.clear();
            settled.clear();
            epochs.clear();
            notify();
        },
        serverIds: () => [...lists.keys()],
        upsert: (list, item) => upsertBy(list, item, idOf),
        subscribe(cb) {
            subscribers.add(cb);
            return () => { subscribers.delete(cb); };
        },
    };
    return cache;
}

export const emojiListCache: ServerListCache<ServerEmoji> = createServerListCache<ServerEmoji>(e => e.emoji_id);
