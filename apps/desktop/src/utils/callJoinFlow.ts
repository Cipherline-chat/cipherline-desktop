/**
 * Optimistic call join — the pure half.
 *
 * Owner ask (2026-10-07): joining a call should feel like sending a message
 * does now — you are in the call the instant you click, and the work happens
 * behind it. Before this, every join path waited on a REST round trip, then
 * (for a Calls channel) a key derivation that only STARTED after that round
 * trip, then the LiveKit connect, before any control appeared. The panel sat
 * empty for that whole stretch, which is the "it hangs for a second".
 *
 * What is decided here, and unit-tested without React:
 *   - which phase the join is in (drives the "Joining… / Securing… /
 *     Connecting…" controls and when they hand over to the real ones),
 *   - whether a join result is still wanted when its request comes back (a
 *     Leave pressed mid-join, or a second join started on top of the first),
 *   - what a failed join tells the user,
 *   - the timing summary logged for every join, so the owner can see where the
 *     time goes on a real machine.
 *
 * Nothing here relaxes the encryption gate: 'securing' is exactly the window
 * in which CallPane is NOT mounted because no key is held yet. The optimistic
 * UI only renders local, content-free placeholders in that window.
 */

/**
 * - idle        no call and no join in flight
 * - requesting  the join request (join_voice / calls/:id/join / huddle spawn…) is in flight
 * - securing    the server join succeeded but the room key is not held yet — CallPane is NOT mounted
 * - connecting  CallPane is mounted under a real key; the LiveKit room is connecting
 * - connected   the room reported Connected — the real controls take over
 */
export type CallJoinPhase = 'idle' | 'requesting' | 'securing' | 'connecting' | 'connected';

export interface CallJoinPhaseInput {
    /** A join was started and has not produced a call object yet. */
    isStartingCall: boolean;
    /** The active call's id, or null when there is none. */
    activeCallId: string | null;
    /** The encryption gate's verdict for the active call. */
    keyGateKind: 'connect' | 'blocked';
    /** The call id CallPane last reported as Connected, or null. */
    roomConnectedCallId: string | null;
}

export function deriveCallJoinPhase(s: CallJoinPhaseInput): CallJoinPhase {
    if (!s.activeCallId) return s.isStartingCall ? 'requesting' : 'idle';
    if (s.keyGateKind !== 'connect') return 'securing';
    // Bound to the id: a stale "connected" from some earlier call can never
    // make a new one skip its connecting state.
    return s.roomConnectedCallId === s.activeCallId ? 'connected' : 'connecting';
}

/** True while the optimistic placeholders (self row + joining controls) own the call UI. */
export function isJoinPending(phase: CallJoinPhase): boolean {
    return phase === 'requesting' || phase === 'securing' || phase === 'connecting';
}

/** Short status shown in the joining controls. Never includes any name or id. */
export function joinPhaseLabel(phase: CallJoinPhase): string {
    switch (phase) {
        case 'requesting': return 'Joining…';
        case 'securing': return 'Securing…';
        case 'connecting': return 'Connecting…';
        default: return '';
    }
}

// ── Attempts: is this join result still wanted? ─────────────────────────────

export interface JoinAttempt {
    readonly id: number;
    /** What the attempt joins (e.g. `voice:<channel>`), so an undo can tell
     *  whether a NEWER attempt is joining the very same thing. Local only. */
    readonly target: string;
    /** Set when the user left mid-join, or a newer join superseded this one. */
    cancelled: boolean;
    /** Set once the attempt has been committed, cancelled, or failed. */
    settled: boolean;
    /** Set when the join request itself failed (the server never joined us). */
    failed: boolean;
}

export interface JoinAttemptTracker {
    /** Start a join. Any still-open earlier attempt is cancelled (superseded). */
    begin(target: string): JoinAttempt;
    /**
     * Called when the request comes back. `true` = commit the result (and the
     * attempt is closed); `false` = the user no longer wants it — the caller
     * must undo whatever the server just did (leave the channel / call).
     */
    settle(attempt: JoinAttempt): boolean;
    /** The join failed — close it without committing. */
    fail(attempt: JoinAttempt): void;
    /** Cancel the open attempt (Leave pressed mid-join). Returns it, or null if none was open. */
    cancel(): JoinAttempt | null;
    /** The open (unsettled) attempt, if any. */
    pending(): JoinAttempt | null;
    /**
     * May an abandoned attempt's server-side join be undone? Not when a NEWER
     * attempt at the same target is still in flight or has been committed:
     * the user left and clicked straight back in, and that newer join may
     * already have reached the server (or already be the call they are in) —
     * undoing the old one would kick them out of it. A newer attempt that was
     * itself cancelled or failed does not protect anything, so undo proceeds.
     */
    mayUndo(abandoned: JoinAttempt): boolean;
}

export function createJoinAttemptTracker(): JoinAttemptTracker {
    let seq = 0;
    let current: JoinAttempt | null = null;
    const latestByTarget = new Map<string, JoinAttempt>();
    return {
        begin(target) {
            if (current && !current.settled) current.cancelled = true;
            current = { id: ++seq, target, cancelled: false, settled: false, failed: false };
            latestByTarget.set(target, current);
            return current;
        },
        settle(attempt) {
            if (attempt.settled && !attempt.cancelled) return false; // double-settle never commits twice
            const live = attempt === current && !attempt.cancelled;
            attempt.settled = true;
            return live;
        },
        fail(attempt) {
            attempt.settled = true;
            attempt.failed = true;
        },
        cancel() {
            if (!current || current.settled || current.cancelled) return null;
            current.cancelled = true;
            return current;
        },
        pending() {
            return current && !current.settled && !current.cancelled ? current : null;
        },
        mayUndo(abandoned) {
            const latest = latestByTarget.get(abandoned.target);
            if (!latest || latest === abandoned) return true;
            // In flight, or committed (settled without being cancelled/failed).
            const protects = !latest.cancelled && !latest.failed;
            return !protects;
        },
    };
}

