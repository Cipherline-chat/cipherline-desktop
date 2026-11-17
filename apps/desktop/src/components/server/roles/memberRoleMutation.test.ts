import { describe, it, expect, vi, beforeEach } from 'vitest';

const axiosMock = vi.hoisted(() => ({ put: vi.fn(), delete: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock }));
const rosterMock = vi.hoisted(() => ({
    roleIds: new Map<string, string[]>(),
    refresh: vi.fn(async () => null),
}));
vi.mock('../../../utils/serverRosterCache', () => ({
    getRoster: (serverId: string) => ({
        members: [...rosterMock.roleIds.entries()]
            .filter(([k]) => k.startsWith(`${serverId}|`))
            .map(([k, role_ids]) => ({ user_id: k.split('|')[1], role_ids })),
        roles: [],
    }),
    refreshRoster: rosterMock.refresh,
    subscribeRoster: () => () => {},
}));

import {
    setMemberRole, getRoleOverride, isRoleToggleInFlight, roleToggleErrorMessage, __resetRoleOverrides,
} from './memberRoleMutation';

function deferred<T = unknown>() {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    __resetRoleOverrides();
    axiosMock.put.mockReset();
    axiosMock.delete.mockReset();
    rosterMock.refresh.mockReset().mockResolvedValue(null);
    rosterMock.roleIds.clear();
    rosterMock.roleIds.set('s1|u1', ['a']);
});

describe('setMemberRole', () => {
    it('applies optimistically, calls the right endpoint, then refreshes and drops the override', async () => {
        const put = deferred();
        axiosMock.put.mockReturnValue(put.promise);
        const p = setMemberRole({ serverId: 's1', userId: 'u1', roleId: 'b', assign: true, token: 't' });
        expect(getRoleOverride('s1', 'u1')).toEqual(['a', 'b']);       // before the server answered
        expect(isRoleToggleInFlight('s1', 'u1')).toBe(true);
        expect(axiosMock.put.mock.calls[0][0]).toMatch(/\/servers\/s1\/members\/u1\/roles\/b$/);
        put.resolve({ data: { ok: true } });
        await p;
        expect(rosterMock.refresh).toHaveBeenCalledWith('s1', 't', { force: true });
        expect(getRoleOverride('s1', 'u1')).toBeUndefined();
        expect(isRoleToggleInFlight('s1', 'u1')).toBe(false);
    });

    it('unassign uses DELETE', async () => {
        axiosMock.delete.mockResolvedValue({ data: { ok: true } });
        await setMemberRole({ serverId: 's1', userId: 'u1', roleId: 'a', assign: false, token: 't' });
        expect(axiosMock.delete.mock.calls[0][0]).toMatch(/\/servers\/s1\/members\/u1\/roles\/a$/);
        expect(axiosMock.put).not.toHaveBeenCalled();
    });

    it('rolls back ONLY the failed role while a sibling toggle is still in flight, and rethrows', async () => {
        const ok = deferred();
        const bad = deferred();
        axiosMock.put.mockImplementation((url: string) => (url.endsWith('/b') ? ok.promise : bad.promise));
        const pb = setMemberRole({ serverId: 's1', userId: 'u1', roleId: 'b', assign: true, token: 't' });
        const pc = setMemberRole({ serverId: 's1', userId: 'u1', roleId: 'c', assign: true, token: 't' });
        expect(getRoleOverride('s1', 'u1')).toEqual(['a', 'b', 'c']);

        const err = { response: { status: 403, data: { message: 'Cannot assign a role at or above your own highest role' } } };
        bad.reject(err);
        await expect(pc).rejects.toBe(err);
        // c rolled back, b still shown as pending-assigned; no refresh yet (b in flight)
        expect(getRoleOverride('s1', 'u1')).toEqual(['a', 'b']);
        expect(rosterMock.refresh).not.toHaveBeenCalled();

        ok.resolve({ data: { ok: true } });
        await pb;
        expect(rosterMock.refresh).toHaveBeenCalledTimes(1);
        expect(getRoleOverride('s1', 'u1')).toBeUndefined();
    });

    it('starts from fallbackIds when the roster lacks the member', async () => {
        axiosMock.put.mockReturnValue(new Promise(() => {}));
        void setMemberRole({ serverId: 's2', userId: 'u9', roleId: 'x', assign: true, token: 't', fallbackIds: ['y'] });
        expect(getRoleOverride('s2', 'u9')).toEqual(['y', 'x']);
    });
});

describe('roleToggleErrorMessage', () => {
    it('prefers the server message, then status-specific copy', () => {
        expect(roleToggleErrorMessage({ response: { data: { message: 'Nope' } } })).toBe('Nope');
        expect(roleToggleErrorMessage({ response: { data: { message: ['first', 'second'] } } })).toBe('first');
        expect(roleToggleErrorMessage({ response: { status: 403, data: {} } })).toMatch(/below your highest role/);
        expect(roleToggleErrorMessage({ response: { status: 429, data: {} } })).toMatch(/Too many/);
        expect(roleToggleErrorMessage(new Error('network'))).toMatch(/connection/);
    });
});
