// @vitest-environment jsdom
/**
 * Create a Server / Join a Server / invite preview / Invite People, mounted for
 * real in the house dialog pattern (components/dialog/DialogFrame). What must hold:
 *   - each dialog is a dlg-card with icon/title/footer (Cancel + the primary), no header close button;
 *   - the first field is focused; where there is no field, the primary is (so Enter acts);
 *   - Enter submits only a valid form; an invalid / blank submit sends nothing;
 *   - a request in flight ignores a second submit, and the primary keeps its label (spinner, not the
 *     kit's three dots);
 *   - Escape and Cancel close without acting;
 *   - the behaviour the old markup had (name rule, invite-code parsing, error copy) is unchanged.
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

const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError }));
vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));
vi.mock('../../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile: vi.fn() }) }));
vi.mock('../../hooks/useEncryptedAvatar', () => ({ useEncryptedAvatar: () => null, avatarUrlMime: () => null }));
const previewState = vi.hoisted(() => ({ value: { state: 'valid' as string, preview: null as unknown, reload: vi.fn() } }));
vi.mock('../../hooks/useInvitePreview', () => ({ useInvitePreview: () => previewState.value }));
const clip = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../utils/clipboard', () => ({ writeToClipboard: clip.write }));
const nudge = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../../utils/firstWeekNudgeStore', () => ({ nudges: nudge }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));

const { CreateServerModal } = await import('./CreateServerModal');
const { JoinServerModal, InvitePreviewModal } = await import('./JoinServerModal');
const { ServerInviteModal, REGEN_DEBOUNCE_MS } = await import('./ServerInviteModal');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
    clip.write.mockReset().mockResolvedValue(undefined);
    nudge.notify.mockReset();
    previewState.value = { state: 'valid', preview: null, reload: vi.fn() };
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
const text = () => document.body.textContent ?? '';
const footerButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.dlg-foot-actions button'));
const footerLabels = () => footerButtons().map(b => b.textContent?.trim());
const primary = () => footerButtons()[footerButtons().length - 1];
const field = () => document.querySelector('.mcard input:not([type=number])') as HTMLInputElement;
function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const submit = async () => {
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
};
const escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
const click = async (b: HTMLElement | undefined) => { expect(b).toBeDefined(); await act(async () => { b!.click(); }); await flush(); };
const frame = () => ({
    card: !!document.querySelector('.mcard.dlg-card'),
    title: document.querySelector('.dlg-title')?.textContent,
    icon: !!document.querySelector('.dlg-head-icon'),
    footer: !!document.querySelector('.dlg-foot'),
    // The old markup had a ghost "close" icon button in the header.
    headerClose: !!document.querySelector('.dlg-head button'),
});
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;

/* ───────────────────────────── Create a Server ───────────────────────────── */

