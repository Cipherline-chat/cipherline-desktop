// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mount check for the profile Time zone picker: the app's own ClSelect (with
 * its opt-in search), not a native <datalist>. Search filters, arrows + Enter
 * pick, Escape closes and hands focus back to the trigger, typing on the
 * closed trigger opens it pre-searched, and Tab can't leave the popover.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: true, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
    // jsdom has no layout: scrollIntoView doesn't exist.
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

const { TimeZonePicker } = await import('./TimeZonePicker');

const JAN = new Date('2026-01-15T02:41:00Z');
const here = dirname(fileURLToPath(import.meta.url));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const trigger = () => host.querySelector<HTMLButtonElement>('button.selt')!;
const searchBox = () => document.querySelector<HTMLInputElement>('.selm--search input');
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.selm--search [role="option"]')];
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });

function typeInto(input: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function mount(value = 'America/Chicago', onChange: (z: string) => void = () => {}) {
    act(() => root.render(React.createElement(TimeZonePicker, { id: 'tz', value, onChange, now: () => JAN })));
    await tick(); // the full list is built just after first paint
}

async function open() {
    act(() => trigger().click());
    await tick(20); // portal mount + rAF + focus
}

describe('TimeZonePicker', () => {
    it('is a styled ClSelect trigger showing the friendly current zone — no native datalist', async () => {
        await mount();
        const t = trigger();
        expect(t.id).toBe('tz');
        expect(t.getAttribute('aria-haspopup')).toBe('listbox');
        expect(t.textContent).toBe('Chicago (America) — UTC−06:00');
        expect(document.querySelector('datalist')).toBeNull();
        expect(document.querySelector('input[list]')).toBeNull();
    });

    it('opens with the whole zone list, the search field focused and the current zone selected', async () => {
        await mount();
        await open();
        const input = searchBox();
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        expect(input!.getAttribute('role')).toBe('combobox');
        expect(Number(rows()[0].getAttribute('aria-setsize'))).toBeGreaterThan(300);
        const selected = rows().filter((r) => r.getAttribute('aria-selected') === 'true');
        expect(selected).toHaveLength(1);
        expect(selected[0].textContent).toContain('Chicago (America) — UTC−06:00, 8:41 PM');
        expect(selected[0].textContent).toContain('America/Chicago');
        // The highlighted (active) row is the selected one.
        expect(input!.getAttribute('aria-activedescendant')).toBe(selected[0].id);
    });

    it('search filters the list ("chi"), and Enter picks the highlighted match', async () => {
        const onChange = vi.fn();
        await mount('UTC', onChange);
        await open();
        typeInto(searchBox()!, 'chi');
        const shown = rows();
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.length).toBeLessThan(20);
        expect(shown[0].textContent!.toLowerCase()).toMatch(/^chi/);
        const target = shown.find((r) => r.textContent!.includes('America/Chicago'))!;
        const targetIndex = Number(target.getAttribute('aria-posinset')) - 1;
        for (let i = 0; i < targetIndex; i++) key(searchBox()!, 'ArrowDown');
        expect(searchBox()!.getAttribute('aria-activedescendant')).toBe(target.id);
        key(searchBox()!, 'Enter');
        await tick(250); // the row's pick flash, then the change lands
        expect(onChange).toHaveBeenCalledWith('America/Chicago');
    });

    it('offset search ("UTC-6") lists only zones at that offset', async () => {
        await mount();
        await open();
        typeInto(searchBox()!, 'UTC-6');
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().every((r) => r.textContent!.includes('UTC−06:00'))).toBe(true);
    });

    it('windows the long list: only rows near the view are mounted, but the set size is the whole list', async () => {
        await mount();
        await open();
        const mounted = rows();
        expect(mounted.length).toBeGreaterThan(0);
        expect(mounted.length).toBeLessThan(40);
        expect(Number(mounted[0].getAttribute('aria-setsize'))).toBeGreaterThan(300);
        // The selected row is mounted (scrolled to on open), with its true position.
        const sel = mounted.find((r) => r.getAttribute('aria-selected') === 'true')!;
        expect(Number(sel.getAttribute('aria-posinset'))).toBeGreaterThan(1);
        // A broad query is still windowed.
        typeInto(searchBox()!, 'a');
        expect(rows().length).toBeLessThan(40);
        expect(Number(rows()[0].getAttribute('aria-setsize'))).toBeGreaterThan(100);
    });

    it('says so when nothing matches', async () => {
        await mount();
        await open();
        typeInto(searchBox()!, 'zzqqxx');
        expect(rows()).toHaveLength(0);
        expect(document.querySelector('.selm-empty')!.textContent).toContain('zzqqxx');
    });

    it('Escape closes without changing the value and returns focus to the trigger', async () => {
        const onChange = vi.fn();
        await mount('America/Chicago', onChange);
        await open();
        typeInto(searchBox()!, 'paris');
        key(searchBox()!, 'Escape');
        await tick(250);
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(searchBox()).toBeNull();
        expect(document.activeElement).toBe(trigger());
        expect(onChange).not.toHaveBeenCalled();
    });

    it('typing on the focused, closed trigger opens it already searching that character', async () => {
        await mount();
        trigger().focus();
        key(trigger(), 't');
        await tick(20);
        expect(searchBox()!.value).toBe('t');
        expect(document.activeElement).toBe(searchBox());
        expect(rows().length).toBeGreaterThan(0);
    });

    it('Tab stays inside the popover (focus trap)', async () => {
        await mount();
        await open();
        const input = searchBox()!;
        const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        act(() => { input.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
        // Rows are not tab stops; the field is the only one.
        expect(rows().every((r) => r.tabIndex === -1)).toBe(true);
    });

    it('ProfilePane uses the picker, not the old <input list> + <datalist>', () => {
        const src = readFileSync(join(here, 'ProfilePane.tsx'), 'utf8');
        expect(src).toContain('<TimeZonePicker');
        expect(src).not.toMatch(/<datalist/);
        expect(src).not.toMatch(/list="pf-time-zone-list"/);
    });
});
