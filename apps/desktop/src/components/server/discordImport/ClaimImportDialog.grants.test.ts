// @vitest-environment jsdom
/**
 * The claim confirm names every role the claimant will get BEFORE Claim
 * (owner rule for D5b), flags Administrator, the channel permissions,
 * nickname and a Discord ban; a person with roles but no messages gets a
 * plain "Claim" (never "Claim 0 messages").
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClaimableAuthor } from '../../../utils/discordClaims';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
vi.mock('axios', () => {
    const ax = { get: vi.fn(), post: vi.fn(async () => ({ data: {} })), put: vi.fn(), delete: vi.fn(), isAxiosError: () => false };
    return { default: ax, ...ax };
});

const { ClaimImportDialog } = await import('./ClaimImportDialog');

const author = (over: Partial<ClaimableAuthor> = {}): ClaimableAuthor => ({
    author_id: 'a1', server_id: 's1', server_name: 'Pixel Farm', claimed: false, claim_source: null, claimed_at: null,
    message_count: 0, imports: [], member: true,
    grants: {
        roles: [
            { role_id: 'r1', name: 'Boss', color: 0xff0000, position: 3000, administrator: true, state: 'pending' },
            { role_id: 'r2', name: 'Farmhand', color: 0x3498db, position: 1000, administrator: false, state: 'pending' },
        ],
        overrides: 2, nickname: 'Sammy', banned: false,
        granted_by: { user_id: 'u', username: 'owner', discriminator: null }, granted_at: '2026-11-22T00:00:00Z', given: false,
    },
    ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function mount(a: ClaimableAuthor, mode: 'claim' | 'auto' = 'claim') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(React.createElement(ClaimImportDialog, { open: true, mode, author: a, token: 'jwt', onClose: () => {} })); });
    return document.body;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

describe('ClaimImportDialog with imported roles', () => {
    it('names every role, flags Administrator, lists channel permissions + nickname, and says who imported', async () => {
        const body = await mount(author());
        const roles = [...body.querySelectorAll('[data-claim-roles] li')].map(li => li.textContent?.trim());
        expect(roles).toEqual(['Boss', 'Farmhand']);
        expect(body.querySelector('[aria-label="Administrator"]')).not.toBeNull();
        expect(body.textContent).toMatch(/Administrator gives full control of Pixel Farm/);
        expect(body.textContent).toMatch(/2 channels or categories/);
        expect(body.textContent).toMatch(/Sammy/);
        expect(body.textContent).toMatch(/@owner/);
        const claim = [...body.querySelectorAll('button')].find(b => /^Claim/.test(b.textContent ?? ''));
        expect(claim?.textContent).toBe('Claim'); // never "Claim 0 messages"
        expect(body.querySelector('[data-claim-review-toggle]')).toBeNull(); // nothing to review
    });
    it('a Discord ban is stated plainly', async () => {
        const a = author();
        const body = await mount({ ...a, grants: { ...a.grants!, banned: true } });
        expect(body.textContent).toMatch(/banned from the original server, so it is banned from Pixel Farm too/);
    });
    it('not a member yet: "you get them as soon as you join"', async () => {
        const body = await mount(author({ member: false }));
        expect(body.textContent).toMatch(/as soon as you join Pixel Farm/);
    });
    it('member since: the Discord join day is named before Claim (UTC day, never shifted by the time zone)', async () => {
        const a = author();
        const body = await mount({ ...a, grants: { ...a.grants!, member_since: '2019-04-02' } });
        expect(body.querySelector('[data-claim-member-since]')?.textContent).toBe('Member since Apr 2, 2019 on your profile in Pixel Farm');
    });
    it('a member-since-only person still sees the grants block and a plain "Claim"', async () => {
        const body = await mount(author({ grants: { roles: [], overrides: 0, nickname: null, banned: false, granted_by: null, granted_at: null, given: false, member_since: '2016-01-05' } }));
        expect(body.querySelector('[data-claim-grants]')).not.toBeNull();
        expect(body.textContent).toMatch(/Member since Jan 5, 2016/);
    });
    it('POSITIVE CONTROL: an author with messages and no grants keeps the old "Claim N messages" dialog, no roles block', async () => {
        const body = await mount(author({ message_count: 4, grants: null }));
        expect(body.querySelector('[data-claim-grants]')).toBeNull();
        expect([...body.querySelectorAll('button')].some(b => b.textContent === 'Claim 4 messages')).toBe(true);
    });
});
