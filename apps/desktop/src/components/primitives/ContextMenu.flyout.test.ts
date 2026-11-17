// @vitest-environment jsdom
/**
 * ContextMenu flyouts — the member right-click menu's "Roles ▸" is a hover
 * flyout beside the menu (not a separate window you click into). Pinned here
 * with the real primitive and the real RolePickerList as the panel:
 *   - hovering the row opens the flyout beside the menu after a short delay,
 *     without a modal and without moving focus out of the menu;
 *   - it opens to the right, flipped to the left near the window's edge;
 *   - toggling a role keeps the flyout and the menu open;
 *   - over 10 roles the search box shows (10 → none);
 *   - → opens it from the keyboard and focuses the search; Escape closes the
 *     flyout first (focus back on "Roles"), then the menu;
 *   - a diagonal move across another row toward the flyout (safe triangle)
 *     does not close it; a move away does; leaving both surfaces does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import {
    placeFlyout, inSafeTriangle, SUBMENU_OPEN_DELAY, SUBMENU_CLOSE_DELAY, SAFE_AREA_GRACE,
} from './contextMenuGeometry';
import { RolePickerList } from '../server/roles/RolePickerList';
import type { PickerRole } from '../server/roles/rolePickerModel';
import { __resetEscapeStackForTests } from '../../utils/escapeStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const mkRoles = (n: number): PickerRole[] =>
    Array.from({ length: n }, (_, i) => ({
        role_id: `r${i}`, name: `Role ${i}`, color: 0x3498db, position: n - i, is_everyone: false,
    }));

/** A stateful stand-in for MemberRolesFlyout: same list, local toggles. */
const RolesPanel: React.FC<{ n: number; viaKeyboard: boolean }> = ({ n, viaKeyboard }) => {
    const roles = React.useMemo(() => mkRoles(n), [n]);
    const [ids, setIds] = React.useState<string[]>([]);
    return h(RolePickerList, {
        roles, assignedIds: ids, autoFocus: viaKeyboard,
        onToggle: (id: string, on: boolean) => setIds(prev => (on ? [...prev, id] : prev.filter(x => x !== id))),
    });
};

const items = (n: number): ContextMenuItem[] => [
    { label: 'View Profile', onSelect: () => {} },
    { label: 'Roles', onSelect: () => {}, flyoutWidth: 240, flyout: ({ viaKeyboard }) => h(RolesPanel, { n, viaKeyboard }) },
    { label: 'Kick', onSelect: () => {} },
];

let root: Root;
let host: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;
const realRect = HTMLElement.prototype.getBoundingClientRect;

function setViewport(w: number, hgt: number) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: hgt, configurable: true });
}

function mount(n: number, anchor = { x: 100, y: 100 }) {
    act(() => root.render(h(ContextMenu, { anchor, items: items(n), onClose })));
    act(() => { vi.advanceTimersByTime(20); }); // initial rAF focus
}

const menu = () => document.querySelector<HTMLElement>('.ctxm:not(.ctxm--sub)');
const flyout = () => document.querySelector<HTMLElement>('[data-testid="ctxm-flyout"]');
const row = (label: string) =>
    Array.from(menu()!.querySelectorAll<HTMLButtonElement>('.ctxm-row')).find(b => b.textContent === label)!;
const roleRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="role-picker-row"]'));
const search = () => document.querySelector<HTMLInputElement>('[data-testid="role-picker-search"]');

/** Pointer moves from `from` (null = outside the window) onto `to`. */
function pointer(from: Element | null, to: Element, at = { x: 0, y: 0 }) {
    act(() => {
        if (from) from.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to, clientX: at.x, clientY: at.y }));
        else to.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null, clientX: at.x, clientY: at.y }));
    });
}
/** Pointer moves within `el` to `at`. */
function move(el: Element, at: { x: number; y: number }) {
    act(() => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: at.x, clientY: at.y })); });
}
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (el: Element, k: string) =>
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

function hoverRolesOpen() {
    pointer(null, row('Roles'), { x: 150, y: 130 });
    tick(SUBMENU_OPEN_DELAY);
}

beforeEach(() => {
    vi.useFakeTimers();
    setViewport(1024, 768);
    onClose = vi.fn<() => void>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    HTMLElement.prototype.getBoundingClientRect = realRect;
    __resetEscapeStackForTests();
    vi.useRealTimers();
});

