/**
 * The width a message's card can take in the chat feed: the row's message
 * COLUMN (MessageCard is `max-width: 100%` of it). The composer's live card
 * preview uses it as its own max width, so a draft wraps where the posted
 * message will.
 *
 * The column is the feed's content box minus the row's own gutters, which
 * are ChatPane's row classes: `pl-3` (12) + the `w-10` avatar (40) + `gap-3`
 * (12) on the left and `pr-2` (8) on the right. messageColumn.test.ts pins
 * those classes in ChatPane, so a change there fails the test instead of
 * silently drifting.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export const MESSAGE_ROW_GUTTER_PX = 12 + 40 + 12 + 8;

/** The message column's width for a feed element (its clientWidth excludes the scrollbar). */
export function messageColumnWidth(feed: HTMLElement): number {
    const cs = getComputedStyle(feed);
    const inner = feed.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return Math.max(0, Math.floor(inner - MESSAGE_ROW_GUTTER_PX));
}

/** Live message-column width for a feed (null until measured, or while `enabled` is false). */
export function useMessageColumnWidth(feedRef: RefObject<HTMLElement | null>, enabled = true): number | null {
    const [w, setW] = useState<number | null>(null);
    useLayoutEffect(() => {
        const feed = feedRef.current;
        if (!feed || !enabled) return;
        const measure = () => { const n = messageColumnWidth(feed); setW(prev => (prev === n ? prev : n)); };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(feed);
        return () => ro.disconnect();
    }, [feedRef, enabled]);
    return enabled ? w : null;
}
