/**
 * useAchievementsSync — keeps achievement progress in step across this
 * account's devices through the `achievements` own-device slot (the
 * personal-saves pattern, see usePersonalSavesSync.ts).
 *
 * Triggered by intent, never by a tight timer: once when ready, on window
 * focus (at most once a minute), and `markDirty()` — which the host calls on
 * an unlock / preference change immediately and otherwise at most every 30
 * minutes while counters move. The idle cost is one slot-meta probe.
 * Best-effort: failures are logged and swallowed; local state is always
 * already correct before this runs.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { achievementsRepublishReason, publishAchievements, pullAchievements } from '../services/achievementsSyncService';
import { createAchievementsSyncEnv, getAchievementsView, setAchievementsView } from '../services/achievementsSyncEnv';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';
import type { AchievementsTracker } from '../utils/achievements/tracker';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;

export interface AchievementsSyncOptions {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
    tracker: AchievementsTracker | null;
}

export function useAchievementsSync({ userId, deviceId, token, tracker }: AchievementsSyncOptions) {
    const inFlight = useRef(false);
    const again = useRef(false);
    const dirty = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRunAt = useRef(0);
    const lastAntiEntropyAt = useRef(0);
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });

    const enabled = !!userId && !!deviceId && !!token && !!tracker;

    const run = useCallback(async () => {
        if (!enabled || !tracker) return;
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        try {
            do {
                again.current = false;
                lastRunAt.current = Date.now();
                const env = createAchievementsSyncEnv(
                    { userId: userId!, deviceId: deviceId!, token: tokenRef.current! },
                    { load: () => tracker.getState(), merge: r => tracker.mergeRemote(r) },
                );
                let pulled = false;
                try {
                    const res = await pullAchievements(env, getAchievementsView(userId!));
                    setAchievementsView(userId!, res.view);
                    pulled = true;
                } catch (e) { console.warn('[achievementsSync] pull failed', e); }

                let publish = dirty.current;
                if (!publish && pulled && Date.now() - lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = achievementsRepublishReason(
                            getAchievementsView(userId!), tracker.getState(), await env.listOwnDeviceIds(), deviceId!,
                        );
                        if (reason !== 'none') { publish = true; lastAntiEntropyAt.current = Date.now(); }
                    } catch (e) { console.warn('[achievementsSync] anti-entropy check failed', e); }
                }
                if (publish) {
                    try {
                        dirty.current = false;
                        const view = await publishAchievements(env, deviceId!);
                        if (view) setAchievementsView(userId!, view);
                    } catch (e) {
                        dirty.current = true;
                        console.warn('[achievementsSync] publish failed', e);
                    }
                }
            } while (again.current);
        } finally {
            inFlight.current = false;
        }
    }, [enabled, userId, deviceId, tracker]);

    const markDirty = useCallback(() => {
        dirty.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { void run(); }, PUBLISH_DEBOUNCE_MS);
    }, [run]);

    useEffect(() => { if (enabled) void run(); }, [enabled, run]);

    useEffect(() => {
        if (!enabled) return;
        const onFocus = () => { if (Date.now() - lastRunAt.current >= FOCUS_MIN_GAP_MS) void run(); };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [enabled, run]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    return useMemo(() => ({ markDirty }), [markDirty]);
}
