// @vitest-environment jsdom
/**
 * Invite People: link settings regenerate on their own, and invites can be
 * sent straight to friends. What must hold:
 *   - there is no Regenerate / "Create new link" button; a settings change makes
 *     ONE new invite after a debounce, however many changes came in;
 *   - while that is pending or in flight the link box says "Updating link…" and
 *     Copy (and every friend Invite button) is disabled; afterwards Copy copies
 *     the NEW link;
 *   - the link this dialog made for the previous settings is revoked, unless it
 *     was already copied/sent, and a link the dialog merely reused on open is
 *     never revoked;
 *   - recent friends ordering, search, per-row send / sent / error states, and
 *     members marked and not offered.
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

const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), isAxiosError: () => false }));
vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));
vi.mock('../EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
const clip = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../utils/clipboard', () => ({ writeToClipboard: clip.write }));
const nudge = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../../utils/firstWeekNudgeStore', () => ({ nudges: nudge }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));
const roster = vi.hoisted(() => ({ members: null as string[] | null }));
vi.mock('../../utils/serverRosterCache', () => {
    const toRoster = () => (roster.members ? { members: roster.members.map(id => ({ user_id: id })), roles: [] } : null);
    return { peekRoster: () => toRoster(), refreshRoster: async () => toRoster() };
});

const { ServerInviteModal, REGEN_DEBOUNCE_MS } = await import('./ServerInviteModal');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
    axiosMock.delete.mockReset().mockResolvedValue({ data: { ok: true } });
    clip.write.mockReset().mockResolvedValue(undefined);
    nudge.notify.mockReset();
    roster.members = null;
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
const settle = async () => {
    await flush();
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    await act(async () => { vi.advanceTimersByTime(120); });
};
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
const text = () => document.body.textContent ?? '';
const linkText = () => document.querySelector('.dlg-linkbox-url')?.textContent;
const footerButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.dlg-foot-actions button'));
const copyBtn = () => footerButtons()[footerButtons().length - 1];
const click = async (b: HTMLElement | undefined | null) => { expect(b).toBeTruthy(); await act(async () => { b!.click(); }); await flush(); };
const buttonByText = (re: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => re.test(b.textContent ?? ''));
const chip = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.dlg-chips button')).find(b => b.textContent?.trim() === label);
const openSettings = async () => click(buttonByText(/Edit link settings/));
function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

const SERVER = { server_id: 's-1', name: 'Game night' } as never;
const mkInvite = (code: string, extra: object = {}) => ({ code, created_at: '2026-10-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0, ...extra });
const CHILD = 'https://cipherline.chat/invite/';
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const mountBare = async (props: Record<string, unknown> = {}) => {
    act(() => root.render(React.createElement(ServerInviteModal, { server: SERVER, token: 'tok', onClose: vi.fn(), ...props })));
    await settle();
};

/* ───────────────────────────── auto-regenerate ───────────────────────────── */

