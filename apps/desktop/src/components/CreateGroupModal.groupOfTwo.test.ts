// @vitest-environment jsdom
/**
 * Easter egg: a "group" of you + one other person (CreateGroupModal →
 * GroupOfTwoDialog). Mounted for real, with the network and the local store
 * faked. What must hold:
 *   - exactly one friend picked → the dialog, and NOTHING is created yet;
 *   - "Open DM with <name>" → the New Message dialog's exact request
 *     (POST /conversations/dm { other_user_id }) then onOpenDm; no group made;
 *   - "Make the group anyway" → POST /conversations/group as before;
 *   - Escape backs out to the form, creating nothing;
 *   - two or more friends → no dialog at all;
 *   - switch OFF → no dialog; asked to insist twice → it retires;
 *   - a DM failure keeps the dialog up with "anyway" still working.
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
Element.prototype.scrollIntoView = function () {};

const axiosGet = vi.fn();
const axiosPost = vi.fn();
const axiosPatch = vi.fn();
vi.mock('axios', () => ({
    default: {
        get: (...a: unknown[]) => axiosGet(...a),
        post: (...a: unknown[]) => axiosPost(...a),
        patch: (...a: unknown[]) => axiosPatch(...a),
    },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', deviceId: 'dev-1', userId: 'me', user: { user_id: 'me', username: 'Dawson' } }),
}));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile: vi.fn() }) }));
vi.mock('../hooks/useAvatarBroadcast', () => ({ useAvatarBroadcast: () => ({ broadcastGroupAvatarKey: vi.fn() }) }));
vi.mock('../utils/avatarKeyStore', () => ({ saveAvatarKey: vi.fn() }));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));

// A real-enough store: the ledger and the switch must persist across calls.
const kv = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const secureLocalStore = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
    };
    return { secureLocalStore, default: secureLocalStore };
});

const { CreateGroupModal } = await import('./CreateGroupModal');
const { API_BASE } = await import('../constants');
const { EGG_LEDGER_KEY, parseLedger } = await import('../utils/easterEggs');
/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


const FRIENDS = [
    { user_id: 'u-ann', username: 'Ann', avatar_url: null },
    { user_id: 'u-bob', username: 'Bob', avatar_url: 'av-bob' },
];

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
const onGroupCreated = vi.fn();
const onOpenDm = vi.fn();

beforeEach(() => {
    // Fake timers for every test: handleClose's 260 ms exit timer from one test
    // must never fire inside the next one and look like a stray onClose.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    kv.clear();
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosPatch.mockReset();
    onClose.mockReset();
    onGroupCreated.mockReset();
    onOpenDm.mockReset();
    axiosGet.mockResolvedValue({ data: { accepted: FRIENDS } });
    axiosPost.mockImplementation(async (url: string, body: { other_user_id?: string }) =>
        url.endsWith('/conversations/dm')
            ? { data: { conversation_id: 'dm-' + body.other_user_id } }
            : { data: { conversation_id: 'grp-1' } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };

type Props = Parameters<typeof CreateGroupModal>[0];
async function mount(props: Partial<Props> = {}) {
    act(() => root.render(React.createElement(CreateGroupModal, {
        onClose, onGroupCreated, onOpenDm,
        preSelectedUsers: [{ user_id: 'u-ann', username: 'Ann' }],
        ...props,
    })));
    await flush();
}

function typeName(value: string) {
    const el = document.getElementById('create-group-name') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() {
    const form = document.querySelector('form.dlg-form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
}
const dialog = () => Array.from(document.querySelectorAll('[role="dialog"], .mcard')).find(e => /Open DM with/.test(e.textContent ?? '')) ?? null;
const btn = (re: RegExp) => Array.from(document.querySelectorAll('button')).find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const groupPosts = () => axiosPost.mock.calls.filter(c => String(c[0]).endsWith('/conversations/group'));
const dmPosts = () => axiosPost.mock.calls.filter(c => String(c[0]).endsWith('/conversations/dm'));

describe('group of two', () => {
    it('intercepts you + one person, and creates nothing yet', async () => {
        await mount();
        typeName('Squad');
        await submit();
        expect(dialog()).not.toBeNull();
        expect(document.body.textContent).toContain('Open DM with Ann');
        expect(document.body.textContent).toContain('Make the group anyway');
        expect(groupPosts()).toHaveLength(0);
        expect(dmPosts()).toHaveLength(0);
        // The first title in the pool, and the other person is named in the body.
        expect(document.body.textContent).toContain('That’s… a DM with extra steps.');
        expect(document.body.textContent).toContain('You and Ann already have a perfectly good one');
    });

    it('"Open DM" sends the New Message dialog’s exact request, hands the chat to onOpenDm, creates no group', async () => {
        await mount();
        typeName('Squad');
        await submit();
        await act(async () => { btn(/Open DM with Ann/)!.click(); });
        await flush();
        expect(dmPosts()).toHaveLength(1);
        expect(dmPosts()[0]).toEqual([
            `${API_BASE}/conversations/dm`,
            { other_user_id: 'u-ann' },
            { headers: { Authorization: 'Bearer tok', 'x-device-id': 'dev-1' } },
        ]);
        expect(onOpenDm).toHaveBeenCalledWith({
            id: 'dm-u-ann', title: 'Ann', type: 'dm', other_user_id: 'u-ann', avatar_url: undefined,
        });
        expect(groupPosts()).toHaveLength(0);
        expect(onGroupCreated).not.toHaveBeenCalled();
    });

    it('"Make the group anyway" carries on exactly as before', async () => {
        await mount();
        typeName('Squad');
        await submit();
        await act(async () => { btn(/Make the group anyway/)!.click(); });
        await flush();
        expect(groupPosts()).toHaveLength(1);
        expect(groupPosts()[0][1]).toEqual({ title: 'Squad', initial_user_ids: ['u-ann'] });
        expect(dmPosts()).toHaveLength(0);
        expect(onOpenDm).not.toHaveBeenCalled();
        expect(onGroupCreated).toHaveBeenCalledWith({ id: 'grp-1', title: 'Squad', type: 'group' });
    });

    it('Escape backs out to the form without creating anything', async () => {
        await mount();
        typeName('Squad');
        await submit();
        expect(dialog()).not.toBeNull();
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(dialog()).toBeNull();
        expect(groupPosts()).toHaveLength(0);
        expect(dmPosts()).toHaveLength(0);
        expect(onClose).not.toHaveBeenCalled();
        // …and the form is still there to submit again.
        expect(document.getElementById('create-group-name')).not.toBeNull();
    });

    it('two or more friends is a real group: no dialog', async () => {
        await mount({ preSelectedUsers: [{ user_id: 'u-ann', username: 'Ann' }, { user_id: 'u-bob', username: 'Bob' }] });
        typeName('Squad');
        await submit();
        expect(dialog()).toBeNull();
        expect(groupPosts()).toHaveLength(1);
    });

    it('a stale "off" from the retired switch changes nothing: the dialog still appears', async () => {
        kv.set(LEGACY_EGGS_KEY, '0');
        await mount();
        typeName('Squad');
        await submit();
        expect(dialog()).not.toBeNull();
        expect(groupPosts()).toHaveLength(0);
        expect(kv.has(EGG_LEDGER_KEY)).toBe(true);
    });

    it('a caller that cannot open a DM (no onOpenDm) never shows it', async () => {
        await mount({ onOpenDm: undefined });
        typeName('Squad');
        await submit();
        expect(dialog()).toBeNull();
        expect(groupPosts()).toHaveLength(1);
    });

    it('rotates its copy and retires after being insisted past twice', async () => {
        for (let round = 0; round < 2; round++) {
            await mount();
            typeName('Squad');
            await submit();
            expect(dialog()).not.toBeNull();
            if (round === 1) expect(document.body.textContent).toContain('A group of two. Bold.');
            await act(async () => { btn(/Make the group anyway/)!.click(); });
            await flush();
            act(() => root.unmount());
            root = createRoot(host);
        }
        expect(parseLedger(kv.get(EGG_LEDGER_KEY) ?? null)['group-of-two-anyway'].count).toBe(2);
        await mount();
        typeName('Squad');
        await submit();
        expect(dialog()).toBeNull();
        expect(groupPosts()).toHaveLength(3);
    });

    it('a failed DM keeps the dialog up, says so, and "anyway" still works', async () => {
        axiosPost.mockImplementation(async (url: string) => {
            if (url.endsWith('/conversations/dm')) throw Object.assign(new Error('net'), { response: undefined });
            return { data: { conversation_id: 'grp-9' } };
        });
        await mount();
        typeName('Squad');
        await submit();
        await act(async () => { btn(/Open DM with Ann/)!.click(); });
        await flush();
        expect(dialog()).not.toBeNull();
        expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Couldn’t open|Couldn't open/);
        expect(onOpenDm).not.toHaveBeenCalled();
        await act(async () => { btn(/Make the group anyway/)!.click(); });
        await flush();
        expect(onGroupCreated).toHaveBeenCalledWith({ id: 'grp-9', title: 'Squad', type: 'group' });
    });

    it('an empty name is still the ordinary validation error, not an egg', async () => {
        await mount();
        await submit();
        expect(dialog()).toBeNull();
        expect(document.body.textContent).toContain('Group name is required');
    });
});
