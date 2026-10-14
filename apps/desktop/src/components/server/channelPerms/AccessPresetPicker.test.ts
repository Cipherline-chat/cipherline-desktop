// @vitest-environment jsdom
/**
 * AccessPresetPicker's "+ Role" finder. The typing box under "Who gets in" /
 * "Who can post" / "Who can talk" searches ROLES (not members); individual
 * members are a Permissions-tab concern, but member overrides that already
 * exist stay visible and removable so opening the screen never hides access.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import { AccessPresetPicker, ROLE_CHIP_THRESHOLD } from './AccessPresetPicker';
import { buildPreset, detectPreset } from './channelPresets';
import { editorReducer, initialEditorState, roleKey, type EditorAction, type EditorState } from './overrideDraft';
import { channelPermissionMask } from '../roles/permissions';
import type { GuardResult } from './editorGuard';
import type { EditorMember } from './usePermissionData';
import type { PermRole } from './effectivePermissions';
import type { Role } from '../roles/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const mask = channelPermissionMask('text');

const mkRole = (id: string, name: string, position: number, color = -1): Role => ({
    role_id: id, name, color, position, permissions: '0', mentionable: false, hoisted: false, is_everyone: false,
});
const everyoneRole: Role = { ...mkRole('ev', '@everyone', 0), is_everyone: true };
const toPerm = (r: Role): PermRole => ({
    role_id: r.role_id, name: r.name, position: r.position, is_everyone: r.is_everyone,
    permissions: r.is_everyone ? DEFAULT_EVERYONE_PERMISSIONS : 0n,
});
/** n ordinary roles r1..rn, hierarchy order high to low. */
const manyRoles = (n: number, names: string[] = []): Role[] =>
    Array.from({ length: n }, (_, i) => mkRole(`r${i + 1}`, names[i] ?? `Role ${i + 1}`, 100 - i, i === 0 ? 0xff0000 : -1));

const members: EditorMember[] = [
    { user_id: 'u1', name: 'Alice', role_ids: [], muted_until: null },
    { user_id: 'u2', name: 'Bob', role_ids: [], muted_until: null },
];

const guardOf = (locks: Record<string, string> = {}): GuardResult => ({
    editable: ~0n,
    baseline: {},
    lockedKeys: new Set(Object.keys(locks).map(roleKey)),
    lockReasons: new Map(Object.entries(locks).map(([rid, why]) => [roleKey(rid), why])),
    privileged: true,
    myHighestPosition: 1000,
    canManageHere: true,
});

interface Setup {
    roles?: Role[];
    granted?: string[];
    memberIds?: string[];
    locks?: Record<string, string>;
    members?: EditorMember[];
    onOpenAdvanced?: () => void;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: EditorState | null = null;

function mount(o: Setup = {}) {
    const roles = o.roles ?? manyRoles(8);
    const draft = buildPreset('private', { kind: 'text', everyoneRoleId: 'ev', roleIds: o.granted ?? [], memberIds: o.memberIds ?? [] });
    const allRoles = [everyoneRole, ...roles];
    const permRoles = allRoles.map(toPerm);
    const guard = guardOf(o.locks);
    const Wrapper = () => {
        const [state, dispatch] = useReducer((s: EditorState, a: EditorAction) => editorReducer(s, a), initialEditorState(draft));
        latest = state;
        return h(AccessPresetPicker, {
            kind: 'text', scope: 'channel', roles: allRoles, permRoles, members: o.members ?? members,
            ownerUserId: 'owner', currentUserId: null, inheritedTiers: [], syncCategoryName: null,
            state, dispatch, mask, guard, onOpenAdvanced: o.onOpenAdvanced ?? (() => {}),
        });
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(h(Wrapper)));
    return host;
}

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null; host = null; latest = null;
    vi.useRealTimers();
});