describe('link settings regenerate automatically', () => {
    it('has no Regenerate / Create-new-link button anywhere, settings open or closed', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        await mountBare();
        const noRegen = () => expect(Array.from(document.querySelectorAll('button')).some(b => /regenerate|create new link|new link/i.test(b.textContent ?? ''))).toBe(false);
        noRegen();
        await openSettings();
        noRegen();
        expect(text()).toContain('Changes update the link automatically.');
    });

    it('a settings change makes one new invite after the debounce, and nothing before it', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        axiosMock.post.mockResolvedValue({ data: mkInvite('Fresh2', { max_uses: 10 }) });
        await mountBare();
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS - 100);
        expect(axiosMock.post).not.toHaveBeenCalled();
        await advance(200);
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        expect(axiosMock.post.mock.calls[0][1]).toEqual({ max_uses: 10, expires_in_seconds: 168 * 3600 });
        expect(linkText()).toBe(CHILD + 'Fresh2');
    });

    it('a burst of changes makes exactly one invite, for the LAST settings', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        axiosMock.post.mockResolvedValue({ data: mkInvite('Fresh2') });
        await mountBare();
        await openSettings();
        await click(chip('5'));
        await advance(300);
        await click(chip('25'));
        await advance(300);
        await click(chip('1 hour'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        expect(axiosMock.post.mock.calls[0][1]).toEqual({ max_uses: 25, expires_in_seconds: 3600 });
    });

    it('changing a setting and changing it back inside the debounce makes no invite', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        await mountBare();
        await openSettings();
        await click(chip('10'));
        await click(chip('∞'));
        await advance(REGEN_DEBOUNCE_MS + 100);
        expect(axiosMock.post).not.toHaveBeenCalled();
        expect(linkText()).toBe(CHILD + 'Reused1');
        expect(copyBtn().disabled).toBe(false);
    });

    it('shows "Updating link…" and keeps Copy disabled from the change until the new link is ready; Copy then copies the new link', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        const inflight = deferred<{ data: unknown }>();
        axiosMock.post.mockReturnValueOnce(inflight.promise);
        await mountBare();
        expect(copyBtn().disabled).toBe(false);
        await openSettings();
        await click(chip('10'));
        // During the debounce: the old link must not be copyable.
        expect(copyBtn().disabled).toBe(true);
        expect(linkText()).toBe('Updating link…');
        await advance(REGEN_DEBOUNCE_MS + 50);
        // The POST is in flight.
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        expect(copyBtn().disabled).toBe(true);
        expect(linkText()).toBe('Updating link…');
        expect(document.querySelector('.dlg-foot-hint')?.textContent).toBe('Updating link…');
        await click(copyBtn());
        expect(clip.write).not.toHaveBeenCalled();
        await act(async () => { inflight.resolve({ data: mkInvite('Fresh2', { max_uses: 10 }) }); });
        await flush();
        expect(copyBtn().disabled).toBe(false);
        expect(linkText()).toBe(CHILD + 'Fresh2');
        await click(copyBtn());
        expect(clip.write).toHaveBeenCalledTimes(1);
        expect(clip.write).toHaveBeenCalledWith(CHILD + 'Fresh2');
    });

    it('revokes the link this dialog made for the previous settings', async () => {
        axiosMock.get.mockResolvedValue({ data: [] });
        axiosMock.post
            .mockResolvedValueOnce({ data: mkInvite('First1') })
            .mockResolvedValueOnce({ data: mkInvite('Second2', { max_uses: 10 }) });
        await mountBare();
        expect(linkText()).toBe(CHILD + 'First1');
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(linkText()).toBe(CHILD + 'Second2');
        expect(axiosMock.delete).toHaveBeenCalledTimes(1);
        expect(String(axiosMock.delete.mock.calls[0][0])).toContain('/servers/s-1/invites/First1');
    });

    it('a chain of changes revokes each superseded link, never the one on screen', async () => {
        axiosMock.get.mockResolvedValue({ data: [] });
        axiosMock.post
            .mockResolvedValueOnce({ data: mkInvite('A1') })
            .mockResolvedValueOnce({ data: mkInvite('B2') })
            .mockResolvedValueOnce({ data: mkInvite('C3') });
        await mountBare();
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        await click(chip('25'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(linkText()).toBe(CHILD + 'C3');
        expect(axiosMock.delete.mock.calls.map(c => String(c[0]).split('/').pop())).toEqual(['A1', 'B2']);
    });

    it('does NOT revoke a link it merely reused on open', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        axiosMock.post.mockResolvedValue({ data: mkInvite('Fresh2') });
        await mountBare();
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(linkText()).toBe(CHILD + 'Fresh2');
        expect(axiosMock.delete).not.toHaveBeenCalled();
    });

    it('does NOT revoke a link that was already copied', async () => {
        axiosMock.get.mockResolvedValue({ data: [] });
        axiosMock.post
            .mockResolvedValueOnce({ data: mkInvite('First1') })
            .mockResolvedValueOnce({ data: mkInvite('Second2') });
        await mountBare();
        await click(copyBtn());
        expect(clip.write).toHaveBeenCalledWith(CHILD + 'First1');
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(linkText()).toBe(CHILD + 'Second2');
        expect(axiosMock.delete).not.toHaveBeenCalled();
    });

    it('a failed regeneration keeps Copy disabled, says so, and Try again retries', async () => {
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Reused1')] });
        axiosMock.post
            .mockRejectedValueOnce({ response: { data: { message: 'Slow down' } } })
            .mockResolvedValueOnce({ data: mkInvite('Fresh2') });
        await mountBare();
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Slow down');
        expect(copyBtn().disabled).toBe(true);
        expect(axiosMock.delete).not.toHaveBeenCalled();
        await click(buttonByText(/Try again/));
        expect(axiosMock.post).toHaveBeenCalledTimes(2);
        expect(linkText()).toBe(CHILD + 'Fresh2');
        expect(copyBtn().disabled).toBe(false);
        expect(document.querySelector('[role="alert"]')).toBeNull();
    });
});

/* ───────────────────────────── friends ───────────────────────────── */

