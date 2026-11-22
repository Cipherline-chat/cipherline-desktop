/**
 * The real MuteSyncEnv: the shared own-slot transport (ownSlotEnv.ts) bound to
 * the `mutes` slot and this account's secureLocalStore blob
 * (`cipherline_mutes_<uid>`, utils/channelMute.mutesStoreKey). Kept apart from
 * the service so that stays unit-testable against a fake env.
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import { mutesStoreKey } from '../utils/channelMute';
import { MUTES_CHANGED_EVENT, MUTES_USER_EDIT_EVENT, OWN_SLOT_CHANGED_EVENT, MUTES_SLOT, muteViewKey, parseMuteState, serializeMuteState, type MuteState } from '../utils/muteSync';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import type { MuteSyncEnv } from './muteSyncService';

export { MUTES_CHANGED_EVENT, MUTES_USER_EDIT_EVENT, OWN_SLOT_CHANGED_EVENT };

export function getMutesView(uid: string): SlotView<MuteState> | null {
    try {
        const raw = secureLocalStore.getItem(muteViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setMutesView(uid: string, view: SlotView<MuteState> | null): void {
    try {
        if (view) secureLocalStore.setItem(muteViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(muteViewKey(uid));
    } catch { /* non-fatal */ }
}

/** This device's full mute state (live entries + tombstones). */
export function loadLocalMuteState(uid: string): MuteState {
    try { return parseMuteState(secureLocalStore.getItem(mutesStoreKey(uid)), Date.now()); } catch { return { mutes: {}, gone: {} }; }
}

/** Persist a state. Refuses on a cold account store (never writes an empty map over the real one). */
export function saveMuteState(uid: string, next: MuteState): boolean {
    if (!secureLocalStore.isAccountReady(uid)) return false;
    try { secureLocalStore.setItem(mutesStoreKey(uid), serializeMuteState(next)); } catch { return false; }
    return true;
}

export function createMuteSyncEnv(auth: OwnSlotAuth): MuteSyncEnv {
    const uid = auth.userId;
    return {
        ...createOwnSlotEnv(auth, MUTES_SLOT),
        loadLocalState: () => loadLocalMuteState(uid),
        saveLocalState: next => {
            // Adopting another device's state is NOT a user edit: it only tells the UI to re-read.
            if (saveMuteState(uid, next)) {
                try { window.dispatchEvent(new CustomEvent(MUTES_CHANGED_EVENT, { detail: { userId: uid } })); } catch { /* non-fatal */ }
            }
        },
    };
}