/**
 * Re-entrancy guard (ghost-call fix, 2026-10-08): is a join for exactly this
 * target already in flight? A double-click, a keyboard + mouse activation, or
 * a click while a slow spawn is still pending used to start a SECOND spawn —
 * a second call room on the server — while the first was still being made.
 * The caller ignores the repeat instead. A join to a DIFFERENT target is not a
 * repeat: it supersedes the open one, as before.
 */
export function isSameJoinInFlight(tracker: Pick<JoinAttemptTracker, 'pending'>, target: string): boolean {
    return tracker.pending()?.target === target;
}

/**
 * Headers for a Calls-channel spawn / join. `x-device-id` lets the server
 * enforce "one device, one call" precisely: a newer join from this device
 * retires any other call this device's presence is still attached to (a spawn
 * whose response was lost, a leave that failed). Omitted when unknown — the
 * server then falls back to a LiveKit-verified check.
 */
export function huddleJoinHeaders(token: string, deviceId?: string | null): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (deviceId) h['x-device-id'] = deviceId;
    return h;
}

// ── Failure → what the user is told ─────────────────────────────────────────

export type CallJoinKind = 'voice' | 'huddle-spawn' | 'huddle-join' | 'dm-start' | 'dm-join';

export interface CallJoinFailure {
    /** null = say nothing (the 426 upgrade overlay already explains it). */
    toast: { kind: 'error' | 'info' | 'warning'; title: string; message: string } | null;
    /** Set for a 429: how long the call buttons should cool down. */
    cooldownMs?: number;
}

interface HttpishError {
    response?: { status?: number; headers?: Record<string, unknown> };
    code?: string;
}

const DEFAULT_MESSAGE: Record<CallJoinKind, string> = {
    'voice': "Couldn't join the voice channel — check your network and try again.",
    'huddle-spawn': "Couldn't start the call — check your network and try again.",
    'huddle-join': "Couldn't join the call — check your network and try again.",
    'dm-start': "Couldn't start the call — check your network and try again.",
    'dm-join': 'Cannot connect. The call might have ended.',
};

export function describeCallJoinFailure(err: unknown, kind: CallJoinKind): CallJoinFailure {
    const e = (err ?? {}) as HttpishError;
    const status = e.response?.status;
    if (status === 426) {
        // httpBootstrap's global handler raises the "update required" overlay
        // (calls carry their own version floor) — a toast on top is noise.
        return { toast: null };
    }
    if (status === 429) {
        const raw = e.response?.headers?.['retry-after'];
        const secs = Math.max(1, parseInt(typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '10', 10) || 10);
        return {
            toast: { kind: 'warning', title: 'Slow down', message: `Too many call attempts — try again in ${secs}s.` },
            cooldownMs: secs * 1000,
        };
    }
    if (status === 409) {
        return { toast: { kind: 'info', title: 'Answered elsewhere', message: 'This call was already joined from your other device.' } };
    }
    if (status === 403) {
        return {
            toast: {
                kind: 'error',
                title: 'Call connection failed',
                message: kind === 'voice'
                    ? "You don't have permission to join this voice channel."
                    : "You don't have permission to join this call.",
            },
        };
    }
    if (status === 404 || status === 410) {
        return { toast: { kind: 'error', title: 'Call connection failed', message: 'That call has ended.' } };
    }
    return { toast: { kind: 'error', title: 'Call connection failed', message: DEFAULT_MESSAGE[kind] } };
}

// ── Timing: where did the join's time go? ───────────────────────────────────

/**
 * Stages in the order they normally happen:
 *   ui        first frame of the optimistic UI after the click
 *   request   the join request returned (LiveKit token in hand)
 *   key       the room key is held and CallPane mounts
 *   connected the LiveKit room reported Connected — the real controls take over
 *   mic       our microphone is published (or the join completed without one)
 */
export const JOIN_STAGES = ['ui', 'request', 'key', 'connected', 'mic'] as const;
export type JoinStage = typeof JOIN_STAGES[number];

export interface JoinTimeline {
    kind: CallJoinKind;
    startedAt: number;
    marks: Partial<Record<JoinStage, number>>;
}

export function startJoinTimeline(kind: CallJoinKind, now: number): JoinTimeline {
    return { kind, startedAt: now, marks: {} };
}

/** Records a stage once (the first time it happens counts). Returns whether it was recorded. */
export function markJoinStage(t: JoinTimeline | null, stage: JoinStage, now: number): boolean {
    if (!t || t.marks[stage] != null) return false;
    t.marks[stage] = Math.max(0, now - t.startedAt);
    return true;
}

/**
 * One-line summary, e.g.
 *   "voice · ui 12ms · request +298ms · key +3ms · connected +612ms · mic +143ms · total 1068ms"
 * Each `+N` is the time since the previous recorded stage. Contains only the
 * join kind and durations — no ids, names or URLs (it goes to the console).
 */
export function formatJoinTimeline(t: JoinTimeline): string {
    const parts: string[] = [t.kind];
    let prev = 0;
    let last = 0;
    for (const stage of JOIN_STAGES) {
        const at = t.marks[stage];
        if (at == null) continue;
        parts.push(stage === 'ui' ? `ui ${Math.round(at)}ms` : `${stage} +${Math.round(Math.max(0, at - prev))}ms`);
        prev = Math.max(prev, at);
        last = Math.max(last, at);
    }
    parts.push(`total ${Math.round(last)}ms`);
    return parts.join(' · ');
}
