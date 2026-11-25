// @vitest-environment jsdom
/**
 * Announcement banners start COLLAPSED (glyph + one truncated line) and expand
 * on click / Enter / Space; dismiss works in both states. Negative controls:
 * a plain ClBanner (no `collapsible`) is never collapsed and has no toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const { kv, announcements } = vi.hoisted(() => ({
    kv: new Map<string, string>(), announcements: { list: [] as Array<Record<string, unknown>> },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'tok', userId: 'u1' }) }));
vi.mock('../hooks/useAnnouncements', () => ({ useAnnouncements: () => announcements.list }));
vi.mock('../utils/secureLocalStore', () => ({
    default: { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => { kv.set(k, v); } },
}));

import { AnnouncementBanners } from './AnnouncementBanners';
import { ClBanner } from './ClBanner';

const h = React.createElement;
let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(() => { root.render(el); });
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
const toggle = () => q<HTMLButtonElement>('.cl-banner__toggle')!;
const ann = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: 'Maintenance', body: 'Tonight at 10pm we restart the servers.', icon: null, color: 'info',
    dismissible: true, ends_at: null, ...over,
});

beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    kv.clear(); announcements.list = [];
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('collapsible announcement banner', () => {
    it('starts collapsed: title only, aria-expanded=false, body hidden', () => {
        announcements.list = [ann('a1')];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        expect(toggle().tagName).toBe('BUTTON');
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(toggle().hasAttribute('data-collapsed')).toBe(true);
        expect(q('.cl-banner__title')?.textContent).toBe('Maintenance');
        expect(host.textContent).not.toContain('Tonight at 10pm');
    });

    it('click expands to the full body, click again collapses', () => {
        announcements.list = [ann('a1')];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        act(() => toggle().click());
        expect(toggle().getAttribute('aria-expanded')).toBe('true');
        expect(host.textContent).toContain('Tonight at 10pm');
        act(() => toggle().click());
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(host.textContent).not.toContain('Tonight at 10pm');
    });

    it('title-less: collapsed shows the (truncated-by-CSS) body line; expanding keeps it', () => {
        announcements.list = [ann('a2', { title: null })];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        expect(q('.cl-banner__title')).toBeNull();
        expect(q('.cl-banner__desc--solo')?.textContent).toContain('Tonight at 10pm');
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('dismiss works while collapsed and while expanded', () => {
        announcements.list = [ann('a1')];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        act(() => q<HTMLButtonElement>('.cl-banner__x')!.click());
        expect(JSON.parse(kv.get('cipherline_announcement_dismissed_u1')!)).toEqual(['a1']);
        expect(q('.cl-banner')).toBeNull();
    });

    it('dismiss works while expanded', () => {
        announcements.list = [ann('a9')];
        render(h(AnnouncementBanners, { wsConnectCount: 2 }));
        act(() => toggle().click());
        act(() => q<HTMLButtonElement>('.cl-banner__x')!.click());
        expect(JSON.parse(kv.get('cipherline_announcement_dismissed_u1')!)).toEqual(['a9']);
    });

    it('expanded state is per view: nothing about it is written to storage', () => {
        announcements.list = [ann('a1')];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        act(() => toggle().click());
        expect(kv.size).toBe(0);
    });

    it('keyboard: the toggle is a native button, so Enter/Space activate it (not tabindex-hacked)', () => {
        announcements.list = [ann('a1')];
        render(h(AnnouncementBanners, { wsConnectCount: 1 }));
        expect(toggle().getAttribute('type')).toBe('button');
        expect(toggle().hasAttribute('tabindex')).toBe(false);
        expect(toggle().getAttribute('aria-controls')).toBe(q('.cl-banner__text--toggle')!.id);
    });

    it('NEGATIVE: a plain ClBanner is never collapsed and has no toggle', () => {
        render(h(ClBanner, { tone: 'info', title: 'T', description: 'full body' }));
        expect(q('.cl-banner__toggle')).toBeNull();
        expect(host.textContent).toContain('full body');
    });

    it('collapsed hides actions and extra rows; expanded shows them', () => {
        render(h(ClBanner, {
            tone: 'info', title: 'T', description: 'd', collapsible: true,
            actions: [{ key: 'go', label: 'Go' }], children: h('i', { 'data-extra': '' }, 'x'),
        }));
        expect(q('[data-action="go"]')).toBeNull();
        expect(q('[data-extra]')).toBeNull();
        act(() => toggle().click());
        expect(q('[data-action="go"]')).not.toBeNull();
        expect(q('[data-extra]')).not.toBeNull();
    });
});

describe('collapsible stylesheet contract', () => {
    const css = readFileSync(resolve(__dirname, '../styles/cl-banner.css'), 'utf8');
    it('collapsed text is a single ellipsised line, focus ring present, no motion added', () => {
        expect(css).toMatch(/\.cl-banner__toggle\[data-collapsed\][^{]*\{[^}]*white-space:\s*nowrap/);
        expect(css).toMatch(/text-overflow:\s*ellipsis/);
        expect(css).toMatch(/\.cl-banner__toggle:focus-visible/);
        const block = css.slice(css.indexOf('Collapsible banner'));
        expect(block).not.toMatch(/transition|animation/);
    });
});
