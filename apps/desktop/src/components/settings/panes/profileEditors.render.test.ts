// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const post = vi.fn();
const del = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a), delete: (...a: unknown[]) => del(...a), isAxiosError: () => false } }));
const opened: string[] = [];
vi.mock('../../../utils/openExternalLink', () => ({ openExternalLink: (u: string) => { opened.push(u); return { ok: /^https:/.test(u) }; } }));
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));

import { ProfileGamesEditor } from './ProfileGamesEditor';
import { SteamConnect } from './SteamConnect';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (...a: any[]) => React.ReactElement;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); post.mockReset(); del.mockReset(); opened.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const type = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra })); });

describe('ProfileGamesEditor (tag input)', () => {
    it('Enter and a comma add; duplicates and over-long names are refused inline', () => {
        const onChange = vi.fn();
        act(() => root.render(h(ProfileGamesEditor, { games: ['Hades'], onChange })));
        const input = host.querySelector<HTMLInputElement>('#pc-game-input')!;
        type(input, 'Celeste'); key(input, 'Enter');
        expect(onChange).toHaveBeenLastCalledWith(['Hades', 'Celeste']);
        type(input, 'Outer Wilds,');
        expect(onChange).toHaveBeenLastCalledWith(['Hades', 'Outer Wilds']);
        type(input, 'hades'); key(input, 'Enter');
        expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Already on your list/);
        type(input, 'x'.repeat(41)); key(input, 'Enter');
        expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/under 41 characters/);
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(host.textContent).not.toMatch(/filter/i);
    });
    it('Backspace on an empty field removes the last game; full list disables the field', () => {
        const onChange = vi.fn();
        act(() => root.render(h(ProfileGamesEditor, { games: ['A', 'B'], onChange })));
        key(host.querySelector('#pc-game-input')!, 'Backspace');
        expect(onChange).toHaveBeenLastCalledWith(['A']);
        act(() => root.render(h(ProfileGamesEditor, { games: ['1', '2', '3', '4', '5'], onChange })));
        expect(host.querySelector('#pc-game-input')!.hasAttribute('disabled')).toBe(true);
    });
});

describe('SteamConnect', () => {
    it('Connect asks the server for a one-time link and opens it in the browser, then waits', async () => {
        post.mockResolvedValue({ data: { url: 'https://api.cipherline.chat/v1/steam/openid/start?state=abc' } });
        act(() => root.render(h(SteamConnect, { token: 't', userId: 'u', linked: false, card: null, onChanged: vi.fn() })));
        const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Connect Steam')!;
        await act(async () => { btn.click(); });
        expect(post).toHaveBeenCalledWith(expect.stringMatching(/\/steam\/link$/), {}, expect.any(Object));
        expect(opened).toEqual(['https://api.cipherline.chat/v1/steam/openid/start?state=abc']);
        expect(host.textContent).toMatch(/Finish in your browser/);
    });
    it('never sends a SteamID; unlink asks first', async () => {
        del.mockResolvedValue({ data: { ok: true } });
        const onChanged = vi.fn();
        act(() => root.render(h(SteamConnect, { token: 't', userId: 'u', linked: true, card: { steam_id: '76561197960287930', persona_name: 'gabe', avatar: null }, onChanged })));
        expect(host.textContent).toMatch(/Verified by Steam/);
        act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Unlink')!.click());
        expect(host.textContent).toMatch(/Unlink\?/);
        await act(async () => { [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Unlink').pop()!.click(); });
        expect(del).toHaveBeenCalledTimes(1);
        expect(onChanged).toHaveBeenCalled();
        expect(JSON.stringify(post.mock.calls)).not.toMatch(/7656119/);
    });
});
