import { describe, it, expect } from 'vitest';
import { Permissions } from '@cipherline/shared';
import {
    ROLE_SEARCH_THRESHOLD, shouldShowRoleSearch, filterRolesByQuery, hasManageRolesPermission,
    actorHighestPosition, canToggleRole, assignableRoles, canOfferRolePicker, withRole,
    type PickerRole,
} from './rolePickerModel';

const role = (id: string, position: number, extra: Partial<PickerRole> = {}): PickerRole =>
    ({ role_id: id, name: id, color: -1, position, is_everyone: false, ...extra });

const everyone = role('everyone', 0, { is_everyone: true, name: '@everyone' });
const admin = role('Admin', 30);
const mod = role('Moderator', 20);
const member = role('Member', 10);
const roles = [everyone, member, admin, mod];

describe('search threshold', () => {
    it('is 10 and appears only ABOVE it (boundary: 10 none, 11 shown)', () => {
        expect(ROLE_SEARCH_THRESHOLD).toBe(10);
        expect(shouldShowRoleSearch(0)).toBe(false);
        expect(shouldShowRoleSearch(9)).toBe(false);
        expect(shouldShowRoleSearch(10)).toBe(false);
        expect(shouldShowRoleSearch(11)).toBe(true);
        expect(shouldShowRoleSearch(200)).toBe(true);
    });
});

describe('filterRolesByQuery', () => {
    const list = [role('Moderator', 3), role('Mods Lead', 2), role('Member', 1), role('ÉLAN', 0)];
    it('blank / whitespace query returns everything, in order, as a copy', () => {
        const out = filterRolesByQuery(list, '   ');
        expect(out.map(r => r.name)).toEqual(['Moderator', 'Mods Lead', 'Member', 'ÉLAN']);
        expect(out).not.toBe(list);
    });
    it('case-insensitive substring, trimmed', () => {
        expect(filterRolesByQuery(list, '  MOD ').map(r => r.name)).toEqual(['Moderator', 'Mods Lead']);
        expect(filterRolesByQuery(list, 'ber').map(r => r.name)).toEqual(['Member']);
        expect(filterRolesByQuery(list, 'élan').map(r => r.name)).toEqual(['ÉLAN']);
    });
    it('no match → empty', () => {
        expect(filterRolesByQuery(list, 'zzz')).toEqual([]);
    });
});

describe('hasManageRolesPermission (mirror of requireServerPermission(MANAGE_ROLES))', () => {
    it('MANAGE_ROLES or ADMINISTRATOR, nothing else', () => {
        expect(hasManageRolesPermission(undefined)).toBe(false);
        expect(hasManageRolesPermission(0n)).toBe(false);
        expect(hasManageRolesPermission(Permissions.KICK_MEMBERS)).toBe(false);
        expect(hasManageRolesPermission(Permissions.MANAGE_ROLES)).toBe(true);
        expect(hasManageRolesPermission(Permissions.ADMINISTRATOR)).toBe(true);
    });
});

describe('actorHighestPosition (mirror of RolesService.highestPositionFor)', () => {
    const members = [
        { user_id: 'owner', role_ids: [] },
        { user_id: 'modUser', role_ids: [member.role_id, mod.role_id] },
        { user_id: 'plain', role_ids: [] },
    ];
    it('owner is +Infinity regardless of roles (case-insensitive id)', () => {
        expect(actorHighestPosition('OWNER', 'owner', members, roles)).toBe(Number.POSITIVE_INFINITY);
    });
    it('max position over assigned roles', () => {
        expect(actorHighestPosition('modUser', 'owner', members, roles)).toBe(20);
    });
    it('no roles / unknown member / no actor → -1', () => {
        expect(actorHighestPosition('plain', 'owner', members, roles)).toBe(-1);
        expect(actorHighestPosition('ghost', 'owner', members, roles)).toBe(-1);
        expect(actorHighestPosition(null, 'owner', members, roles)).toBe(-1);
    });
});

describe('canToggleRole / assignableRoles', () => {
    it('strictly below the actor; never @everyone', () => {
        expect(canToggleRole(mod, 20)).toBe(false);     // equal → refused (server: myHighest <= position)
        expect(canToggleRole(member, 20)).toBe(true);
        expect(canToggleRole(admin, 20)).toBe(false);
        expect(canToggleRole(everyone, Number.POSITIVE_INFINITY)).toBe(false);
    });
    it('lists toggleable roles highest-first and counts the hidden real roles', () => {
        expect(assignableRoles(roles, 20)).toEqual({ roles: [member], hiddenAbove: 2 });
        const all = assignableRoles(roles, Number.POSITIVE_INFINITY);
        expect(all.roles.map(r => r.role_id)).toEqual(['Admin', 'Moderator', 'Member']);
        expect(all.hiddenAbove).toBe(0);
        expect(assignableRoles(roles, -1)).toEqual({ roles: [], hiddenAbove: 3 });
    });
});

describe('canOfferRolePicker (decision table)', () => {
    const roster = {
        members: [{ user_id: 'me', role_ids: [mod.role_id] }, { user_id: 'low', role_ids: [member.role_id] }],
        roles,
    };
    const cases: Array<[string, Parameters<typeof canOfferRolePicker>[0], boolean]> = [
        ['no permission', { perms: 0n, actorUserId: 'me', ownerUserId: 'o', roster }, false],
        ['permission, roster unknown → offer (picker loads it)', { perms: Permissions.MANAGE_ROLES, actorUserId: 'me', ownerUserId: 'o', roster: null }, true],
        ['permission, a role below me', { perms: Permissions.MANAGE_ROLES, actorUserId: 'me', ownerUserId: 'o', roster }, true],
        ['permission, nothing below me', { perms: Permissions.MANAGE_ROLES, actorUserId: 'low', ownerUserId: 'o', roster }, false],
        ['administrator bit counts', { perms: Permissions.ADMINISTRATOR, actorUserId: 'me', ownerUserId: 'o', roster }, true],
        ['owner without a role still can', { perms: Permissions.ADMINISTRATOR, actorUserId: 'o', ownerUserId: 'o', roster }, true],
        ['only @everyone exists', { perms: Permissions.MANAGE_ROLES, actorUserId: 'o', ownerUserId: 'o', roster: { members: [], roles: [everyone] } }, false],
    ];
    it.each(cases)('%s', (_name, input, expected) => {
        expect(canOfferRolePicker(input)).toBe(expected);
    });
});

describe('withRole', () => {
    it('adds once, removes, keeps order, never mutates', () => {
        const ids = ['a', 'b'];
        expect(withRole(ids, 'c', true)).toEqual(['a', 'b', 'c']);
        expect(withRole(ids, 'a', true)).toEqual(['a', 'b']);
        expect(withRole(ids, 'a', false)).toEqual(['b']);
        expect(withRole(ids, 'z', false)).toEqual(['a', 'b']);
        expect(ids).toEqual(['a', 'b']);
    });
});
