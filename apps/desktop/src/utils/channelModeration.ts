/**
 * Client side of slowmode and age-restricted channels.
 *
 * EVERYTHING here is presentation. The API enforces both (slowmode on the
 * channel message POST, the age gate on every history read), and this client
 * has no load-bearing check: a countdown that disagrees with the server is
 * corrected by the server's answer (429 SLOWMODE_ACTIVE -> `retry_after_ms`),
 * and a gate that this device skipped would still be answered 403.
 *
 * Nothing here is persisted: the slowmode clock is a few seconds of in-memory
 * state (the server holds the real one), and the 18+ confirmation lives on the
 * account, server-side, so every device agrees. No new settings key, so nothing
 * to add to backupRegistry.
 */
import { Permissions, SLOWMODE_ERROR_CODE, AGE_GATE_ERROR_CODE } from '@cipherline/shared';

export interface ModerationFields {
    slowmode_seconds?: number;
    age_restricted?: boolean;
    age_gate_confirmed?: boolean;
    my_permissions?: string;
}

/** The channel's slowmode in seconds (0 = off; absent from an older API = off). */
export function slowmodeSecondsOf(ch: ModerationFields | null | undefined): number {
    const n = ch?.slowmode_seconds;
    return typeof n === 'number' && n > 0 ? n : 0;
}

/** Does THIS member skip slowmode? Same rule as the server (MANAGE_MESSAGES or
 *  MANAGE_CHANNELS in the channel). UX only: a wrong guess is corrected by the
 *  server's answer either way. */
export function isSlowmodeExempt(myPermissions: string | undefined | null): boolean {
    if (!myPermissions) return false;
    try {
        const p = BigInt(myPermissions);
        return (p & (Permissions.MANAGE_MESSAGES | Permissions.MANAGE_CHANNELS)) !== 0n;
    } catch {
        return false;
    }
}

/** Is this channel age-restricted AND not yet confirmed by this account? */
export function isChannelAgeGated(ch: ModerationFields | null | undefined): boolean {
    return ch?.age_restricted === true && ch.age_gate_confirmed !== true;
}

// ── Errors ───────────────────────────────────────────────────────────────

type ErrBody = { response?: { status?: number; data?: { code?: unknown; retry_after_ms?: unknown; slowmode_seconds?: unknown } } };

export function isSlowmodeError(err: unknown): boolean {
    const r = (err as ErrBody | null)?.response;
    return r?.status === 429 && r.data?.code === SLOWMODE_ERROR_CODE;
}

/** Milliseconds the server says to wait, for a slowmode refusal. */
export function slowmodeRetryMs(err: unknown): number | undefined {
    if (!isSlowmodeError(err)) return undefined;
    const n = Number((err as ErrBody).response?.data?.retry_after_ms);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function isAgeGateError(err: unknown): boolean {
    const r = (err as ErrBody | null)?.response;
    return r?.status === 403 && r.data?.code === AGE_GATE_ERROR_CODE;
}

/** "0:23", "12:05", "1:02:00". */
export function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
}

// ── The per-channel slowmode clock ───────────────────────────────────────

const until = new Map<string, number>();

const key = (userId: string, channelId: string) => `${userId}:${channelId}`;

/** The window the server will enforce, starting `now`. */
export function startSlowmode(userId: string, channelId: string, ms: number, now: number = Date.now()): void {
    if (ms > 0) until.set(key(userId, channelId), now + ms);
}

/** Milliseconds left in this member's window for this channel (0 = free). */
export function slowmodeLeftMs(userId: string, channelId: string, now: number = Date.now()): number {
    const k = key(userId, channelId);
    const t = until.get(k);
    if (t === undefined) return 0;
    if (t <= now) { until.delete(k); return 0; }
    return t - now;
}

/** The slowmode was switched off or lowered: drop a window that outlives it. */
export function clampSlowmode(userId: string, channelId: string, maxMs: number, now: number = Date.now()): void {
    const k = key(userId, channelId);
    const t = until.get(k);
    if (t !== undefined && t - now > maxMs) {
        if (maxMs <= 0) until.delete(k); else until.set(k, now + maxMs);
    }
}

export function resetSlowmodeClockForTests(): void { until.clear(); }