describe('invite a friend from the dialog', () => {
    const NOW = Date.now();
    const iso = (ms: number) => new Date(NOW - ms).toISOString();
    const H = 3_600_000;
    const friend = (id: string, username: string, since: number, disc = 1) => ({ user_id: id, username, discriminator: disc, avatar_url: null, friends_since: iso(since) });
    // Ana: old friend, chatted 10 min ago. Bo: added 1 h ago, never chatted. Cy: old friend, chatted 3 days ago.
    // Di/Ed: old friends with nothing recent. Fay: blocked.
    const FRIENDS = [
        friend('u-ana', 'Ana', 400 * 24 * H, 7),
        friend('u-bo', 'Bo', 1 * H, 42),
        friend('u-cy', 'Cy', 300 * 24 * H, 3),
        friend('u-di', 'Dimitri', 500 * 24 * H, 4),
        friend('u-ed', 'Edith', 450 * 24 * H, 5),
        friend('u-fay', 'Fay', 1 * H, 6),
    ];
    const CONVS = [
        { conversation_id: 'c-ana', type: 'dm', other_user_id: 'u-ana' },
        { conversation_id: 'c-cy', type: 'dm', other_user_id: 'u-cy' },
    ];
    const ACTIVITY = { 'c-ana': NOW - 10 * 60_000, 'c-cy': NOW - 3 * 24 * H };
    const onSendInvite = vi.fn();
    const rowIds = () => Array.from(document.querySelectorAll<HTMLElement>('.dlg-fr-row')).map(r => r.dataset.userId);
    const row = (id: string) => document.querySelector<HTMLElement>(`.dlg-fr-row[data-user-id="${id}"]`)!;
    const inviteBtn = (id: string) => row(id).querySelector<HTMLButtonElement>('button')!;
    const searchBox = () => document.querySelector<HTMLInputElement>('[data-testid="invite-friends"] input')!;
    const mount = (extra: Record<string, unknown> = {}) => mountBare({
        friends: FRIENDS, conversations: CONVS, lastActivityAt: ACTIVITY, blockedIds: new Set(['u-fay']), myUserId: 'u-me', onSendInvite, ...extra,
    });
    beforeEach(() => {
        onSendInvite.mockReset().mockResolvedValue(true);
        axiosMock.get.mockResolvedValue({ data: [mkInvite('Link1234')] });
    });

    it('lists recent friends: newest signal first (a chat 10 min ago beats a friend added 1 h ago, which beats a chat 3 days ago); older friends follow by when they were added; blocked friends never appear', async () => {
        await mount();
        expect(document.querySelector('.dlg-fr .dlg-section')?.textContent).toBe('Recent friends');
        expect(rowIds()).toEqual(['u-ana', 'u-bo', 'u-cy', 'u-ed', 'u-di']);
        expect(row('u-ana').textContent).toContain('Ana');
        expect(row('u-ana').textContent).toContain('#0007');
        expect(row('u-ana').textContent).toContain('Recent chat');
        expect(row('u-bo').textContent).toContain('New friend');
        expect(rowIds()).not.toContain('u-fay');
    });

    it('a brand-new friend leads the list when nothing was said recently', async () => {
        await mount({ lastActivityAt: { 'c-ana': NOW - 5 * 24 * H, 'c-cy': NOW - 3 * 24 * H } });
        expect(rowIds().slice(0, 3)).toEqual(['u-bo', 'u-cy', 'u-ana']);
    });

    it('Invite sends the CURRENT link through the send path exactly once and the row reads Sent', async () => {
        await mount();
        await click(inviteBtn('u-bo'));
        expect(onSendInvite).toHaveBeenCalledTimes(1);
        expect(onSendInvite).toHaveBeenCalledWith('u-bo', 'Link1234');
        expect(row('u-bo').textContent).toContain('Sent');
        expect(row('u-bo').querySelector('button')).toBeNull();
        expect(nudge.notify).toHaveBeenCalledWith({ kind: 'invite_sent' });
        // Other rows are untouched.
        expect(row('u-ana').textContent).not.toContain('Sent');
    });

    it('a double click while sending still sends once', async () => {
        const d = deferred<boolean>();
        onSendInvite.mockReturnValueOnce(d.promise);
        await mount();
        const b = inviteBtn('u-bo');
        await act(async () => { b.click(); b.click(); });
        expect(onSendInvite).toHaveBeenCalledTimes(1);
        expect(inviteBtn('u-bo').disabled).toBe(true);
        await act(async () => { d.resolve(true); });
        await flush();
        expect(row('u-bo').textContent).toContain('Sent');
    });

    it('a failed send shows an error on the row and offers Retry, which can succeed', async () => {
        onSendInvite.mockResolvedValueOnce(false);
        await mount();
        await click(inviteBtn('u-bo'));
        expect(row('u-bo').textContent).toContain('Couldn’t send');
        expect(row('u-bo').textContent).not.toContain('Sent');
        expect(inviteBtn('u-bo').textContent).toContain('Retry');
        await click(inviteBtn('u-bo'));
        expect(onSendInvite).toHaveBeenCalledTimes(2);
        expect(row('u-bo').textContent).toContain('Sent');
    });

    it('a send that throws is treated as an error, not left spinning', async () => {
        onSendInvite.mockRejectedValueOnce(new Error('boom'));
        await mount();
        await click(inviteBtn('u-bo'));
        expect(row('u-bo').textContent).toContain('Couldn’t send');
        expect(inviteBtn('u-bo').disabled).toBe(false);
    });

    it('search reaches every friend (not just the recent ones) and filters by name; clearing restores the recent list', async () => {
        await mount();
        type(searchBox(), 'edi');
        expect(document.querySelector('.dlg-fr .dlg-section')?.textContent).toBe('Results');
        expect(rowIds()).toEqual(['u-ed']);
        type(searchBox(), 'a');
        expect(rowIds()).toContain('u-ana');
        expect(rowIds()).not.toContain('u-bo');
        expect(rowIds()).not.toContain('u-fay');
        type(searchBox(), 'zzz');
        expect(rowIds()).toEqual([]);
        expect(text()).toContain('No friends match “zzz”.');
        type(searchBox(), '');
        expect(rowIds()).toEqual(['u-ana', 'u-bo', 'u-cy', 'u-ed', 'u-di']);
    });

    it('a friend found by search can be invited', async () => {
        await mount();
        type(searchBox(), 'dimi');
        await click(inviteBtn('u-di'));
        expect(onSendInvite).toHaveBeenCalledWith('u-di', 'Link1234');
        expect(row('u-di').textContent).toContain('Sent');
    });

    it('people already in the server are marked Member and cannot be invited', async () => {
        roster.members = ['u-ana', 'u-me'];
        await mount();
        expect(row('u-ana').textContent).toContain('Member');
        expect(row('u-ana').textContent).toContain('Already in this server');
        expect(row('u-ana').querySelector('button')).toBeNull();
        expect(row('u-bo').querySelector('button')).not.toBeNull();
    });

    it('Invite buttons are disabled while the link is being updated, and enable once it is ready (sending the NEW code)', async () => {
        const inflight = deferred<{ data: unknown }>();
        axiosMock.post.mockReturnValueOnce(inflight.promise);
        await mount();
        await openSettings();
        await click(chip('10'));
        expect(inviteBtn('u-bo').disabled).toBe(true);
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(inviteBtn('u-bo').disabled).toBe(true);
        await act(async () => { inflight.resolve({ data: mkInvite('Fresh2') }); });
        await flush();
        expect(inviteBtn('u-bo').disabled).toBe(false);
        await click(inviteBtn('u-bo'));
        expect(onSendInvite).toHaveBeenCalledWith('u-bo', 'Fresh2');
    });

    it('a link that was DM\'d is not revoked by the next settings change, and the row offers Invite again for the new link', async () => {
        axiosMock.get.mockResolvedValue({ data: [] });
        axiosMock.post
            .mockResolvedValueOnce({ data: mkInvite('First1') })
            .mockResolvedValueOnce({ data: mkInvite('Second2') });
        await mount();
        await click(inviteBtn('u-bo'));
        expect(onSendInvite).toHaveBeenCalledWith('u-bo', 'First1');
        await openSettings();
        await click(chip('10'));
        await advance(REGEN_DEBOUNCE_MS + 50);
        expect(axiosMock.delete).not.toHaveBeenCalled();
        expect(row('u-bo').textContent).not.toContain('Sent');
        expect(inviteBtn('u-bo').textContent).toContain('Invite');
    });

    it('without onSendInvite the friend section is not rendered at all', async () => {
        await mountBare({ friends: FRIENDS, conversations: CONVS });
        expect(document.querySelector('[data-testid="invite-friends"]')).toBeNull();
    });

    it('with no friends yet it says how to get some instead of an empty box', async () => {
        await mount({ friends: [] });
        expect(rowIds()).toEqual([]);
        expect(text()).toContain('Add friends to send them invites right from here.');
    });
});
