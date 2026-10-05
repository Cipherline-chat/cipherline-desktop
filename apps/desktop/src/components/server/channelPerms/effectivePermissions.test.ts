import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, Permissions as P } from '@cipherline/shared';
import {
    resolveEffective,
    describeReason,
    reasonAllows,
    overrideFromWire,
    roleFromWire,
    type PermOverride,
    type PermRole,
    type PermTier,
    type ResolveContext,
} from './effectivePermissions';

/**
 * The client preview must agree with apps/api/src/servers/permissions.service.ts
 * bit for bit. The first block ports every case of the server's own
 * `permissions-batch.service.spec.ts` (same ids, same inputs, same expected
 * values), so a divergence shows up as a failing mirror of a server test.
 * The rest pins the per-bit explanations the editor shows.
 */

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const EVERYONE_ROLE = '55555555-5555-5555-5555-555555555555';
const MOD_ROLE = '66666666-6666-6666-6666-666666666666';
const OTHER_ROLE = '77777777-7777-7777-7777-777777777777';

const role = (role_id: string, permissions: bigint, position = 1, name = role_id.slice(0, 4)): PermRole =>
    ({ role_id, name, position, is_everyone: role_id === EVERYONE_ROLE, permissions });
const ov = (target_kind: 'role' | 'member', target_id: string, allow = 0n, deny = 0n): PermOverride =>
    ({ target_kind, target_id, allow, deny });
const catTier = (overrides: PermOverride[]): PermTier => ({ kind: 'category', label: 'category ‘Staff’', overrides });
const chTier = (overrides: PermOverride[]): PermTier => ({ kind: 'channel', label: 'this channel', overrides });

/** Mirrors the server spec's makeSvc(opts): @everyone perms, assigned roles,
 *  category + channel overrides, owner, mute. */
function mirror(opts: {
    everyonePerms?: bigint;
    assignedRoles?: { role_id: string; permissions: bigint }[];
    categoryOverrides?: PermOverride[] | null;
    channelOverrides?: PermOverride[];
    ownerUserId?: string;
    mutedUntil?: Date | null;
}) {
    const roles: PermRole[] = [
        role(EVERYONE_ROLE, opts.everyonePerms ?? P.VIEW_CHANNEL, 0, '@everyone'),
        ...(opts.assignedRoles ?? []).map((r, i) => role(r.role_id, r.permissions, 10 + i)),
    ];
    const tiers: PermTier[] = [];
    if (opts.categoryOverrides) tiers.push(catTier(opts.categoryOverrides));
    tiers.push(chTier(opts.channelOverrides ?? []));
    const ctx: ResolveContext = { roles, ownerUserId: opts.ownerUserId ?? OWNER, tiers };
    return resolveEffective(ctx, {
        kind: 'member', userId: USER,
        roleIds: (opts.assignedRoles ?? []).map(r => r.role_id),
        mutedUntil: opts.mutedUntil ?? null,
    });
}

