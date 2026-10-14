// @vitest-environment jsdom
/**
 * The shared "add people to a group" picker (used by GroupSettingsModal and the
 * right-hand panel's "+" modal):
 *   - offers only friends who are NOT already in the group,
 *   - adds through POST /conversations/:id/invite, one call per person,
 *   - reports added / failed counts and hands the host the people it added,
 *   - mirrors the server's 200-member cap (selection stops, Add never fires past it).
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

const { AddGroupMembersPicker } = await import('./AddGroupMembersPicker');
const { API_BASE } = await import('../constants');
const { GROUP_MAX_MEMBERS } = await import('../utils/groupAddMembers');

const FRIENDS = [
    { user_id: 'u-ann', username: 'Ann', avatar_url: null },
    { user_id: 'u-bob', username: 'Bob', avatar_url: 'av-bob' },
    { user_id: 'u-cat', username: 'Cat', avatar_url: null },
];

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
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
});

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => host.textContent ?? '';
const rowButton = (name: string) =>
    [...host.querySelectorAll('button')].find(b => b.textContent?.includes(name)) as HTMLButtonElement | undefined;
const addButton = () =>
    [...host.querySelectorAll('button')].find(b => /^Add \d+ Members?$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement | undefined;

async function mount(props: Partial<React.ComponentProps<typeof AddGroupMembersPicker>> = {}) {
    const onResult = props.onResult ?? vi.fn();
    act(() => root.render(React.createElement(AddGroupMembersPicker, {
        conversationId: 'conv-1',
        memberIds: new Set(['me', 'u-ann']),
        ...props,
        onResult,
    })));
    await flush();
    return onResult as ReturnType<typeof vi.fn>;
}

const click = async (el: HTMLElement | undefined) => {
    expect(el).toBeDefined();
    await act(async () => { el!.click(); });
    await flush();
};

describe('AddGroupMembersPicker', () => {
    it('excludes friends who are already members and offers the rest', async () => {
        await mount();
        expect(axiosGet).toHaveBeenCalledWith(`${API_BASE}/friends`, expect.anything());
        expect(rowButton('Ann')).toBeUndefined();      // already in the group
        expect(rowButton('Bob')).toBeDefined();
        expect(rowButton('Cat')).toBeDefined();
    });

    it('NEGATIVE CONTROL: with nobody in the group yet, the same friend IS offered', async () => {
        await mount({ memberIds: new Set(['me']) });
        expect(rowButton('Ann')).toBeDefined();
    });

    it('says so when every friend is already in the group', async () => {
        await mount({ memberIds: new Set(['me', 'u-ann', 'u-bob', 'u-cat']) });
        expect(text()).toContain('All your friends are already in this group');
    });

    it('shows no Add button until someone is selected', async () => {
        await mount();
        expect(addButton()).toBeUndefined();
        await click(rowButton('Bob'));
        expect(addButton()?.textContent).toContain('Add 1 Member');
    });

    it('posts one invite per selected person to /conversations/:id/invite with the bearer token', async () => {
        const onResult = await mount();
        await click(rowButton('Bob'));
        await click(rowButton('Cat'));
        await click(addButton());

        expect(axiosPost).toHaveBeenCalledTimes(2);
        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-1/invite`,
            { user_id: 'u-bob' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-1/invite`,
            { user_id: 'u-cat' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(text()).toContain('2 members added to the group');
        expect(onResult).toHaveBeenCalledTimes(1);
        expect(onResult.mock.calls[0][0]).toEqual({
            added: [
                { user_id: 'u-bob', username: 'Bob', avatar_url: 'av-bob' },
                { user_id: 'u-cat', username: 'Cat', avatar_url: null },
            ],
            failedCount: 0,
        });
        // selection is cleared after an add
        expect(addButton()).toBeUndefined();
    });

    it('reports a partial failure and only hands back the people who were actually added', async () => {
        axiosPost.mockImplementation((_url: string, body: { user_id: string }) =>
            body.user_id === 'u-cat' ? Promise.reject(new Error('400')) : Promise.resolve({ data: { ok: true } }));
        const onResult = await mount();
        await click(rowButton('Bob'));
        await click(rowButton('Cat'));
        await click(addButton());

        expect(text()).toContain('1 member added to the group');
        expect(text()).toContain('Failed to add 1 member.');
        expect(onResult.mock.calls[0][0].added.map((a: { user_id: string }) => a.user_id)).toEqual(['u-bob']);
        expect(onResult.mock.calls[0][0].failedCount).toBe(1);
    });

    it('NEGATIVE CONTROL: a failed invite is never reported as added', async () => {
        axiosPost.mockRejectedValue(new Error('403'));
        const onResult = await mount();
        await click(rowButton('Bob'));
        await click(addButton());
        expect(text()).not.toContain('added to the group');
        expect(text()).toContain('Failed to add 1 member.');
        expect(onResult.mock.calls[0][0].added).toEqual([]);
    });

    it('filters by the search box', async () => {
        await mount();
        const input = host.querySelector('input') as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(input, 'ca');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(rowButton('Cat')).toBeDefined();
        expect(rowButton('Bob')).toBeUndefined();
    });

    describe('group size limit', () => {
        const fullMinus = (slots: number) =>
            new Set(Array.from({ length: GROUP_MAX_MEMBERS - slots }, (_, i) => `x${i}`));

        it('shows the running size against the cap', async () => {
            await mount({ memberIds: new Set(['me', 'u-ann']) });
            expect(host.querySelector('[data-testid="group-size-note"]')?.textContent).toBe(`2 / ${GROUP_MAX_MEMBERS} members`);
        });

        it('stops selecting once the remaining slots are used up', async () => {
            await mount({ memberIds: fullMinus(1) });
            await click(rowButton('Bob'));
            await click(rowButton('Cat'));                // no room: ignored
            expect(addButton()?.textContent).toContain('Add 1 Member');
            expect(host.querySelector('[data-testid="group-size-note"]')?.textContent).toMatch(/limit reached/i);
            await click(addButton());
            expect(axiosPost).toHaveBeenCalledTimes(1);
        });

        it('a full group offers no way to add anyone', async () => {
            await mount({ memberIds: fullMinus(0) });
            expect(host.querySelector('[data-testid="group-size-note"]')?.textContent).toMatch(/is full/i);
            await click(rowButton('Bob'));
            expect(addButton()).toBeUndefined();
            expect(axiosPost).not.toHaveBeenCalled();
        });

        it('NEGATIVE CONTROL: one slot below the cap, selection is not blocked', async () => {
            await mount({ memberIds: fullMinus(2) });
            await click(rowButton('Bob'));
            await click(rowButton('Cat'));
            expect(addButton()?.textContent).toContain('Add 2 Members');
        });
    });

    it('shows a spinner (and no "everyone is in" message) while the host is still loading members', async () => {
        await mount({ membersLoading: true });
        expect(text()).not.toContain('All your friends are already');
        expect(rowButton('Bob')).toBeUndefined();
    });
});
