/**
 * The real CustomThemeSyncEnv: the shared own-slot transport (ownSlotEnv.ts)
 * bound to the `themes` slot and this account's secureLocalStore. Kept apart
 * from the service so that stays unit-testable against a fake env.
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import {
    THEMES_SLOT, THEME_LIBRARY_MAX, buildLocalThemeState, customThemeLibraryKey, customThemeMetaKey, customThemeViewKey,
    libraryFromState, parseThemeMeta, serializeThemeLibrary, serializeThemeMeta, themeMetaFromState, type ThemeSyncState,
} from '../utils/customThemeSync';
import { CUSTOM_THEMES_CHANGED_EVENT, readCustomThemes } from '../theme/customThemeLibrary';
import type { CustomThemeSyncEnv } from './customThemeSyncService';

export function getCustomThemesView(uid: string): SlotView<ThemeSyncState> | null {
    try {
        const raw = secureLocalStore.getItem(customThemeViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setCustomThemesView(uid: string, view: SlotView<ThemeSyncState> | null): void {
    try {
        if (view) secureLocalStore.setItem(customThemeViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(customThemeViewKey(uid));
    } catch { /* non-fatal */ }
}

/** This device's library + stamps as a sync state. */
export function loadLocalCustomThemeState(uid: string): ThemeSyncState {
    return buildLocalThemeState(readCustomThemes(uid), parseThemeMeta(secureLocalStore.getItem(customThemeMetaKey(uid)), Date.now()));
}

/** Persist a state (library, then its stamps). Refuses on a cold account store. Returns whether it wrote. */
export function saveCustomThemeState(uid: string, next: ThemeSyncState): boolean {
    if (!secureLocalStore.isAccountReady(uid)) return false;
    try {
        secureLocalStore.setItem(customThemeLibraryKey(uid), serializeThemeLibrary(libraryFromState(next).slice(0, THEME_LIBRARY_MAX)));
        secureLocalStore.setItem(customThemeMetaKey(uid), serializeThemeMeta(themeMetaFromState(next)));
    } catch { return false; }
    return true;
}

export function createCustomThemeSyncEnv(auth: OwnSlotAuth): CustomThemeSyncEnv {
    const uid = auth.userId;
    return {
        ...createOwnSlotEnv(auth, THEMES_SLOT),
        loadLocalState: () => loadLocalCustomThemeState(uid),
        saveLocalState: next => {
            // Adopting another device's state is NOT a user edit: it only tells the UI to re-read.
            if (saveCustomThemeState(uid, next)) {
                try { window.dispatchEvent(new CustomEvent(CUSTOM_THEMES_CHANGED_EVENT)); } catch { /* non-fatal */ }
            }
        },
    };
}
