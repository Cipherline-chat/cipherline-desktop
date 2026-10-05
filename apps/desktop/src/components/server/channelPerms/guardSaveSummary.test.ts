import { describe, it, expect, vi } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, Permissions as P } from '@cipherline/shared';
import { computeGuard } from './editorGuard';
import { saveOverrideDiff, describeFailures } from './saveOverrides';
import { describeAccess, summarizeAccess, tierFromDraft } from './accessSummary';
import { memberKey, roleKey } from './overrideDraft';
import type { PermRole, PermTier } from './effectivePermissions';

const roles: PermRole[] = [
    { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, permissions: DEFAULT_EVERYONE_PERMISSIONS },
    { role_id: 'admin', name: 'Admin', position: 50, is_everyone: false, permissions: P.ADMINISTRATOR },
    { role_id: 'mod', name: 'Moderator', position: 40, is_everyone: false, permissions: P.MANAGE_CHANNELS | P.MANAGE_MESSAGES },
    { role_id: 'reg', name: 'Regulars', position: 10, is_everyone: false, permissions: 0n },
];
const members = [
    { user_id: 'owner', role_ids: [] },
    { user_id: 'me', role_ids: ['mod'] },
    { user_id: 'boss', role_ids: ['admin'] },
    { user_id: 'kai', role_ids: ['reg'] },
];
const modPerms = DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_CHANNELS | P.MANAGE_MESSAGES;

const base = { roles, ownerUserId: 'owner', scope: 'channel' as const, inheritedTiers: [] as PermTier[] };
const asMod = (extra: Partial<Parameters<typeof computeGuard>[0]> = {}) =>
    computeGuard({ ...base, members, currentUserId: 'me', myPermissions: modPerms, baseline: {}, ...extra });

describe('computeGuard — mirrors the server’s override rules', () => {
    it('owner and admins are not gated at all', () => {
        const owner = computeGuard({ ...base, members, currentUserId: 'owner', myPermissions: ALL_PERMISSIONS, baseline: {} });
        expect(owner.privileged).toBe(true);
        expect(owner.lockedKeys.size).toBe(0);
        expect(owner.editable).toBe(~0n);
        expect(owner.resolveMine).toBeUndefined();
        const admin = computeGuard({ ...base, members, currentUserId: 'boss', myPermissions: ALL_PERMISSIONS, baseline: {} });
        expect(admin.privileged).toBe(true);
    });

    it('hierarchy is STRICT: roles and members at or above the caller are locked, their own row and @everyone are not', () => {
        const g = asMod();
        expect(g.privileged).toBe(false);
        expect(g.lockReasons.get(roleKey('admin'))).toBe('At or above your highest role');
        expect(g.lockReasons.get(roleKey('mod'))).toBe('At or above your highest role'); // equal → locked, as the server does
        expect(g.lockedKeys.has(roleKey('reg'))).toBe(false);
        expect(g.lockedKeys.has(roleKey('ev'))).toBe(false);
        expect(g.lockReasons.get(memberKey('owner'))).toBe('Server owner');
        expect(g.lockReasons.get(memberKey('boss'))).toBe('Has a role at or above yours');
        expect(g.lockedKeys.has(memberKey('kai'))).toBe(false);
        expect(g.lockedKeys.has(memberKey('me'))).toBe(false);
        // A second Mod-role holder is equal → locked.
        const g2 = asMod({ members: [...members, { user_id: 'peer', role_ids: ['mod'] }] });
        expect(g2.lockReasons.get(memberKey('peer'))).toBe('Has a role at or above yours');
    });

    it('editable = the caller’s permissions IN the channel, not server-wide: a saved deny on them removes the bit', () => {
        expect(asMod().editable).toBe(modPerms);
        expect(asMod().canManageHere).toBe(true);
        // The owner denied me SEND here.
        const g = asMod({ baseline: { [memberKey('me')]: { allow: 0n, deny: P.SEND_MESSAGES } } });
        expect(g.editable).toBe(modPerms & ~P.SEND_MESSAGES);
        // ...via my role, at the inherited category tier.
        const g2 = asMod({ inheritedTiers: [{ kind: 'category', label: 'category ‘Staff’', overrides: [{ target_kind: 'role', target_id: 'mod', allow: 0n, deny: P.MANAGE_MESSAGES }] }] });
        expect(g2.editable).toBe(modPerms & ~P.MANAGE_MESSAGES);
    });

    it('a caller locked out of the target (no VIEW or no MANAGE_CHANNELS there) can change nothing', () => {
        const hidden = asMod({ baseline: { [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL } } });
        expect(hidden.canManageHere).toBe(false);
        expect(hidden.editable).toBe(0n);
        const noManage = asMod({ baseline: { [roleKey('mod')]: { allow: 0n, deny: P.MANAGE_CHANNELS } } });
        expect(noManage.editable).toBe(0n);
    });

    it('a server timeout strips SEND_MESSAGES from what the caller may change', () => {
        const g = asMod({ members: members.map(m => (m.user_id === 'me' ? { ...m, muted_until: new Date(Date.now() + 60_000).toISOString() } : m)) });
        expect(g.editable & P.SEND_MESSAGES).toBe(0n);
        expect(g.editable & P.MANAGE_MESSAGES).toBe(P.MANAGE_MESSAGES);
    });

    it('a saved allow the caller lacks no longer locks the row — only that bit is untouchable', () => {
        const g = asMod({ baseline: { [roleKey('reg')]: { allow: P.MENTION_EVERYONE, deny: 0n } } });
        expect(g.lockedKeys.has(roleKey('reg'))).toBe(false);
        expect(g.editable & P.MENTION_EVERYONE).toBe(0n);
    });

    it('a member with no roles has nothing below them: every role is locked except @everyone', () => {
        const g = computeGuard({ ...base, members: [...members, { user_id: 'nobody', role_ids: [] }], currentUserId: 'nobody', myPermissions: P.MANAGE_CHANNELS, baseline: {} });
        expect(g.lockedKeys.has(roleKey('reg'))).toBe(true);
        expect(g.lockedKeys.has(roleKey('ev'))).toBe(false);
    });

    it('without a member row it falls back to the server-wide bits and offers no save sequencer', () => {
        const g = computeGuard({ ...base, members: [], currentUserId: 'me', myPermissions: modPerms, baseline: {} });
        expect(g.editable).toBe(modPerms);
        expect(g.resolveMine).toBeUndefined();
    });

    it('resolveMine answers for an arbitrary override set of the target', () => {
        const g = asMod();
        expect(g.resolveMine!({})).toBe(modPerms);
        expect(g.resolveMine!({ [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL } }) & P.VIEW_CHANNEL).toBe(0n);
        expect(g.resolveMine!({
            [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL },
            [roleKey('mod')]: { allow: P.VIEW_CHANNEL, deny: 0n },
        }) & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL);
    });
});

