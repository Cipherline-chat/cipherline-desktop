// @vitest-environment jsdom
/**
 * The claim button on the "Not on Cipherline yet" card (Discord import phase
 * 3, plan B6.3 entry point a), mounted for real with the API mocked:
 * unavailable / not linked (starts sign-in through the validated opener) /
 * linked + a match (Claim) / linked + no match / already claimed. The client
 * never sends a Discord id: the only calls are the link status, the start and
 * the server's own `claimable` answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const api = vi.hoisted(() => ({
    status: { available: true, linked: false, auto_claim: true, verified_at: null } as { available: boolean; linked: boolean; auto_claim: boolean; verified_at: string | null },
    claimable: [] as unknown[],
    startUrl: 'https://api.cipherline.chat/v1/discord/oauth/start?state=' + 'A'.repeat(43),
    calls: [] as Array<[string, string, unknown?]>,
}));
vi.mock('axios', () => {
    const get = vi.fn(async (url: string) => {
        api.calls.push(['GET', url]);
        if (url.endsWith('/discord/link')) return { data: api.status };
        if (url.includes('/imports/claimable')) return { data: { linked: api.status.linked, authors: api.claimable } };
        throw new Error('unexpected GET ' + url);
    });
    const post = vi.fn(async (url: string, body: unknown) => {
        api.calls.push(['POST', url, body]);
        if (url.endsWith('/discord/link')) return { data: { url: api.startUrl, expires_in: 600 } };
        throw new Error('unexpected POST ' + url);
    });
    const ax = { get, post, put: vi.fn(), delete: vi.fn(), isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError };
    return { default: ax, ...ax };
});
vi.mock('../../../constants', async (orig) => ({ ...(await orig<typeof import('../../../constants')>()), API_BASE: 'https://api.cipherline.chat/v1' }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock('../../../utils/openExternalLink', () => ({ openExternalLink: (u: string) => { opened.push(u); return { ok: true }; } }));

const { ClaimSlot } = await import('./ClaimSlot');
const { _resetDiscordLinkStore } = await import('../../../hooks/useDiscordLink');

const SID = '11111111-1111-4111-8111-111111111111';
const AID = '44444444-4444-4444-8444-444444444444';
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    _resetDiscordLinkStore();
    api.calls.length = 0; opened.length = 0; api.claimable = [];
    api.status = { available: true, linked: false, auto_claim: true, verified_at: null };
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const render = (onClaim = vi.fn()) => { act(() => root.render(React.createElement(ClaimSlot, { token: 'jwt', serverId: SID, authorRef: AID, onClaim }))); return onClaim; };
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

describe('ClaimSlot', () => {
    it('unavailable on this server (OAuth not set up): one quiet line, no button', async () => {
        api.status = { ...api.status, available: false };
        render();
        await flush();
        expect(host.textContent).toContain('isn\'t available on this Cipherline server yet');
        expect(host.querySelector('button')).toBeNull();
    });

    it('not linked: "Is this you? Claim with Discord" opens OUR start page in the system browser and waits', async () => {
        render();
        await flush();
        expect(host.textContent).toContain('Is this you?');
        await act(async () => { button('Claim with Discord')!.click(); });
        await flush();
        expect(opened).toEqual([api.startUrl]);
        // The start call carries no body at all: the client never asserts a Discord id.
        expect(api.calls.find(c => c[0] === 'POST')?.[2]).toEqual({});
        expect(host.textContent).toContain('Finish in your browser');
    });

    it('refuses to open a start URL that is not ours (a confused or hostile response)', async () => {
        api.startUrl = 'https://evil.example/v1/discord/oauth/start?state=' + 'A'.repeat(43);
        render();
        await flush();
        await act(async () => { button('Claim with Discord')!.click(); });
        await flush();
        expect(opened).toEqual([]);
        expect(host.textContent).not.toContain('Finish in your browser');
        api.startUrl = 'https://api.cipherline.chat/v1/discord/oauth/start?state=' + 'A'.repeat(43);
    });

    it('linked and the server says this author is yours: "Claim these messages" hands the author to the confirm dialog', async () => {
        api.status = { ...api.status, linked: true };
        const mine = { author_id: AID, server_id: SID, server_name: 'Old Guild', claimed: false, claim_source: null, claimed_at: null, message_count: 4, imports: [], member: true };
        api.claimable = [mine];
        const onClaim = render();
        await flush();
        expect(host.textContent).toContain('These are yours');
        await act(async () => { button('Claim these messages')!.click(); });
        expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({ author_id: AID, message_count: 4 }));
    });

    it('linked but the server matched a DIFFERENT author (or none): no claim button', async () => {
        api.status = { ...api.status, linked: true };
        api.claimable = [{ author_id: '55555555-5555-4555-8555-555555555555', server_id: SID, server_name: 'x', claimed: false, claim_source: null, claimed_at: null, message_count: 1, imports: [], member: true }];
        render();
        await flush();
        expect(host.textContent).toContain('didn\'t write these messages');
        expect(button('Claim these messages')).toBeUndefined();
    });

    it('already claimed by you: says so', async () => {
        api.status = { ...api.status, linked: true };
        api.claimable = [{ author_id: AID, server_id: SID, server_name: 'x', claimed: true, claim_source: 'manual', claimed_at: null, message_count: 1, imports: [], member: true }];
        render();
        await flush();
        expect(host.textContent).toContain('You already claimed these messages');
    });
});