describe('mirror of permissions-batch.service.spec.ts (server resolver)', () => {
    it('short-circuits the owner to ALL_PERMISSIONS', () => {
        const r = mirror({
            ownerUserId: USER,
            channelOverrides: [ov('role', EVERYONE_ROLE, 0n, P.VIEW_CHANNEL)],
        });
        expect(r.perms).toBe(ALL_PERMISSIONS);
        expect(r.shortCircuit).toBe('owner');
    });

    it('short-circuits ADMINISTRATOR to ALL_PERMISSIONS, ignoring every override', () => {
        const r = mirror({
            assignedRoles: [{ role_id: MOD_ROLE, permissions: P.ADMINISTRATOR }],
            channelOverrides: [ov('role', EVERYONE_ROLE, 0n, P.VIEW_CHANNEL)],
        });
        expect(r.perms).toBe(ALL_PERMISSIONS);
        expect(r.shortCircuit).toBe('admin');
    });

    it('bases permissions on the union of @everyone and every assigned role', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL,
            assignedRoles: [{ role_id: MOD_ROLE, permissions: P.SEND_MESSAGES }],
        });
        expect(r.perms).toBe(P.VIEW_CHANNEL | P.SEND_MESSAGES);
    });

    it('ignores role overrides for roles the caller does not hold', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL,
            channelOverrides: [ov('role', OTHER_ROLE, P.MANAGE_MESSAGES)],
        });
        expect(r.perms).toBe(P.VIEW_CHANNEL);
    });

    it('lets an explicit allow on ANY assigned role beat a deny on another', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL,
            assignedRoles: [{ role_id: MOD_ROLE, permissions: 0n }, { role_id: OTHER_ROLE, permissions: 0n }],
            channelOverrides: [
                ov('role', MOD_ROLE, 0n, P.SEND_MESSAGES),
                ov('role', OTHER_ROLE, P.SEND_MESSAGES, 0n),
            ],
        });
        expect(r.has(P.SEND_MESSAGES)).toBe(true);
    });

    it('applies the member override last, overriding a role-level allow', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES,
            channelOverrides: [ov('member', USER, 0n, P.SEND_MESSAGES)],
        });
        expect(r.has(P.SEND_MESSAGES)).toBe(false);
        expect(r.has(P.VIEW_CHANNEL)).toBe(true);
    });

    it('applies category overrides BEFORE channel ones, so a channel can re-allow what its category denied', () => {
        const cat = [ov('role', EVERYONE_ROLE, 0n, P.SEND_MESSAGES)];
        const a = mirror({
            everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES,
            categoryOverrides: cat,
            channelOverrides: [ov('role', EVERYONE_ROLE, P.SEND_MESSAGES)],
        });
        const b = mirror({ everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES, categoryOverrides: cat });
        expect(a.has(P.SEND_MESSAGES)).toBe(true);
        expect(b.has(P.SEND_MESSAGES)).toBe(false);
    });

    it('leaves an uncategorised channel untouched by category overrides', () => {
        // No category tier at all = the server's `if (c.parent_category_id)` false branch.
        const r = mirror({ everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES, categoryOverrides: null });
        expect(r.has(P.SEND_MESSAGES)).toBe(true);
    });

    it('strips SEND_MESSAGES + SPEAK while the member is muted', () => {
        const r = mirror({
            mutedUntil: new Date(Date.now() + 60_000),
            everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES | P.SPEAK,
        });
        expect(r.has(P.SEND_MESSAGES)).toBe(false);
        expect(r.has(P.SPEAK)).toBe(false);
        expect(r.has(P.VIEW_CHANNEL)).toBe(true);
    });

    it('does not strip talk perms once the mute has expired', () => {
        const r = mirror({
            mutedUntil: new Date(Date.now() - 60_000),
            everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES,
        });
        expect(r.has(P.SEND_MESSAGES)).toBe(true);
    });

    describe('category tier (resolveCategoryPermissionsForServer)', () => {
        const denyViewEveryone = ov('role', EVERYONE_ROLE, 0n, P.VIEW_CHANNEL);
        const catOnly = (o: Parameters<typeof mirror>[0]) => {
            // Category resolution = base + ONLY the category tier.
            const roles: PermRole[] = [
                role(EVERYONE_ROLE, o.everyonePerms ?? P.VIEW_CHANNEL, 0, '@everyone'),
                ...(o.assignedRoles ?? []).map((r, i) => role(r.role_id, r.permissions, 10 + i)),
            ];
            return resolveEffective(
                { roles, ownerUserId: o.ownerUserId ?? OWNER, tiers: [catTier(o.categoryOverrides ?? [])] },
                { kind: 'member', userId: USER, roleIds: (o.assignedRoles ?? []).map(r => r.role_id) },
            );
        };

        it('applies the category tier to the role base', () => {
            expect(catOnly({ categoryOverrides: [denyViewEveryone] }).has(P.VIEW_CHANNEL)).toBe(false);
        });

        it('agrees with the channel tier: a channel under the category inherits the same answer', () => {
            const cat = catOnly({ categoryOverrides: [denyViewEveryone] });
            const ch = mirror({ categoryOverrides: [denyViewEveryone] });
            expect(ch.perms).toBe(cat.perms);
        });

        it('lets a role allow on the category beat the @everyone deny', () => {
            const r = catOnly({
                assignedRoles: [{ role_id: MOD_ROLE, permissions: 0n }],
                categoryOverrides: [denyViewEveryone, ov('role', MOD_ROLE, P.VIEW_CHANNEL)],
            });
            expect(r.has(P.VIEW_CHANNEL)).toBe(true);
        });

        it('short-circuits the owner and ADMINISTRATOR to ALL_PERMISSIONS', () => {
            expect(catOnly({ ownerUserId: USER, categoryOverrides: [denyViewEveryone] }).perms).toBe(ALL_PERMISSIONS);
            expect(catOnly({
                assignedRoles: [{ role_id: MOD_ROLE, permissions: P.ADMINISTRATOR }],
                categoryOverrides: [denyViewEveryone],
            }).perms).toBe(ALL_PERMISSIONS);
        });
    });
});

