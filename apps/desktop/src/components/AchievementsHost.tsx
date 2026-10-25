import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Trophy } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { API_BASE } from '../constants';
import secureLocalStore from '../utils/secureLocalStore';
import { EGG_FOUND_EVENT, eggsFound } from '../utils/eggProgress';
import { resolveProfileBadgeColor } from '../utils/profileBadges';
import { achievementById, ACHIEVEMENT_IDS } from '../utils/achievements/catalog';
import { bindTracker, createTracker, type AchievementsTracker } from '../utils/achievements/tracker';
import { sameTop, type PlayedGame } from '../utils/achievements/mostPlayed';
import { useAchievementsSync } from '../hooks/useAchievementsSync';
import { pushUnlockedIds } from '../services/achievementsSyncEnv';
import { invalidateAchievements } from '../hooks/useUserAchievements';
import { achievementsKey, weeklyGamesKey, ACHIEVEMENT_UNLOCK_EVENT } from '../utils/achievements/keys';

const TICK_MS = 30_000;
const MOST_PLAYED_PUBLISH_MS = 10 * 60_000;
const COUNTER_SYNC_MS = 30 * 60_000;
const TIER_COLOR = { bronze: 'orange', silver: 'cyan', gold: 'gold' } as const;

/**
 * The signed-in app's side of Achievements and Most played this week, mounted
 * once next to EggProgressHost. It renders nothing; it:
 *
 *   1. binds the per-account tracker (utils/achievements/tracker.ts) and ticks
 *      it every 30 s so elapsed call / game time is credited;
 *   2. syncs the progress snapshot between the user's own devices (E2EE slot);
 *   3. pushes ONLY the set of unlocked ids to `PUT /v1/achievements/me`
 *      (add-only; the server stamps the month) — never a counter or a time;
 *   4. if the user opted in, publishes the rolling-week top 3 games to
 *      `PUT /v1/most-played/me` (and `DELETE`s every row on opt-out);
 *   5. shows the unlock toast (the stock toast stack, which honours
 *      prefers-reduced-motion; the icon never animates).
 *
 * Achievements are client-attested and gate NOTHING.
 */