describe('Roles ▸ hover flyout', () => {
    it('opens beside the menu on hover after a short delay — no modal, focus stays in the menu', () => {
        mount(4);
        const focused = document.activeElement;
        expect(focused).toBe(row('View Profile'));

        pointer(null, row('Roles'));
        tick(SUBMENU_OPEN_DELAY - 10);
        expect(flyout()).toBeNull(); // sweeping past does not flash it open
        tick(10);

        const fly = flyout()!;
        expect(fly).not.toBeNull();
        expect(fly.getAttribute('role')).toBe('dialog');
        expect(fly.getAttribute('aria-label')).toBe('Roles');
        // Beside the menu (menu at x=100, 220 wide), not on top of it.
        expect(fly.dataset.side).toBe('right');
        expect(parseFloat(fly.style.left)).toBe(100 + 220 + 4);
        expect(fly.style.width).toBe('240px');
        // The menu is still there; nothing else opened a window.
        expect(menu()).not.toBeNull();
        expect(document.querySelector('[data-testid="member-role-picker"]')).toBeNull();
        expect(row('Roles').getAttribute('aria-expanded')).toBe('true');
        // Hover did not pull focus into the flyout.
        expect(document.activeElement).toBe(focused);
        expect(roleRows()).toHaveLength(4);
    });

    it('flips to the left of the menu near the right edge of the window', () => {
        mount(4, { x: 900, y: 100 });
        hoverRolesOpen();
        const menuLeft = parseFloat(menu()!.style.left);
        expect(menuLeft).toBe(900 - 220); // the menu itself flipped left of the click
        const fly = flyout()!;
        expect(fly.dataset.side).toBe('left');
        expect(parseFloat(fly.style.left)).toBe(menuLeft - 240 - 4);
    });

    it('toggling roles keeps the flyout and the menu open (multi-select)', () => {
        mount(4);
        hoverRolesOpen();
        act(() => { roleRows()[0].click(); });
        act(() => { roleRows()[2].click(); });
        tick(2000);
        expect(flyout()).not.toBeNull();
        expect(menu()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(roleRows().map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true', 'false']);
    });

    it('shows the search box over 10 roles, not at 10', () => {
        mount(10);
        hoverRolesOpen();
        expect(roleRows()).toHaveLength(10);
        expect(search()).toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        mount(11);
        hoverRolesOpen();
        expect(search()).not.toBeNull();
        expect(search()!.placeholder).toBe('Search 11 roles');
        // Hover-opened: the search box does NOT steal focus from the menu.
        expect(document.activeElement).not.toBe(search());
    });

    it('→ opens it from the keyboard and focuses the search; Escape closes the flyout, then the menu', () => {
        mount(12);
        key(row('View Profile'), 'ArrowDown');
        expect(document.activeElement).toBe(row('Roles'));
        key(row('Roles'), 'ArrowRight');
        expect(flyout()).not.toBeNull();
        expect(document.activeElement).toBe(search());

        // Escape #1 → just the flyout; focus is handed back to "Roles".
        key(search()!, 'Escape');
        expect(flyout()).toBeNull();
        expect(menu()).not.toBeNull();
        expect(document.activeElement).toBe(row('Roles'));

        // Enter opens it too.
        key(row('Roles'), 'Enter');
        expect(document.activeElement).toBe(search());
        // ArrowLeft in an empty search box backs out to the menu.
        key(search()!, 'ArrowLeft');
        expect(flyout()).toBeNull();
        expect(document.activeElement).toBe(row('Roles'));

        // Escape #2 (no flyout) → the whole menu.
        key(row('Roles'), 'Escape');
        tick(200);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a hover-opened flyout takes focus when → is pressed on it', () => {
        mount(12);
        key(row('View Profile'), 'ArrowDown');
        hoverRolesOpen();
        expect(document.activeElement).toBe(row('Roles'));
        key(row('Roles'), 'ArrowRight');
        expect(document.activeElement).toBe(search());
    });

    it('arrow keys in the menu still work while a hover-opened flyout shows', () => {
        mount(4);
        hoverRolesOpen();
        // Hover moved the menu's highlight to "Roles" (like a native menu);
        // the arrows continue from there, and leaving the row closes the flyout.
        key(document.activeElement!, 'ArrowDown');
        expect(document.activeElement).toBe(row('Kick'));
        expect(flyout()).toBeNull();
        key(row('Kick'), 'ArrowUp');
        expect(document.activeElement).toBe(row('Roles'));
    });

    describe('pointer travel (safe triangle)', () => {
        // jsdom has no layout: give the flyout a real box from its inline style.
        beforeEach(() => {
            HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
                if (this.dataset?.testid === 'ctxm-flyout') {
                    const left = parseFloat(this.style.left) || 0;
                    const top = parseFloat(this.style.top) || 0;
                    return { left, top, right: left + 240, bottom: top + 300, width: 240, height: 300, x: left, y: top, toJSON() {} } as DOMRect;
                }
                return realRect.call(this);
            };
        });

        it('crossing another row diagonally toward the flyout keeps it open', () => {
            mount(4);
            hoverRolesOpen(); // flyout: x 324..564, y 0..300
            // Leave "Roles" at its right end heading down-right; land on "Kick" inside the triangle.
            move(row('Roles'), { x: 300, y: 130 });
            pointer(row('Roles'), row('Kick'), { x: 305, y: 140 });
            tick(SUBMENU_CLOSE_DELAY + 50);
            expect(flyout()).not.toBeNull();
            expect(row('Roles').getAttribute('aria-expanded')).toBe('true');
            // …and it reaches the flyout: stays open for good.
            pointer(row('Kick'), flyout()!, { x: 330, y: 150 });
            tick(SAFE_AREA_GRACE * 3);
            expect(flyout()).not.toBeNull();
        });

        it('a move that leaves the triangle hands over at once', () => {
            mount(4);
            hoverRolesOpen();
            move(row('Roles'), { x: 300, y: 130 });
            pointer(row('Roles'), row('Kick'), { x: 305, y: 140 });
            move(row('Kick'), { x: 200, y: 150 }); // turned back toward the menu
            tick(SUBMENU_CLOSE_DELAY);
            expect(flyout()).toBeNull();
        });

        it('moving to another row away from the flyout closes it', () => {
            mount(4);
            hoverRolesOpen();
            // Straight down off "Roles" onto "Kick": not heading for the flyout.
            move(row('Roles'), { x: 150, y: 130 });
            pointer(row('Roles'), row('Kick'), { x: 150, y: 160 });
            tick(SUBMENU_CLOSE_DELAY);
            expect(flyout()).toBeNull();
        });

        it('resting inside the triangle without reaching the flyout hands over after the grace period', () => {
            mount(4);
            hoverRolesOpen();
            move(row('Roles'), { x: 300, y: 130 });
            pointer(row('Roles'), row('Kick'), { x: 305, y: 140 });
            tick(SAFE_AREA_GRACE - 50);
            expect(flyout()).not.toBeNull();
            tick(50 + SUBMENU_CLOSE_DELAY);
            expect(flyout()).toBeNull();
        });

        it('leaving the menu and the flyout for empty space leaves it open', () => {
            mount(4);
            hoverRolesOpen();
            pointer(row('Roles'), document.body, { x: 40, y: 400 });
            tick(2000);
            expect(flyout()).not.toBeNull();
        });
    });
});

describe('placeFlyout', () => {
    const base = { parentLeft: 100, parentWidth: 220, rowTop: 120, width: 240, height: 300, vw: 1024, vh: 768 };
    it('goes right of the menu when it fits', () => {
        expect(placeFlyout(base)).toEqual({ top: 120, left: 324, side: 'right' });
    });
    it('flips left when the right side would leave the window', () => {
        expect(placeFlyout({ ...base, parentLeft: 700 })).toEqual({ top: 120, left: 456, side: 'left' });
    });
    it('is pulled up so its bottom stays inside the window', () => {
        expect(placeFlyout({ ...base, rowTop: 700 }).top).toBe(768 - 300 - 8);
    });
    it('never goes above the top margin, however tall', () => {
        expect(placeFlyout({ ...base, rowTop: 400, height: 2000 }).top).toBe(8);
    });
});

describe('inSafeTriangle', () => {
    const fly = { left: 324, right: 564, top: 0, bottom: 300 };
    it('is true on the way to the flyout and false away from it', () => {
        expect(inSafeTriangle({ x: 300, y: 130 }, fly, { x: 310, y: 140 })).toBe(true);
        expect(inSafeTriangle({ x: 300, y: 130 }, fly, { x: 150, y: 160 })).toBe(false);
        expect(inSafeTriangle({ x: 300, y: 130 }, fly, { x: 300, y: 200 })).toBe(false);
    });
    it('works for a flyout on the left', () => {
        const left = { left: 100, right: 340, top: 0, bottom: 300 };
        expect(inSafeTriangle({ x: 360, y: 130 }, left, { x: 350, y: 140 })).toBe(true);
        expect(inSafeTriangle({ x: 360, y: 130 }, left, { x: 450, y: 140 })).toBe(false);
    });
});