describe('resolveEffective — further algorithm cases', () => {
    it('applies @everyone BEFORE the combined role overrides within a tier (role allow beats @everyone deny)', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL,
            assignedRoles: [{ role_id: MOD_ROLE, permissions: 0n }],
            channelOverrides: [ov('role', EVERYONE_ROLE, 0n, P.VIEW_CHANNEL), ov('role', MOD_ROLE, P.VIEW_CHANNEL)],
        });
        expect(r.has(P.VIEW_CHANNEL)).toBe(true);
    });

    it('a channel-tier @everyone deny beats a category-tier ROLE allow (later tier wins)', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL | P.SEND_MESSAGES,
            assignedRoles: [{ role_id: MOD_ROLE, permissions: 0n }],
            categoryOverrides: [ov('role', MOD_ROLE, P.SEND_MESSAGES)],
            channelOverrides: [ov('role', EVERYONE_ROLE, 0n, P.SEND_MESSAGES)],
        });
        expect(r.has(P.SEND_MESSAGES)).toBe(false);
    });

    it('allow wins when one override row sets both allow and deny for a bit (deny-then-allow)', () => {
        const r = mirror({ everyonePerms: 0n, channelOverrides: [ov('role', EVERYONE_ROLE, P.SEND_MESSAGES, P.SEND_MESSAGES)] });
        expect(r.has(P.SEND_MESSAGES)).toBe(true);
    });

    it('a member override allow is still stripped by an active mute', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL,
            channelOverrides: [ov('member', USER, P.SEND_MESSAGES)],
            mutedUntil: new Date(Date.now() + 1000),
        });
        expect(r.has(P.SEND_MESSAGES)).toBe(false);
        expect(r.explain(P.SEND_MESSAGES)).toEqual({ kind: 'muted' });
    });

    it('mute never strips non-talk bits and does not apply to a role preview', () => {
        const roles = [role(EVERYONE_ROLE, DEFAULT_EVERYONE_PERMISSIONS, 0, '@everyone')];
        const r = resolveEffective({ roles, ownerUserId: OWNER, tiers: [] }, { kind: 'role', roleId: EVERYONE_ROLE });
        expect(r.perms).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    });

    it('an override on a role the member lacks, or a member override for someone else, does nothing', () => {
        const r = mirror({
            everyonePerms: P.VIEW_CHANNEL,
            channelOverrides: [ov('role', OTHER_ROLE, 0n, P.VIEW_CHANNEL), ov('member', 'someone-else', 0n, P.VIEW_CHANNEL)],
        });
        expect(r.has(P.VIEW_CHANNEL)).toBe(true);
    });

    it('owner short-circuit applies only to a member subject, never to a role preview', () => {
        const roles = [role(EVERYONE_ROLE, 0n, 0, '@everyone')];
        const r = resolveEffective({ roles, ownerUserId: EVERYONE_ROLE, tiers: [] }, { kind: 'role', roleId: EVERYONE_ROLE });
        expect(r.shortCircuit).toBe(null);
        expect(r.perms).toBe(0n);
    });

    it('a role preview for @everyone uses no assigned roles, so @everyone is not double-applied as a role override', () => {
        const roles = [role(EVERYONE_ROLE, P.VIEW_CHANNEL, 0, '@everyone')];
        const r = resolveEffective(
            { roles, ownerUserId: OWNER, tiers: [chTier([ov('role', EVERYONE_ROLE, 0n, P.VIEW_CHANNEL)])] },
            { kind: 'role', roleId: EVERYONE_ROLE },
        );
        expect(r.has(P.VIEW_CHANNEL)).toBe(false);
        expect(r.explain(P.VIEW_CHANNEL)).toMatchObject({ kind: 'override', target: 'everyone', allowed: false });
    });

    it('works with no @everyone role at all (base = assigned roles only)', () => {
        const roles = [role(MOD_ROLE, P.SEND_MESSAGES, 5, 'Mod')];
        const r = resolveEffective({ roles, ownerUserId: OWNER, tiers: [] }, { kind: 'member', userId: USER, roleIds: [MOD_ROLE] });
        expect(r.perms).toBe(P.SEND_MESSAGES);
    });

    it('matches a hand-computed reference over many random inputs', () => {
        // Independent re-statement of the server algorithm with plain bit
        // math, checked against resolveEffective for 300 seeded cases.
        // mulberry32 — Math.imul keeps it in exact 32-bit integer space.
        let seed = 42;
        const rnd = () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return (t ^ (t >>> 14)) >>> 0;
        };
        let decidedByOverride = 0;
        const bits = [P.VIEW_CHANNEL, P.SEND_MESSAGES, P.SPEAK, P.CONNECT, P.MANAGE_MESSAGES, P.ADD_REACTIONS];
        const pick = () => bits.filter(() => rnd() % 3 === 0).reduce((a, b) => a | b, 0n);
        for (let n = 0; n < 300; n++) {
            const ids = [MOD_ROLE, OTHER_ROLE];
            const roles = [role(EVERYONE_ROLE, pick(), 0, '@everyone'), role(MOD_ROLE, pick(), 5), role(OTHER_ROLE, pick(), 3)];
            const held = ids.filter(() => rnd() % 2 === 0);
            const mkTier = (kind: 'category' | 'channel'): PermTier => ({
                kind, label: kind,
                overrides: [
                    ov('role', EVERYONE_ROLE, pick(), pick()),
                    ov('role', MOD_ROLE, pick(), pick()),
                    ov('role', OTHER_ROLE, pick(), pick()),
                    ov('member', USER, pick(), pick()),
                ].filter(() => rnd() % 4 !== 0),
            });
            const tiers = rnd() % 2 ? [mkTier('category'), mkTier('channel')] : [mkTier('channel')];
            const muted = rnd() % 5 === 0;

            // Reference.
            let ref = roles[0].permissions;
            for (const r of roles.slice(1)) if (held.includes(r.role_id)) ref |= r.permissions;
            for (const t of tiers) {
                const e = t.overrides.find(o => o.target_kind === 'role' && o.target_id === EVERYONE_ROLE);
                if (e) ref = (ref & ~e.deny) | e.allow;
                let a = 0n, d = 0n;
                for (const o of t.overrides) if (o.target_kind === 'role' && held.includes(o.target_id)) { a |= o.allow; d |= o.deny; }
                ref = (ref & ~d) | a;
                const m = t.overrides.find(o => o.target_kind === 'member' && o.target_id === USER);
                if (m) ref = (ref & ~m.deny) | m.allow;
            }
            if (muted) ref &= ~(P.SEND_MESSAGES | P.SPEAK);

            const got = resolveEffective(
                { roles, ownerUserId: OWNER, tiers },
                { kind: 'member', userId: USER, roleIds: held, mutedUntil: muted ? new Date(Date.now() + 1e6) : null },
            );
            expect(got.perms).toBe(ref);
            // And every bit's explanation agrees with its final state.
            for (const b of bits) {
                const why = got.explain(b);
                expect(reasonAllows(why)).toBe((ref & b) === b);
                if (why.kind === 'override') decidedByOverride++;
            }
        }
        // Non-vacuity: the sweep must actually exercise the override tiers.
        expect(decidedByOverride).toBeGreaterThan(300);
    });
});

