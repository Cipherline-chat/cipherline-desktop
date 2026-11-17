// @vitest-environment jsdom
/**
 * The member right-click menu's "Roles ▸" row end to end: the real
 * ContextMenu + rolesMenuItem + MemberRolesFlyout + RolePickerList, with the
 * roster cache and axios stubbed. Pinned:
 *   - hovering "Roles" opens the picker as a flyout beside the menu — NOT the
 *     separate MemberRolePicker popover;
 *   - a toggle is optimistic, hits the right endpoint, and leaves the flyout
 *     and the menu open; a failed one rolls back and toasts;
 *   - the hierarchy mirror: only roles below the viewer's highest, with the
 *     "N roles at or above your highest role not shown" footer; an owner sees
 *     every role and, over 10, the search box.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Permissions } from '@cipherline/shared';

const axiosMock = vi.hoisted(() => ({ put: vi.fn(), delete: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock }));
const toastPush = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ push: toastPush }) }));
const rosterMock = vi.hoisted(() => ({
    roster: null as null | { members: Array<{ user_id: string; role_ids: string[] }>; roles: unknown[] },
    refresh: vi.fn(async () => null),
}));
vi.mock('../../../utils/serverRosterCache', () => ({
    getRoster: () => rosterMock.roster,
    peekRoster: () => rosterMock.roster,
    refreshRoster: rosterMock.refresh,
    subscribeRoster: () => () => {},
}));

import { ContextMenu } from '../../primitives/ContextMenu';
import { SUBMENU_OPEN_DELAY } from '../../primitives/contextMenuGeometry';
import { RolePickerContext, type RolePickerApi } from '../../../contexts/RolePickerContext';
import { rolesMenuItem } from './rolesMenuItem';
import { __resetRoleOverrides } from './memberRoleMutation';
import { __resetEscapeStackForTests } from '../../../utils/escapeStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const ROLES = [
    { role_id: 'everyone', name: '@everyone', color: -1, position: 0, hoisted: false, is_everyone: true },
    ...Array.from({ length: 12 }, (_, i) => ({
        role_id: `r${i + 1}`, name: `Role ${i + 1}`, color: 0x2ecc71, position: i + 1, hoisted: false, is_everyone: false,
    })),
];

let root: Root;
let host: HTMLDivElement;

function mount(opts: { owner: boolean }) {
    rosterMock.roster = {
        members: [
            // The viewer holds Role 8 (position 8) unless they own the server.
            { user_id: 'me', role_ids: opts.owner ? [] : ['r8'] },
            { user_id: 'u1', role_ids: ['r2'] },
        ],
        roles: ROLES,
    };
    const api: RolePickerApi = {
        open: vi.fn(),
        session: () => ({ token: 'tok', myUserId: 'me', ownerUserId: opts.owner ? 'me' : 'someone-else', perms: Permissions.MANAGE_ROLES }),
        canAssignRoles: () => true,
        actorHighest: () => (opts.owner ? Number.POSITIVE_INFINITY : 8),
        openFor: null,
    };
    const items = [
        { label: 'View Profile', onSelect: () => {} },
        { divider: true as const },
        rolesMenuItem({ serverId: 's1', userId: 'u1', displayName: 'alice', fallbackRoleIds: ['r2'] }),
    ];
    act(() => root.render(
        h(RolePickerContext.Provider, { value: api },
            h(ContextMenu, { anchor: { x: 100, y: 100 }, items, onClose: () => {}, title: 'alice' })),
    ));
    act(() => { vi.advanceTimersByTime(20); });
}

const rolesRow = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.ctxm-row')).find(b => b.textContent === 'Roles')!;
const flyout = () => document.querySelector<HTMLElement>('[data-testid="ctxm-flyout"]');
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="role-picker-row"]'));
const rowFor = (id: string) => rows().find(r => r.dataset.roleId === id)!;

function hoverRoles() {
    act(() => { rolesRow().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })); });
    act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY); });
}

/** Let resolved promises run (fake timers do not cover microtasks). */
async function flush() {
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

beforeEach(() => {
    vi.useFakeTimers();
    __resetRoleOverrides();
    axiosMock.put.mockReset();
    axiosMock.delete.mockReset();
    rosterMock.refresh.mockReset().mockResolvedValue(null);
    toastPush.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    __resetEscapeStackForTests();
    vi.useRealTimers();
});

describe('member menu "Roles ▸" flyout', () => {
    it('opens the shared picker beside the menu on hover — not the separate popover', () => {
        mount({ owner: true });
        expect(rolesRow().getAttribute('aria-haspopup')).toBe('dialog');
        hoverRoles();
        const fly = flyout()!;
        expect(fly).not.toBeNull();
        expect(fly.getAttribute('aria-label')).toBe('Roles for alice');
        expect(fly.querySelector('[data-testid="member-roles-flyout"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="member-role-picker"]')).toBeNull();
        // Owner: every real role (12, never @everyone), highest first, with search.
        expect(rows().map(r => r.dataset.roleId)).toEqual(['r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
        expect(document.querySelector('[data-testid="role-picker-search"]')).not.toBeNull();
        expect(rowFor('r2').getAttribute('aria-checked')).toBe('true');
    });

    it('a toggle is optimistic, calls the API and keeps the flyout and menu open', async () => {
        mount({ owner: true });
        hoverRoles();
        let resolvePut!: () => void;
        axiosMock.put.mockReturnValue(new Promise<void>(res => { resolvePut = res; }));

        act(() => { rowFor('r5').click(); });
        expect(rowFor('r5').getAttribute('aria-checked')).toBe('true'); // before the server answers
        expect(axiosMock.put).toHaveBeenCalledTimes(1);
        expect(String(axiosMock.put.mock.calls[0][0])).toMatch(/\/servers\/s1\/members\/u1\/roles\/r5$/);

        resolvePut();
        await flush();
        expect(rosterMock.refresh).toHaveBeenCalledWith('s1', 'tok', { force: true });
        act(() => { vi.advanceTimersByTime(1000); });
        expect(flyout()).not.toBeNull();
        expect(document.querySelector('.ctxm:not(.ctxm--sub)')).not.toBeNull();

        // A second role in the same flyout, no reopening.
        axiosMock.delete.mockResolvedValue({});
        act(() => { rowFor('r2').click(); });
        expect(rowFor('r2').getAttribute('aria-checked')).toBe('false');
        expect(axiosMock.delete).toHaveBeenCalledTimes(1);
        await flush();
        expect(flyout()).not.toBeNull();
    });

    it('a failed toggle rolls back and toasts, and the flyout stays', async () => {
        mount({ owner: true });
        hoverRoles();
        axiosMock.put.mockRejectedValue({ response: { status: 403, data: {} } });
        act(() => { rowFor('r7').click(); });
        expect(rowFor('r7').getAttribute('aria-checked')).toBe('true');
        await flush();
        expect(rowFor('r7').getAttribute('aria-checked')).toBe('false');
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', title: 'Could not add role' }));
        expect(flyout()).not.toBeNull();
    });

    it('lists only roles below the viewer\'s highest, with the hidden-above footer', () => {
        mount({ owner: false }); // viewer's highest = Role 8
        hoverRoles();
        expect(rows().map(r => r.dataset.roleId)).toEqual(['r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
        expect(document.querySelector('[data-testid="role-picker-search"]')).toBeNull(); // 7 ≤ 10
        expect(flyout()!.textContent).toContain('5 roles at or above your highest role not shown');
    });
});
