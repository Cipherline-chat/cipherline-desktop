import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { secureLocalStore } from '../../utils/secureLocalStore';
import { ACHIEVEMENT_UNLOCK_EVENT } from '../../utils/achievements/keys';
import { EGG_FOUND_EVENT } from '../../utils/eggProgress';
import { getHasActiveCall } from '../../utils/activeCallRegistry';
import { quietEnough } from '../../utils/moments';
import { holdToasts } from '../../utils/toastHold';
import {
    decideLevelUp, levelUpCopy, levelUpKey, levelUpMotion, parseLevelUpRecord, serializeLevelUpRecord,
    type LevelUpMotion, type LevelUpRecord, type LevelUpVariant,
} from '../../utils/levelUp';
import { LevelUpCelebration } from './LevelUpCelebration';

/** A local unlock / egg find counts as "this device did it" for this long. */
export const LEVEL_UP_ARM_MS = 60_000;
/** Re-read /auth/me this long after a local find, if no server ack came first (eggs; a failed push). */
export const LEVEL_UP_FALLBACK_REFRESH_MS = 7_000;
/** After the server acknowledged new unlocks, re-read /auth/me after this (one request per burst). */
export const LEVEL_UP_ACK_REFRESH_MS = 400;
/** While a celebration waits for a quiet moment, look again this often. */
export const LEVEL_UP_POLL_MS = 1_000;