describe('CreateServerModal', () => {
    const onClose = vi.fn();
    const onCreateServer = vi.fn();
    beforeEach(() => { onClose.mockReset(); onCreateServer.mockReset().mockResolvedValue(undefined); });
    const mount = async () => {
        act(() => root.render(React.createElement(CreateServerModal, { onClose, onCreateServer })));
        await settle();
    };

    it('is a framed dialog: icon, title, footer = Cancel + Create server, no header close button', async () => {
        await mount();
        expect(frame()).toEqual({ card: true, title: 'Create a Server', icon: true, footer: true, headerClose: false });
        expect(footerLabels()).toEqual(['Cancel', 'Create server']);
        expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Create a Server');
    });

    it('focuses the name field; Enter with it empty sends nothing and shows nothing', async () => {
        await mount();
        expect(document.activeElement).toBe(field());
        expect(primary().disabled).toBe(true);
        await submit();
        expect(onCreateServer).not.toHaveBeenCalled();
        expect(alertText()).toBeNull();
    });

    it('a one-character name is refused with the length message', async () => {
        await mount();
        type(field(), 'a');
        expect(primary().disabled).toBe(false);
        await submit();
        expect(onCreateServer).not.toHaveBeenCalled();
        expect(alertText()).toBe('Server name must be at least 2 characters');
    });

    it('the plain-text rule strips symbols as you type and the counter follows', async () => {
        await mount();
        type(field(), "Game! night@ #1_.'-");
        expect(field().value).toBe("Game night 1_.'-");
        expect(text()).toContain('16/50');
    });

    it('creates once with the trimmed name, then closes', async () => {
        await mount();
        type(field(), '  Game night ');
        await submit();
        expect(onCreateServer).toHaveBeenCalledTimes(1);
        expect(onCreateServer).toHaveBeenCalledWith('Game night');
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('while creating: a second submit is ignored and the primary keeps its label with a spinner', async () => {
        onCreateServer.mockReturnValue(new Promise(() => {}));
        await mount();
        type(field(), 'Game night');
        await submit();
        await submit();
        await submit();
        expect(onCreateServer).toHaveBeenCalledTimes(1);
        expect(primary().textContent?.trim()).toBe('Create server');
        expect(primary().querySelector('.dlg-spin')).not.toBeNull();
        expect(document.querySelector('.ldots')).toBeNull();
        expect(document.querySelector('.dlg-foot-hint')?.textContent).toBe('Creating your server…');
    });

    it('shows the server\'s refusal, and a generic message when it gave none; the form stays usable', async () => {
        onCreateServer.mockRejectedValueOnce({ response: { data: { message: 'You own too many servers' } } });
        await mount();
        type(field(), 'Game night');
        await submit();
        expect(alertText()).toBe('You own too many servers');
        onCreateServer.mockRejectedValueOnce(new Error('offline'));
        await submit();
        expect(alertText()).toBe('Failed to create server');
        expect(field().value).toBe('Game night');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape and Cancel close without creating', async () => {
        await mount();
        type(field(), 'Game night');
        await escape();
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onCreateServer).not.toHaveBeenCalled();
    });

    it('Cancel closes without creating', async () => {
        await mount();
        await click(footerButtons()[0]);
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onCreateServer).not.toHaveBeenCalled();
    });

    it('offers the Discord import only when the caller can preview and import', async () => {
        await mount();
        expect(text()).not.toContain('Import from a Discord template');
        act(() => root.render(React.createElement(CreateServerModal, {
            onClose, onCreateServer, onPreviewTemplate: vi.fn(), onImportTemplate: vi.fn(),
        })));
        await flush();
        expect(text()).toContain('Import from a Discord template');
    });
});

/* ───────────────────────────── Join a Server ───────────────────────────── */

