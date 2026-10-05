/**
 * The real SavesSyncEnv: the shared own-slot transport (ownSlotEnv.ts) bound to
 * the `personal_saves` slot, plus the Dashboard's pin state as the local side.
 */

import secureLocalStore from '../utils/secureLocalStore';
import { PERSONAL_SAVES_SLOT, type SavesState } from '../utils/personalSavesSync';
import type { SlotView } from '../utils/ownSlotSync';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import type { SavesSyncEnv } from './personalSavesSyncService';

/** What this device last knew about the `personal_saves` slot. Device-specific
 *  bookkeeping: never restored from a backup (backupRegistry.ts). */
export const savesViewKey = (uid: string) => `cipherline_saves_sync_view_${uid}`;

export function getSavesView(uid: string): SlotView<SavesState> | null {
    try {
        const raw = secureLocalStore.getItem(savesViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}

export function setSavesView(uid: string, view: SlotView<SavesState> | null): void {
    try {
        if (view) secureLocalStore.setItem(savesViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(savesViewKey(uid));
    } catch { /* non-fatal */ }
}

export interface SavesLocalBinding {
    load(): SavesState;
    save(next: SavesState, prev: SavesState): void;
}

export function createSavesSyncEnv(auth: OwnSlotAuth, local: SavesLocalBinding): SavesSyncEnv {
    return {
        ...createOwnSlotEnv(auth, PERSONAL_SAVES_SLOT),
        loadLocalState: local.load,
        saveLocalState: local.save,
    };
}
