/**
 * The read-only "why is my phone quiet?" line in Settings > Advanced.
 *
 *   Idle for 12s · away after 5 min · phone notifications: held
 *
 * It exists to make a stuck idle clock a 30-second diagnosis (audit 2026-11-25,
 * G3): if "Idle for" never climbs while nobody is at the PC, something is
 * resetting the OS idle clock. Everything is read from this device's own state;
 * nothing is sent anywhere.
 *
 * "held" = this PC currently reports itself in use, so the server holds new
 * messages back from the phone (for at most the push window); "sent" = the PC
 * reports not in use, so messages go to the phone.
 */
import { computeIsAttentive } from './attentionState';
import { getIdleThresholdSeconds, getPushPresenceThresholdSeconds, PUSH_PRESENCE_MAX_SECONDS } from './idleThreshold';
import { getOsIdleReading } from './inputRecency';
import { isSessionAway } from './sessionLock';

export interface AttentionDiagnostics {
    /** OS idle seconds; +Infinity = unknown (never read, failed, or stale). */
    idleSeconds: number;
    /** The user's Idle timeout (visible auto-away), minutes. */
    awayAfterMinutes: number;
    /** What the phone decision uses: min(setting, 5 min), minutes. */
    phoneAfterMinutes: number;
    sessionAway: boolean;
    /** True = held (PC reports in use). */
    held: boolean;
}

export function getAttentionDiagnostics(now: number = Date.now()): AttentionDiagnostics {
    const { idleSeconds } = getOsIdleReading(now);
    const sessionAway = isSessionAway();
    return {
        idleSeconds,
        awayAfterMinutes: getIdleThresholdSeconds() / 60,
        phoneAfterMinutes: getPushPresenceThresholdSeconds() / 60,
        sessionAway,
        held: computeIsAttentive(!sessionAway, idleSeconds, getPushPresenceThresholdSeconds()),
    };
}

function formatIdle(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
    const s = Math.floor(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatAttentionDiagnostics(d: AttentionDiagnostics): string {
    const away = d.phoneAfterMinutes < d.awayAfterMinutes
        ? `away after ${d.awayAfterMinutes} min (phone after ${d.phoneAfterMinutes})`
        : `away after ${d.awayAfterMinutes} min`;
    const idle = d.sessionAway ? 'Locked or asleep' : `Idle for ${formatIdle(d.idleSeconds)}`;
    return `${idle} · ${away} · phone notifications: ${d.held ? 'held' : 'sent'}`;
}

export { PUSH_PRESENCE_MAX_SECONDS };
