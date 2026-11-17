/**
 * The real RailSyncEnv: the shared own-slot transport (ownSlotEnv.ts) bound to
 * the `server_rail` slot and to this account's secureLocalStore. Kept apart
 * from the service so that stays unit-testable against a fake env.
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import {
    SERVER_RAIL_SLOT, adoptRemoteRail, loadLocalRailSnapshot, notifyRailRestored, serverRailViewKey,
    type RailSnapshot, type RailSyncEnv,
} from './serverRailSyncService';

export function getServerRailView(uid: string): SlotView<RailSnapshot> | null {
    try {
        const raw = secureLocalStore.getItem(serverRailViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setServerRailView(uid: string, view: SlotView<RailSnapshot> | null): void {
    try {
        if (view) secureLocalStore.setItem(serverRailViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(serverRailViewKey(uid));
    } catch { /* non-fatal */ }
}

export function createServerRailSyncEnv(auth: OwnSlotAuth): RailSyncEnv {
    const uid = auth.userId;
    return {
        ...createOwnSlotEnv(auth, SERVER_RAIL_SLOT),
        loadLocalState: () => loadLocalRailSnapshot(secureLocalStore, uid),
        mergeRemote: remote => adoptRemoteRail(secureLocalStore, uid, remote, () => notifyRailRestored(uid)),
    };
}