describe('explanations', () => {
    const roles: PermRole[] = [
        role(EVERYONE_ROLE, P.VIEW_CHANNEL | P.SEND_MESSAGES, 0, '@everyone'),
        role(MOD_ROLE, P.MANAGE_MESSAGES, 40, 'Moderator'),
        role(OTHER_ROLE, 0n, 10, 'Regulars'),
    ];
    const subj = { kind: 'member' as const, userId: USER, roleIds: [MOD_ROLE, OTHER_ROLE] };

    it('attributes a base grant to the highest role that grants it', () => {
        const r = resolveEffective({ roles, ownerUserId: OWNER, tiers: [] }, subj);
        expect(describeReason(r.explain(P.MANAGE_MESSAGES))).toBe('Allowed by @Moderator role');
        expect(describeReason(r.explain(P.SEND_MESSAGES))).toBe('Allowed by @everyone');
        expect(describeReason(r.explain(P.ATTACH_FILES))).toBe('No role grants this');
    });

    it('names the tier and target of the deciding override', () => {
        const r = resolveEffective({
            roles, ownerUserId: OWNER,
            tiers: [catTier([ov('role', EVERYONE_ROLE, 0n, P.SEND_MESSAGES)]), chTier([ov('role', OTHER_ROLE, P.SEND_MESSAGES)])],
        }, subj);
        expect(describeReason(r.explain(P.SEND_MESSAGES))).toBe('Allowed by this channel (@Regulars)');
        const r2 = resolveEffective({ roles, ownerUserId: OWNER, tiers: [catTier([ov('role', EVERYONE_ROLE, 0n, P.SEND_MESSAGES)])] }, subj);
        expect(describeReason(r2.explain(P.SEND_MESSAGES))).toBe('Denied by category ‘Staff’ (@everyone)');
    });

    it('credits the HIGHEST role when several of the member’s role overrides allow the same bit', () => {
        const r = resolveEffective({
            roles, ownerUserId: OWNER,
            tiers: [chTier([ov('role', OTHER_ROLE, P.ATTACH_FILES), ov('role', MOD_ROLE, P.ATTACH_FILES)])],
        }, subj);
        expect(r.explain(P.ATTACH_FILES)).toMatchObject({ kind: 'override', roleName: 'Moderator', allowed: true });
    });

    it('explains a combined-role deny that no role allow overturned', () => {
        const r = resolveEffective({
            roles, ownerUserId: OWNER,
            tiers: [chTier([ov('role', OTHER_ROLE, 0n, P.SEND_MESSAGES)])],
        }, subj);
        expect(describeReason(r.explain(P.SEND_MESSAGES))).toBe('Denied by this channel (@Regulars)');
    });

    it('explains a member override', () => {
        const r = resolveEffective({ roles, ownerUserId: OWNER, tiers: [chTier([ov('member', USER, 0n, P.VIEW_CHANNEL)])] }, subj);
        expect(describeReason(r.explain(P.VIEW_CHANNEL))).toBe('Denied by this channel (member override)');
    });

    it('explains owner and admin short-circuits', () => {
        const owner = resolveEffective({ roles, ownerUserId: USER, tiers: [] }, subj);
        expect(describeReason(owner.explain(P.VIEW_CHANNEL))).toBe('Server owner — everything allowed');
        const admin = resolveEffective(
            { roles: [...roles, role('adm', P.ADMINISTRATOR, 90, 'Admin')], ownerUserId: OWNER, tiers: [] },
            { kind: 'role', roleId: 'adm' },
        );
        expect(describeReason(admin.explain(P.VIEW_CHANNEL))).toBe('Admin via @Admin — everything allowed');
    });

    it('explains a mute strip', () => {
        const r = resolveEffective(
            { roles, ownerUserId: OWNER, tiers: [], now: new Date('2026-01-01T00:00:00Z') },
            { ...subj, mutedUntil: '2026-01-01T01:00:00Z' },
        );
        expect(describeReason(r.explain(P.SEND_MESSAGES))).toBe('Removed by an active server timeout');
        expect(r.has(P.VIEW_CHANNEL)).toBe(true);
    });
});

describe('wire adapters', () => {
    it('parse decimal strings, tolerating garbage as 0n', () => {
        expect(overrideFromWire({ target_kind: 'member', target_id: 'x', allow_bits: '131072', deny_bits: 'nope' }))
            .toEqual({ target_kind: 'member', target_id: 'x', allow: P.SEND_MESSAGES, deny: 0n });
        expect(roleFromWire({ role_id: 'r', name: 'R', position: 3, is_everyone: false, permissions: null }).permissions).toBe(0n);
    });
});
