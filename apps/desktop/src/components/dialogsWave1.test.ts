// @vitest-environment jsdom
/**
 * Dialog redesign, wave 1 — one smoke test per migrated dialog, each pinning
 * (a) it renders its title and primary action and (b) the primary action
 * triggers the SAME request / callback as before the redesign, with controls
 * for the gates (disabled until valid, invalid input sends nothing, the
 * destructive default focus, the step-up on delete-account).
 *
 * Visuals live in harness/dialogs-wave1-* (screenshots); this file is the
 * behavioural contract.
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
const axiosDelete = vi.fn();
vi.mock('axios', () => ({
    default: {
        get: (...a: unknown[]) => axiosGet(...a),
        post: (...a: unknown[]) => axiosPost(...a),
        delete: (...a: unknown[]) => axiosDelete(...a),
        patch: vi.fn(),
    },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', userId: 'me', deviceId: 'dev-1', user: { user_id: 'me', username: 'Me' } }),
}));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile: vi.fn() }) }));
vi.mock('../hooks/useAvatarBroadcast', () => ({ useAvatarBroadcast: () => ({ broadcastGroupAvatarKey: vi.fn() }) }));
vi.mock('../utils/avatarKeyStore', () => ({ saveAvatarKey: vi.fn() }));
vi.mock('../utils/firstWeekNudgeStore', () => ({ nudges: { notify: vi.fn() } }));

const { API_BASE } = await import('../constants');
const { AddFriendModal } = await import('./AddFriendModal');
const { CreateGroupModal } = await import('./CreateGroupModal');
const { AddToGroupModal } = await import('./AddToGroupModal');
const { SharedContentModal } = await import('./SharedContentModal');
const { CloseChatDialog } = await import('./CloseChatDialog');
const { SoloKickDialog } = await import('./call/SoloKickDialog');
const { PurgeConfirmModal } = await import('./PurgeControls');
const { DangerPane } = await import('./settings/panes/DangerPane');
const { ConfirmDialog } = await import('./primitives/ConfirmDialog');
const { useUnsavedChangesGuard } = await import('../hooks/useUnsavedChangesGuard');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    axiosGet.mockReset(); axiosPost.mockReset(); axiosDelete.mockReset();
    axiosGet.mockImplementation(async (url: string) => {
        if (/totp\/status$/.test(url)) return { data: { enabled: false } };
        return { data: { accepted: [
            { user_id: 'u-ann', username: 'Ann', discriminator: 12, avatar_url: null },
            { user_id: 'u-bob', username: 'Bob', discriminator: 345, avatar_url: null },
        ] } };
    });
    axiosPost.mockResolvedValue({ data: { conversation_id: 'g-new', ok: true } });
    axiosDelete.mockResolvedValue({ data: { ok: true } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const wait = async (ms = 60) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); await wait(30); };
const render = async (el: React.ReactElement) => { act(() => root.render(el)); await flush(); };
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const btn = (re: RegExp) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => re.test(b.textContent?.trim() ?? ''));
const click = async (el: HTMLElement | undefined | null) => {
    expect(el).toBeTruthy();
    await act(async () => { el!.click(); });
    await flush();
};
const typeInto = async (el: Element | null | undefined, value: string) => {
    expect(el).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })); });
};
const option = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent?.includes(name));
/** Every dialog closes through useModalExit's 260ms timer. */
const closed = () => wait(420);

