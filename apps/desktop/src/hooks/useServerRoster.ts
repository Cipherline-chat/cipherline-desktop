import { useSyncExternalStore } from 'react';
import { getRoster, subscribeRoster, type Roster } from '../utils/serverRosterCache';

/**
 * The cached member roster for a server, or null before the first fetch lands.
 * Reads synchronously, so switching to a server whose roster is cached paints
 * its rows in the same render — no effect, no spinner, no stale rows from the
 * server you just left. The returned object's identity changes only when the
 * members or roles actually changed (see serverRosterCache), so an unchanged
 * background revalidation re-renders nothing.
 */
export function useServerRoster(serverId: string | null | undefined): Roster | null {
    return useSyncExternalStore(
        subscribeRoster,
        () => getRoster(serverId),
        () => null,
    );
}
