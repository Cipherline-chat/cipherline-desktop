/**
 * firstWeekNudgeStore — persistence + the public hook for the first-week nudges.
 *
 * The rules are in firstWeekNudges.ts (pure). This file is the thin edge:
 *
 *  - read / write the per-account state blob in secureLocalStore (encrypted at
 *    rest; account-scoped by the key). It is a PREFERENCE-ish record (the off
 *    switch, what has been taught), so it travels in backups — see
 *    backupRegistry.ts.
 *  - a same-window change event so Settings → Notifications and the engine stay
 *    in step without sharing React state.
 *  - `nudges.notify(event)`: the way ANY other feature tells the engine
 *    something real happened. It is a no-op until the engine is mounted, and
 *    safe to call from anywhere (components, handlers, tests).
 *
 *      nudges.notify({ kind: 'friend_joined', username: 'sam', userId })
 *      nudges.notify({ kind: 'friend_request_sent' })
 *      nudges.notify({ kind: 'invite_sent' })
 *      nudges.notify({ kind: 'message_sent' })
 *
 * Nothing here talks to the network.
 */
import secureLocalStore from './secureLocalStore';
import { parseNudgeState, defaultNudgeState, type NudgeState, type NudgeEvent } from './firstWeekNudges';

export const NUDGE_STATE_CHANGED_EVENT = 'cipherline:first-week-nudges-changed';

export function readNudgeState(userId: string): NudgeState {
    try {
        return parseNudgeState(secureLocalStore.getItem(`cipherline_first_week_nudges_${userId}`));
    } catch {
        return defaultNudgeState();
    }
}

/** The stored blob as a string ('' when absent) — a stable, primitive snapshot
 *  for useSyncExternalStore (parse it with parseNudgeState). */
export function readNudgeStateRaw(userId: string): string {
    try { return secureLocalStore.getItem(`cipherline_first_week_nudges_${userId}`) ?? ''; } catch { return ''; }
}

export function writeNudgeState(userId: string, state: NudgeState): void {
    try {
        secureLocalStore.setItem(`cipherline_first_week_nudges_${userId}`, JSON.stringify(state));
    } catch { /* locked store: in-memory state still holds for this session */ }
    try { window.dispatchEvent(new CustomEvent(NUDGE_STATE_CHANGED_EVENT, { detail: { userId } })); } catch { /* no window (tests) */ }
}

/** Run `fn` over the stored state and write the result back. */
export function updateNudgeState(userId: string, fn: (s: NudgeState) => NudgeState): NudgeState {
    const next = fn(readNudgeState(userId));
    writeNudgeState(userId, next);
    return next;
}

export function subscribeNudgeState(cb: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener(NUDGE_STATE_CHANGED_EVENT, cb);
    return () => window.removeEventListener(NUDGE_STATE_CHANGED_EVENT, cb);
}

// ── Event bus (the hook other features call) ─────────────────────────────────

type Listener = (e: NudgeEvent) => void;
const listeners = new Set<Listener>();

export const nudges = {
    /** Report something real. Listeners are the mounted engine; with none it is a no-op. */
    notify(event: NudgeEvent): void {
        for (const l of [...listeners]) {
            try { l(event); } catch { /* one bad listener must not break a caller's flow */ }
        }
    },
    subscribe(l: Listener): () => void {
        listeners.add(l);
        return () => { listeners.delete(l); };
    },
};

/** Test-only. */
export function __resetNudgeBusForTests(): void { listeners.clear(); coachSession.release(); }

// ── The save-a-message coach mark's in-memory session slot ───────────────────
// Which message the mark is currently pointing at. In memory only: the
// persisted "taught" flag (NudgeState.coachSaveDone) is what makes it one-time.
// An external store (rather than component state) so the mark can be claimed
// from an effect without a synchronous setState, and released on unmount.
let coachShownId: string | null = null;
const coachListeners = new Set<() => void>();
const emitCoach = () => { for (const l of [...coachListeners]) l(); };

export const coachSession = {
    get: (): string | null => coachShownId,
    lock(id: string): void { if (coachShownId !== id) { coachShownId = id; emitCoach(); } },
    release(): void { if (coachShownId !== null) { coachShownId = null; emitCoach(); } },
    subscribe(cb: () => void): () => void {
        coachListeners.add(cb);
        return () => { coachListeners.delete(cb); };
    },
};