// ───────────────────────────────────────────────────────────────────────────
describe('AddFriendModal', () => {
    it('renders the title and a primary that is disabled until a tag is typed', async () => {
        await render(React.createElement(AddFriendModal, { onClose: vi.fn() }));
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Add a friend');
        expect(btn(/^Send request$/)?.disabled).toBe(true);
        await typeInto(document.querySelector('#add-friend-tag'), 'Ann#0012');
        expect(btn(/^Send request$/)?.disabled).toBe(false);
    });

    it('submitting sends the same request (parsed username + discriminator)', async () => {
        await render(React.createElement(AddFriendModal, { onClose: vi.fn() }));
        await typeInto(document.querySelector('#add-friend-tag'), 'Ann#0012');
        await click(btn(/^Send request$/));
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost.mock.calls[0][0]).toBe(`${API_BASE}/friends/request`);
        expect(axiosPost.mock.calls[0][1]).toMatchObject({ target_username: 'Ann' });
        expect(axiosPost.mock.calls[0][2]).toEqual({ headers: { Authorization: 'Bearer tok' } });
        expect(dialog()?.textContent).toContain('Friend request sent to Ann#0012!');
    });

    it('CONTROL: a malformed tag shows an inline error and sends nothing', async () => {
        await render(React.createElement(AddFriendModal, { onClose: vi.fn() }));
        await typeInto(document.querySelector('#add-friend-tag'), 'nohash');
        await click(btn(/^Send request$/));
        expect(axiosPost).not.toHaveBeenCalled();
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Format: Username#1234');
    });

    it('a server refusal is shown inline and the dialog stays open', async () => {
        axiosPost.mockRejectedValue({ response: { data: { message: 'No user found with that tag.' } } });
        const onClose = vi.fn();
        await render(React.createElement(AddFriendModal, { onClose }));
        await typeInto(document.querySelector('#add-friend-tag'), 'Ann#0012');
        await click(btn(/^Send request$/));
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('No user found with that tag.');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Cancel closes it', async () => {
        const onClose = vi.fn();
        await render(React.createElement(AddFriendModal, { onClose }));
        await click(btn(/^Cancel$/));
        await closed();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('CreateGroupModal', () => {
    const mountGroup = async (extra: Record<string, unknown> = {}) => {
        const onClose = vi.fn();
        const onGroupCreated = vi.fn();
        await render(React.createElement(CreateGroupModal, { onClose, onGroupCreated, ...extra }));
        return { onClose, onGroupCreated };
    };

    it('renders the title; the primary is disabled until the group is named AND a friend is picked', async () => {
        await mountGroup();
        expect(dialog()?.querySelector('h2')?.textContent).toBe('New group chat');
        expect(btn(/^Create group$/)?.disabled).toBe(true);
        await typeInto(document.querySelector('#create-group-name'), 'Crew');
        expect(btn(/^Create group$/)?.disabled).toBe(true);   // named, nobody picked
        await click(option('Ann'));
        expect(btn(/^Create group$/)?.disabled).toBe(false);
        expect(dialog()?.querySelector('.dlg-foot-hint')?.textContent).toContain('1');
    });

    it('creating sends the same request: trimmed title + the picked ids, then hands the group to the host', async () => {
        const { onGroupCreated } = await mountGroup();
        await typeInto(document.querySelector('#create-group-name'), '  Crew  ');
        await click(option('Ann'));
        await click(option('Bob'));
        await click(btn(/^Create group$/));
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost.mock.calls[0][0]).toBe(`${API_BASE}/conversations/group`);
        expect(axiosPost.mock.calls[0][1]).toEqual({ title: 'Crew', initial_user_ids: ['u-ann', 'u-bob'] });
        expect(axiosPost.mock.calls[0][2]).toEqual({ headers: { Authorization: 'Bearer tok', 'x-device-id': 'dev-1' } });
        expect(onGroupCreated).toHaveBeenCalledWith({ id: 'g-new', title: 'Crew', type: 'group' });
    });

    it('pre-selected users start selected (and are sent) even before the friends list resolves them', async () => {
        const { onGroupCreated } = await mountGroup({ preSelectedUsers: [{ user_id: 'u-zed', username: 'Zed' }] });
        expect(dialog()?.textContent).toContain('Zed pre-added');
        await typeInto(document.querySelector('#create-group-name'), 'Crew');
        await click(btn(/^Create group$/));
        expect(axiosPost.mock.calls[0][1]).toEqual({ title: 'Crew', initial_user_ids: ['u-zed'] });
        expect(onGroupCreated).toHaveBeenCalled();
    });

    it('CONTROL: a server refusal is shown inline, nothing is handed to the host', async () => {
        axiosPost.mockRejectedValue({ response: { data: { message: 'Group limit reached.' } } });
        const { onGroupCreated } = await mountGroup();
        await typeInto(document.querySelector('#create-group-name'), 'Crew');
        await click(option('Ann'));
        await click(btn(/^Create group$/));
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Group limit reached.');
        expect(onGroupCreated).not.toHaveBeenCalled();
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AddToGroupModal', () => {
    const GROUPS = [
        { conversation_id: 'g1', title: 'Weekend Crew' },
        { conversation_id: 'g2', title: 'Ops' },
    ];
    const mountAdd = async () => {
        const onClose = vi.fn(); const onGroupJoined = vi.fn(); const onCreateNew = vi.fn();
        await render(React.createElement(AddToGroupModal, {
            targetUser: { user_id: 'u-sana', username: 'Sana' }, myGroups: GROUPS, onClose, onGroupJoined, onCreateNew,
        }));
        return { onClose, onGroupJoined, onCreateNew };
    };

    it('lists the groups; Add invites that one user to that group (same endpoint + body)', async () => {
        const { onGroupJoined } = await mountAdd();
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Add to group');
        expect(dialog()?.textContent).toContain('Weekend Crew');
        await click(btn(/^Add$/));
        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/g1/invite`, { user_id: 'u-sana' }, { headers: { Authorization: 'Bearer tok' } },
        );
        await wait(900);
        expect(onGroupJoined).toHaveBeenCalledWith('g1');
    });

    it('the primary "New group" hands off to the create flow without any request', async () => {
        const { onCreateNew } = await mountAdd();
        await click(btn(/New group$/));
        expect(onCreateNew).toHaveBeenCalledTimes(1);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('CONTROL: a failed invite shows the server message on that row and never reports a join', async () => {
        axiosPost.mockRejectedValue({ response: { data: { message: 'Not a mutual friend.' } } });
        const { onGroupJoined } = await mountAdd();
        await click(btn(/^Add$/));
        expect(dialog()?.querySelector('.dlg-row-err')?.textContent).toBe('Not a mutual friend.');
        await wait(900);
        expect(onGroupJoined).not.toHaveBeenCalled();
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('SharedContentModal', () => {
    const MESSAGES = [
        { id: 'm1', sender_user_id: 'u-ann', sent_at_client: '2026-10-10T10:00:00Z', content: { type: 'text', text: 'see https://example.org/page' } },
    ];
    it('renders the title + tabs and Done closes it; the links tab shows the shared link', async () => {
        const onClose = vi.fn();
        await render(React.createElement(SharedContentModal, {
            open: true, initialTab: 'links', onClose, messages: MESSAGES, token: 'tok', title: 'Ann',
        }));
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Shared in Ann');
        expect(dialog()?.textContent).toContain('example.org/page');
        await click(btn(/^Done$/));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('CloseChatDialog', () => {
    const mountClose = async (state: { id: string; title: string; isGroup?: boolean }, checked = false) => {
        const onClose = vi.fn(); const onConfirm = vi.fn(); const setChecked = vi.fn();
        await render(React.createElement(CloseChatDialog, {
            state, deleteDataChecked: checked, setDeleteDataChecked: setChecked, onConfirm, onClose,
        }));
        await wait(200);
        return { onClose, onConfirm, setChecked };
    };

    it('DM: "Close chat" confirms; initial focus is the safe button (Cancel)', async () => {
        const { onConfirm } = await mountClose({ id: 'c1', title: 'Mira' });
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Close chat?');
        expect(document.activeElement).toBe(btn(/^Cancel$/));
        await click(btn(/^Close chat$/));
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('DM with "delete history" ticked relabels the primary and makes it danger', async () => {
        await mountClose({ id: 'c1', title: 'Mira' }, true);
        expect(btn(/^Delete & close$/)?.closest('.clb')?.classList.contains('clb--danger')).toBe(true);
    });

    it('GROUP: Leave is disabled until the acknowledgement is ticked (CONTROL: enabled once ticked)', async () => {
        const first = await mountClose({ id: 'g1', title: 'Crew', isGroup: true }, false);
        expect(btn(/^Leave group$/)?.disabled).toBe(true);
        await click(btn(/^Leave group$/));
        expect(first.onConfirm).not.toHaveBeenCalled();
        act(() => root.unmount());
        root = createRoot(host);
        const second = await mountClose({ id: 'g1', title: 'Crew', isGroup: true }, true);
        expect(btn(/^Leave group$/)?.disabled).toBe(false);
        await click(btn(/^Leave group$/));
        expect(second.onConfirm).toHaveBeenCalledTimes(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('SoloKickDialog', () => {
    it('explains the call ended; "Got it" closes it', async () => {
        const onClose = vi.fn();
        await render(React.createElement(SoloKickDialog, { onClose }));
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Call ended');
        expect(dialog()?.textContent).toContain('alone for 15 minutes');
        await click(btn(/^Got it$/));
        await closed();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PurgeConfirmModal', () => {
    it('shows the exact count; Delete N confirms and Cancel does not', async () => {
        const onConfirm = vi.fn(); const onCancel = vi.fn();
        await render(React.createElement(PurgeConfirmModal, { count: 1284, label: '1 month', convTitle: 'Mira', onConfirm, onCancel }));
        await wait(100);
        expect(dialog()?.textContent).toContain('1,284');
        expect(document.activeElement).toBe(btn(/^Cancel$/));
        await click(btn(/^Cancel$/));
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
        await click(btn(/^Delete 1,284$/));
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: with nothing to purge there is no destructive button at all, just Close', async () => {
        const onConfirm = vi.fn(); const onCancel = vi.fn();
        await render(React.createElement(PurgeConfirmModal, { count: 0, label: '1 week', onConfirm, onCancel }));
        expect(btn(/^Delete/)).toBeUndefined();
        await click(btn(/^Close$/));
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('ConfirmDialog (primitive behind delete / kick / ban / leave confirmations)', () => {
    it('Cancel is focused first; Confirm runs onConfirm after the exit animation, Cancel never confirms', async () => {
        const onConfirm = vi.fn(); const onCancel = vi.fn();
        await render(React.createElement(ConfirmDialog, { title: 'Delete message?', message: 'Gone for everyone.', confirmLabel: 'Delete', onConfirm, onCancel }));
        await wait(200);
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Delete message?');
        expect(document.activeElement).toBe(btn(/^Cancel$/));
        await click(btn(/^Delete$/));
        await wait(300);
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('Escape cancels (and only cancels)', async () => {
        const onConfirm = vi.fn(); const onCancel = vi.fn();
        await render(React.createElement(ConfirmDialog, { title: 'Kick Bob?', confirmLabel: 'Kick', onConfirm, onCancel }));
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        await wait(300);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('a bare title works without a message, and the hint sits in the footer', async () => {
        await render(React.createElement(ConfirmDialog, { title: 'Remove role?', hint: 'Hold Shift to skip', onConfirm: vi.fn(), onCancel: vi.fn() }));
        expect(dialog()?.querySelector('.dlg-text')).toBeNull();
        expect(dialog()?.querySelector('.dlg-foot-hint')?.textContent).toBe('Hold Shift to skip');
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('unsaved-changes guard dialog (useUnsavedChangesGuard)', () => {
    let api: ReturnType<typeof useUnsavedChangesGuard>;
    const Probe: React.FC = () => { api = useUnsavedChangesGuard('Your profile changes'); return React.createElement(React.Fragment, null, api.dialog); };

    it('clean: the action runs immediately, no dialog', async () => {
        await render(React.createElement(Probe));
        const action = vi.fn();
        act(() => api.guard(action));
        expect(action).toHaveBeenCalledTimes(1);
        expect(dialog()).toBeNull();
    });

    it('dirty: asks first; Cancel keeps the changes, "Discard changes" runs the action and clears dirty', async () => {
        await render(React.createElement(Probe));
        act(() => api.setDirty(true));
        const action = vi.fn();
        act(() => api.guard(action));
        await wait(200);
        expect(action).not.toHaveBeenCalled();
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Unsaved changes');
        expect(dialog()?.textContent).toContain('Your profile changes haven');
        expect(document.activeElement).toBe(btn(/^Cancel$/));
        await click(btn(/^Cancel$/));
        await wait(300);
        expect(action).not.toHaveBeenCalled();
        expect(api.dirty).toBe(true);

        act(() => api.guard(action));
        await wait(100);
        await click(btn(/^Discard changes$/));
        await wait(300);
        expect(action).toHaveBeenCalledTimes(1);
        expect(api.dirty).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
describe('DangerPane — delete-account dialog (step-up preserved)', () => {
    const mountDanger = async () => {
        const onLogout = vi.fn(); const onCloseSettings = vi.fn();
        await render(React.createElement(DangerPane, { onLogout, onCloseSettings }));
        await click(btn(/Delete my account/));
        await wait(150);
        return { onLogout, onCloseSettings };
    };
    const deleteBtn = () => dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]');

    it('opens a dialog titled "Delete account" and fetches the 2FA status', async () => {
        await mountDanger();
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Delete account');
        expect(axiosGet.mock.calls.some(c => /totp\/status$/.test(String(c[0])))).toBe(true);
    });

    it('no 2FA: delete stays disabled until the password is typed AND an emailed code was requested', async () => {
        await mountDanger();
        expect(deleteBtn()?.disabled).toBe(true);
        await typeInto(document.querySelector('#delete-account-password'), 'correct horse');
        expect(deleteBtn()?.disabled).toBe(true);                  // password alone is not enough
        await click(btn(/^Email me a verification code$/));
        expect(axiosPost.mock.calls.some(c => String(c[0]) === `${API_BASE}/auth/account/deletion-code`)).toBe(true);
        expect(deleteBtn()?.disabled).toBe(false);
    });

    it('with 2FA: needs the authenticator code, and sends password + totp_code to DELETE /auth/account', async () => {
        axiosGet.mockImplementation(async (url: string) => (/totp\/status$/.test(url) ? { data: { enabled: true } } : { data: {} }));
        const { onLogout, onCloseSettings } = await mountDanger();
        await typeInto(document.querySelector('#delete-account-password'), 'correct horse');
        expect(deleteBtn()?.disabled).toBe(true);                  // code missing
        await typeInto(document.querySelector('input[aria-label="Authenticator code"]'), '123456');
        expect(deleteBtn()?.disabled).toBe(false);
        await click(deleteBtn());
        expect(axiosDelete).toHaveBeenCalledTimes(1);
        expect(axiosDelete.mock.calls[0][0]).toBe(`${API_BASE}/auth/account`);
        expect(axiosDelete.mock.calls[0][1]).toEqual({
            headers: { Authorization: 'Bearer tok' },
            data: { password: 'correct horse', totp_code: '123456' },
        });
        expect(onCloseSettings).toHaveBeenCalledTimes(1);
        expect(onLogout).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: a refusal stays in the dialog as an inline error and does not log out', async () => {
        axiosGet.mockImplementation(async (url: string) => (/totp\/status$/.test(url) ? { data: { enabled: true } } : { data: {} }));
        axiosDelete.mockRejectedValue({ response: { data: { message: 'Incorrect password.' } } });
        const { onLogout } = await mountDanger();
        await typeInto(document.querySelector('#delete-account-password'), 'nope');
        await typeInto(document.querySelector('input[aria-label="Authenticator code"]'), '123456');
        await click(deleteBtn());
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Incorrect password.');
        expect(onLogout).not.toHaveBeenCalled();
    });

    it('Cancel closes the dialog without any request', async () => {
        await mountDanger();
        await click(btn(/^Cancel$/));
        await wait(400);
        expect(axiosDelete).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
    });
});
