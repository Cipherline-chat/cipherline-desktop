// @vitest-environment jsdom
/**
 * RolePickerList — the shared role checklist. Pinned here:
 *   - the search box appears only above 10 rows (10 → none, 11 → shown) and
 *     is autofocused; with none, the first row is focused instead;
 *   - filtering, the "no roles match" empty state, Escape clearing a query;
 *   - toggles report the NEXT state, busy rows ignore clicks;
 *   - arrow-key movement between the box and the rows;
 *   - the loading / error / nothing-assignable states.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RolePickerList, type RolePickerListProps } from './RolePickerList';
import { __resetEscapeStackForTests } from '../../../utils/escapeStack';
import type { PickerRole } from './rolePickerModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const mkRoles = (n: number): PickerRole[] =>
    Array.from({ length: n }, (_, i) => ({
        role_id: `r${i}`, name: i === 0 ? 'Moderator' : `Role ${i}`, color: -1, position: n - i, is_everyone: false,
    }));

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; __resetEscapeStackForTests?.(); });

function mount(props: Partial<RolePickerListProps> & { roles: PickerRole[] }) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onToggle = props.onToggle ?? vi.fn();
    const full: RolePickerListProps = { assignedIds: [], ...props, onToggle };
    act(() => root.render(h(RolePickerList, full)));
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return {
        host, onToggle,
        rerender: (next: Partial<RolePickerListProps>) => act(() => root.render(h(RolePickerList, { ...full, ...next }))),
        rows: () => Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="role-picker-row"]')),
        search: () => host.querySelector<HTMLInputElement>('[data-testid="role-picker-search"]'),
    };
}

function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function key(el: Element, k: string) {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
}

describe('RolePickerList', () => {
    it('10 roles: no search box, all rows, first row focused', () => {
        const t = mount({ roles: mkRoles(10) });
        expect(t.search()).toBeNull();
        expect(t.rows()).toHaveLength(10);
        expect(document.activeElement).toBe(t.rows()[0]);
    });

    it('11 roles: search box shown and focused; filters; empty state; Escape clears', () => {
        const t = mount({ roles: mkRoles(11) });
        const input = t.search()!;
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        expect(t.rows()).toHaveLength(11);

        type(input, 'moder');
        expect(t.rows().map(r => r.textContent)).toEqual(['Moderator']);

        type(input, 'nothing-like-this');
        expect(t.rows()).toHaveLength(0);
        expect(t.host.querySelector('[data-testid="role-picker-empty"]')?.textContent).toContain('No roles match');

        key(document.body, 'Escape');
        expect(input.value).toBe('');
        expect(t.rows()).toHaveLength(11);
    });

    it('the list scrolls inside its own capped box', () => {
        const t = mount({ roles: mkRoles(40), maxListHeight: 200 });
        const box = t.host.querySelector<HTMLElement>('[role="group"]')!;
        expect(box.style.maxHeight).toBe('200px');
        expect(box.className).toContain('rpk-rows');
    });

    it('click reports the next state; checked rows read aria-checked; busy rows ignore clicks', () => {
        const onToggle = vi.fn();
        const t = mount({ roles: mkRoles(3), assignedIds: ['r1'], onToggle, pendingIds: new Set(['r2']) });
        const [r0, r1, r2] = t.rows();
        expect(r1.getAttribute('aria-checked')).toBe('true');
        expect(r0.getAttribute('aria-checked')).toBe('false');
        act(() => r0.click());
        act(() => r1.click());
        act(() => r2.click());
        expect(onToggle.mock.calls).toEqual([['r0', true], ['r1', false]]);
        expect(r2.getAttribute('aria-busy')).toBe('true');
    });

    it('Enter in the search box toggles the single remaining match', () => {
        const onToggle = vi.fn();
        const t = mount({ roles: mkRoles(12), onToggle });
        type(t.search()!, 'Moderator');
        key(t.search()!, 'Enter');
        expect(onToggle).toHaveBeenCalledWith('r0', true);
        type(t.search()!, 'Role');            // many matches → Enter does nothing
        key(t.search()!, 'Enter');
        expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('arrow keys move from the box to the rows and back', () => {
        const t = mount({ roles: mkRoles(12) });
        key(t.search()!, 'ArrowDown');
        expect(document.activeElement).toBe(t.rows()[0]);
        key(t.rows()[0], 'ArrowDown');
        expect(document.activeElement).toBe(t.rows()[1]);
        key(t.rows()[1], 'End');
        expect(document.activeElement).toBe(t.rows()[11]);
        key(t.rows()[11], 'Home');
        expect(document.activeElement).toBe(t.rows()[0]);
        key(t.rows()[0], 'ArrowUp');
        expect(document.activeElement).toBe(t.search());
    });

    it('loading, error (with retry) and nothing-assignable states', () => {
        const onRetry = vi.fn();
        const t = mount({ roles: [], loading: true });
        expect(t.host.textContent).toContain('Loading roles');
        t.rerender({ loading: false, error: 'Could not load roles.', onRetry });
        expect(t.host.querySelector('[role="alert"]')?.textContent).toContain('Could not load roles.');
        act(() => (t.host.querySelector('.rpk-retry') as HTMLButtonElement).click());
        expect(onRetry).toHaveBeenCalled();
        t.rerender({ loading: false, error: null, hiddenAbove: 2 });
        const none = t.host.querySelector('[data-testid="role-picker-none"]')!;
        expect(none.textContent).toContain('No roles you can assign');
        expect(none.textContent).toContain('below your highest role');
    });

    it('notes how many roles were left out above the viewer', () => {
        const t = mount({ roles: mkRoles(2), hiddenAbove: 3 });
        expect(t.host.querySelector('.rpk-foot')?.textContent).toBe('3 roles at or above your highest role not shown');
    });
});