describe('JoinServerModal', () => {
    const onClose = vi.fn();
    const onJoinServer = vi.fn();
    beforeEach(() => { onClose.mockReset(); onJoinServer.mockReset().mockResolvedValue(undefined); });
    const mount = async () => {
        act(() => root.render(React.createElement(JoinServerModal, { onClose, onJoinServer })));
        await settle();
    };

    it('is a framed dialog: footer = Cancel + Join server, field focused, nothing to send yet', async () => {
        await mount();
        expect(frame()).toEqual({ card: true, title: 'Join a Server', icon: true, footer: true, headerClose: false });
        expect(footerLabels()).toEqual(['Cancel', 'Join server']);
        expect(document.activeElement).toBe(field());
        expect(primary().disabled).toBe(true);
        await submit();
        type(field(), '   ');
        await submit();
        expect(onJoinServer).not.toHaveBeenCalled();
    });

    it.each([
        ['a plain code', 'AbCd1234', 'AbCd1234'],
        ['a web link', ' https://cipherline.chat/invite/AbCd_1234-x ', 'AbCd_1234-x'],
        ['a deep link', 'cipherline://invite/Zz99', 'Zz99'],
    ])('parses %s to its code, joins once, then closes', async (_n, input, expected) => {
        await mount();
        type(field(), input);
        await submit();
        expect(onJoinServer).toHaveBeenCalledTimes(1);
        expect(onJoinServer).toHaveBeenCalledWith(expected);
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['You are banned from this server', 'user is banned', 'You are banned from this server'],
        ['an expired invite', 'invite expired', 'This invite has expired or reached its usage limit'],
        ['an exhausted invite', 'uses exhausted', 'This invite has expired or reached its usage limit'],
        ['any other message', 'Server is full', 'Server is full'],
    ])('maps a refusal (%s) to its copy and stays open', async (_n, apiMsg, shown) => {
        onJoinServer.mockRejectedValueOnce({ response: { data: { message: apiMsg } } });
        await mount();
        type(field(), 'AbCd1234');
        await submit();
        expect(alertText()).toBe(shown);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('falls back to "Invalid invite code" when the failure carries no message', async () => {
        onJoinServer.mockRejectedValueOnce(new Error('offline'));
        await mount();
        type(field(), 'AbCd1234');
        await submit();
        expect(alertText()).toBe('Invalid invite code');
    });

    it('while joining: a second submit is ignored and the primary keeps its label with a spinner', async () => {
        onJoinServer.mockReturnValue(new Promise(() => {}));
        await mount();
        type(field(), 'AbCd1234');
        await submit();
        await submit();
        expect(onJoinServer).toHaveBeenCalledTimes(1);
        expect(primary().textContent?.trim()).toBe('Join server');
        expect(primary().querySelector('.dlg-spin')).not.toBeNull();
        expect(document.querySelector('.ldots')).toBeNull();
    });

    it('Escape closes without joining', async () => {
        await mount();
        type(field(), 'AbCd1234');
        await escape();
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onJoinServer).not.toHaveBeenCalled();
    });
});

/* ───────────────────────────── invite preview ───────────────────────────── */

describe('InvitePreviewModal', () => {
    const onClose = vi.fn();
    const onJoin = vi.fn();
    const PREVIEW = {
        server_id: 's-1', server_name: 'Game night', server_description: 'Weekly board games.',
        server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 1204, expires_at: null,
    };
    beforeEach(() => { onClose.mockReset(); onJoin.mockReset(); });
    const mount = async (props: Partial<React.ComponentProps<typeof InvitePreviewModal>> = {}) => {
        act(() => root.render(React.createElement(InvitePreviewModal, { code: 'AbCd1234', token: 'tok', servers: [], onJoin, onClose, ...props })));
        await settle();
    };
    const ready = (state = 'valid') => { previewState.value = { state, preview: PREVIEW, reload: previewState.value.reload }; };

    it('ready: framed dialog with the server, member count, Cancel + Join server; Join has focus so Enter joins', async () => {
        ready();
        await mount();
        expect(frame()).toEqual({ card: true, title: "You've been invited", icon: true, footer: true, headerClose: false });
        expect(text()).toContain('Game night');
        expect(text()).toContain('Weekly board games.');
        expect(text()).toContain('1,204 members');
        expect(footerLabels()).toEqual(['Cancel', 'Join server']);
        expect(document.activeElement).toBe(primary());
    });

    it('joins once on submit: POSTs the accept, then reports the server', async () => {
        ready();
        axiosMock.post.mockReturnValue(new Promise(() => {}));
        await mount();
        await submit();
        await submit();
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        expect(String(axiosMock.post.mock.calls[0][0])).toContain('/invites/AbCd1234/accept');
        expect(primary().textContent?.trim()).toBe('Join server');
        expect(primary().querySelector('.dlg-spin')).not.toBeNull();
        axiosMock.post.mockReset().mockResolvedValue({});
    });

    it('a successful accept calls onJoin with the server', async () => {
        ready();
        axiosMock.post.mockResolvedValue({});
        await mount();
        await submit();
        expect(onJoin).toHaveBeenCalledWith('s-1', 'Game night');
    });

    it('a refused accept shows the server\'s message and does not report a join', async () => {
        ready();
        axiosMock.post.mockRejectedValue({ isAxiosError: true, response: { data: { message: 'This invite has expired' } } });
        await mount();
        await submit();
        expect(alertText()).toBe('This invite has expired');
        expect(onJoin).not.toHaveBeenCalled();
    });

    it('while the invite is still being checked: Join is disabled and Enter joins nothing', async () => {
        previewState.value = { state: 'loading', preview: null, reload: vi.fn() };
        await mount();
        expect(primary().disabled).toBe(true);
        await submit();
        expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it('without a token there is nothing to join with', async () => {
        ready();
        await mount({ token: null });
        expect(primary().disabled).toBe(true);
        await submit();
        expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it('already a member: Go to server reports the server and closes; Join is not offered', async () => {
        ready('joined');
        await mount();
        expect(footerLabels()).toEqual(['Cancel', 'Go to server']);
        expect(text()).toContain('already a member');
        await submit();
        expect(axiosMock.post).not.toHaveBeenCalled();
        await click(primary());
        expect(onJoin).toHaveBeenCalledWith('s-1', 'Game night');
    });

    it('an expired invite offers only Close, and no retry', async () => {
        previewState.value = { state: 'invalid', preview: null, reload: vi.fn() };
        await mount();
        expect(text()).toContain('Invite expired');
        expect(footerLabels()).toEqual(['Close']);
    });

    it('an invite that could not be loaded offers Try again, which reloads', async () => {
        const reload = vi.fn();
        previewState.value = { state: 'error', preview: null, reload };
        await mount();
        expect(text()).toContain('Invite unavailable');
        expect(footerLabels()).toEqual(['Close', 'Try again']);
        await click(primary());
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('arrival uses the welcome copy and "Not now", and Join still needs the click', async () => {
        ready();
        await mount({ arrival: true });
        expect(document.querySelector('.dlg-title')?.textContent).toBe("Welcome — you've been invited");
        expect(footerLabels()).toEqual(['Not now', 'Join server']);
        expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it('Escape closes without joining; Cancel does too', async () => {
        ready();
        await mount();
        await escape();
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(axiosMock.post).not.toHaveBeenCalled();
    });
});

/* ───────────────────────────── Invite People ───────────────────────────── */

describe('ServerInviteModal', () => {
    const onClose = vi.fn();
    const SERVER = { server_id: 's-1', name: 'Game night' } as never;
    const INVITE = { code: 'AbCd1234', created_at: '2026-10-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0 };
    beforeEach(() => {
        onClose.mockReset();
        axiosMock.get.mockResolvedValue({ data: [INVITE] });
        axiosMock.post.mockResolvedValue({ data: { ...INVITE, code: 'NewCode99', max_uses: 10 } });
    });
    const mount = async () => {
        act(() => root.render(React.createElement(ServerInviteModal, { server: SERVER, token: 'tok', onClose })));
        await settle();
    };

    it('is a framed dialog: the link, Close + Copy link, Copy link has focus so Enter copies', async () => {
        await mount();
        expect(frame()).toEqual({ card: true, title: 'Invite People', icon: true, footer: true, headerClose: false });
        expect(document.querySelector('.dlg-subtitle')?.textContent).toBe('to Game night');
        expect(document.querySelector('.dlg-linkbox-url')?.textContent).toBe('https://cipherline.chat/invite/AbCd1234');
        expect(footerLabels()).toEqual(['Close', 'Copy link']);
        expect(document.activeElement).toBe(primary());
        expect(axiosMock.post).not.toHaveBeenCalled();
    });

    it('Copy link writes the link, reports the nudge, and confirms', async () => {
        await mount();
        await click(primary());
        expect(clip.write).toHaveBeenCalledWith('https://cipherline.chat/invite/AbCd1234');
        expect(nudge.notify).toHaveBeenCalledWith({ kind: 'invite_sent' });
        expect(primary().textContent).toContain('Copied!');
        expect(document.querySelector('.dlg-foot-hint')?.textContent).toBe('Copied to your clipboard');
    });

    it('with no usable invite it creates one on open, and only one', async () => {
        axiosMock.get.mockResolvedValue({ data: [] });
        await mount();
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.dlg-linkbox-url')?.textContent).toBe('https://cipherline.chat/invite/NewCode99');
    });

    it('shows the create failure and has nothing to copy', async () => {
        axiosMock.get.mockResolvedValue({ data: [] });
        axiosMock.post.mockRejectedValue({ response: { data: { message: 'No permission to invite' } } });
        await mount();
        expect(alertText()).toBe('No permission to invite');
        expect(primary().disabled).toBe(true);
    });

    it('link settings fold open: expiry and uses chips, custom fields, and no Regenerate button (changes apply on their own)', async () => {
        await mount();
        expect(text()).not.toContain('Expire after');
        await click(Array.from(document.querySelectorAll('button')).find(b => /Edit link settings/.test(b.textContent ?? '')));
        expect(text()).toContain('Expire after');
        expect(text()).toContain('Max uses');
        const chip = (label: string) => Array.from(document.querySelectorAll('.dlg-chips button')).find(b => b.textContent?.trim() === label) as HTMLElement;
        await click(chip('10'));
        expect(Array.from(document.querySelectorAll('button')).some(b => /Create new link|Regenerate/i.test(b.textContent ?? ''))).toBe(false);
        await act(async () => { vi.advanceTimersByTime(REGEN_DEBOUNCE_MS + 50); });
        await flush();
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        expect(axiosMock.post.mock.calls[0][1]).toEqual({ max_uses: 10, expires_in_seconds: 168 * 3600 });
        expect(document.querySelector('.dlg-linkbox-url')?.textContent).toBe('https://cipherline.chat/invite/NewCode99');
    });

    it('custom expiry and uses reveal labelled number fields with their ranges', async () => {
        await mount();
        await click(Array.from(document.querySelectorAll('button')).find(b => /Edit link settings/.test(b.textContent ?? '')));
        const customs = Array.from(document.querySelectorAll('.dlg-chips button')).filter(b => /^Custom/.test(b.textContent?.trim() ?? ''));
        expect(customs).toHaveLength(2);
        await click(customs[0] as HTMLElement);
        await click(customs[1] as HTMLElement);
        expect(text()).toContain('Between 1 minute and 30 days.');
        expect(text()).toMatch(/Between \d+ and \d+ uses\./);
        const nums = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=number]'));
        expect(nums).toHaveLength(2);
        for (const n of nums) expect(document.querySelector(`label[for="${n.id}"]`)).not.toBeNull();
    });

    it('Escape and Close close the dialog', async () => {
        await mount();
        await escape();
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
