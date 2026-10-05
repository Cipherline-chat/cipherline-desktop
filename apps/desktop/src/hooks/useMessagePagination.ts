import { useCallback, useEffect, useMemo, useState } from 'react';

const PAGE_SIZE = 20;

/**
 * Paginated "tail" view over a message array.
 * Caller passes the full in-memory message history for a conversation; we return
 * only the last `visibleCount` messages and a `loadMore()` fn that bumps the
 * window by PAGE_SIZE. On conversation-switch the window resets to PAGE_SIZE.
 *
 * `resetKey` is typically the conversation_id so switching chats resets the window.
 */
export function useMessagePagination<T>(allMessages: T[], resetKey: string | null | undefined) {
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

    // Reset the window when the conversation changes.
    useEffect(() => {
        setVisibleCount(PAGE_SIZE);
    }, [resetKey]);

    const total = allMessages.length;
    const hasMore = visibleCount < total;

    const loadMore = useCallback(() => {
        setVisibleCount(n => Math.min(n + PAGE_SIZE, allMessages.length));
    }, [allMessages.length]);

    /**
     * Expands the visible window just enough to include the message with the
     * given id. Returns true if the id was found in allMessages, false otherwise.
     * Used by jump-to-reply so we don't have to call loadMore() in a loop.
     */
    const ensureVisible = useCallback((msgId: string) => {
        const idx = (allMessages as any[]).findIndex((m: any) => m.id === msgId);
        if (idx === -1) return false;
        const needed = total - idx; // messages visible from tail to include this index
        setVisibleCount(v => Math.max(v, needed));
        return true;
    }, [allMessages, total]);

    const displayed = useMemo(() => {
        if (visibleCount >= total) return allMessages;
        return allMessages.slice(Math.max(0, total - visibleCount));
    }, [allMessages, visibleCount, total]);

    return { displayed, hasMore, loadMore, ensureVisible, visibleCount };
}

export const MESSAGE_PAGE_SIZE = PAGE_SIZE;