export const AchievementsHost: React.FC = () => {
    const { token, userId, deviceId, user } = useAuth();
    const { push } = useToast();
    const [tracker, setTracker] = useState<AchievementsTracker | null>(null);
    const [optIn, setOptIn] = useState(false);

    const tokenRef = useRef(token);
    const pushRef = useRef(push);
    const createdRef = useRef<string | null>(null);
    useEffect(() => { tokenRef.current = token; pushRef.current = push; createdRef.current = user?.created_at ?? null; });

    const sync = useAchievementsSync({ userId, deviceId, token, tracker });
    const markDirtyRef = useRef(sync.markDirty);
    useEffect(() => { markDirtyRef.current = sync.markDirty; });

    // Bind the tracker once the account-scoped store is readable.
    useEffect(() => {
        if (!userId || !deviceId) return;
        let cancelled = false;
        let t: AchievementsTracker | null = null;
        void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => {
            if (cancelled) return;
            t = createTracker({
                load: () => secureLocalStore.getItem(achievementsKey(userId)),
                save: raw => secureLocalStore.setItem(achievementsKey(userId), raw),
                loadWeekly: () => secureLocalStore.getItem(weeklyGamesKey(userId)),
                saveWeekly: raw => secureLocalStore.setItem(weeklyGamesKey(userId), raw),
                deviceId,
                now: () => Date.now(),
                eggCount: () => eggsFound().length,
                accountCreatedMs: () => {
                    const ms = createdRef.current ? Date.parse(createdRef.current) : NaN;
                    return Number.isFinite(ms) ? ms : null;
                },
            });
            bindTracker(t);
            t.reevaluate();
            setTracker(t);
        });
        return () => { cancelled = true; bindTracker(null); setTracker(null); };
    }, [userId, deviceId]);

    // Ticks, egg finds and the account-age rule.
    useEffect(() => {
        if (!tracker) return;
        const id = window.setInterval(() => tracker.tick(), TICK_MS);
        const onEgg = () => tracker.reevaluate();
        window.addEventListener(EGG_FOUND_EVENT, onEgg);
        const onHide = () => tracker.flush();
        window.addEventListener('beforeunload', onHide);
        return () => {
            window.clearInterval(id);
            window.removeEventListener(EGG_FOUND_EVENT, onEgg);
            window.removeEventListener('beforeunload', onHide);
            tracker.flush();
        };
    }, [tracker]);
    useEffect(() => { tracker?.reevaluate(); }, [tracker, user?.created_at]);

    // Unlocks: toast, event, server push, sync.
    const acked = useRef<Set<string>>(new Set());
    const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!tracker || !userId) return;
        const pushIds = async () => {
            const t = tokenRef.current;
            if (!t) return;
            const ids = tracker.unlockedIds().filter(id => ACHIEVEMENT_IDS.includes(id));
            if (ids.length === 0 || ids.every(id => acked.current.has(id))) return;
            if (await pushUnlockedIds(t, ids)) {
                for (const id of ids) acked.current.add(id);
                invalidateAchievements(userId);
            } else {
                // Retry later (focus / next unlock / next boot); nothing is lost.
                if (pushTimer.current) clearTimeout(pushTimer.current);
                pushTimer.current = setTimeout(() => { void pushIds(); }, 5 * 60_000);
            }
        };
        const schedule = (ms: number) => {
            if (pushTimer.current) clearTimeout(pushTimer.current);
            pushTimer.current = setTimeout(() => { void pushIds(); }, ms);
        };
        const off = tracker.onUnlock(({ id }) => {
            const def = achievementById(id);
            if (!def) return;
            const c = resolveProfileBadgeColor(TIER_COLOR[def.tier]);
            window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCK_EVENT, { detail: { id } }));
            pushRef.current({
                kind: 'success',
                title: `Achievement unlocked: ${def.name}`,
                message: def.description,
                durationMs: 8000,
                icon: (
                    <span className={`inline-flex items-center justify-center rounded-full border w-7 h-7 ${c.bg} ${c.border} ${c.text}`} data-testid="achievement-toast-icon">
                        <Trophy size={16} aria-hidden />
                    </span>
                ),
            });
            schedule(3_000);
            markDirtyRef.current();
        });
        schedule(10_000); // boot: reconcile anything unlocked on another device or while offline
        return () => { off(); if (pushTimer.current) clearTimeout(pushTimer.current); };
    }, [tracker, userId]);

    // Counter progress follows the account between devices at most every 30 min.
    useEffect(() => {
        if (!tracker) return;
        let changed = false;
        const off = tracker.subscribe(() => { changed = true; });
        const id = window.setInterval(() => { if (changed) { changed = false; markDirtyRef.current(); } }, COUNTER_SYNC_MS);
        return () => { off(); window.clearInterval(id); };
    }, [tracker]);

    // Most played: follow the (account-wide, synced) opt-in.
    useEffect(() => {
        if (!tracker) return;
        const read = () => setOptIn(tracker.getState().prefs.mostPlayed);
        read();
        return tracker.subscribe(read);
    }, [tracker]);

    const prevOptIn = useRef<boolean | null>(null);
    const lastTop = useRef<PlayedGame[] | null>(null);
    useEffect(() => {
        if (!tracker || !deviceId) return;
        const headers = () => ({ Authorization: `Bearer ${tokenRef.current}`, 'x-device-id': deviceId });
        const publish = async () => {
            if (!tokenRef.current) return;
            const top = tracker.top();
            if (lastTop.current && sameTop(top, lastTop.current)) return;
            try {
                await axios.put(`${API_BASE}/most-played/me`, { games: top }, { headers: headers(), timeout: 15000 });
                lastTop.current = top;
            } catch { /* retried on the next interval */ }
        };
        const was = prevOptIn.current;
        prevOptIn.current = optIn;
        if (optIn) {
            void publish();
            const id = window.setInterval(() => { void publish(); }, MOST_PLAYED_PUBLISH_MS);
            return () => window.clearInterval(id);
        }
        lastTop.current = null;
        // Opt-out deletes every device's rows server-side: on the flip, and once per
        // boot for anyone who has ever toggled (self-heals a delete that failed or
        // never ran; an account that never opted in sends nothing).
        if ((was === true || (was === null && tracker.getState().prefs.at > 0)) && tokenRef.current) {
            let tries = 0;
            let retry: ReturnType<typeof setTimeout> | null = null;
            const del = () => {
                axios.delete(`${API_BASE}/most-played/me`, { headers: headers(), timeout: 15000 }).catch(() => {
                    if (++tries < 4) retry = setTimeout(del, 60_000);
                });
            };
            del();
            return () => { if (retry) clearTimeout(retry); };
        }
        return undefined;
    }, [tracker, optIn, deviceId]);

    return null;
};

export default AchievementsHost;
