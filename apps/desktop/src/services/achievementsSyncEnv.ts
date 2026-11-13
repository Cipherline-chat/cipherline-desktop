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
import { achievementById } from '../utils/achievements/catalog';
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

/**
 * `PUT /v1/achievements/me` — the unlocked ids only (add-only; the server stamps the month).
 * The server rejects the WHOLE set (400) on an id it does not know. A client that is newer
 * than the API it talks to (a desktop build out before the API's main push) would then sync
 * nothing at all, so on a 400 it retries once without the starter ids, the newest entries.
 * Returns what the server holds (the caller acks only those), or null.
 */
export async function pushUnlockedIds(token: string, ids: readonly string[]): Promise<{ id: string; month: string }[] | null> {
    const put = async (set: readonly string[]) => {
        const res = await axios.put(`${API_BASE}/achievements/me`, { ids: set }, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
        });
        return Array.isArray(res.data?.unlocked) ? res.data.unlocked as { id: string; month: string }[] : null;
    };
    try {
        return await put(ids);
    } catch (e) {
        const older = ids.filter(id => !achievementById(id)?.starter);
        if (axios.isAxiosError(e) && e.response?.status === 400 && older.length > 0 && older.length < ids.length) {
            try { return await put(older); } catch { return null; }
        }
        return null;
    }
}
