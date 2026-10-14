// @vitest-environment jsdom
/**
 * PurgeDropdown — the "Purge older than…" menu in Settings → Storage.
 *
 * It is a real ARIA menu now (role=menu / menuitem, roving focus), not a stack
 * of kit buttons:
 *   - five menuitems; ONLY "Everything" carries the destructive styling;
 *   - per-row "N msgs" hints appear when the caller hands over the messages
 *     (or precomputed counts) and are absent when it does not;
 *   - ArrowUp/Down (wrapping), Home/End, Enter/Space select, Esc closes and
 *     returns focus to the trigger, outside click closes;
 *   - onSelect(ms, label) fires with the right window, and the menu closes;
 *   - placement flips above the trigger when there is no room below;
 *   - the entrance animation is switched off under prefers-reduced-motion
 *     (jsdom has no media queries, so that one pins the stylesheet source —
 *     with a negative control proving the pin can actually fail).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The kit's clPhysics module queries matchMedia at import time; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

import { PurgeDropdown, PURGE_OPTIONS, countMessagesToPurge } from './PurgeControls';
import { formatPurgeCount, computePurgeMenuPlacement } from '../utils/purgeMenuPlacement';

const DAY = 24 * 3600 * 1000;
const MS = Object.fromEntries(PURGE_OPTIONS.map(o => [o.label, o.ms])) as Record<string, number>;

let host: HTMLElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn<(ms: number, label: string) => void>>;

function render(props: Partial<React.ComponentProps<typeof PurgeDropdown>> = {}) {
    act(() => {
        root.render(React.createElement(PurgeDropdown, { onSelect, ...props }));
    });
}

const trigger = () => host.querySelector('button.purge-trigger') as HTMLButtonElement;
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null;
const items = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
const labelOf = (el: Element) => el.querySelector('.clabel')?.textContent;
const hintOf = (el: Element) => el.querySelector('.ctxm-acc')?.textContent ?? null;

function openMenu() {
    act(() => { trigger().click(); });
}

function key(target: Element, type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}) {
    act(() => {
        target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init }));
    });
}
const press = (k: string) => key(document.activeElement as Element, 'keydown', k);

function mousedownOutside() {
    act(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        // A real click is mousedown+mouseup+click; useDismissOnOutsideClick swallows the trailing
        // two with one-shot listeners, so finish the gesture or they'd eat the NEXT test's click.
        document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
}

/** Messages spread over known ages, plus an unsent one that is never purged. */
function sampleMessages() {
    const now = Date.now();
    const at = (days: number) => ({ timestamp: now - days * DAY });
    return [
        at(400), at(400), at(400),         // older than 1 year
        at(100), at(100),                  // older than 1 month, newer than 6 months
        at(10), at(10), at(10), at(10),    // older than 1 week, newer than 1 month
        at(2), at(2), at(2), at(2), at(2), // this week
        { timestamp: now - 900 * DAY, _pending: true },
    ];
}

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host') as HTMLElement;
    root = createRoot(host);
    onSelect = vi.fn<(ms: number, label: string) => void>();
});

afterEach(() => {
    act(() => { root.unmount(); });
    document.body.innerHTML = '';
});

describe('PurgeDropdown trigger', () => {
    it('is a closed menu button until clicked', () => {
        render();
        expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(trigger().textContent).toContain('Purge older than…');
        expect(menu()).toBeNull();

        openMenu();
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(menu()).not.toBeNull();
        expect(trigger().getAttribute('aria-controls')).toBe(menu()!.id);
    });

    it('opens on ArrowDown from the trigger; a disabled trigger never opens', () => {
        render();
        key(trigger(), 'keydown', 'ArrowDown');
        expect(menu()).not.toBeNull();

        act(() => { root.unmount(); });
        root = createRoot(host);
        render({ disabled: true });
        act(() => { trigger().click(); });
        key(trigger(), 'keydown', 'ArrowDown');
        expect(menu()).toBeNull();
    });
});

