// @vitest-environment jsdom
/**
 * GroupSettingsModal now embeds the shared AddGroupMembersPicker instead of its
 * own copy of the friend picker. Behaviour must be unchanged: members load, the
 * picker excludes them, adding calls the same invite endpoint, reports the
 * result, and re-loads the members list afterwards.
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
const btn = (match: RegExp) =>
    [...document.querySelectorAll('button')].find(b => match.test(b.textContent?.trim() ?? '')) as HTMLButtonElement | undefined;
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

describe('GroupSettingsModal with the extracted AddGroupMembersPicker', () => {
    it('loads members and renders the Add Members section from the shared picker', async () => {
        await mount();
        expect(body()).toContain('Members (2)');
        expect(body()).toContain('Add Members');
        expect(document.querySelector('input[placeholder="Search friends"]')).not.toBeNull();
    });

    it('offers only friends who are not already members', async () => {
        await mount();
        // Ann is a member (shown in the member list, not as a pick-row with a checkbox)
        expect(btn(/Ann/)).toBeUndefined();
        expect(btn(/Bob/)).toBeDefined();
    });

    it('adding calls the same invite endpoint, reports it, and re-loads the member list', async () => {
        await mount();
        const devicesCallsBefore = axiosGet.mock.calls.filter(c => String(c[0]).includes('/devices')).length;
        await click(btn(/Bob/));
        await click(btn(/^Add 1 Member$/));

        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-1/invite`,
            { user_id: 'u-bob' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(body()).toContain('1 member added to the group');
        const devicesCallsAfter = axiosGet.mock.calls.filter(c => String(c[0]).includes('/devices')).length;
        expect(devicesCallsAfter).toBe(devicesCallsBefore + 1);
        expect(body()).toContain('Members (3)');
        // Bob is a member now, so he is no longer offered
        expect(btn(/Bob/)).toBeUndefined();
    });

    it('NEGATIVE CONTROL: a failed invite reports failure and leaves the member count alone', async () => {
        axiosPost.mockRejectedValue(new Error('400'));
        await mount();
        await click(btn(/Bob/));
        await click(btn(/^Add 1 Member$/));
        expect(body()).toContain('Failed to add 1 member.');
        expect(body()).not.toContain('added to the group');
        expect(body()).toContain('Members (2)');
    });
});