const reducedMotion = (): boolean => {
    try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

interface Pending {
    level: number;
    from: number;
    variant: LevelUpVariant;
    record: LevelUpRecord;
    points: number | null;
    nextPoints: number | null;
}
interface Playing extends Pending { motion: LevelUpMotion; seq: number }

/**
 * The signed-in app's side of the level-up celebration (utils/levelUp.ts has
 * the rules). Mounted once next to MomentHost; renders nothing until the
 * account's profile level (server-computed, `/auth/me` profile_level) goes up
 * because of something done on THIS device.
 *
 *   1. Arms on a local achievement unlock or easter-egg find, then re-reads
 *      `/auth/me` once the server has the new unlocks (the achievements push
 *      acks with ACHIEVEMENT_UNLOCK_EVENT id=null) or, failing that, after
 *      LEVEL_UP_FALLBACK_REFRESH_MS. The re-read is a GET of the account's own
 *      profile: nothing new is sent.
 *   2. A higher level while armed -> celebrate; otherwise (first run, another
 *      device, a level the account already had) the level is recorded silently.
 *   3. It plays at a quiet moment: window visible, not in a call, no
 *      keystroke for a few seconds (the same rule as ambient moments, so a
 *      celebration never takes the keyboard from someone mid-sentence), and
 *      no other full-screen moment on screen.
 *   4. While it is up the toast stack is held (utils/toastHold.ts): the
 *      achievement toast that came with it is still there afterwards.
 *
 * The playful touches have no off switch (owner, 2026-10-20, utils/easterEggs.ts),
 * so neither does this; prefers-reduced-motion gets the still card.
 */
export const LevelUpHost: React.FC = () => {
    const { userId, user, refreshProfile } = useAuth();
    const pl = user?.profile_level;
    const observed = pl?.level;
    const [readyFor, setReadyFor] = useState<string | null>(null);
    const [playing, setPlaying] = useState<Playing | null>(null);
    const [said, setSaid] = useState('');
    const playingRef = useRef<Playing | null>(null);
    const pending = useRef<Pending | null>(null);
    const [pendingTick, setPendingTick] = useState(0);
    const armedUntil = useRef(0);
    const lastKeyAt = useRef(-Infinity);
    const lastRefreshAt = useRef(-Infinity);
    const seq = useRef(0);
    const refreshRef = useRef(refreshProfile);
    useEffect(() => { refreshRef.current = refreshProfile; });
    const plRef = useRef(pl);
    useEffect(() => { plRef.current = pl; });

    // The account's encrypted records are cold until the rebind finishes.
    useEffect(() => {
        if (!userId) return; // signed out: the observer below waits for readyFor === userId
        let cancelled = false;
        void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => {
            if (!cancelled && secureLocalStore.isAccountReady(userId)) setReadyFor(userId);
        });
        return () => { cancelled = true; };
    }, [userId]);

    // A different account: nothing armed or waiting carries over.
    useEffect(() => { pending.current = null; armedUntil.current = 0; }, [userId]);

    // Keystroke TIMING only (never the key): "is someone typing right now?"
    useEffect(() => {
        const onKey = () => { lastKeyAt.current = Date.now(); };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    // 1. Arm on local progress; re-read the level when the server has it.
    useEffect(() => {
        let ackTimer: ReturnType<typeof setTimeout> | null = null;
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
        const refresh = () => {
            lastRefreshAt.current = Date.now();
            void Promise.resolve(refreshRef.current?.()).catch(() => undefined);
        };
        const arm = () => {
            armedUntil.current = Date.now() + LEVEL_UP_ARM_MS;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            const armedAt = Date.now();
            fallbackTimer = setTimeout(() => {
                fallbackTimer = null;
                if (lastRefreshAt.current < armedAt + 1000) refresh();
            }, LEVEL_UP_FALLBACK_REFRESH_MS);
        };
        const onUnlock = (e: Event) => {
            const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
            if (typeof id === 'string') { arm(); return; }
            // id null = the server now holds new unlocks (AchievementsHost's push).
            if (id === null && Date.now() < armedUntil.current) {
                if (ackTimer) clearTimeout(ackTimer);
                ackTimer = setTimeout(() => { ackTimer = null; refresh(); }, LEVEL_UP_ACK_REFRESH_MS);
            }
        };
        window.addEventListener(ACHIEVEMENT_UNLOCK_EVENT, onUnlock);
        window.addEventListener(EGG_FOUND_EVENT, arm);
        return () => {
            window.removeEventListener(ACHIEVEMENT_UNLOCK_EVENT, onUnlock);
            window.removeEventListener(EGG_FOUND_EVENT, arm);
            if (ackTimer) clearTimeout(ackTimer);
            if (fallbackTimer) clearTimeout(fallbackTimer);
        };
    }, []);

    // 2. Every new server level: adopt silently, or queue the celebration.
    useEffect(() => {
        if (!userId || readyFor !== userId || observed === undefined) return;
        const key = levelUpKey(userId);
        const record = parseLevelUpRecord(secureLocalStore.getItem(key));
        const armed = Date.now() < armedUntil.current || pending.current !== null;
        const d = decideLevelUp(record, observed, armed);
        if (d.kind === 'adopt') {
            secureLocalStore.setItem(key, serializeLevelUpRecord(d.record));
        } else if (d.kind === 'celebrate') {
            const p = plRef.current;
            pending.current = {
                level: d.level, from: d.from, variant: d.variant, record: d.record,
                points: typeof p?.points === 'number' ? p.points : null,
                nextPoints: typeof p?.next_level_points === 'number' ? p.next_level_points : null,
            };
            setPendingTick((n) => n + 1);
        }
    }, [userId, readyFor, observed]);

    // 3. Play at a quiet moment.
    const tryPlay = useCallback((): boolean => {
        const p = pending.current;
        if (!p || !userId || playingRef.current) return false;
        if (!quietEnough({
            hidden: document.visibilityState === 'hidden',
            inCall: getHasActiveCall(),
            sinceKeyMs: Date.now() - lastKeyAt.current,
        })) return false;
        if (document.querySelector('.mo-root, .pcel')) return false; // another full-screen moment is up
        pending.current = null;
        // Recorded as it STARTS: a quit mid-animation never replays it.
        secureLocalStore.setItem(levelUpKey(userId), serializeLevelUpRecord(p.record));
        const next: Playing = { ...p, motion: levelUpMotion(reducedMotion()), seq: ++seq.current };
        playingRef.current = next;
        setPlaying(next);
        setSaid(levelUpCopy(p.level, p.variant).announcement);
        return true;
    }, [userId]);

    useEffect(() => {
        if (!pending.current) return;
        if (tryPlay()) return;
        const id = window.setInterval(() => { if (!pending.current || tryPlay()) window.clearInterval(id); }, LEVEL_UP_POLL_MS);
        return () => window.clearInterval(id);
    }, [pendingTick, tryPlay]);

    // 4. Hold the toast stack while the celebration covers it.
    useEffect(() => (playing ? holdToasts() : undefined), [playing]);

    const done = useCallback(() => { playingRef.current = null; setPlaying(null); }, []);

    // Clear the live region afterwards, so the next level is announced again.
    useEffect(() => {
        if (playing || !said) return;
        const t = window.setTimeout(() => setSaid(''), 1000);
        return () => window.clearTimeout(t);
    }, [playing, said]);

    return (
        <>
            <span className="sr-only" role="status" aria-live="polite" data-testid="level-up-live">{said}</span>
            {playing && (
                <LevelUpCelebration
                    key={playing.seq}
                    level={playing.level}
                    from={playing.from}
                    variant={playing.variant}
                    motion={playing.motion}
                    points={playing.points}
                    nextPoints={playing.nextPoints}
                    profileTheme={user?.profile_theme}
                    onClose={done}
                />
            )}
        </>
    );
};

export default LevelUpHost;