describe('PurgeDropdown menu structure', () => {
    it('renders five menuitems in a role=menu, danger styling ONLY on Everything', () => {
        render();
        openMenu();
        const rows = items();
        expect(menu()!.getAttribute('role')).toBe('menu');
        expect(rows.map(labelOf)).toEqual(['1 year', '6 months', '1 month', '1 week', 'Everything']);

        const danger = rows.filter(r => r.classList.contains('danger'));
        expect(danger.map(labelOf)).toEqual(['Everything']);
        // Everything: Trash2 icon, preceded by a divider. The time rows: no icon.
        expect(rows[4].querySelector('.ci svg')).not.toBeNull();
        expect(rows.slice(0, 4).every(r => r.querySelector('.ci') === null)).toBe(true);
        expect(rows[4].previousElementSibling?.getAttribute('role')).toBe('separator');
        // Not the old stack of kit buttons.
        expect(menu()!.querySelector('.clb')).toBeNull();
    });

    it('portals the panel to <body>, outside the trigger wrapper', () => {
        render();
        openMenu();
        expect(host.contains(menu())).toBe(false);
        expect(menu()!.parentElement?.parentElement).toBe(document.body);
    });

    it('focuses the first item on open, with a roving tabindex', () => {
        render();
        openMenu();
        const rows = items();
        expect(document.activeElement).toBe(rows[0]);
        expect(rows.map(r => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    });
});

describe('PurgeDropdown counts', () => {
    it('shows how many messages each option would delete when messages are given', () => {
        const messages = sampleMessages();
        render({ messages });
        openMenu();
        const hints = items().map(hintOf);
        expect(hints).toEqual(['3 msgs', '3 msgs', '5 msgs', '9 msgs', '14 msgs']);
        // Same numbers the confirm modal will use.
        expect(items().map((_, i) => countMessagesToPurge(messages, PURGE_OPTIONS[i].ms))).toEqual([3, 3, 5, 9, 14]);
    });

    it('prefers explicit counts, and singularises 1 msg / groups thousands', () => {
        render({ counts: { [MS['1 year']]: 1, [MS['Everything']]: 12345 }, messages: sampleMessages() });
        openMenu();
        const hints = items().map(hintOf);
        expect(hints[0]).toBe('1 msg');
        expect(hints[4]).toBe(formatPurgeCount(12345));
        expect(hints[4]).toMatch(/^12.?345 msgs$/);
        // Unspecified windows fall back to counting the messages.
        expect(hints[2]).toBe('5 msgs');
    });

    it('NEGATIVE CONTROL: with neither messages nor counts there are no hints at all', () => {
        render();
        openMenu();
        expect(items().map(hintOf)).toEqual([null, null, null, null, null]);
        expect(menu()!.querySelector('.ctxm-acc')).toBeNull();
    });

    it('shows zero as "0 msgs" for an empty conversation (still selectable)', () => {
        render({ messages: [] });
        openMenu();
        expect(items().map(hintOf)).toEqual(Array(5).fill('0 msgs'));
        expect(items().every(r => !r.disabled)).toBe(true);
    });
});

describe('PurgeDropdown keyboard', () => {
    it('ArrowDown / ArrowUp move focus and wrap', () => {
        render();
        openMenu();
        const rows = items();
        press('ArrowDown');
        expect(document.activeElement).toBe(rows[1]);
        press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
        expect(document.activeElement).toBe(rows[4]);
        press('ArrowDown');                       // wraps to the top
        expect(document.activeElement).toBe(rows[0]);
        press('ArrowUp');                         // and back to the bottom
        expect(document.activeElement).toBe(rows[4]);
        press('ArrowUp');
        expect(document.activeElement).toBe(rows[3]);
        expect(rows.map(r => r.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    });

    it('Home / End jump to the first / last item', () => {
        render();
        openMenu();
        const rows = items();
        press('End');
        expect(document.activeElement).toBe(rows[4]);
        press('Home');
        expect(document.activeElement).toBe(rows[0]);
    });

    it('Enter selects the focused item with the right window', () => {
        render();
        openMenu();
        press('ArrowDown'); press('ArrowDown');   // 1 month
        press('Enter');
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(30 * DAY, '1 month');
        expect(menu()).toBeNull();
    });

    it('Enter held down (auto-repeat) does not select', () => {
        render();
        openMenu();
        key(document.activeElement as Element, 'keydown', 'Enter', { repeat: true });
        expect(onSelect).not.toHaveBeenCalled();
        expect(menu()).not.toBeNull();
    });

    it('Space selects on key RELEASE, not on press (the confirm modal autofocuses a destructive button)', () => {
        render();
        openMenu();
        press('End');
        press(' ');
        expect(onSelect).not.toHaveBeenCalled();
        key(document.activeElement as Element, 'keyup', ' ');
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(0, 'Everything');
    });

    it('Escape closes the menu and returns focus to the trigger', () => {
        render();
        openMenu();
        press('ArrowDown');
        expect(document.activeElement).toBe(items()[1]);
        act(() => {
            (document.activeElement as Element).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(menu()).toBeNull();
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger());
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('Tab closes the menu without selecting', () => {
        render();
        openMenu();
        press('Tab');
        expect(menu()).toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
    });
});

describe('PurgeDropdown pointer', () => {
    it.each(PURGE_OPTIONS.map(o => [o.label, o.ms] as const))('clicking "%s" calls onSelect(%s ms, label), closes, and refocuses the trigger', (label, ms) => {
        render();
        openMenu();
        const row = items().find(r => labelOf(r) === label)!;
        act(() => { row.click(); });
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(ms, label);
        expect(menu()).toBeNull();
        expect(document.activeElement).toBe(trigger());
    });

    it('hovering a row moves the focus/tint to it', () => {
        render();
        openMenu();
        const rows = items();
        expect(rows[0].classList.contains('focus')).toBe(true);
        // React derives onMouseEnter from a bubbling mouseover.
        act(() => { rows[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        expect(rows[2].classList.contains('focus')).toBe(true);
        expect(rows[0].classList.contains('focus')).toBe(false);
        expect(document.activeElement).toBe(rows[2]);
    });

    it('an outside click closes the menu without selecting', () => {
        render();
        openMenu();
        mousedownOutside();
        expect(menu()).toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('NEGATIVE CONTROL: a mousedown inside the panel does NOT close it', () => {
        render();
        openMenu();
        act(() => {
            items()[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        });
        expect(menu()).not.toBeNull();
    });

    it('clicking the trigger again toggles it closed', () => {
        render();
        openMenu();
        act(() => { trigger().click(); });
        expect(menu()).toBeNull();
    });

    it('removes the panel from <body> when the component unmounts open', () => {
        render();
        openMenu();
        act(() => { root.unmount(); });
        root = createRoot(host);
        expect(menu()).toBeNull();
    });
});

describe('computePurgeMenuPlacement', () => {
    const vp = { width: 1280, height: 800 };
    const trig = (top: number) => ({ top, bottom: top + 32, left: 400, width: 300 });

    it('opens below the trigger when it fits', () => {
        const p = computePurgeMenuPlacement(trig(200), 190, vp);
        expect(p.side).toBe('below');
        expect(p.top).toBe(200 + 32 + 4);
        expect(p.left).toBe(400);
        expect(p.width).toBe(300);
    });

    it('flips above when there is no room below but room above', () => {
        const p = computePurgeMenuPlacement(trig(700), 190, vp);
        expect(p.side).toBe('above');
        expect(p.top).toBe(700 - 4 - 190);
        expect(p.top + 190).toBeLessThanOrEqual(700);   // never covers the trigger
    });

    it('NEGATIVE CONTROL: stays below when above is even tighter', () => {
        const p = computePurgeMenuPlacement(trig(60), 190, { width: 1280, height: 200 });
        expect(p.side).toBe('below');
    });

    it('never covers the trigger: when neither side fits it takes the roomier one and caps the height', () => {
        // 340px viewport, trigger at 154..186: 142px above, 142px below... make above roomier.
        const t = { top: 170, bottom: 202, left: 400, width: 300 };
        const p = computePurgeMenuPlacement(t, 400, { width: 1280, height: 340 });
        expect(p.side).toBe('above');
        expect(p.maxHeight).toBe(170 - 4 - 8);
        expect(p.top + p.maxHeight!).toBeLessThanOrEqual(t.top);   // bottom edge clears the trigger
        expect(p.top).toBeGreaterThanOrEqual(8);
        const below = computePurgeMenuPlacement({ top: 40, bottom: 72, left: 0, width: 300 }, 400, { width: 1280, height: 340 });
        expect(below.side).toBe('below');
        expect(below.maxHeight).toBe(340 - 8 - (72 + 4));
        expect(below.top).toBe(76);
    });

    it('does not cap the height when the whole panel fits', () => {
        expect(computePurgeMenuPlacement(trig(200), 190, vp).maxHeight).toBeUndefined();
        expect(computePurgeMenuPlacement(trig(700), 190, vp).maxHeight).toBeUndefined();
    });

    it('widens a narrow trigger to a readable minimum and keeps the panel on screen', () => {
        const p = computePurgeMenuPlacement({ top: 100, bottom: 132, left: 1200, width: 120 }, 190, vp);
        expect(p.width).toBeGreaterThanOrEqual(208);
        expect(p.left + p.width).toBeLessThanOrEqual(vp.width - 8);
        const q = computePurgeMenuPlacement({ top: 100, bottom: 132, left: -50, width: 300 }, 190, vp);
        expect(q.left).toBeGreaterThanOrEqual(8);
    });

    it('is reflected on the rendered panel (data-side + transform origin)', () => {
        render();
        openMenu();
        // jsdom has no layout: the trigger rect is all zeros, so it fits below.
        expect(menu()!.getAttribute('data-side')).toBe('below');
        expect(menu()!.style.getPropertyValue('--purge-origin')).toBe('top left');
    });
});

describe('reduced motion (stylesheet pin)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, '..', 'styles', 'purge-menu.css'), 'utf8');

    /** The entrance animation is declared, AND a reduced-motion block turns it off. */
    function entranceIsMotionSafe(source: string): boolean {
        const declaresAnimation = /\.purge-menu\.ctxm\s*\{[^}]*animation\s*:\s*purge-menu-in/.test(source);
        const m = source.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
        const offUnderReduce = !!m && /\.purge-menu\.ctxm\s*\{[^}]*animation\s*:\s*none[^}]*opacity\s*:\s*1[^}]*transform\s*:\s*none/.test(m[1]);
        return declaresAnimation && offUnderReduce;
    }

    it('animates the entrance, and disables it (visible, no transform) under prefers-reduced-motion', () => {
        expect(entranceIsMotionSafe(css)).toBe(true);
    });

    it('NEGATIVE CONTROL: the same check fails if the reduced-motion block is removed', () => {
        const stripped = css.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\}\s*$/, '');
        expect(stripped).not.toBe(css);
        expect(entranceIsMotionSafe(stripped)).toBe(false);
    });

    it('the stylesheet is loaded by the component', () => {
        const src = readFileSync(join(here, 'PurgeControls.tsx'), 'utf8');
        expect(src).toMatch(/import '\.\.\/styles\/purge-menu\.css'/);
    });

    it('does not ship the chunky kit-button menu any more', () => {
        const src = readFileSync(join(here, 'PurgeControls.tsx'), 'utf8');
        const dropdown = src.slice(src.indexOf('export const PurgeDropdown'), src.indexOf('interface PurgeConfirmModalProps'));
        expect(dropdown).not.toMatch(/<ClButton/);
        expect(dropdown).not.toMatch(/role="listbox"/);
    });
});