const detectedNow = () => detectPreset(latest!.draft, { kind: 'text', everyoneRoleId: 'ev', staffIds: [], mask });
const grantedIds = () => detectedNow().roleIds.slice().sort();
const q = (sel: string) => host!.querySelector<HTMLElement>(sel);
const chips = () => [...host!.querySelectorAll<HTMLElement>('[role="checkbox"]')].map(b => b.textContent?.trim());
const roleTrigger = () => [...host!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Role')!;
const input = () => q('input[role="combobox"]') as HTMLInputElement;
const options = () => [...host!.querySelectorAll<HTMLElement>('[role="option"]')];
const optionNames = () => options().map(o => o.textContent?.trim());

const openFinder = () => act(() => { roleTrigger().click(); });
const typeQuery = (value: string) => act(() => {
    const el = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
const press = (key: string, target: EventTarget = input()) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});

describe('AccessPresetPicker role finder', () => {
    it('offers "+ Role" with an "Add a role…" box and no member search', () => {
        mount();
        expect(roleTrigger()).toBeTruthy();
        // the old "+ Member" control is gone
        expect([...host!.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Member')).toBe(false);
        openFinder();
        expect(input().placeholder).toBe('Add a role…');
        expect(input().getAttribute('aria-label')).toBe('Add a role');
        expect(host!.textContent).not.toContain('Add a member');
    });

    it('lists every addable role on an empty query, with colour dots, and not the granted ones', () => {
        mount({ granted: ['r2'] });
        openFinder();
        expect(optionNames()).toEqual(['Role 1', 'Role 3', 'Role 4', 'Role 5', 'Role 6', 'Role 7', 'Role 8']);
        // Role 1 has a colour -> filled dot; Role 3 has none -> hollow outline dot.
        const dot = (i: number) => options()[i].querySelector<HTMLElement>('span[style]')!;
        expect(dot(0).style.backgroundColor).not.toBe('');
        expect(dot(1).style.backgroundColor).toBe('');
        expect(dot(1).style.border).not.toBe('');
    });

    it('filters by name, case-insensitively, and shows an empty state', () => {
        mount({ roles: manyRoles(8, ['Moderator', 'Helper', 'Regulars', 'VIP', 'Boosters', 'Artists', 'Devs', 'Modders']) });
        openFinder();
        typeQuery('MOD');
        expect(optionNames()).toEqual(['Moderator', 'Modders']);
        typeQuery('  vip ');
        expect(optionNames()).toEqual(['VIP']);
        typeQuery('zzz');
        expect(options()).toHaveLength(0);
        expect(host!.textContent).toContain('No matching roles');
        // nothing to pick, so Enter is inert
        press('Enter');
        expect(grantedIds()).toEqual([]);
    });

    it('does not search members by name', () => {
        mount();
        openFinder();
        typeQuery('Alice');
        expect(options()).toHaveLength(0);
    });

    it('picking a role (click) grants it exactly like its chip, and closes the finder', () => {
        mount({ granted: ['r1'] });
        openFinder();
        typeQuery('Role 5');
        act(() => { options()[0].click(); });
        expect(grantedIds()).toEqual(['r1', 'r5']);
        expect(input()).toBeNull();
        // it is now a chip, and no longer offered
        expect(chips()).toContain('Role 5');
        openFinder();
        expect(optionNames()).not.toContain('Role 5');
    });

    it('Enter picks the top match', () => {
        mount();
        openFinder();
        typeQuery('role 4');
        press('Enter');
        expect(grantedIds()).toEqual(['r4']);
    });

    it('Up/Down move the highlight (wrapping) and Enter picks the highlighted role', () => {
        mount();
        openFinder();
        expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
        press('ArrowDown');
        press('ArrowDown');
        expect(input().getAttribute('aria-activedescendant')).toBe(options()[2].id);
        expect(options()[2].getAttribute('aria-selected')).toBe('true');
        expect(options()[0].getAttribute('aria-selected')).toBe('false');
        press('ArrowUp');
        expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id);
        press('ArrowUp');
        press('ArrowUp'); // wraps to the last
        expect(input().getAttribute('aria-activedescendant')).toBe(options()[options().length - 1].id);
        press('Enter');
        expect(grantedIds()).toEqual(['r8']);
    });

    it('exposes combobox / listbox semantics', () => {
        mount();
        openFinder();
        const box = input();
        const list = q('[role="listbox"]')!;
        expect(box.getAttribute('aria-controls')).toBe(list.id);
        expect(box.getAttribute('aria-expanded')).toBe('true');
        expect(box.getAttribute('aria-autocomplete')).toBe('list');
        expect(document.getElementById(box.getAttribute('aria-activedescendant')!)?.getAttribute('role')).toBe('option');
    });

    it('Esc closes the finder without granting anything and returns focus to "+ Role"', () => {
        mount();
        openFinder();
        typeQuery('role');
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(input()).toBeNull();
        expect(grantedIds()).toEqual([]);
        expect(document.activeElement).toBe(roleTrigger());
        // reopening starts from a clean query
        openFinder();
        expect(input().value).toBe('');
    });

    it('closes shortly after the input loses focus (existing blur behaviour)', () => {
        vi.useFakeTimers();
        mount();
        openFinder();
        act(() => { input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(input()).not.toBeNull(); // not instantly: a click on an option must land first
        act(() => { vi.advanceTimersByTime(200); });
        expect(input()).toBeNull();
    });

    it('locked roles are listed disabled with their reason and cannot be added', () => {
        mount({ locks: { r3: 'Above your highest role' } });
        openFinder();
        const locked = options().find(o => o.textContent?.includes('Role 3'))!;
        expect(locked.getAttribute('aria-disabled')).toBe('true');
        expect(locked.title).toBe('Locked: Above your highest role');
        act(() => { locked.click(); });
        expect(grantedIds()).toEqual([]);
        expect(input()).not.toBeNull(); // still open: nothing was picked

        // Enter never lands on a locked role, even when it is the only match.
        typeQuery('Role 3');
        press('Enter');
        expect(grantedIds()).toEqual([]);
        expect(input().getAttribute('aria-activedescendant')).toBeNull();

        // ...and arrow navigation skips it.
        typeQuery('Role');
        const ids = options().filter(o => o.getAttribute('aria-disabled') !== 'true').map(o => o.id);
        expect(ids).toHaveLength(7);
        press('ArrowDown');
        press('ArrowDown');
        expect(ids).toContain(input().getAttribute('aria-activedescendant'));
        expect(input().getAttribute('aria-activedescendant')).not.toBe(locked.id);
    });

    it('hides "+ Role" once every role is granted', () => {
        const roles = manyRoles(8);
        mount({ roles, granted: roles.map(r => r.role_id) });
        expect([...host!.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Role')).toBe(false);
    });
});

describe('AccessPresetPicker role chips', () => {
    it(`shows every role as a toggle chip while there are at most ${ROLE_CHIP_THRESHOLD}`, () => {
        mount({ roles: manyRoles(ROLE_CHIP_THRESHOLD), granted: ['r2'] });
        expect(chips()).toHaveLength(ROLE_CHIP_THRESHOLD);
        const r2 = [...host!.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(b => b.textContent?.trim() === 'Role 2')!;
        expect(r2.getAttribute('aria-checked')).toBe('true');
        // one-click toggle still works
        const r4 = [...host!.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(b => b.textContent?.trim() === 'Role 4')!;
        act(() => { r4.click(); });
        expect(grantedIds()).toEqual(['r2', 'r4']);
    });

    it(`shows only granted roles as chips above ${ROLE_CHIP_THRESHOLD}`, () => {
        mount({ roles: manyRoles(ROLE_CHIP_THRESHOLD + 1), granted: ['r2', 'r5'] });
        expect(chips()).toEqual(['Role 2', 'Role 5']);
        expect(roleTrigger()).toBeTruthy();
    });

    it('a granted chip can still be un-granted with one click', () => {
        mount({ roles: manyRoles(9), granted: ['r2', 'r5'] });
        const r2 = [...host!.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(b => b.textContent?.trim() === 'Role 2')!;
        act(() => { r2.click(); });
        expect(grantedIds()).toEqual(['r5']);
        expect(chips()).toEqual(['Role 5']);
    });

    it('a locked role stays a disabled chip with its lock reason (small server)', () => {
        mount({ roles: manyRoles(4), locks: { r2: 'Above your highest role' } });
        const r2 = [...host!.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find(b => b.textContent?.trim() === 'Role 2')!;
        expect(r2.disabled).toBe(true);
        expect(r2.title).toBe('Locked: Above your highest role');
        act(() => { r2.click(); });
        expect(grantedIds()).toEqual([]);
    });
});

describe('AccessPresetPicker existing member overrides', () => {
    it('keeps them as removable chips and removing one leaves the roles alone', () => {
        mount({ roles: manyRoles(9), granted: ['r2'], memberIds: ['u1', 'u2'] });
        const remove = (name: string) => host!.querySelector<HTMLElement>(`button[aria-label="Remove ${name}"]`);
        expect(remove('Alice')).toBeTruthy();
        expect(remove('Bob')).toBeTruthy();
        expect(detectedNow().memberIds.sort()).toEqual(['u1', 'u2']);

        act(() => { remove('Alice')!.click(); });
        expect(detectedNow().memberIds).toEqual(['u2']);
        expect(grantedIds()).toEqual(['r2']);
        expect(remove('Alice')).toBeNull();
    });

    it('picking a role does not drop member overrides', () => {
        mount({ roles: manyRoles(9), memberIds: ['u1'] });
        openFinder();
        typeQuery('Role 7');
        press('Enter');
        expect(grantedIds()).toEqual(['r7']);
        expect(detectedNow().memberIds).toEqual(['u1']);
    });

    it('points at the Permissions tab for adding members', () => {
        const onOpenAdvanced = vi.fn();
        mount({ onOpenAdvanced });
        const hint = [...host!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Members: set in Permissions')!;
        expect(hint).toBeTruthy();
        act(() => { hint.click(); });
        expect(onOpenAdvanced).toHaveBeenCalledTimes(1);
    });
});
