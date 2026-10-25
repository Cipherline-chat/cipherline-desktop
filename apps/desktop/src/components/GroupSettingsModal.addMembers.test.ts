// @vitest-environment jsdom
/**
 * The redone GroupSettingsModal keeps "add people" but through the SAME dialog
 * as the right-hand panel's "+" (AddGroupMembersModal, stacked on top) instead
 * of an inline picker. Behaviour must be unchanged: members load, the picker
 * excludes them, adding calls the same invite endpoint, reports the result, and
 * the member list re-loads afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const axiosGet = vi.fn();
const axiosPost = vi.fn();
vi.mock('axios', () => ({
    default: { get: (...a: unknown[]) => axiosGet(...a), post: (...a: unknown[]) => axiosPost(...a), patch: vi.fn() },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', user: { user_id: 'me', username: 'Me', avatar_url: null }, deviceId: 'dev' }),
}));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('../hooks/useEncryptedAvatar', () => ({ useEncryptedAvatar: () => null, evictAvatar: vi.fn() }));
vi.mock('../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile: vi.fn() }) }));
vi.mock('../hooks/useAvatarBroadcast', () => ({ useAvatarBroadcast: () => ({ broadcastGroupAvatarKey: vi.fn() }) }));
vi.mock('../utils/avatarKeyStore', () => ({ saveAvatarKey: vi.fn() }));

const { GroupSettingsModal } = await import('./GroupSettingsModal');
const { API_BASE } = await import('../constants');

let devices: Array<{ user_id: string; username: string; avatar_url: string | null }>;
const FRIENDS = [
    { user_id: 'u-ann', username: 'Ann', avatar_url: null },
    { user_id: 'u-bob', username: 'Bob', avatar_url: null },
];

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    devices = [
        { user_id: 'me', username: 'Me', avatar_url: null },
        { user_id: 'u-ann', username: 'Ann', avatar_url: null },
    ];
    axiosGet.mockImplementation((url: string) =>
        url.endsWith('/friends') ? Promise.resolve({ data: { accepted: FRIENDS } }) : Promise.resolve({ data: devices }));
    axiosPost.mockImplementation((_u: string, body: { user_id: string }) => {
        devices = [...devices, { user_id: body.user_id, username: 'Bob', avatar_url: null }];
        return Promise.resolve({ data: { ok: true } });
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const body = () => document.body.textContent ?? '';
const memberCount = () => document.querySelector('[data-testid="member-count"]')?.textContent;
const btn = (match: RegExp) =>
    [...document.querySelectorAll('button')].find(b => match.test(b.textContent?.trim() ?? '')) as HTMLButtonElement | undefined;
const row = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent?.includes(name));
const click = async (el: HTMLElement | undefined) => {
    expect(el).toBeDefined();
    await act(async () => { el!.click(); });
    await flush();
};

async function mount() {
    act(() => root.render(React.createElement(GroupSettingsModal, {
        conversationId: 'conv-1',
        conversationTitle: 'Crew',
        onClose: () => {},
        onGroupLeft: () => {},
    })));
    await flush();
}

describe('GroupSettingsModal add-people entry point', () => {
    it('loads members and offers "Add people" (no inline picker any more)', async () => {
        await mount();
        expect(memberCount()).toBe('2');
        expect(body()).toContain('Ann');
        expect(btn(/^Add people$/)).toBeDefined();
        expect(document.querySelector('input[placeholder="Search friends"]')).toBeNull();
    });

    it('Add people is disabled while the member list is loading', async () => {
        axiosGet.mockImplementation(() => new Promise(() => {}));
        await mount();
        expect(btn(/^Add people$/)?.disabled).toBe(true);
        expect(body()).toContain('Loading members');
    });

    it('opens the shared add-people dialog, which offers only friends who are not already members', async () => {
        await mount();
        await click(btn(/^Add people$/));
        expect(document.querySelector('[aria-label="Add people to Crew"]')).not.toBeNull();
        expect(row('Ann')).toBeUndefined();
        expect(row('Bob')).toBeDefined();
    });

    it('adding calls the same invite endpoint, reports it, and re-loads the member list', async () => {
        await mount();
        const devicesCallsBefore = axiosGet.mock.calls.filter(c => String(c[0]).includes('/devices')).length;
        await click(btn(/^Add people$/));
        await click(row('Bob'));
        await click(btn(/^Add 1 member$/));

        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-1/invite`,
            { user_id: 'u-bob' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(body()).toContain('1 member added to the group');
        const devicesCallsAfter = axiosGet.mock.calls.filter(c => String(c[0]).includes('/devices')).length;
        expect(devicesCallsAfter).toBe(devicesCallsBefore + 1);
        expect(memberCount()).toBe('3');
    });

    it('NEGATIVE CONTROL: a failed invite reports failure and leaves the member count alone', async () => {
        axiosPost.mockRejectedValue(new Error('400'));
        await mount();
        await click(btn(/^Add people$/));
        await click(row('Bob'));
        await click(btn(/^Add 1 member$/));
        expect(body()).toContain('Failed to add 1 member.');
        expect(body()).not.toContain('added to the group');
        expect(memberCount()).toBe('2');
    });

    it('a failed member fetch shows a retry, not a silently empty list', async () => {
        axiosGet.mockRejectedValueOnce(new Error('500'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await mount();
        expect(body()).toContain("Couldn't load members");
        expect(btn(/^Add people$/)?.disabled).toBe(true);
        await click(btn(/^Try again$/));
        expect(memberCount()).toBe('2');
        expect(btn(/^Add people$/)?.disabled).toBe(false);
    });
});
