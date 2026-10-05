import { describe, it, expect } from 'vitest';
import { DEFAULT_EVERYONE_PERMISSIONS, Permissions as P } from '@cipherline/shared';
import { buildPreset, detectPreset, staffRoleIds } from './channelPresets';
import { resolveEffective, type PermRole } from './effectivePermissions';
import { channelPermissionMask } from '../roles/permissions';
import { memberKey, roleKey } from './overrideDraft';

const roles: PermRole[] = [
    { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, permissions: DEFAULT_EVERYONE_PERMISSIONS },
    { role_id: 'admin', name: 'Admin', position: 50, is_everyone: false, permissions: P.ADMINISTRATOR },
    { role_id: 'mod', name: 'Moderator', position: 40, is_everyone: false, permissions: P.MANAGE_MESSAGES | P.KICK_MEMBERS },
    { role_id: 'helper', name: 'Helper', position: 30, is_everyone: false, permissions: P.MUTE_MEMBERS },
    { role_id: 'reg', name: 'Regulars', position: 10, is_everyone: false, permissions: 0n },
];
const textMask = channelPermissionMask('text');
const callMask = channelPermissionMask('huddle');
const staff = staffRoleIds(roles);
const can = (draft: ReturnType<typeof buildPreset>, roleId: string, bit: bigint) =>
    resolveEffective(
        { roles, ownerUserId: 'owner', tiers: [{ kind: 'channel', label: 'x', overrides: Object.entries(draft).map(([k, b]) => ({
            target_kind: k.startsWith('member:') ? 'member' as const : 'role' as const,
            target_id: k.slice(k.indexOf(':') + 1), allow: b.allow, deny: b.deny,
        })) }] },
        { kind: 'role', roleId },
    ).has(bit);

describe('staffRoleIds', () => {
    it('picks moderation roles in hierarchy order and skips admins and @everyone', () => {
        expect(staff).toEqual(['mod', 'helper']);
    });
});

describe('presets produce the access they promise (checked through the resolver)', () => {
    it('public: no overrides', () => {
        expect(buildPreset('public', { kind: 'text', everyoneRoleId: 'ev', roleIds: [] })).toEqual({});
    });

    it('public inside a category that hides itself from @everyone re-allows View', () => {
        const d = buildPreset('public', { kind: 'text', everyoneRoleId: 'ev', roleIds: [], everyoneViewInheritedDenied: true });
        expect(d).toEqual({ [roleKey('ev')]: { allow: P.VIEW_CHANNEL, deny: 0n } });
    });

    it('staff only: @everyone cannot see, staff can, admins still can', () => {
        const d = buildPreset('staff', { kind: 'text', everyoneRoleId: 'ev', roleIds: staff });
        expect(can(d, 'ev', P.VIEW_CHANNEL)).toBe(false);
        expect(can(d, 'reg', P.VIEW_CHANNEL)).toBe(false);
        expect(can(d, 'mod', P.VIEW_CHANNEL)).toBe(true);
        expect(can(d, 'helper', P.VIEW_CHANNEL)).toBe(true);
        expect(can(d, 'admin', P.VIEW_CHANNEL)).toBe(true);
    });

    it('private with picked roles + members grants exactly those', () => {
        const d = buildPreset('private', { kind: 'huddle', everyoneRoleId: 'ev', roleIds: ['reg'], memberIds: ['u9'] });
        expect(d[memberKey('u9')]).toEqual({ allow: P.VIEW_CHANNEL, deny: 0n });
        expect(can(d, 'reg', P.VIEW_CHANNEL)).toBe(true);
        expect(can(d, 'mod', P.VIEW_CHANNEL)).toBe(false);
        // @everyone in the role list is ignored, never granted its own access back.
        const d2 = buildPreset('private', { kind: 'text', everyoneRoleId: 'ev', roleIds: ['ev', 'reg'] });
        expect(d2[roleKey('ev')]).toEqual({ allow: 0n, deny: P.VIEW_CHANNEL });
    });

    it('read-only text: everyone reads but cannot post; staff can post', () => {
        const d = buildPreset('readonly', { kind: 'text', everyoneRoleId: 'ev', roleIds: staff });
        expect(can(d, 'reg', P.VIEW_CHANNEL)).toBe(true);
        expect(can(d, 'reg', P.SEND_MESSAGES)).toBe(false);
        expect(can(d, 'reg', P.ADD_REACTIONS)).toBe(true);
        expect(can(d, 'mod', P.SEND_MESSAGES)).toBe(true);
    });

    it('listen-only Calls: everyone can join but not talk, show video or share', () => {
        const d = buildPreset('readonly', { kind: 'huddle', everyoneRoleId: 'ev', roleIds: staff });
        expect(can(d, 'reg', P.CONNECT)).toBe(true);
        for (const b of [P.SPEAK, P.VIDEO, P.SCREEN_SHARE]) {
            expect(can(d, 'reg', b)).toBe(false);
            expect(can(d, 'mod', b)).toBe(true);
        }
    });
});

describe('detectPreset', () => {
    const ctx = { kind: 'text' as const, everyoneRoleId: 'ev', staffIds: staff, mask: textMask };

    it('round-trips every preset it builds', () => {
        expect(detectPreset(buildPreset('public', { kind: 'text', everyoneRoleId: 'ev', roleIds: [] }), ctx).id).toBe('public');
        expect(detectPreset(buildPreset('staff', { kind: 'text', everyoneRoleId: 'ev', roleIds: staff }), ctx).id).toBe('staff');
        expect(detectPreset(buildPreset('private', { kind: 'text', everyoneRoleId: 'ev', roleIds: ['reg'] }), ctx))
            .toEqual({ id: 'private', roleIds: ['reg'], memberIds: [] });
        expect(detectPreset(buildPreset('readonly', { kind: 'text', everyoneRoleId: 'ev', roleIds: staff }), ctx).id).toBe('readonly');
        expect(detectPreset(buildPreset('readonly', { kind: 'huddle', everyoneRoleId: 'ev', roleIds: staff }),
            { ...ctx, kind: 'huddle', mask: callMask }).id).toBe('readonly');
    });

    it('private with no roles at all is still private', () => {
        expect(detectPreset({ [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL } }, ctx).id).toBe('private');
    });

    it('anything else is custom, and hidden (unmasked) bits do not count', () => {
        expect(detectPreset({ [roleKey('mod')]: { allow: P.ATTACH_FILES, deny: 0n } }, ctx).id).toBe('custom');
        expect(detectPreset({ [roleKey('mod')]: { allow: P.MANAGE_CHANNELS, deny: 0n } }, ctx).id).toBe('public');
    });
});
