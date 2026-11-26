/**
 * "Has a person had real input recently?" as ONE shared, DOM-light fact.
 *
 * Two kinds of evidence, both untrusted-by-default:
 *  - the OS-wide idle clock (`electronAPI.getSystemIdleTime()`), published here by
 *    the attention poll (utils/idlePoller.ts, wired in hooks/useRealtime.ts);
 *  - real input that reached THIS window (pointer / key / wheel / scroll,
 *    `isTrusted` only, so a script cannot fake it).
 *
 * Why it exists (notification-reliability audit, 2026-11-25): a PC left idle with a
 * chat focused auto-sent `message:read` for every arriving message. The server
 * treats a read as "a human looked" and cancelled the phone's pending
 * notification, so the phone never rang. An auto read-receipt now needs input
 * inside AUTO_READ_MAX_IDLE_MS; the id is not marked sent, so it goes out the
 * moment input returns while the chat is still on screen.
 *
 * Failure direction: an unknown / stale reading is NOT recent input. Withholding
 * a read costs a later badge clear; claiming one silences a phone.
 *
 * Module state only, nothing leaves the device except the `idle_ms` integer the
 * callers attach to read events and heartbeats.
 */

/** Auto read-receipts need real input at most this long ago (server cancels the
 *  phone's escalation on the same bound). */
export const AUTO_READ_MAX_IDLE_MS = 120_000;

/** A reading older than this (2 x the 30 s poll interval) is unknown, not "low". */
export const IDLE_READING_STALE_MS = 60_000;

const MAX_IDLE_MS = 24 * 60 * 60 * 1000;

let osIdleSeconds = Number.POSITIVE_INFINITY;
let osReadAt = 0;
let lastLocalInputAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();

function notify(): void {
    for (const fn of [...listeners]) {
        try { fn(); } catch { /* a listener must not break the others */ }
    }
}

/** OS idle seconds as of `now`, or +Infinity when never read / stale / invalid. */
export function freshIdleSeconds(
    idleSeconds: number,
    readAt: number,
    now: number = Date.now(),
    staleMs: number = IDLE_READING_STALE_MS,
): number {
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(readAt) || readAt <= 0) return Number.POSITIVE_INFINITY;
    if (now - readAt > staleMs) return Number.POSITIVE_INFINITY;
    return idleSeconds;
}

/**
 * ms since the last real input, or undefined when unknown. The smaller of the OS
 * clock (plus the reading's age, which errs toward idle) and the time since the
 * last trusted input in this window.
 */
export function computeInputIdleMs(
    s: { osIdleSeconds: number; osReadAt: number; lastLocalInputAt: number },
    now: number,
): number | undefined {
    let best = Number.POSITIVE_INFINITY;
    const os = freshIdleSeconds(s.osIdleSeconds, s.osReadAt, now);
    if (Number.isFinite(os)) best = os * 1000 + Math.max(0, now - s.osReadAt);
    if (Number.isFinite(s.lastLocalInputAt)) best = Math.min(best, Math.max(0, now - s.lastLocalInputAt));
    // Same 24 h ceiling the server accepts on `idle_ms`.
    return Number.isFinite(best) ? Math.min(MAX_IDLE_MS, Math.round(best)) : undefined;
}

/** Current `idle_ms` to attach to a read event / heartbeat; undefined = unknown (omit the field). */
export function getInputIdleMs(now: number = Date.now()): number | undefined {
    return computeInputIdleMs({ osIdleSeconds, osReadAt, lastLocalInputAt }, now);
}

/** True when real input happened within `maxMs`. Unknown is false. */
export function hasRecentInput(now: number = Date.now(), maxMs: number = AUTO_READ_MAX_IDLE_MS): boolean {
    const idle = getInputIdleMs(now);
    return idle !== undefined && idle <= maxMs;
}

/** The last OS idle reading and when it was taken (for diagnostics). */
export function getOsIdleReading(now: number = Date.now()): { idleSeconds: number; readAt: number; ageMs: number } {
    return { idleSeconds: freshIdleSeconds(osIdleSeconds, osReadAt, now), readAt: osReadAt, ageMs: osReadAt > 0 ? now - osReadAt : Number.POSITIVE_INFINITY };
}

/** The attention poll publishes each reading (+Infinity = unknown/failed). */
export function publishOsIdleReading(idleSeconds: number, at: number = Date.now()): void {
    const was = hasRecentInput(at);
    osIdleSeconds = idleSeconds;
    osReadAt = at;
    if (hasRecentInput(at) !== was) notify();
}

/** Real input reached this window. Notifies only on the not-recent -> recent edge. */
export function noteLocalInput(at: number = Date.now()): void {
    const was = hasRecentInput(at);
    lastLocalInputAt = at;
    if (!was) notify();
}

/** Called on a not-recent <-> recent change (publish / local input). Expiry by the
 *  mere passage of time is NOT announced: poll hasRecentInput() for that. */
export function subscribeInputRecency(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

const LOCAL_INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Track trusted input in this window. Idempotent per target; returns the remover.
 * `scroll` is captured too (it does not bubble). Cheap: one timestamp write per event.
 */
export function installLocalInputTracking(target: Document | undefined = typeof document !== 'undefined' ? document : undefined): () => void {
    if (!target) return () => {};
    const onInput = (e: Event) => { if (e.isTrusted) noteLocalInput(); };
    for (const ev of LOCAL_INPUT_EVENTS) target.addEventListener(ev, onInput, { capture: true, passive: true });
    target.addEventListener('scroll', onInput, { capture: true, passive: true });
    return () => {
        for (const ev of LOCAL_INPUT_EVENTS) target.removeEventListener(ev, onInput, true);
        target.removeEventListener('scroll', onInput, true);
    };
}

/** Test/sign-out reset. */
export function resetInputRecency(): void {
    osIdleSeconds = Number.POSITIVE_INFINITY;
    osReadAt = 0;
    lastLocalInputAt = Number.NEGATIVE_INFINITY;
    listeners.clear();
}
