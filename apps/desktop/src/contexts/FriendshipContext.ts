import { createContext, useContext } from 'react';

/**
 * Context that answers "does the current viewer have an established relationship
 * with this user ID?" — used to gate avatar / banner rendering.
 *
 * Returns true when:
 *   - userId is the current viewer (their own images always show), OR
 *   - userId is an accepted friend.
 *
 * Returns false for everyone else, including people in the same group chat
 * or call. Those strangers get the deterministic colored-silhouette fallback.
 */
export type FriendshipCheckFn = (userId: string | null | undefined) => boolean;

export const FriendshipContext = createContext<FriendshipCheckFn | null>(null);

export function useIsFriendOrSelf(): FriendshipCheckFn {
    const fn = useContext(FriendshipContext);
    // When the provider isn't mounted (tests, storybook, etc.) assume all IDs
    // are allowed — components behave as they did before the context existed.
    return fn ?? (() => true);
}
