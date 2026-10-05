import { describe, it, expect } from 'vitest';
import {
    toSeconds, clampExpirySeconds, clampUses,
    EXPIRY_MIN_SECONDS, EXPIRY_MAX_SECONDS, USES_MIN, USES_MAX,
} from './inviteLimits';

// These constants mirror CreateInviteDto (apps/api/src/servers/dto/server.dto.ts)
// — a value outside them is a hard 400 from the API. The tests pin the exact
// bounds so a drift between the two files fails loudly here first.
describe('inviteLimits constants', () => {
    it('match the CreateInviteDto bounds', () => {
        expect(EXPIRY_MIN_SECONDS).toBe(60);
        expect(EXPIRY_MAX_SECONDS).toBe(60 * 60 * 24 * 30);
        expect(USES_MIN).toBe(1);
        expect(USES_MAX).toBe(1000);
    });
});

describe('toSeconds', () => {
    it('converts minutes/hours/days to whole seconds', () => {
        expect(toSeconds(30, 'minutes')).toBe(1800);
        expect(toSeconds(1, 'hours')).toBe(3600);
        expect(toSeconds(1, 'days')).toBe(86400);
    });

    it('rounds fractional results', () => {
        expect(toSeconds(1.5, 'minutes')).toBe(90);
    });

    it('treats a non-finite value as 0', () => {
        expect(toSeconds(NaN, 'hours')).toBe(0);
    });
});

describe('clampExpirySeconds', () => {
    it('passes null (never expires) through untouched', () => {
        expect(clampExpirySeconds(null)).toBeNull();
    });

    it('clamps below the 60s floor', () => {
        expect(clampExpirySeconds(10)).toBe(60);
        expect(clampExpirySeconds(0)).toBe(60);
        expect(clampExpirySeconds(-5)).toBe(60);
    });

    it('clamps above the 30-day ceiling', () => {
        expect(clampExpirySeconds(toSeconds(40, 'days'))).toBe(EXPIRY_MAX_SECONDS);
    });

    it('passes an in-range value through, rounded', () => {
        expect(clampExpirySeconds(3599.6)).toBe(3600);
    });

    it('treats NaN as the floor', () => {
        expect(clampExpirySeconds(NaN)).toBe(EXPIRY_MIN_SECONDS);
    });
});

describe('clampUses', () => {
    it('passes null (unlimited) through untouched', () => {
        expect(clampUses(null)).toBeNull();
    });

    it('clamps below the floor of 1', () => {
        expect(clampUses(0)).toBe(1);
        expect(clampUses(-3)).toBe(1);
    });

    it('clamps above the ceiling of 1000', () => {
        expect(clampUses(5000)).toBe(1000);
    });

    it('passes an in-range value through, rounded', () => {
        expect(clampUses(42.4)).toBe(42);
    });

    it('treats NaN as the floor', () => {
        expect(clampUses(NaN)).toBe(USES_MIN);
    });
});

// ── Invite liveness ───────────────────────────────────────────────────────────

import { isInviteUsable, newestUsableInvite } from './inviteLimits';

const NOW = 1_700_000_000_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const inv = (o: Partial<{ expires_at: string | null; max_uses: number | null; uses: number; created_at: string }> = {}) => ({
    expires_at: o.expires_at ?? null,
    max_uses: o.max_uses ?? null,
    uses: o.uses ?? 0,
    created_at: o.created_at ?? iso(0),
});

describe('isInviteUsable', () => {
    it('accepts a never-expiring, unlimited invite', () => {
        expect(isInviteUsable(inv(), NOW)).toBe(true);
    });

    it('rejects one whose expiry has passed', () => {
        expect(isInviteUsable(inv({ expires_at: iso(-1) }), NOW)).toBe(false);
    });

    it('treats the exact expiry instant as expired', () => {
        expect(isInviteUsable(inv({ expires_at: iso(0) }), NOW)).toBe(false);
    });

    it('accepts one expiring in the future', () => {
        expect(isInviteUsable(inv({ expires_at: iso(60_000) }), NOW)).toBe(true);
    });

    it('rejects one that has hit its use cap', () => {
        expect(isInviteUsable(inv({ max_uses: 5, uses: 5 }), NOW)).toBe(false);
        expect(isInviteUsable(inv({ max_uses: 5, uses: 6 }), NOW)).toBe(false);
    });

    it('accepts one with uses remaining', () => {
        expect(isInviteUsable(inv({ max_uses: 5, uses: 4 }), NOW)).toBe(true);
    });

    it('needs BOTH conditions — a live expiry does not rescue an exhausted invite', () => {
        expect(isInviteUsable(inv({ expires_at: iso(60_000), max_uses: 1, uses: 1 }), NOW)).toBe(false);
    });
});

describe('newestUsableInvite', () => {
    it('returns null when every invite is spent', () => {
        expect(newestUsableInvite([
            inv({ expires_at: iso(-1) }),
            inv({ max_uses: 1, uses: 1 }),
        ], NOW)).toBeNull();
    });

    it('returns null for an empty list', () => {
        expect(newestUsableInvite([], NOW)).toBeNull();
    });

    it('skips a newer expired invite in favour of an older working one', () => {
        // The exact bug: picking by created_at alone surfaced a dead link.
        const old = inv({ created_at: iso(-100_000) });
        const fresh = inv({ created_at: iso(-1_000), expires_at: iso(-1) });
        expect(newestUsableInvite([fresh, old], NOW)).toBe(old);
    });

    it('prefers the newest among several usable invites', () => {
        const older = inv({ created_at: iso(-100_000) });
        const newer = inv({ created_at: iso(-1_000) });
        expect(newestUsableInvite([older, newer], NOW)).toBe(newer);
    });
});
