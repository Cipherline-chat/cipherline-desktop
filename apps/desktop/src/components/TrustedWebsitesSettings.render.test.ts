// @vitest-environment jsdom
/**
 * Settings → Privacy → "Opening links" + "Trusted websites" in a real DOM,
 * over the real encrypted store: a 60-site list with count, search (Unicode +
 * punycode), empty search, a bounded scroll container, keyboard safety, the
 * in-page "Remove all" confirm, and the two warning toggles.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartStore, signIn, wipeStoreDb } from '../utils/externalLinks/testStore.testkit';
import { listTrustedDomains, trustDomain } from '../utils/externalLinks/trustedDomains';
import { getLinkWarningPrefs } from '../utils/externalLinks/linkWarningPrefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let TrustedWebsitesSettings: React.FC;
beforeAll(async () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    TrustedWebsitesSettings = (await import('./TrustedWebsitesSettings')).default;
});

const UID = '44444444-4444-4444-8444-444444444444';
const SIXTY = [
    ...Array.from({ length: 56 }, (_, i) => `site${String(i).padStart(2, '0')}.example.com`),
    'github.com', 'example.co.uk', 'xn--mnchen-3ya.de', '192.168.1.20',
];

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
    await wipeStoreDb();
    await restartStore();
    await signIn(UID);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = () => act(() => root.render(React.createElement(TrustedWebsitesSettings)));
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const rowsShown = () => [...host.querySelectorAll('.tws-domain')].map(e => e.firstChild?.textContent);
const count = () => q('[data-tws-count]')?.textContent;
const search = () => q<HTMLInputElement>('input[aria-label="Search trusted websites"]')!;
function type(value: string) {
    const input = search();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const press = (el: Element, key: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
const clickBtn = (label: string, within: ParentNode = host) => {
    const b = [...within.querySelectorAll('button')].find(x => x.textContent?.trim() === label || x.getAttribute('aria-label') === label)!;
    act(() => { b.click(); });
};

describe('Trusted websites — long list', () => {
    beforeEach(() => { for (const d of SIXTY) expect(trustDomain(d)).toBe(true); });

    it('shows a count, and every row inside ONE bounded scroll container', () => {
        render();
        expect(count()).toBe('60 trusted websites');
        const scroll = q('[data-tws-scroll]')!;
        expect(scroll.getAttribute('role')).toBe('region');
        expect(scroll.querySelectorAll('.tws-item')).toHaveLength(60);
        expect(host.querySelectorAll('.tws-item')).toHaveLength(60); // none outside it
        // The bound itself is CSS (jsdom has no layout): the rule must cap the height and scroll.
        const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/leaving-dialog.css'), 'utf8');
        const rule = /\.tws-scroll\{([^}]*)\}/.exec(css)?.[1] ?? '';
        expect(rule).toMatch(/max-height:min\(320px, 42vh\)/);
        expect(rule).toMatch(/overflow-y:auto/);
    });

    it('search filters as you type, anywhere in the name, case-insensitive, Unicode or punycode', () => {
        render();
        type('SITE1');
        expect(rowsShown()).toEqual(Array.from({ length: 10 }, (_, i) => `site1${i}.example.com`));
        expect(count()).toBe('10 of 60 trusted websites');
        type('münchen');
        expect(rowsShown()).toEqual(['münchen.de']);
        type('xn--mnchen');
        expect(rowsShown()).toEqual(['münchen.de']);
        type('co.uk');
        expect(rowsShown()).toEqual(['example.co.uk']);
    });

    it('an empty search says so, and clearing it brings the list back', () => {
        render();
        type('nothing-like-this');
        expect(q('[data-tws-nomatch]')?.textContent).toBe('No trusted websites match “nothing-like-this”.');
        expect(count()).toBe('0 of 60 trusted websites');
        act(() => { search().focus(); });
        press(search(), 'Escape'); // Esc clears a non-empty, focused search (shared escape stack)
        expect(search().value).toBe('');
        expect(host.querySelectorAll('.tws-item')).toHaveLength(60);
    });

    it('keyboard: Enter in the search removes nothing; Remove buttons are real, tabbable buttons', () => {
        render();
        type('github');
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        act(() => { search().dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
        expect(listTrustedDomains()).toHaveLength(60);
        expect(search().tabIndex).not.toBe(-1);
        const removes = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove "]')].filter(b => b.getAttribute('aria-label') !== 'Remove all trusted websites');
        expect(removes.length).toBeGreaterThan(0);
        for (const b of removes) { expect(b.tabIndex).not.toBe(-1); expect(b.disabled).toBe(false); }
        clickBtn('Remove github.com from trusted websites');
        expect(listTrustedDomains()).toHaveLength(59);
        expect(listTrustedDomains()).not.toContain('github.com');
    });

    it('"Remove all" asks in the page first: Cancel / Esc keep everything, confirming clears the list', () => {
        render();
        clickBtn('Remove all trusted websites');
        const confirm = q('[data-tws-confirm]')!;
        expect(confirm.textContent).toContain('Remove all 60 trusted websites?');
        expect(document.activeElement?.textContent?.trim()).toBe('Cancel'); // focus on the safe choice
        clickBtn('Cancel', confirm);
        expect(q('[data-tws-confirm]')).toBeNull();
        expect(listTrustedDomains()).toHaveLength(60);
        clickBtn('Remove all trusted websites');
        press(q('[data-tws-confirm]')!, 'Escape');
        expect(q('[data-tws-confirm]')).toBeNull();
        expect(listTrustedDomains()).toHaveLength(60);
        clickBtn('Remove all trusted websites');
        clickBtn('Remove all', q('[data-tws-confirm]')!);
        expect(listTrustedDomains()).toEqual([]);
        expect(host.textContent).toContain('No trusted websites yet.');
    });
});

describe('Opening links — the two toggles', () => {
    const toggle = (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    it('defaults: warn ON, suspicious ON but grayed out (only matters when warnings are off)', () => {
        render();
        expect(toggle('Warn before opening links').getAttribute('aria-checked')).toBe('true');
        const sub = toggle('Still warn about suspicious links');
        expect(sub.getAttribute('aria-checked')).toBe('true');
        expect(sub.disabled).toBe(true);
        expect(q('[data-setting="link-warnings-suspicious"]')?.getAttribute('aria-disabled')).toBe('true');
        expect(host.textContent).toContain('Recommended');
        expect(host.textContent).toContain('how phishing links hide where they really go');
    });

    it('turning warnings off enables the sub-toggle; both can be turned off ("never warn")', () => {
        render();
        act(() => { toggle('Warn before opening links').click(); });
        expect(getLinkWarningPrefs()).toEqual({ warn: false, warnSuspicious: true });
        const sub = toggle('Still warn about suspicious links');
        expect(sub.disabled).toBe(false);
        act(() => { sub.click(); });
        expect(getLinkWarningPrefs()).toEqual({ warn: false, warnSuspicious: false });
        act(() => { toggle('Warn before opening links').click(); });
        expect(getLinkWarningPrefs()).toEqual({ warn: true, warnSuspicious: false });
        expect(toggle('Still warn about suspicious links').disabled).toBe(true);
    });
});
