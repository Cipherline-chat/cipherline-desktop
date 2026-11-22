import { useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';

/**
 * "Leave call when I'm alone for…" — the auto-leave when nobody else is in the call.
 *
 * Report ac33640d (2026-11-20): friends thought they were being kicked for being quiet. The timer counts OTHER
 * PEOPLE, not audio, but its dialog said "Removed due to inactivity". Two prod rooms also showed a leave at
 * 15m02s while someone else had been connected nearly the whole time: the count the timer used came from the
 * `useParticipants` hook, which can freeze after a reconnect. So:
 *   - the countdown only starts, and only finishes in a leave, if EVERY live source agrees nobody else is here
 *     (the Room's own remoteParticipants, the server's voice presence, the hook);
 *   - the user can say "Stay in call" (restarts the timer) and choose 15 / 30 / 60 minutes or never.
 *
 * Device-wide, persisted through secureLocalStore (written only on an explicit change, never on mount).
 * Note: for DM / group calls the API's own reaper still ends a call LiveKit reports as one person for 15 minutes;
 * that count comes from LiveKit itself, so it cannot be stale the way the hook can.
 */

export const ALONE_LEAVE_KEY = 'cipherline_alone_leave_minutes';
export const DEFAULT_ALONE_LEAVE_MINUTES = 15;
/** Seconds the "leaving in…" countdown runs before the final re-check and the leave. */
export const ALONE_COUNTDOWN_SECONDS = 60;

/** Stored values: '15' | '30' | '60' | 'never'. */
export type AloneLeaveSetting = '15' | '30' | '60' | 'never';
export const ALONE_LEAVE_OPTIONS: ReadonlyArray<{ value: AloneLeaveSetting; label: string }> = [
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: 'never', label: 'Never' },
];

export function parseAloneLeave(raw: unknown): AloneLeaveSetting {
    return raw === '30' || raw === '60' || raw === 'never' || raw === '15' ? raw : '15';
}

/** Minutes to wait alone, or null = never leave automatically. */
/** How long a person may sit alone in a call before the "still there?" countdown: 24 hours (owner, 2026-11-21). */
export const ALONE_LEAVE_MINUTES = 24 * 60;

export function aloneLeaveMinutes(setting: AloneLeaveSetting): number | null {
    // One fixed limit for everyone since 2026-11-21 (owner: "remove the idle time out thing", then "allow them to stay
    // in server calls for 24 hours alone"). The 15 / 30 / 60 / never setting is no longer shown and whatever an earlier
    // build stored is ignored. Being alone costs almost nothing meanwhile: utils/aloneUpstream.ts stops the audio upload
    // after 30 s. After 24 hours the usual one-minute "Stay in call" countdown runs before the leave.
    void setting;
    return ALONE_LEAVE_MINUTES;
}

// ── Store ───────────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* isolate */ } } };

export function getAloneLeaveSetting(): AloneLeaveSetting {
    try { return parseAloneLeave(secureLocalStore.getItem(ALONE_LEAVE_KEY)); } catch { return '15'; }
}

export function setAloneLeaveSetting(v: AloneLeaveSetting): void {
    try { secureLocalStore.setItem(ALONE_LEAVE_KEY, parseAloneLeave(v)); } catch { /* locked store: in-memory only */ }
    emit();
}

export function useAloneLeaveSetting(): AloneLeaveSetting {
    return useSyncExternalStore(subscribe, getAloneLeaveSetting, () => '15' as const);
}

// ── Live sources ────────────────────────────────────────────────────────────
/** Counts of OTHER people from each source. `null` = that source is not available (e.g. no server presence for a DM). */
export interface AloneCounts {
    hook: number;
    live: number | null;
    presence: number | null;
}

/** Someone else is here if ANY source says so. The sources only ever disagree when one of them is stale, and the cost of
 *  a wrongly-kept call is a few more minutes while the cost of a wrongly-ended one is a person thrown out of a call. */
export function someoneElseHere(c: AloneCounts): boolean {
    return c.hook > 0 || (c.live ?? 0) > 0 || (c.presence ?? 0) > 0;
}

