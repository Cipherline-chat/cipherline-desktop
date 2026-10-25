/**
 * The real AchievementsSyncEnv: the shared own-slot transport (ownSlotEnv.ts)
 * bound to the `achievements` slot, plus the two small network/storage helpers
 * the host needs. Kept apart from the service so that stays unit-testable.
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import type { AchievementsState } from '../utils/achievements/state';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import type { AchievementsSyncEnv } from './achievementsSyncService';

export const ACHIEVEMENTS_SLOT = 'achievements';

/** What this DEVICE last knew about the slot. Device-specific: never restored from a backup. */
export const achievementsViewKey = (uid: string) => `cipherline_achievements_sync_view_${uid}`;

export function getAchievementsView(uid: string): SlotView<AchievementsState> | null {
    try {
        const raw = secureLocalStore.getItem(achievementsViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setAchievementsView(uid: string, view: SlotView<AchievementsState> | null): void {
    try {
        if (view) secureLocalStore.setItem(achievementsViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(achievementsViewKey(uid));
    } catch { /* non-fatal */ }
}

export function createAchievementsSyncEnv(
    auth: OwnSlotAuth,
    local: { load(): AchievementsState; merge(remote: AchievementsState): boolean },
): AchievementsSyncEnv {
    return { ...createOwnSlotEnv(auth, ACHIEVEMENTS_SLOT), loadLocalState: local.load, mergeRemote: local.merge };
}

/** `PUT /v1/achievements/me` — the unlocked ids only (add-only; the server stamps the month). */
export async function pushUnlockedIds(token: string, ids: readonly string[]): Promise<{ id: string; month: string }[] | null> {
    try {
        const res = await axios.put(`${API_BASE}/achievements/me`, { ids }, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
        });
        return Array.isArray(res.data?.unlocked) ? res.data.unlocked : null;
    } catch { return null; }
}
