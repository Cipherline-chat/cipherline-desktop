/**
 * Invite expiry/max-uses clamping — mirrors the server-side limits in
 * `CreateInviteDto` (apps/api/src/servers/dto/server.dto.ts). Keep these
 * constants in sync with that DTO; a value outside them is a hard 400 from
 * the global validation pipe (`whitelist: true, forbidNonWhitelisted: true`).
 */

/** `expires_in_seconds` — @Min(60) */
export const EXPIRY_MIN_SECONDS = 60;
/** `expires_in_seconds` — @Max(60 * 60 * 24 * 30), 30 days */
export const EXPIRY_MAX_SECONDS = 60 * 60 * 24 * 30;
/** `max_uses` — @Min(1) */
export const USES_MIN = 1;
/** `max_uses` — @Max(1000) */
export const USES_MAX = 1000;

export type ExpiryUnit = 'minutes' | 'hours' | 'days';

const UNIT_SECONDS: Record<ExpiryUnit, number> = {
    minutes: 60,
    hours: 3600,
    days: 86400,
};

/** Convert a custom-expiry field value + unit into whole seconds. */
export function toSeconds(value: number, unit: ExpiryUnit): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * UNIT_SECONDS[unit]);
}

/**
 * Clamp a candidate expiry (in seconds) to the DTO's allowed range.
 * `null` (never expires) always passes through untouched — it's the
 * "omit the field" sentinel, not a value the API bounds-checks.
 */
export function clampExpirySeconds(n: number | null): number | null {
    if (n === null) return null;
    if (!Number.isFinite(n)) return EXPIRY_MIN_SECONDS;
    const rounded = Math.round(n);
    return Math.min(EXPIRY_MAX_SECONDS, Math.max(EXPIRY_MIN_SECONDS, rounded));
}

/**
 * Clamp a candidate max-uses count to the DTO's allowed range.
 * `null` (unlimited) always passes through untouched.
 */
export function clampUses(n: number | null): number | null {
    if (n === null) return null;
    if (!Number.isFinite(n)) return USES_MIN;
    const rounded = Math.round(n);
    return Math.min(USES_MAX, Math.max(USES_MIN, rounded));
}

// ── Invite liveness ───────────────────────────────────────────────────────────

/** The shape of an invite that liveness depends on. */
export interface InviteLiveness {
    expires_at: string | null;
    max_uses: number | null;
    uses: number;
}

/**
 * Is this invite still usable?
 *
 * `GET /servers/:id/invites` is an audit log — it deliberately returns every
 * invite the server has ever issued, expired and exhausted ones included, so
 * the settings screen can show the full history. Anything presenting an
 * invite as usable has to apply this itself; the quick-share modal used to
 * take the newest row by created_at and show a long-dead link as the server's
 * invite.
 */
export function isInviteUsable(inv: InviteLiveness, now: number = Date.now()): boolean {
    if (inv.expires_at !== null && new Date(inv.expires_at).getTime() <= now) return false;
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) return false;
    return true;
}

/**
 * The best invite to offer for sharing: the newest one that still works, or
 * null when every invite is spent. Newest-first so a freshly created link
 * wins over an older one that also happens to be valid.
 */
export function newestUsableInvite<T extends InviteLiveness & { created_at: string }>(
    invites: readonly T[], now: number = Date.now(),
): T | null {
    return [...invites]
        .filter(i => isInviteUsable(i, now))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;
}
