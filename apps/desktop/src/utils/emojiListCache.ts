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
 */
import type { ServerEmoji } from '../hooks/useServerEmojis';

const lists = new Map<string, ServerEmoji[]>();
/** Servers whose fetch has completed at least once (success or failure). */
const settled = new Set<string>();
const subscribers = new Set<() => void>();
/** Bumped by every LOCAL write (create/rename/remove response). A background
 *  fetch that started before one finished carries a list older than that
 *  write - applying it would revert the change on screen. */
const epochs = new Map<string, number>();

/** One entry per emoji_id (first wins) - a list never shows an emoji twice. */
export function dedupeEmojis(list: ServerEmoji[]): ServerEmoji[] {
    const seen = new Set<string>();
    const out: ServerEmoji[] = [];
    for (const e of list) {
        if (seen.has(e.emoji_id)) continue;
        seen.add(e.emoji_id);
        out.push(e);
    }
    return out.length === list.length ? list : out;
}

/** Insert or replace by emoji_id. Idempotent: a create response that arrives
 *  after the refetch its own realtime event triggered must not add a second
 *  copy of the same emoji. */
export function upsertEmoji(list: ServerEmoji[], emoji: ServerEmoji): ServerEmoji[] {
    return list.some(e => e.emoji_id === emoji.emoji_id)
        ? list.map(e => (e.emoji_id === emoji.emoji_id ? emoji : e))
        : [...list, emoji];
}

function notify(): void {
    for (const cb of [...subscribers]) cb();
}

export const emojiListCache = {
    get(serverId: string): ServerEmoji[] | undefined {
        return lists.get(serverId);
    },
    has(serverId: string): boolean {
        return lists.has(serverId);
    },
    /** A write made by THIS client (a mutation's response): stamps the epoch. */
    setLocal(serverId: string, list: ServerEmoji[]): void {
        epochs.set(serverId, (epochs.get(serverId) ?? 0) + 1);
        this.set(serverId, list);
    },
    epoch(serverId: string): number {
        return epochs.get(serverId) ?? 0;
    },
    set(serverId: string, list: ServerEmoji[]): void {
        lists.set(serverId, dedupeEmojis(list));
        settled.add(serverId);
        notify();
    },
    delete(serverId: string): void {
        lists.delete(serverId);
        notify();
    },
    /** A fetch finished without a list (network error) — stop "loading". */
    markSettled(serverId: string): void {
        if (settled.has(serverId)) return;
        settled.add(serverId);
        notify();
    },
    isSettled(serverId: string): boolean {
        return settled.has(serverId);
    },
    clear(): void {
        if (lists.size === 0 && settled.size === 0) return;
        lists.clear();
        settled.clear();
        epochs.clear();
        notify();
    },
    subscribe(cb: () => void): () => void {
        subscribers.add(cb);
        return () => { subscribers.delete(cb); };
    },
};
