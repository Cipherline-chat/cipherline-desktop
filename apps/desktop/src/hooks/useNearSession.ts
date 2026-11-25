import { useSyncExternalStore } from 'react';
import { getNearStore, type NearStore } from '../utils/nearStore';
import type { NearSnapshot } from '../types/near';

/** The host's near snapshot (null until the first one arrives, or when the bridge has none). */
export function useNearSession(store: NearStore = getNearStore()): NearSnapshot | null {
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