export function countsDisagree(c: AloneCounts): boolean {
    const vals = [c.hook, c.live, c.presence].filter((v): v is number => v !== null);
    return vals.some(v => v > 0) && vals.some(v => v === 0);
}

// Server presence for the call being shown, registered by Dashboard (which owns it) and read here. Returns the number
// of OTHER users listed in the call, or null when there is no server presence for this call (DM / group call).
// Dashboard re-registers the probe on every presence change, so a registration doubles as the "presence changed"
// signal the alone upstream pause (aloneUpstream.ts) resumes on - a joiner shows in presence before LiveKit.
let presenceProbe: (() => number | null) | null = null;
const presenceListeners = new Set<() => void>();
export function setAlonePresenceProbe(fn: (() => number | null) | null): void {
    presenceProbe = fn;
    for (const l of [...presenceListeners]) { try { l(); } catch { /* isolate */ } }
}
export function subscribeAlonePresence(l: () => void): () => void {
    presenceListeners.add(l);
    return () => { presenceListeners.delete(l); };
}
export function readAlonePresence(): number | null {
    try { return presenceProbe ? presenceProbe() : null; } catch { return null; }
}

// ── Controller ──────────────────────────────────────────────────────────────
export type AloneAction = 'kept' | 'countdown_cancelled' | 'left';

export interface AloneDeps {
    minutes: () => number | null;
    probe: () => AloneCounts;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (h: unknown) => void;
    /** Countdown started (seconds) / ticked (seconds) / ended without leaving (null). */
    onCountdown: (secondsLeft: number | null) => void;
    onLeave: () => void;
    /** Called when the sources disagree (and always before leaving), with the action taken. Counts only. */
    log: (counts: AloneCounts, action: AloneAction) => void;
}

/**
 * The decision logic, free of React and real timers. `arm()` starts the alone-for-N-minutes wait; at expiry the LIVE
 * sources are re-read, and the countdown only starts if they all say alone. When the countdown ends they are read again
 * before leaving. `stay()` (the "Stay in call" button / Esc) dismisses the countdown and restarts the wait.
 */
export class AloneGuard {
    private idle: unknown = null;
    private tick: unknown = null;
    private left: number | null = null;
    private readonly d: AloneDeps;
    constructor(deps: AloneDeps) { this.d = deps; }

    get countdown(): number | null { return this.left; }

    private clearTimers() {
        if (this.idle !== null) { this.d.cancel(this.idle); this.idle = null; }
        if (this.tick !== null) { this.d.cancel(this.tick); this.tick = null; }
    }

    private endCountdown() {
        if (this.left !== null) { this.left = null; this.d.onCountdown(null); }
    }

    /** (Re)start the wait. No timer when the setting is Never. */
    arm(): void {
        this.clearTimers();
        this.endCountdown();
        const m = this.d.minutes();
        if (m === null) return;
        this.idle = this.d.schedule(() => { this.idle = null; this.expire(); }, m * 60_000);
    }

    /** Someone else is in the call (per the hook): stop everything. */
    disarm(): void {
        this.clearTimers();
        this.endCountdown();
    }

    stay(): void { this.arm(); }

    private expire() {
        const c = this.d.probe();
        if (someoneElseHere(c)) {
            if (countsDisagree(c)) this.d.log(c, 'kept');
            this.arm();
            return;
        }
        this.left = ALONE_COUNTDOWN_SECONDS;
        this.d.onCountdown(this.left);
        this.scheduleTick();
    }

    private scheduleTick() {
        this.tick = this.d.schedule(() => {
            this.tick = null;
            if (this.left === null) return;
            this.left -= 1;
            if (this.left > 0) { this.d.onCountdown(this.left); this.scheduleTick(); return; }
            const c = this.d.probe();
            if (someoneElseHere(c)) {
                if (countsDisagree(c)) this.d.log(c, 'countdown_cancelled');
                this.arm();
                return;
            }
            this.left = null;
            this.d.log(c, 'left');
            this.d.onLeave();
        }, 1000);
    }
}
