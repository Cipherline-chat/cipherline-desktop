import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../utils/apiPath';
import { ACHIEVEMENTS, ACHIEVEMENT_IDS } from '../utils/achievements/catalog';
import { getTracker } from '../utils/achievements/tracker';
import { ACHIEVEMENT_UNLOCK_EVENT } from '../utils/achievements/keys';
import type { Progress } from '../utils/achievements/catalog';

/** What AchievementsPanel renders: unlocked ids and the month each unlocked ('YYYY-MM'). */
export interface AchievementsData {
    unlocked: Array<{ id: string; month: string }>;
}

const cache = new Map<string, { at: number; data: AchievementsData }>();
const FRESH_MS = 60_000;

/** Drop a user's cached answer (the host calls this after pushing new unlocks). */
export function invalidateAchievements(userId: string): void {
    cache.delete(userId);
    window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCK_EVENT, { detail: { id: null } }));
}

/**
 * `GET /v1/users/:id/achievements` (public to signed-in users). For YOUR OWN
 * card the local unlocks are merged in too, so a fresh unlock shows at once
 * instead of after the server round trip (the server's month wins when both exist).
 */
export function useUserAchievements(userId: string | null | undefined, isSelf: boolean): {
    data: AchievementsData | null;
    loading: boolean;
    error: boolean;
    reload: () => void;
} {
    const { token } = useAuth();
    const [fetched, setFetched] = useState<{ id: string; data: AchievementsData } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
        const on = () => setNonce(n => n + 1);
        window.addEventListener(ACHIEVEMENT_UNLOCK_EVENT, on);
        return () => window.removeEventListener(ACHIEVEMENT_UNLOCK_EVENT, on);
    }, []);

    useEffect(() => {
        if (!userId || !token) return;
        const hit = cache.get(userId);
        if (hit && Date.now() - hit.at < FRESH_MS) return; // rendered straight from the cache below
        let cancelled = false;
        setLoading(true);
        setError(false);
        axios.get(apiUrl`/users/${userId}/achievements`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
            .then(res => {
                if (cancelled) return;
                const list = Array.isArray(res.data?.unlocked) ? res.data.unlocked : [];
                const clean = list.filter((u: { id?: unknown; month?: unknown }) =>
                    typeof u?.id === 'string' && typeof u?.month === 'string' && ACHIEVEMENT_IDS.includes(u.id));
                const d = { unlocked: clean };
                cache.set(userId, { at: Date.now(), data: d });
                setFetched({ id: userId, data: d });
            })
            .catch(() => { if (!cancelled) setError(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [userId, token, nonce]);

    const data = (fetched && fetched.id === userId ? fetched.data : null) ?? (userId ? cache.get(userId)?.data ?? null : null);
    let merged = data;
    if (isSelf) {
        const state = getTracker()?.getState();
        if (state) {
            const have = new Map((data?.unlocked ?? []).map(u => [u.id, u.month]));
            for (const [id, month] of Object.entries(state.unlocked)) if (!have.has(id) && ACHIEVEMENT_IDS.includes(id)) have.set(id, month);
            merged = { unlocked: [...have].map(([id, month]) => ({ id, month })) };
        }
    }
    return { data: merged, loading, error, reload: useCallback(() => { if (userId) cache.delete(userId); setNonce(n => n + 1); }, [userId]) };
}

/** Local-only progress for your own panel (never sent anywhere). Null until the tracker is bound. */
export function useAchievementProgress(): Record<string, Progress> | null {
    const [, setTick] = useState(0);
    useEffect(() => {
        const t = getTracker();
        if (!t) return;
        return t.subscribe(() => setTick(n => n + 1));
    }, []);
    const t = getTracker();
    if (!t) return null;
    const totals = t.totals();
    const out: Record<string, Progress> = {};
    for (const a of ACHIEVEMENTS) out[a.id] = a.progress(totals);
    return out;
}
