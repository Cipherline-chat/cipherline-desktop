/**
 * Whether this PC's OS session is available to a person, as ONE shared fact.
 *
 * Fed by exactly one place (useRealtime's `onOsPowerSignal` listener, which
 * already folds main's powerMonitor / Linux screensaver signals through
 * reduceSessionPowerState) and read by:
 *   - useUserStatus   - a locked or sleeping PC reports idle AT ONCE, instead of
 *                       waiting out the idle timeout;
 *   - the notification dispatcher - a locked PC stays silent (the phone is
 *                       being told instead, so a toast here would be a double
 *                       notification, and would also pile up to greet you at
 *                       unlock).
 *
 * Pure module state, no Electron/React imports, so the rules are unit-testable.
 * Metadata stays on this device: nothing here is ever sent anywhere; the
 * network only ever sees the existing `presence:idle` / heartbeat booleans.
 *
 * Quiet window after a wake: a machine that slept had no socket, so on resume
 * it fetches every message that arrived meanwhile and would toast all of them
 * at once, though the phone already delivered them. For POST_WAKE_QUIET_MS
 * after a `resume` alerts stay silent (badges and unread counts are NOT
 * affected, same asymmetry as DND). A plain unlock needs no such window: the
 * socket stayed up during the lock, so those messages were already handled
 * (silently) while locked.
 */
import { SESSION_AVAILABLE, isSessionInUse, reduceSessionPowerState, type SessionPowerState } from './attentionState';

export const POST_WAKE_QUIET_MS = 20_000;

/** How long after an unlock the idle reading may be capped by "time since unlock". */
export const UNLOCK_CAP_WINDOW_SECONDS = 10;

let state: SessionPowerState = SESSION_AVAILABLE;
let quietUntil = 0;
let lastUnlockAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();

/** Fold one main-process power signal in. Unknown signals change nothing. */
export function applySessionPowerSignal(signal: string, now: number = Date.now()): void {
    const next = reduceSessionPowerState(state, signal);
    if (signal === 'resume') quietUntil = now + POST_WAKE_QUIET_MS;
    // Only an unlock that follows a lock counts as "signing back in": a repeated
    // or spurious `unlock-screen` (RDP / fast-user-switch reconnects) must not
    // keep refreshing the "just used" cap below.
    if (signal === 'unlock-screen' && state.locked) lastUnlockAt = now;
    const wasInUse = isSessionInUse(state);
    state = next;
    if (wasInUse !== isSessionInUse(state)) {
        for (const fn of [...listeners]) {
            try { fn(); } catch { /* a listener must not break the others */ }
        }
    }
}

/**
 * Real input reached THIS window, which cannot happen on a locked or sleeping
 * session: whatever the signals last said, the PC is in use. Backstop for a
 * missed unlock edge (a screensaver D-Bus signal dropped, a platform that
 * never reports one): without it a stuck "locked" would keep the user idle and
 * their desktop silent until restart. Returns whether it changed anything.
 */
export function noteSessionInteraction(): boolean {
    if (!isSessionAway()) return false;
    state = SESSION_AVAILABLE;
    lastUnlockAt = Date.now();
    for (const fn of [...listeners]) {
        try { fn(); } catch { /* a listener must not break the others */ }
    }
    return true;
}

/** Locked or suspended right now. */
export function isSessionAway(): boolean {
    return !isSessionInUse(state);
}

/** Alerts (sound / toast / taskbar flash) must stay quiet: away, or just woke. */
export function isSessionSilent(now: number = Date.now()): boolean {
    return isSessionAway() || now < quietUntil;
}

/** Called when the session flips between in-use and away (either direction). */
export function subscribeSessionAway(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/**
 * Signing back in IS input, but the OS idle clock does not always see it (the
 * credential entry happens on the lock screen, not in the user session on
 * every platform). Cap the OS reading by the time since the unlock so a fresh
 * unlock reads as "just used" and the status / attention come back at once
 * instead of waiting for the next keystroke.
 */
export function effectiveIdleSeconds(osIdleSeconds: number, now: number = Date.now()): number {
    if (!Number.isFinite(osIdleSeconds) || osIdleSeconds < 0) return osIdleSeconds;
    const sinceUnlock = (now - lastUnlockAt) / 1000;
    // Only inside UNLOCK_CAP_WINDOW_SECONDS: past it the OS clock decides, so a
    // late or repeated signal cannot hold idle near 0 for a whole timeout
    // (notification-reliability audit 2026-11-25, A5).
    return sinceUnlock >= 0 && sinceUnlock < UNLOCK_CAP_WINDOW_SECONDS && sinceUnlock < osIdleSeconds ? sinceUnlock : osIdleSeconds;
}

/**
 * The idle verdict with hysteresis (go idle at the threshold, come back once
 * input is this recent), with the session in the loop: a locked or sleeping PC
 * is idle regardless of the OS idle clock (which keeps resetting while a
 * password is typed, and is not reliable on every Linux session).
 */
export function nextIdleVerdict(input: {
    wasIdle: boolean;
    idleSeconds: number;
    thresholdSeconds: number;
    returnSeconds: number;
    away: boolean;
}): boolean {
    if (input.away) return true;
    return input.wasIdle ? input.idleSeconds >= input.returnSeconds : input.idleSeconds >= input.thresholdSeconds;
}

/** Test/sign-out reset. */
export function resetSessionLock(): void {
    state = SESSION_AVAILABLE;
    quietUntil = 0;
    lastUnlockAt = Number.NEGATIVE_INFINITY;
    listeners.clear();
}
