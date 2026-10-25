/**
 * The achievements tracker: the ONE place local events become progress.
 *
 *   noteMessage(serverId)   ChatPane: the server accepted a message of yours
 *   noteVerified(peerId)    keyVerification.markVerified: a safety number was verified
 *   signalCall(...)         Dashboard (via useAchievementSignals): call/voice state
 *   signalGame(name)        Dashboard: the detected game
 *   tick()                  AchievementsHost, every 30 s: flushes elapsed time
 *
 * Everything stays on the device. State persists through an injected store
 * (secureLocalStore in the app) and is shared across the account's own devices
 * only as an E2EE snapshot (see state.ts for the merge). Unlocks are
 * client-attested and gate NOTHING (see catalog.ts).
 *
 * No window / network / React here: the app wiring is `AchievementsHost`, and
 * the factory takes an env so the whole machine runs in vitest's node env.
 */
import { satisfied, ACHIEVEMENT_IDS } from './catalog';
import {
    addCallTime, addGameTime, addMessage, addVerified, computeTotals, dayKey, emptyState, mergeState, monthKey,
    notePeople, parseState, sameState, setMostPlayedPref, unlockIds, type AchievementsState, type Totals,
} from './state';
import { addPlay, parseBuckets, topGames, type PlayedGame, type WeeklyBuckets } from './mostPlayed';

/** A sleeping laptop must not bank hours: no single tick credits more than this. */
export const MAX_TICK_MS = 90_000;
const PERSIST_DEBOUNCE_MS = 5_000;

export interface TrackerEnv {
    load(): string | null;
    save(raw: string): void;
    loadWeekly(): string | null;
    saveWeekly(raw: string): void;
    deviceId: string;
    now(): number;
    /** Distinct easter eggs found right now. */
    eggCount(): number;
    /** Account creation, epoch ms, or null if unknown. */
    accountCreatedMs(): number | null;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(h: unknown): void;
}

export interface CallSignal {
    id: string;
    /** The media room is connected (not merely ringing / joining). */
    connected: boolean;
    /** People in the call, including you. */
    people: number;
    /** You started this call (a voice channel has no host). */
    isHost: boolean;
}

export interface UnlockEvent {
    id: string;
}

