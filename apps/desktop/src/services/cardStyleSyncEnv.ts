/**
 * The real CardStyleSyncEnv: the shared own-slot transport (ownSlotEnv.ts)
 * bound to the `card_styles` slot and this account's secureLocalStore. Kept
 * apart from the service so that stays unit-testable against a fake env.
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import {
    CARD_STYLES_SLOT, buildLocalState, cardStyleLibraryKey, cardStyleMetaKey, cardStyleViewKey, metaFromState,
    parseStyleMeta, serializeStyleMeta, STYLE_LIBRARY_MAX, type StyleSyncState,
} from '../utils/cardStyleSync';
import { CARD_LIBRARY_CHANGED_EVENT, readCardStyleLibrary } from '../hooks/useCardStylePrefs';
import type { CardStyleSyncEnv } from './cardStyleSyncService';

export function getCardStylesView(uid: string): SlotView<StyleSyncState> | null {
    try {
        const raw = secureLocalStore.getItem(cardStyleViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setCardStylesView(uid: string, view: SlotView<StyleSyncState> | null): void {
    try {
        if (view) secureLocalStore.setItem(cardStyleViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(cardStyleViewKey(uid));
    } catch { /* non-fatal */ }
}

/** This device's library + stamps as a sync state. */
export function loadLocalCardStyleState(uid: string): StyleSyncState {
    const now = Date.now();
    return buildLocalState(readCardStyleLibrary(uid), parseStyleMeta(secureLocalStore.getItem(cardStyleMetaKey(uid)), now));
}

/** Persist a state (library, then its stamps). Refuses on a cold account store. Returns whether it wrote. */
export function saveCardStyleState(uid: string, next: StyleSyncState): boolean {
    if (!secureLocalStore.isAccountReady(uid)) return false;
    try {
        const items = next.items.slice(0, STYLE_LIBRARY_MAX).map(i => ({ id: i.id, name: i.name, style: i.style }));
        secureLocalStore.setItem(cardStyleLibraryKey(uid), JSON.stringify({ v: 1, items }));
        secureLocalStore.setItem(cardStyleMetaKey(uid), serializeStyleMeta(metaFromState(next)));
    } catch { return false; }
    return true;
}

export function createCardStyleSyncEnv(auth: OwnSlotAuth): CardStyleSyncEnv {
    const uid = auth.userId;
    return {
        ...createOwnSlotEnv(auth, CARD_STYLES_SLOT),
        loadLocalState: () => loadLocalCardStyleState(uid),
        saveLocalState: next => {
            // Adopting another device's state is NOT a user edit: it only tells the UI to re-read.
            if (saveCardStyleState(uid, next)) {
                try { window.dispatchEvent(new CustomEvent(CARD_LIBRARY_CHANGED_EVENT)); } catch { /* non-fatal */ }
            }
        },
    };
}
