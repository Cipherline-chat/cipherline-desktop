// @vitest-environment jsdom
/**
 * The redesigned New Message dialog (StartDMModal), mounted for real.
 *
 * Behaviour that must survive the redesign, each with a control:
 *   - only ACCEPTED friends are offered (GET /friends → `accepted`);
 *   - opening a 1:1 is the same single call as before — POST /conversations/dm
 *     { other_user_id } with the auth + device headers — then onDMStarted;
 *     the server's mutual-friendship gate is untouched (a 403 surfaces as an
 *     error, the client does not retry or work around it);
 *   - the dialog is SINGLE-select (no checkboxes, no chips): a row click only
 *     picks (no network) and the footer's "Open chat" opens the pick;
 *   - groups are a quiet footer link, "Start a group chat", which hands the
 *     picked friend (or nobody) to onStartGroup — hidden without that prop;
 *   - no "End-to-end encrypted" line in the footer;
 *   - keyboard: arrows move aria-activedescendant, Enter opens the highlight;
 *   - empty / error states: no friends (Add a friend → the real flow), no
 *     search results, friends failed to load (with retry).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'fs';
import * as path from 'path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = function () {};

const axiosGet = vi.fn();
const axiosPost = vi.fn();
vi.mock('axios', () => ({
    default: { get: (...a: unknown[]) => axiosGet(...a), post: (...a: unknown[]) => axiosPost(...a) },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', user: { user_id: 'me', username: 'Dawson' }, deviceId: 'dev-1' }),
}));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('./AddFriendModal', () => ({
    AddFriendModal: () => React.createElement('div', { 'data-testid': 'add-friend-modal' }, 'Add Friend'),
}));

const { StartDMModal } = await import('./StartDMModal');
const { API_BASE } = await import('../constants');

const NOW = Date.now();
const FRIENDS = [
    { user_id: 'u-ann', username: 'Ann', discriminator: 12, avatar_url: null },
    { user_id: 'u-bob', username: 'Bob', discriminator: 345, avatar_url: 'av-bob' },
    { user_id: 'u-cat', username: 'Cat', discriminator: null, avatar_url: null },
];
const CONVERSATIONS = [
    { conversation_id: 'c-bob', type: 'dm', other_user_id: 'u-bob', title: 'Bob' },
    { conversation_id: 'g-1', type: 'group', title: 'Crew' },
];

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    axiosGet.mockResolvedValue({
        data: { accepted: FRIENDS, pending_incoming: [{ user_id: 'u-pend', username: 'Pending' }], pending_outgoing: [] },
    });
    axiosPost.mockImplementation(async (_url: string, body: { other_user_id: string }) => ({ data: { conversation_id: 'conv-' + body.other_user_id } }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };

type Props = Parameters<typeof StartDMModal>[0];
async function mount(extra: Partial<Props> = {}) {
    const onDMStarted = vi.fn();
    const onStartGroup = vi.fn();
    const onClose = vi.fn();
    const props: Props = {
        onClose,
        onDMStarted,
        existingConversations: CONVERSATIONS,
        friendStatuses: { 'u-bob': { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null } },
        lastActivityAt: { 'c-bob': NOW - 60_000 },
        onStartGroup,
        ...extra,
    };
    await act(async () => { root.render(React.createElement(StartDMModal, props)); });
    await flush();
    return { onDMStarted, onStartGroup, onClose };
}

const dialog = () => document.querySelector('[role=dialog]') as HTMLElement;
const input = () => document.querySelector('input[role=combobox]') as HTMLInputElement;
const names = () => [...document.querySelectorAll('[role=option] .pp-name')].map(n => n.textContent);
const option = (userId: string) => document.querySelector(`[role=option][data-user-id="${userId}"]`) as HTMLElement;
const button = (label: string) =>
    [...dialog().querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
/** A button in the footer only (the highlighted row's hover pill is also labelled "Open chat"). */
const footBtn = (label: string) =>
    [...dialog().querySelectorAll('.dlg-foot button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const activeName = () => {
    const id = input().getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.querySelector('.pp-name')?.textContent ?? null : null;
};
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }
async function key(k: string, opts: KeyboardEventInit = {}) {
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts })); });
    await flush();
}
async function type(value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { set.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
}

describe('who is offered', () => {
    it('lists exactly the accepted friends (pending requests are not offered)', async () => {
        await mount();
        expect(axiosGet).toHaveBeenCalledWith(`${API_BASE}/friends`, { headers: { Authorization: 'Bearer tok' } });
        expect(names().sort()).toEqual(['Ann', 'Bob', 'Cat']);
        // control: the pending user really was in the payload
        expect(JSON.stringify(await axiosGet.mock.results[0].value)).toContain('Pending');
        expect(names()).not.toContain('Pending');
    });

    it('groups Recent (has a chat) before the rest; the repeated "existing chat" tag is gone from view', async () => {
        await mount();
        const heads = [...document.querySelectorAll('.pp-section-head')].map(h => h.firstChild?.textContent);
        expect(heads).toEqual(['Recent', 'Offline']);
        expect(names()[0]).toBe('Bob');
        // only a screen-reader cue remains
        const visibleTag = [...dialog().querySelectorAll('*')].filter(el =>
            !el.closest('.sr-only') && [...el.childNodes].some(n => n.nodeType === 3 && /existing chat/i.test(n.textContent ?? '')));
        expect(visibleTag).toHaveLength(0);
        expect(option('u-bob').textContent).toContain('existing chat'); // sr-only text, control
    });
});

describe('opening a chat — same call as before', () => {
    it('Enter on the highlighted row POSTs /conversations/dm once and reports the chat', async () => {
        const { onDMStarted } = await mount();
        expect(activeName()).toBe('Bob');
        await key('Enter');
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost).toHaveBeenCalledWith(
            `${API_BASE}/conversations/dm`,
            { other_user_id: 'u-bob' },
            { headers: { Authorization: 'Bearer tok', 'x-device-id': 'dev-1' } },
        );
        expect(onDMStarted).toHaveBeenCalledWith({ id: 'conv-u-bob', title: 'Bob', type: 'dm', other_user_id: 'u-bob', avatar_url: 'av-bob' });
    });

    it('the row action pill opens in one click; a plain row click only picks (no network)', async () => {
        const { onDMStarted } = await mount();
        await click(option('u-ann'));
        expect(axiosPost).not.toHaveBeenCalled();
        expect(option('u-ann').getAttribute('aria-selected')).toBe('true');
        expect(footBtn('Open chat')!.disabled).toBe(false);
        // let go of the pick, then use the hover action on Cat (no chat yet → "Start chat")
        await click(option('u-ann'));
        expect(option('u-ann').getAttribute('aria-selected')).toBe('false');
        await act(async () => { option('u-cat').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); });
        await flush();
        const pill = option('u-cat').querySelector('.pp-action') as HTMLButtonElement;
        expect(pill.textContent).toBe('Start chat');
        await click(pill);
        expect(axiosPost).toHaveBeenCalledWith(`${API_BASE}/conversations/dm`, { other_user_id: 'u-cat' }, expect.anything());
        expect(onDMStarted).toHaveBeenCalledTimes(1);
    });

    it('picking a friend enables "Open chat", which opens exactly that chat', async () => {
        const { onDMStarted } = await mount();
        expect(footBtn('Open chat')!.disabled).toBe(true); // nothing picked yet
        await click(option('u-bob'));
        const primary = footBtn('Open chat')!;
        expect(primary.disabled).toBe(false);
        await click(primary);
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(onDMStarted.mock.calls[0][0].other_user_id).toBe('u-bob');
    });

    it('is single-select: no checkboxes, no chips, a second pick replaces the first', async () => {
        await mount();
        await click(option('u-ann'));
        await click(option('u-cat'));
        expect(document.querySelector('.pp-check')).toBeNull();
        expect(document.querySelector('.pp-chip')).toBeNull();
        expect(document.querySelector('[role=listbox]')!.getAttribute('aria-multiselectable')).toBeNull();
        expect(option('u-ann').getAttribute('aria-selected')).toBe('false');
        expect(option('u-cat').getAttribute('aria-selected')).toBe('true');
        await click(footBtn('Open chat')!);
        expect(axiosPost.mock.calls[0][1]).toEqual({ other_user_id: 'u-cat' });
    });

    it('a pick hidden by a new search is dropped, so "Open chat" never acts on an unseen row', async () => {
        await mount();
        await click(option('u-ann'));
        await type('bo');
        expect(names()).toEqual(['Bob']);
        expect(footBtn('Open chat')!.disabled).toBe(true);
    });

    it('a refused DM (403: not mutual friends) shows an error and does not report a chat', async () => {
        axiosPost.mockRejectedValueOnce({ response: { status: 403, data: { message: 'Forbidden' } } });
        const { onDMStarted } = await mount();
        await key('Enter');
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(onDMStarted).not.toHaveBeenCalled();
        expect(dialog().querySelector('[role=alert]')?.textContent).toMatch(/need to be friends/);
        // control: a network failure words it differently
        axiosPost.mockRejectedValueOnce(new Error('Network Error'));
        await key('Enter');
        expect(dialog().querySelector('[role=alert]')?.textContent).toMatch(/Check your connection/);
    });
});