/** Records the order requests are sent in and how many overlap. */
function recordingHttp(failIds: string[] = []) {
    const order: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const http = {
        patch: vi.fn(async (_u: string, b: unknown) => {
            const id = (b as { target_id: string }).target_id;
            inflight++; maxInflight = Math.max(maxInflight, inflight);
            order.push(`patch:${id}`);
            await new Promise(r => setTimeout(r, 5));
            inflight--;
            if (failIds.includes(id)) throw { response: { data: { code: 'OVERRIDE_MISSING_PERMISSION', message: 'server text' } } };
        }),
        delete: vi.fn(async (u: string) => { order.push(`delete:${u.split('/').pop()}`); }),
    };
    return { http, order, max: () => maxInflight };
}

describe('saveOverrideDiff', () => {
    it('without a resolver: @everyone first and alone, then the rest in parallel; deletes use the kind/id route', async () => {
        const { http, order, max } = recordingHttp();
        const r = await saveOverrideDiff({
            http, base: '/b', everyoneRoleId: 'ev',
            baseline: { [memberKey('gone')]: { allow: P.VIEW_CHANNEL, deny: 0n } },
            draft: {
                [roleKey('a')]: { allow: P.VIEW_CHANNEL, deny: 0n },
                [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL },
                [roleKey('b')]: { allow: P.VIEW_CHANNEL, deny: 0n },
            },
        });
        expect(order[0]).toBe('patch:ev');
        expect(r).toEqual({ applied: 4, failed: [] });
        expect(http.delete).toHaveBeenCalledWith('/b/member/gone');
        expect(max()).toBeGreaterThanOrEqual(2); // a and b concurrently, after ev
    });

    it('"make it private, keep my role in": my role’s allow goes BEFORE the @everyone deny', async () => {
        const g = asMod();
        const { http, order } = recordingHttp();
        const r = await saveOverrideDiff({
            http, base: '/b', everyoneRoleId: 'ev', baseline: {}, resolveMine: g.resolveMine,
            draft: {
                [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL },
                [roleKey('mod')]: { allow: P.VIEW_CHANNEL, deny: 0n },
                [roleKey('reg')]: { allow: 0n, deny: P.SEND_MESSAGES },
            },
        });
        expect(r.failed).toEqual([]);
        expect(order.indexOf('patch:mod')).toBeLessThan(order.indexOf('patch:ev'));
        expect(order.indexOf('patch:reg')).toBeLessThan(order.indexOf('patch:ev'));
    });

    it('"make it public again": the @everyone deny is removed BEFORE my role’s allow is', async () => {
        const g = asMod();
        const { http, order } = recordingHttp();
        const baseline = {
            [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL },
            [roleKey('mod')]: { allow: P.VIEW_CHANNEL, deny: 0n },
        };
        const r = await saveOverrideDiff({ http, base: '/b', everyoneRoleId: 'ev', baseline, draft: {}, resolveMine: g.resolveMine });
        expect(r.failed).toEqual([]);
        expect(order).toEqual(['delete:ev', 'delete:mod']);
    });

    it('when I am deliberately locking myself out, the changes still go — one at a time, in stable order', async () => {
        const g = asMod();
        const { http, order } = recordingHttp();
        await saveOverrideDiff({
            http, base: '/b', everyoneRoleId: 'ev', baseline: {}, resolveMine: g.resolveMine,
            draft: { [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL }, [memberKey('me')]: { allow: 0n, deny: P.SEND_MESSAGES } },
        });
        expect(order).toHaveLength(2);
    });

    it('a change that narrows the caller waits for the round after the ones that do not', async () => {
        const g = asMod();
        const { http, order } = recordingHttp();
        await saveOverrideDiff({
            http, base: '/b', everyoneRoleId: 'ev', baseline: {}, resolveMine: g.resolveMine,
            draft: { [roleKey('ev')]: { allow: 0n, deny: P.SEND_MESSAGES }, [roleKey('reg')]: { allow: P.SEND_MESSAGES, deny: 0n } },
        });
        // The @everyone deny of SEND narrows the mod (they are not 'reg') → after reg.
        expect(order).toEqual(['patch:reg', 'patch:ev']);
    });

    it('a failed request is not counted as applied when sequencing the next round', async () => {
        const g = asMod();
        const { http, order } = recordingHttp(['mod']);
        const r = await saveOverrideDiff({
            http, base: '/b', everyoneRoleId: 'ev', baseline: {}, resolveMine: g.resolveMine,
            draft: { [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL }, [roleKey('mod')]: { allow: P.VIEW_CHANNEL, deny: 0n } },
        });
        expect(r.applied).toBe(1);
        expect(r.failed).toHaveLength(1);
        expect(order).toEqual(['patch:mod', 'patch:ev']);
    });

    it('maps the server’s override codes to plain messages, and passes other messages through', async () => {
        const http = {
            patch: vi.fn(async (_u: string, b: unknown) => {
                const id = (b as { target_id: string }).target_id;
                if (id === 'a') throw { response: { data: { code: 'OVERRIDE_HIERARCHY', message: 'server text' } } };
                if (id === 'b') throw { response: { data: { code: 'OVERRIDE_MISSING_PERMISSION', message: 'server text' } } };
                if (id === 'c') throw { response: { data: { code: 'OVERRIDE_INVALID_BITS', message: 'server text' } } };
                if (id === 'd') throw { response: { data: { message: 'Cannot grant permissions you do not yourself have' } } };
            }),
            delete: vi.fn(async () => undefined),
        };
        const r = await saveOverrideDiff({
            http, base: '/b', everyoneRoleId: 'ev', baseline: {},
            draft: {
                [roleKey('a')]: { allow: P.MANAGE_MESSAGES, deny: 0n },
                [roleKey('b')]: { allow: P.MANAGE_MESSAGES, deny: 0n },
                [roleKey('c')]: { allow: P.MANAGE_MESSAGES, deny: 0n },
                [roleKey('d')]: { allow: P.MANAGE_MESSAGES, deny: 0n },
                [roleKey('e')]: { allow: P.VIEW_CHANNEL, deny: 0n },
            },
        });
        expect(r.applied).toBe(1);
        expect(r.failed.map(f => f.message)).toEqual([
            'that role or member is at or above your highest role',
            'you can only change permissions you have here yourself',
            'the permission values were not valid',
            'Cannot grant permissions you do not yourself have',
        ]);
        expect(describeFailures(r)).toBe('4 permission changes weren’t saved: that role or member is at or above your highest role');
        expect(describeFailures({ applied: 1, failed: [] })).toBeNull();
    });
});