export function createTracker(env: TrackerEnv) {
    const setT = env.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearT = env.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

    let state: AchievementsState = parseState(env.load());
    let weekly: WeeklyBuckets = parseBuckets(env.loadWeekly());
    let call: CallSignal | null = null;
    let sessionMs = 0;
    let sessionId: string | null = null;
    let game: string | null = null;
    let lastTickAt = env.now();
    let persistTimer: unknown = null;
    let weeklyDirty = false;
    const changeListeners = new Set<() => void>();
    const unlockListeners = new Set<(e: UnlockEvent) => void>();

    const emitChange = () => { for (const l of changeListeners) l(); };

    function persistSoon() {
        if (persistTimer !== null) return;
        persistTimer = setT(flush, PERSIST_DEBOUNCE_MS);
    }
    function flush() {
        if (persistTimer !== null) { clearT(persistTimer); persistTimer = null; }
        try { env.save(JSON.stringify(state)); } catch { /* progress is cosmetic */ }
        if (weeklyDirty) {
            weeklyDirty = false;
            try { env.saveWeekly(JSON.stringify(weekly)); } catch { /* ditto */ }
        }
    }

    /** Re-check every rule; record and announce what is newly satisfied. Never removes. */
    function evaluate(): string[] {
        const now = env.now();
        const sat = satisfied(computeTotals(state, { eggCount: env.eggCount(), accountCreatedMs: env.accountCreatedMs(), now }));
        const fresh = sat.filter(id => !state.unlocked[id]);
        if (fresh.length === 0) return [];
        state = unlockIds(state, fresh, monthKey(new Date(now)));
        for (const id of fresh) for (const l of unlockListeners) l({ id });
        return fresh;
    }

    function commit(next: AchievementsState) {
        state = next;
        evaluate();
        persistSoon();
        emitChange();
    }

    function tick() {
        const now = env.now();
        const dt = Math.min(Math.max(0, now - lastTickAt), MAX_TICK_MS);
        lastTickAt = now;
        if (dt <= 0) return;
        const d = new Date(now);
        let next = state;
        if (call?.connected) {
            sessionMs += dt;
            next = addCallTime(next, env.deviceId, {
                dtMs: dt, people: call.people, isHost: call.isHost, sessionMs, hour: d.getHours(), day: dayKey(d),
            });
        }
        if (game) {
            next = addGameTime(next, env.deviceId, game, dt);
            weekly = addPlay(weekly, dayKey(d), game, dt);
            weeklyDirty = true;
        }
        if (next !== state || weeklyDirty) commit(next);
    }

    return {
        /** The current state (treat as immutable). */
        getState: (): AchievementsState => state,
        totals: (): Totals => computeTotals(state, { eggCount: env.eggCount(), accountCreatedMs: env.accountCreatedMs(), now: env.now() }),
        unlockedIds: (): string[] => Object.keys(state.unlocked).filter(id => ACHIEVEMENT_IDS.includes(id)),
        top: (): PlayedGame[] => topGames(weekly, dayKey(new Date(env.now()))),

        noteMessage(serverId: string | null) {
            commit(addMessage(state, env.deviceId, serverId, dayKey(new Date(env.now()))));
        },
        noteVerified(peerId: string) {
            const next = addVerified(state, peerId);
            if (next !== state) commit(next);
        },
        signalCall(next: CallSignal | null) {
            tick(); // credit the time spent under the OLD signal first
            const nextId = next?.connected ? next.id : null;
            if (nextId !== sessionId) { sessionId = nextId; sessionMs = 0; } // a new (or ended) call restarts "how long"
            call = next;
            if (next?.connected) {
                const withPeople = notePeople(state, env.deviceId, next.people, next.isHost);
                if (withPeople !== state && !sameState(withPeople, state)) commit(withPeople);
            }
        },
        signalGame(name: string | null) {
            tick();
            game = name && name.trim() ? name.trim().slice(0, 64) : null;
        },
        tick,

        /** An eggs / account-age change can satisfy a rule without any tracker event. */
        reevaluate() {
            if (evaluate().length > 0) { persistSoon(); emitChange(); }
        },

        /** Adopt a merged snapshot from another device. Returns true if anything changed. */
        mergeRemote(remote: AchievementsState): boolean {
            const merged = mergeState(state, remote);
            if (sameState(merged, state)) return false;
            commit(merged);
            return true;
        },
        setMostPlayed(on: boolean) {
            commit(setMostPlayedPref(state, on, env.now()));
        },

        subscribe(fn: () => void) { changeListeners.add(fn); return () => { changeListeners.delete(fn); }; },
        onUnlock(fn: (e: UnlockEvent) => void) { unlockListeners.add(fn); return () => { unlockListeners.delete(fn); }; },
        /** Write now (sign-out, quit). */
        flush,
    };
}

export type AchievementsTracker = ReturnType<typeof createTracker>;

// ── app singleton ───────────────────────────────────────────────────────────
// The host binds it once per signed-in account; producers call the helpers
// below, which are harmless no-ops until (and after) that.

let active: AchievementsTracker | null = null;

const bindListeners = new Set<() => void>();

export function bindTracker(t: AchievementsTracker | null): void {
    if (active && active !== t) active.flush();
    active = t;
    for (const l of bindListeners) l();
}
/** Fires whenever a tracker is bound or unbound (producers re-send their current signal). */
export function subscribeBind(fn: () => void): () => void {
    bindListeners.add(fn);
    return () => { bindListeners.delete(fn); };
}
export const getTracker = (): AchievementsTracker | null => active;

export function noteAchievementMessage(serverId: string | null): void {
    try { active?.noteMessage(serverId); } catch { /* cosmetic */ }
}
export function noteAchievementVerified(peerId: string): void {
    try { active?.noteVerified(peerId); } catch { /* cosmetic */ }
}
export { emptyState };
