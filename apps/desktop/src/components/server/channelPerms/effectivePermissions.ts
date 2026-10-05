/**
 * Client-side PREVIEW of the server's channel permission resolver, with a
 * per-bit "why".
 *
 * The authority is `apps/api/src/servers/permissions.service.ts`. This file
 * mirrors its algorithm step for step so the channel/category editors can say
 * what a role or member will actually end up with — and which rule decided it
 * — BEFORE anything is saved. It is never used to grant or hide anything; the
 * server re-resolves every request on its own.
 *
 * Resolution order (identical to `resolveChannelPermissions`,
 * `resolveChannelPermissionsForServer` and `resolveCategoryPermissionsForServer`):
 *
 *   1. Server owner                    → every permission, stop.
 *   2. base = @everyone role | every assigned role (plain OR).
 *   3. base has ADMINISTRATOR          → every permission, stop. Overrides
 *                                         never apply to admins.
 *   4. For each override TIER, in order — category (if the channel has a
 *      parent), then channel:
 *        a. the @everyone override            (deny, then allow)
 *        b. the UNION of the subject's other role overrides — all allows OR'd,
 *           all denies OR'd, applied once as deny-then-allow, so an allow on
 *           ANY of their roles beats a deny on another
 *        c. the subject's own member override (deny, then allow)
 *   5. Server mute (timeout) active     → strip SEND_MESSAGES and SPEAK.
 *
 * Every operation is bitwise, so each bit resolves independently — which is
 * what makes a per-bit explanation exact rather than approximate.
 */

import {
    ALL_PERMISSIONS,
    Permissions,
    applyOverride,
    isAdministrator,
} from '@cipherline/shared';

/** Mirror of the server's `MUTE_STRIPPED_PERMISSIONS`. */
export const MUTE_STRIPPED_PERMISSIONS = Permissions.SEND_MESSAGES | Permissions.SPEAK;

export interface PermRole {
    role_id: string;
    name: string;
    position: number;
    is_everyone: boolean;
    /** The role's own server-wide bitfield. */
    permissions: bigint;
}

export interface PermOverride {
    target_kind: 'role' | 'member';
    target_id: string;
    allow: bigint;
    deny: bigint;
}

export interface PermTier {
    kind: 'category' | 'channel';
    /** Human label used in explanations, e.g. "category ‘Staff’" or "this channel". */
    label: string;
    overrides: readonly PermOverride[];
}

export type PermSubject =
    /** A real member: their roles, their own member overrides, their mute. */
    | { kind: 'member'; userId: string; roleIds: readonly string[]; mutedUntil?: string | Date | null }
    /** "Someone who holds only this role" (plus @everyone, which everyone holds).
     *  Selecting @everyone itself means a member with no roles at all. */
    | { kind: 'role'; roleId: string };

export interface ResolveContext {
    roles: readonly PermRole[];
    ownerUserId: string | null | undefined;
    /** Category tier first (when there is one), then the channel tier. */
    tiers: readonly PermTier[];
    /** Injectable clock for the mute check. */
    now?: Date;
}

export type PermReason =
    | { kind: 'owner' }
    | { kind: 'admin'; roleName: string }
    /** Decided by the role base (no override touched this bit). */
    | { kind: 'base'; allowed: boolean; roleName: string | null }
    | {
        kind: 'override';
        allowed: boolean;
        tierKind: 'category' | 'channel';
        tierLabel: string;
        target: 'everyone' | 'role' | 'member';
        /** The deciding role for target 'role' / 'everyone'. */
        roleName?: string;
    }
    | { kind: 'muted' };

export interface Resolution {
    perms: bigint;
    shortCircuit: 'owner' | 'admin' | null;
    has: (bit: bigint) => boolean;
    /** Why `bit` ended up where it did. `bit` must be a single permission bit. */
    explain: (bit: bigint) => PermReason;
}

interface Step {
    allow: bigint;
    deny: bigint;
    /** Reason recorded when this step turns the bit ON (allow) / OFF (deny). */
    allowReason: (bit: bigint) => PermReason;
    denyReason: (bit: bigint) => PermReason;
}

