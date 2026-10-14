// @vitest-environment jsdom
/**
 * "Add people to <group>" modal: titled with the group, excludes current
 * members, adds through the same invite endpoint, tells the host immediately
 * (so the panel's member list refreshes), then closes itself after a
 * fully-successful add - but stays open on a failure.
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
    default: { get: (...a: unknown[]) => axiosGet(...a), post: (...a: unknown[]) => axiosPost(...a) },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', user: { user_id: 'me', username: 'Me' }, deviceId: 'dev' }),
}));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));

const { AddGroupMembersModal, ADD_MEMBERS_CLOSE_DELAY_MS } = await import('./AddGroupMembersModal');
const { API_BASE } = await import('../constants');

const FRIENDS = [
    { user_id: 'u-ann', username: 'Ann', avatar_url: null },
    { user_id: 'u-bob', username: 'Bob', avatar_url: null },
];

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosGet.mockResolvedValue({ data: { accepted: FRIENDS } });
    axiosPost.mockResolvedValue({ data: { ok: true } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const btn = (match: RegExp) =>
    [...document.querySelectorAll('button')].find(b => match.test(b.textContent?.trim() ?? '')) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement | undefined) => {
    expect(el).toBeDefined();
    await act(async () => { el!.click(); });
    await flush();
};

async function mount() {
    const onClose = vi.fn();
    const onAdded = vi.fn();
    act(() => root.render(React.createElement(AddGroupMembersModal, {
        conversationId: 'conv-9',
        conversationTitle: 'Weekend Crew',
        memberIds: ['me', 'u-ann'],
        onClose,
        onAdded,
    })));
    await flush();
    return { onClose, onAdded };
}

describe('AddGroupMembersModal', () => {
    it('is a dialog titled "Add people to <group name>"', async () => {
        await mount();
        expect(dialog()).not.toBeNull();
        expect(dialog()!.getAttribute('aria-label')).toBe('Add people to Weekend Crew');
        expect(dialog()!.querySelector('h2')?.textContent).toBe('Add people to Weekend Crew');
    });

    it('does not offer people who are already in the group', async () => {
        await mount();
        expect(btn(/Ann/)).toBeUndefined();
        expect(btn(/Bob/)).toBeDefined();
    });

    it('adds via the invite endpoint, tells the host at once, then closes itself after the success beat', async () => {
        const { onClose, onAdded } = await mount();
        await click(btn(/Bob/));
        await click(btn(/^Add 1 Member$/));

        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-9/invite`,
            { user_id: 'u-bob' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(onAdded).toHaveBeenCalledTimes(1);
        expect(onAdded.mock.calls[0][0].added.map((a: { user_id: string }) => a.user_id)).toEqual(['u-bob']);
        expect(document.body.textContent).toContain('1 member added to the group');
        expect(onClose).not.toHaveBeenCalled();           // success state is visible first

        await act(async () => { vi.advanceTimersByTime(ADD_MEMBERS_CLOSE_DELAY_MS + 400); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('NEGATIVE CONTROL: a failed add stays open (error visible) and does not auto-close', async () => {
        axiosPost.mockRejectedValue(new Error('403'));
        const { onClose, onAdded } = await mount();
        await click(btn(/Bob/));
        await click(btn(/^Add 1 Member$/));

        expect(document.body.textContent).toContain('Failed to add 1 member.');
        await act(async () => { vi.advanceTimersByTime(ADD_MEMBERS_CLOSE_DELAY_MS + 1000); });
        expect(onClose).not.toHaveBeenCalled();
        expect(dialog()).not.toBeNull();
        // host is still told (with nothing added) so it never shows a phantom member
        expect(onAdded.mock.calls[0][0].added).toEqual([]);
    });

    it('Done closes it', async () => {
        const { onClose } = await mount();
        await click(btn(/^Done$/));
        await act(async () => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
