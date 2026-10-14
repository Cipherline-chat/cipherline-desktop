import { useSyncExternalStore } from 'react';
import { reactionStore, type ReactionStore } from '../utils/pendingReactions';

/**
 * Re-renders the caller whenever a pending / failed reaction changes
 * (utils/pendingReactions.ts). Returns the store's version; rows read their own
 * entries with `store.forMessage`, whose array identity only changes when that
 * message's entries do, so a memoised row re-renders only for its own change.
 */
export function usePendingReactions(store: ReactionStore = reactionStore): number {
    return useSyncExternalStore(store.subscribe, store.getVersion);
}