describe('access summary', () => {
    const summarize = (draft: Parameters<typeof tierFromDraft>[2], kind: 'text' | 'huddle' = 'text') =>
        describeAccess(summarizeAccess({ roles, ownerUserId: 'owner', tiers: [tierFromDraft('channel', 'this channel', draft)] }, kind), kind);

    it('public', () => {
        expect(summarize({})).toBe('Everyone can see it and post');
        expect(summarize({}, 'huddle')).toBe('Everyone can see it and talk');
    });
    it('read-only', () => {
        expect(summarize({
            [roleKey('ev')]: { allow: 0n, deny: P.SEND_MESSAGES },
            [roleKey('mod')]: { allow: P.SEND_MESSAGES, deny: 0n },
        })).toBe('Everyone can see it · only @Moderator and admins can post');
    });
    it('private with a member grant', () => {
        expect(summarize({
            [roleKey('ev')]: { allow: 0n, deny: P.VIEW_CHANNEL },
            [roleKey('mod')]: { allow: P.VIEW_CHANNEL, deny: 0n },
            [memberKey('kai')]: { allow: P.VIEW_CHANNEL, deny: 0n },
        })).toBe('Private — visible to @Moderator, 1 member and admins');
    });
    it('a member-only tier removal is exactly "inherit" for that member', () => {
        const t = tierFromDraft('channel', 'x', { [memberKey('kai')]: { allow: 1n, deny: 0n }, [roleKey('ev')]: { allow: 0n, deny: 2n } }, memberKey('kai'));
        expect(t.overrides).toEqual([{ target_kind: 'role', target_id: 'ev', allow: 0n, deny: 2n }]);
    });
});