describe('group chat link', () => {
    const groupLink = () => footBtn('Start a group chat');

    it('nothing picked → onStartGroup([]) and nothing is created here', async () => {
        const { onStartGroup, onDMStarted } = await mount();
        expect(groupLink()).toBeTruthy();
        await click(groupLink()!);
        expect(onStartGroup).toHaveBeenCalledTimes(1);
        expect(onStartGroup).toHaveBeenCalledWith([]);
        expect(axiosPost).not.toHaveBeenCalled();
        expect(onDMStarted).not.toHaveBeenCalled();
    });

    it('a friend picked → they come along, prefilled', async () => {
        const { onStartGroup } = await mount();
        await click(option('u-bob'));
        await click(groupLink()!);
        expect(onStartGroup).toHaveBeenCalledWith([{ user_id: 'u-bob', username: 'Bob', avatar_url: 'av-bob' }]);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('is a quiet link on the left of the footer; Cancel + Open chat stay on the right', async () => {
        await mount();
        const left = dialog().querySelector('.dlg-foot-hint')!;
        expect(left.querySelector('button.dlg-foot-link')?.textContent?.trim()).toBe('Start a group chat');
        const actions = [...dialog().querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim());
        expect(actions).toEqual(['Cancel', 'Open chat']);
    });

    it('is hidden without onStartGroup (and when there are no friends to group with)', async () => {
        await mount({ onStartGroup: undefined });
        expect(groupLink()).toBeUndefined();
        act(() => root.unmount());
        root = createRoot(host);
        axiosGet.mockResolvedValue({ data: { accepted: [] } });
        await mount();
        expect(groupLink()).toBeUndefined();
    });

    it('the self row can be picked but is never carried into a group', async () => {
        const { onStartGroup } = await mount();
        await type('me');
        await click(option('me'));
        expect(axiosPost).not.toHaveBeenCalled();
        await click(groupLink()!);
        expect(onStartGroup).toHaveBeenCalledWith([]);
    });

    it('the footer no longer carries the end-to-end-encrypted line or a "selected" count', async () => {
        await mount();
        await click(option('u-bob'));
        expect(dialog().textContent).not.toMatch(/end-to-end|encrypted/i);
        expect(dialog().textContent).not.toMatch(/\d+ selected/);
        expect(dialog().textContent).not.toMatch(/pick a few|several/i);
    });
});

describe('keyboard', () => {
    it('arrows move the highlight (wrapping), Enter opens the highlighted person', async () => {
        await mount();
        const order = names();
        expect(activeName()).toBe(order[0]);
        await key('ArrowDown');
        expect(activeName()).toBe(order[1]);
        await key('ArrowUp');
        await key('ArrowUp');
        expect(activeName()).toBe(order[order.length - 1]); // wrapped
        await key('Enter');
        expect(axiosPost.mock.calls[0][1]).toEqual({ other_user_id: FRIENDS.find(f => f.username === order[order.length - 1])!.user_id });
    });

    it('Space / Backspace no longer multi-select; Enter opens the highlight even with a pick', async () => {
        const { onStartGroup } = await mount();
        await click(option('u-ann'));
        await key(' ');
        await key('Backspace');
        expect(document.querySelector('.pp-chip')).toBeNull();
        expect(axiosPost).not.toHaveBeenCalled();
        await key('Enter');
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(onStartGroup).not.toHaveBeenCalled();
    });

    it('focus starts in the search field, which owns the listbox', async () => {
        await mount();
        await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
        expect(document.activeElement).toBe(input());
        expect(input().getAttribute('aria-controls')).toBe(document.querySelector('[role=listbox]')!.id);
        expect(document.querySelector('[role=listbox]')!.getAttribute('aria-multiselectable')).toBeNull();
    });
});

describe('wiring (source-level)', () => {
    // Dashboard is too large to mount; pin that it feeds the dialog its live
    // data and routes a group pick into the existing group-creation step.
    const dash = fs.readFileSync(path.join(__dirname, 'Dashboard.tsx'), 'utf8');
    const block = dash.slice(dash.indexOf('<StartDMModal'), dash.indexOf('/>', dash.indexOf('<StartDMModal')));
    it('Dashboard passes presence, activity and the group link hand-off to CreateGroupModal (empty list allowed)', () => {
        expect(block).toMatch(/friendStatuses=\{friendStatuses\}/);
        expect(block).toMatch(/presence=\{displayPresence\}/);
        expect(block).toMatch(/lastActivityAt=\{lastActivityAt\}/);
        expect(block).toMatch(/onStartGroup=\{\(people\) => \{[\s\S]*setCreateGroupPreselected\(people\);[\s\S]*setShowCreateGroupModal\(true\);/);
        // control: the block really is the StartDMModal element (it still carries onDMStarted)
        expect(block).toMatch(/onDMStarted=/);
    });
});

describe('empty and error states', () => {
    it('no friends → explains why and offers "Add a friend", which opens the Add Friend flow', async () => {
        axiosGet.mockResolvedValue({ data: { accepted: [] } });
        await mount();
        expect(dialog().textContent).toContain('No friends yet');
        expect(document.querySelector('[data-testid=add-friend-modal]')).toBeNull();
        await click(button('Add a friend')!);
        expect(document.querySelector('[data-testid=add-friend-modal]')).not.toBeNull();
    });

    it('a search with no match says so (and is not the no-friends state)', async () => {
        await mount();
        await type('zzq');
        expect(names()).toEqual([]);
        expect(dialog().textContent).toContain('No friends match “zzq”');
        expect(dialog().textContent).not.toContain('No friends yet');
    });

    it('a failed friends load is an error with retry — not "No friends yet"', async () => {
        axiosGet.mockRejectedValueOnce(new Error('Network Error'));
        await mount();
        expect(dialog().textContent).toContain("Couldn't load your friends");
        expect(dialog().textContent).not.toContain('No friends yet');
        await click(button('Try again')!);
        expect(axiosGet).toHaveBeenCalledTimes(2);
        expect(names().sort()).toEqual(['Ann', 'Bob', 'Cat']);
    });

    it('nothing picked → the primary is disabled and the footer never ends in a lone Cancel', async () => {
        await mount();
        const actions = [...dialog().querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim());
        expect(actions).toEqual(['Cancel', 'Open chat']);
        expect(footBtn('Open chat')!.disabled).toBe(true);
    });
});
