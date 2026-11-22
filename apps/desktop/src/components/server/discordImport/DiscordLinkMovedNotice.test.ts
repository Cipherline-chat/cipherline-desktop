// @vitest-environment jsdom
/**
 * Discord import phase 3b (the link move), the side that LOSES the link:
 * "Your Discord link was moved", mounted for real through DiscordClaimNotices
 * (the component Dashboard renders) with the API mocked. Shown at sign-in
 * from GET /v1/discord/link, live when `discord:link_changed` arrives
 * (refreshDiscordLinkStore), never while linked, never naming the other
 * account, and "OK" clears it on the server (DELETE .../moved-notice).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

type Status = { available: boolean; linked: boolean; auto_claim: boolean; verified_at: string | null; moved_away_at?: unknown };
const api = vi.hoisted(() => ({
    status: { available: true, linked: true, auto_claim: true, verified_at: '2026-11-20T10:00:00.000Z' } as Status,
    calls: [] as Array<[string, string]>,
    failAck: false,
}));
vi.mock('axios', () => {
    const get = vi.fn(async (url: string) => {
        api.calls.push(['GET', url]);
        if (url.endsWith('/discord/link')) return { data: api.status };
        if (url.endsWith('/discord/claims')) return { data: { linked: api.status.linked, authors: [] } };
        throw new Error('unexpected GET ' + url);
    });
    const del = vi.fn(async (url: string) => {
        api.calls.push(['DELETE', url]);
        if (api.failAck) throw Object.assign(new Error('x'), { isAxiosError: true, response: { status: 500, data: {} } });
        if (url.endsWith('/discord/link/moved-notice')) { api.status = { ...api.status, moved_away_at: null }; return { data: { ok: true } }; }
        throw new Error('unexpected DELETE ' + url);
    });
    const ax = { get, post: vi.fn(), put: vi.fn(), delete: del, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError };
    return { default: ax, ...ax };
});
vi.mock('../../../constants', async (orig) => ({ ...(await orig<typeof import('../../../constants')>()), API_BASE: 'https://api.cipherline.chat/v1' }));
vi.mock('../../../utils/secureLocalStore', () => ({
    default: { whenAccountReady: async () => undefined, getItem: () => null, setItem: () => undefined },
}));

const { DiscordClaimNotices } = await import('./DiscordClaimNotices');
const { _resetDiscordLinkStore } = await import('../../../hooks/useDiscordLink');
const { DISCORD_LINK_CHANGED_EVENT } = await import('../../../utils/discordLinkEvents');

const MOVED_AT = '2026-11-21T18:30:00.000Z';
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    _resetDiscordLinkStore();
    api.calls.length = 0; api.failAck = false;
    api.status = { available: true, linked: true, auto_claim: true, verified_at: '2026-11-20T10:00:00.000Z' };
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const render = () => act(() => root.render(React.createElement(DiscordClaimNotices, { token: 'jwt', userId: 'me', changedTick: 0 })));
const dialog = () => document.querySelector('[role="dialog"]');
const okButton = () => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'OK') as HTMLButtonElement | undefined;

describe('DiscordLinkMovedNotice (via DiscordClaimNotices)', () => {
    it('at sign-in: a link moved away while you were offline shows the notice, without naming the other account', async () => {
        api.status = { available: true, linked: false, auto_claim: true, verified_at: null, moved_away_at: MOVED_AT };
        render();
        await flush();
        expect(dialog()).not.toBeNull();
        const text = document.body.textContent ?? '';
        expect(text).toContain('Your Discord link was moved');
        expect(text).toContain('another Cipherline account');
        expect(text).toContain('November 21, 2026');
        // Keyboard: OK is focused, so Enter / Space dismisses it.
        expect(document.activeElement?.textContent?.trim()).toBe('OK');
        // Something behind it grabbing focus while it mounts (the composer does) gets it pulled back.
        const composer = document.createElement('input');
        document.body.appendChild(composer);
        await act(async () => { composer.focus(); });
        expect(document.activeElement?.textContent?.trim()).toBe('OK');
    });

    it('LIVE: linked, then `discord:link_changed` (the window event useRealtime fires) shows it without a restart', async () => {
        render();
        await flush();
        expect(dialog()).toBeNull();
        api.status = { available: true, linked: false, auto_claim: true, verified_at: null, moved_away_at: MOVED_AT };
        await act(async () => { window.dispatchEvent(new CustomEvent(DISCORD_LINK_CHANGED_EVENT)); });
        await flush();
        expect(document.body.textContent).toContain('Your Discord link was moved');
    });

    it('OK clears it on the server and closes; a failed clear keeps it open with an error', async () => {
        api.status = { available: true, linked: false, auto_claim: true, verified_at: null, moved_away_at: MOVED_AT };
        render();
        await flush();
        api.failAck = true;
        await act(async () => { okButton()!.click(); });
        await flush();
        expect(dialog()).not.toBeNull();
        expect(document.body.textContent).toContain('Could not dismiss that notice');
        api.failAck = false;
        await act(async () => { okButton()!.click(); });
        await flush();
        expect(api.calls.filter(c => c[0] === 'DELETE').map(c => c[1])).toEqual([
            'https://api.cipherline.chat/v1/discord/link/moved-notice', 'https://api.cipherline.chat/v1/discord/link/moved-notice',
        ]);
        expect(dialog()).toBeNull();
    });

    it('never while linked (a stale notice field is ignored), and junk dates are ignored', async () => {
        api.status = { available: true, linked: true, auto_claim: true, verified_at: null, moved_away_at: MOVED_AT };
        render();
        await flush();
        expect(dialog()).toBeNull();
        _resetDiscordLinkStore();
        api.status = { available: true, linked: false, auto_claim: true, verified_at: null, moved_away_at: 'not a date' };
        await act(async () => { root.render(React.createElement(DiscordClaimNotices, { token: 'jwt2', userId: 'me', changedTick: 1 })); });
        await flush();
        expect(dialog()).toBeNull();
    });
});
