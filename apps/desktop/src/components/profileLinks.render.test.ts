// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileCardLinks } from './ProfileCardParts';
import { ProfileLinksEditor } from './settings/panes/ProfileLinksEditor';
import { LINK_PLATFORMS, PROFILE_LINKS_MAX, type ProfileLink } from '../utils/profileLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const h = React.createElement as (...a: any[]) => React.ReactElement;
const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

const LINKS: ProfileLink[] = [
    { platform: 'steam', handle: 'gaben' },
    { platform: 'x', handle: 'jack' },
    { platform: 'discord', handle: 'some.one' },
];

describe('ProfileCardLinks (card rendering)', () => {
    it('renders a chip per link with the platform icon and handle, in order', () => {
        const out = html(h(ProfileCardLinks, { links: LINKS }));
        expect(out).toContain('data-testid="profile-links"');
        expect(out).toContain('Links');
        expect(out.indexOf('gaben')).toBeLessThan(out.indexOf('@jack'));
        expect(out.indexOf('@jack')).toBeLessThan(out.indexOf('some.one'));
        expect((out.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(3);
        for (const p of ['steam', 'x', 'discord']) expect(out).toContain(`data-platform="${p}"`);
    });
    it('every platform has a glyph', () => {
        for (const p of LINK_PLATFORMS) {
            const handle = { steam: 'gaben', x: 'jack', instagram: 'abc', tiktok: 'abc', youtube: 'abc', twitch: 'abcd', github: 'abc', reddit: 'abc', spotify: 'abc', discord: 'abc', bluesky: 'a.bsky.social', medal: 'abc' }[p];
            expect(html(h(ProfileCardLinks, { links: [{ platform: p, handle }] }))).toContain('<svg');
        }
    });
    it('says Unverified for assistive tech; Discord is text (no button), others are buttons', () => {
        const out = html(h(ProfileCardLinks, { links: LINKS }));
        expect(out).toContain('Unverified');
        expect((out.match(/<button/g) ?? []).length).toBe(2);
        expect(out).toMatch(/<span[^>]*data-platform="discord"/);
    });
    it('nothing for none / null / only-garbage; garbage entries and extra keys are dropped; text is escaped', () => {
        expect(html(h(ProfileCardLinks, { links: [] }))).toBe('');
        expect(html(h(ProfileCardLinks, { links: null }))).toBe('');
        expect(html(h(ProfileCardLinks, { links: [{ platform: 'website', handle: 'https://evil.example' }] }))).toBe('');
        const out = html(h(ProfileCardLinks, { links: [{ platform: 'github', handle: '<b>x</b>' }, { platform: 'github', handle: 'octocat', url: 'https://evil.example' }] }));
        expect(out).not.toContain('<b>x</b>');
        expect(out).not.toContain('evil.example');
        expect(out).toContain('octocat');
    });
    it('shows at most 6 links', () => {
        const many = Array.from({ length: 9 }, (_, i) => ({ platform: 'reddit', handle: `user_${i}abc` }));
        expect((html(h(ProfileCardLinks, { links: many })).match(/data-platform=/g) ?? []).length).toBe(PROFILE_LINKS_MAX);
    });
    it('friends-only lock follows the flag', () => {
        expect(html(h(ProfileCardLinks, { links: LINKS, friendsOnly: true }))).toContain('data-friends-only');
        expect(html(h(ProfileCardLinks, { links: LINKS }))).not.toContain('data-friends-only');
    });
});

describe('ProfileCardLinks click -> safe open path', () => {
    let host: HTMLDivElement; let root: Root;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

    it('clicking a chip calls onOpen with that link only', () => {
        const onOpen = vi.fn();
        act(() => root.render(h(ProfileCardLinks, { links: LINKS, onOpen })));
        act(() => { host.querySelector<HTMLButtonElement>('[data-platform="x"]')!.click(); });
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledWith({ platform: 'x', handle: 'jack' });
    });
    it('by default a click reaches electronAPI.openExternal with the template URL (and Discord opens nothing)', () => {
        const openExternal = vi.fn().mockResolvedValue(undefined);
        const original = window.electronAPI;
        window.electronAPI = { ...(window.electronAPI ?? {}), openExternal } as typeof window.electronAPI;
        try {
            act(() => root.render(h(ProfileCardLinks, { links: LINKS })));
            act(() => { host.querySelector<HTMLButtonElement>('[data-platform="steam"]')!.click(); });
            expect(openExternal).toHaveBeenCalledWith('https://steamcommunity.com/id/gaben');
            act(() => { host.querySelector<HTMLElement>('[data-platform="discord"]')!.click(); });
            expect(openExternal).toHaveBeenCalledTimes(1);
        } finally { window.electronAPI = original; }
    });
    it('the card has no other way to open a URL (no <a href>, no direct openExternal / window.open)', () => {
        const src = read('./ProfileCardParts.tsx');
        const start = src.indexOf('const ProfileLinkChip');
        const part = src.slice(start, src.indexOf('/** Shown only when THIS device', start));
        expect(part).not.toMatch(/<a[\s>]|href=|window\.open|electronAPI|openExternal\(/);
        expect(part).toContain('onOpen(link)');
        expect(src).toContain('openProfileLink');
    });
});

describe('ProfileLinksEditor (one combined control)', () => {
    let host: HTMLDivElement; let root: Root;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });

    const type = (el: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    const input = () => host.querySelector<HTMLInputElement>('#pc-link-input')!;
    const enter = () => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    const msg = () => host.querySelector('[role="alert"]')?.textContent ?? '';
    const pick = () => host.querySelector<HTMLButtonElement>('.ps-combo-pick')!;

    it('a pasted link picks its own platform and shows the handle as a chip preview; Enter adds it', () => {
        const onChange = vi.fn();
        act(() => root.render(h(ProfileLinksEditor, { links: [], onChange })));
        type(input(), 'https://www.twitch.tv/somebody');
        expect(pick().getAttribute('aria-label')).toMatch(/Twitch/);
        expect(host.querySelector('.ps-combo-preview')!.textContent).toContain('@somebody');
        enter();
        expect(onChange).toHaveBeenCalledWith([{ platform: 'twitch', handle: 'somebody' }]);
    });
    it('a link to another website or a bad handle says why inline and adds nothing', () => {
        const onChange = vi.fn();
        act(() => root.render(h(ProfileLinksEditor, { links: [], onChange })));
        type(input(), 'https://evil.example/id/gaben');
        expect(msg()).toMatch(/Only steamcommunity.com links/);
        enter();
        type(input(), 'a b c');
        expect(msg()).toMatch(/Not a Steam handle/);
        enter();
        expect(onChange).not.toHaveBeenCalled();
        expect(host.querySelector('.ps-combo-preview')).toBeNull();
    });
    it('rejects a duplicate and stops at 6', () => {
        const onChange = vi.fn();
        act(() => root.render(h(ProfileLinksEditor, { links: [{ platform: 'steam', handle: 'gaben' }], onChange })));
        act(() => pick().click());
        act(() => [...host.querySelectorAll<HTMLButtonElement>('.ps-plat')].find((b) => b.textContent === 'Steam')!.click());
        type(input(), 'gaben');
        expect(msg()).toMatch(/Already on your profile/);
        enter();
        expect(onChange).not.toHaveBeenCalled();
        const six = Array.from({ length: 6 }, (_, i) => ({ platform: 'reddit' as const, handle: `user_${i}abc` }));
        act(() => root.render(h(ProfileLinksEditor, { links: six, onChange })));
        expect(input().hasAttribute('disabled')).toBe(true);
        expect(msg()).toMatch(/most links \(6\)/);
    });
    it('remove (x / Delete) and reorder (Alt + arrows) call onChange with the new order', () => {
        const onChange = vi.fn();
        const links: ProfileLink[] = [{ platform: 'steam', handle: 'gaben' }, { platform: 'x', handle: 'jack' }];
        act(() => root.render(h(ProfileLinksEditor, { links, onChange })));
        const chips = () => [...host.querySelectorAll<HTMLElement>('[data-chip]')];
        act(() => { chips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })); });
        expect(onChange).toHaveBeenLastCalledWith([links[1], links[0]]);
        act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove X link @jack"]')!.click());
        expect(onChange).toHaveBeenLastCalledWith([links[0]]);
        act(() => { chips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
        expect(onChange).toHaveBeenLastCalledWith([links[1]]);
    });
    it('a verified Steam account leads with a tick and cannot be removed here', () => {
        act(() => root.render(h(ProfileLinksEditor, { links: [{ platform: 'x', handle: 'jack' }], onChange: vi.fn(), verifiedSteam: { label: 'gabe' } })));
        const first = host.querySelector('[data-chip]')!;
        expect(first.textContent).toContain('gabe');
        expect(first.querySelector('[aria-label="Verified"]')).not.toBeNull();
        expect(first.querySelector('.ps-rchip-x')).toBeNull();
    });
    it('offers only the closed platform list (no website option)', () => {
        const src = read('./settings/panes/ProfileLinksEditor.tsx');
        expect(src).toContain('LINK_PLATFORMS.map');
        expect(src).not.toMatch(/['"]website['"]|custom url/i);
    });
});