const toDate = (v: string | Date | null | undefined): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** Highest-positioned role among `roles` whose `pick(role)` is truthy. */
const highest = <T extends { position: number }>(items: readonly T[], pick: (t: T) => boolean): T | undefined => {
    let best: T | undefined;
    for (const it of items) if (pick(it) && (!best || it.position > best.position)) best = it;
    return best;
};

export function resolveEffective(ctx: ResolveContext, subject: PermSubject): Resolution {
    const rolesById = new Map(ctx.roles.map(r => [r.role_id, r]));
    const everyone = ctx.roles.find(r => r.is_everyone);
    const everyoneId = everyone?.role_id;

    // 1. Owner short-circuit — only a real member can be the owner.
    if (subject.kind === 'member' && ctx.ownerUserId && subject.userId === ctx.ownerUserId) {
        return shortCircuit('owner', { kind: 'owner' });
    }

    const assignedIds: string[] = subject.kind === 'member'
        ? [...subject.roleIds]
        : (subject.roleId === everyoneId ? [] : [subject.roleId]);
    const assignedSet = new Set(assignedIds);
    const assignedRoles = assignedIds.map(id => rolesById.get(id)).filter((r): r is PermRole => !!r);

    // 2. Base = @everyone | assigned roles.
    const baseSources: PermRole[] = everyone ? [everyone, ...assignedRoles] : assignedRoles;
    let perms = 0n;
    for (const r of baseSources) perms |= r.permissions;

    // 3. ADMINISTRATOR short-circuit.
    if (isAdministrator(perms)) {
        const adminRole = highest(baseSources, r => isAdministrator(r.permissions));
        return shortCircuit('admin', { kind: 'admin', roleName: adminRole?.name ?? 'a role' });
    }

    const base = perms;
    const steps: Step[] = [];

    // 4. Override tiers.
    for (const tier of ctx.tiers) {
        const tierBits = { tierKind: tier.kind, tierLabel: tier.label };

        // 4a — @everyone.
        const ev = everyoneId
            ? tier.overrides.find(o => o.target_kind === 'role' && o.target_id === everyoneId)
            : undefined;
        if (ev) {
            const roleName = everyone?.name;
            steps.push({
                allow: ev.allow, deny: ev.deny,
                allowReason: () => ({ kind: 'override', allowed: true, target: 'everyone', roleName, ...tierBits }),
                denyReason: () => ({ kind: 'override', allowed: false, target: 'everyone', roleName, ...tierBits }),
            });
        }

        // 4b — union of the subject's other role overrides.
        const roleOvs = tier.overrides.filter(o =>
            o.target_kind === 'role' && o.target_id !== everyoneId && assignedSet.has(o.target_id));
        let allow = 0n;
        let deny = 0n;
        for (const o of roleOvs) { allow |= o.allow; deny |= o.deny; }
        if (allow !== 0n || deny !== 0n) {
            const decider = (bit: bigint, side: 'allow' | 'deny') => {
                const ranked = roleOvs.map(o => ({ o, position: rolesById.get(o.target_id)?.position ?? -1 }));
                const hit = highest(ranked, x => (x.o[side] & bit) === bit);
                return hit ? rolesById.get(hit.o.target_id)?.name : undefined;
            };
            steps.push({
                allow, deny,
                allowReason: bit => ({ kind: 'override', allowed: true, target: 'role', roleName: decider(bit, 'allow'), ...tierBits }),
                denyReason: bit => ({ kind: 'override', allowed: false, target: 'role', roleName: decider(bit, 'deny'), ...tierBits }),
            });
        }

        // 4c — the member's own override.
        if (subject.kind === 'member') {
            const mo = tier.overrides.find(o => o.target_kind === 'member' && o.target_id === subject.userId);
            if (mo) {
                steps.push({
                    allow: mo.allow, deny: mo.deny,
                    allowReason: () => ({ kind: 'override', allowed: true, target: 'member', ...tierBits }),
                    denyReason: () => ({ kind: 'override', allowed: false, target: 'member', ...tierBits }),
                });
            }
        }
    }

    for (const s of steps) perms = applyOverride(perms, s.allow, s.deny);

    // 5. Mute strip.
    const mutedUntil = subject.kind === 'member' ? toDate(subject.mutedUntil) : null;
    const muted = !!mutedUntil && mutedUntil > (ctx.now ?? new Date());
    if (muted) perms &= ~MUTE_STRIPPED_PERMISSIONS;

    const explain = (bit: bigint): PermReason => {
        let on = (base & bit) === bit;
        let reason: PermReason = on
            ? { kind: 'base', allowed: true, roleName: highest(baseSources, r => (r.permissions & bit) === bit)?.name ?? null }
            : { kind: 'base', allowed: false, roleName: null };
        for (const s of steps) {
            // applyOverride is (p & ~deny) | allow: deny first, allow wins.
            if ((s.deny & bit) === bit) { on = false; reason = s.denyReason(bit); }
            if ((s.allow & bit) === bit) { on = true; reason = s.allowReason(bit); }
        }
        if (on && muted && (MUTE_STRIPPED_PERMISSIONS & bit) === bit) reason = { kind: 'muted' };
        return reason;
    };

    return {
        perms,
        shortCircuit: null,
        has: bit => (perms & bit) === bit,
        explain,
    };
}

function shortCircuit(kind: 'owner' | 'admin', reason: PermReason): Resolution {
    return {
        perms: ALL_PERMISSIONS,
        shortCircuit: kind,
        has: () => true,
        explain: () => reason,
    };
}

/** Is the reason's end state "allowed"? */
export const reasonAllows = (r: PermReason): boolean => {
    switch (r.kind) {
        case 'owner':
        case 'admin': return true;
        case 'muted': return false;
        default: return r.allowed;
    }
};

/** "@Moderator" for a role name, "@everyone" as-is. */
export const mention = (roleName: string): string =>
    roleName.startsWith('@') ? roleName : `@${roleName}`;

/**
 * One short plain-language line for a reason, e.g.
 *   "Allowed by @Moderator role"
 *   "Denied by category ‘Staff’ (@everyone)"
 *   "Admin — everything allowed"
 */
export function describeReason(r: PermReason): string {
    switch (r.kind) {
        case 'owner': return 'Server owner — everything allowed';
        case 'admin': return `Admin via ${mention(r.roleName)} — everything allowed`;
        case 'muted': return 'Removed by an active server timeout';
        case 'base':
            if (!r.allowed) return 'No role grants this';
            return r.roleName
                ? `Allowed by ${mention(r.roleName)}${r.roleName.startsWith('@') ? '' : ' role'}`
                : 'Allowed by role';
        case 'override': {
            const verb = r.allowed ? 'Allowed' : 'Denied';
            const who = r.target === 'member'
                ? 'member override'
                : (r.roleName ? mention(r.roleName) : 'a role');
            return `${verb} by ${r.tierLabel} (${who})`;
        }
    }
}

// ── Adapters from wire shapes ───────────────────────────────────────────────

const parseBits = (s: string | null | undefined): bigint => {
    if (!s) return 0n;
    try { return BigInt(s); } catch { return 0n; }
};

/** API override row → PermOverride. */
export const overrideFromWire = (o: {
    target_kind: string; target_id: string; allow_bits?: string | null; deny_bits?: string | null;
}): PermOverride => ({
    target_kind: o.target_kind === 'member' ? 'member' : 'role',
    target_id: o.target_id,
    allow: parseBits(o.allow_bits),
    deny: parseBits(o.deny_bits),
});

/** API role row → PermRole. */
export const roleFromWire = (r: {
    role_id: string; name: string; position: number; is_everyone: boolean; permissions?: string | null;
}): PermRole => ({
    role_id: r.role_id,
    name: r.name,
    position: r.position,
    is_everyone: r.is_everyone,
    permissions: parseBits(r.permissions),
});
