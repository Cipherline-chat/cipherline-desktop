// @vitest-environment jsdom
/**
 * Settings -> Profile: the username + "#0000" combined field (owner,
 * 2026-11-16). Rendered for real: validation in place, the Pro lock (mirror
 * only - the server enforces), save on Enter / blur, Escape reverts, and a
 * 409 lands under the field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a), isAxiosError: () => false } }));

const auth = vi.hoisted(() => ({
    user: { user_id: 'u1', username: 'Shinobi', discriminator: 1 } as { user_id: string; username: string; discriminator: number | null; next_discriminator_change_at?: string | null },
    refreshProfile: vi.fn(async () => {}),
}));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, token: 'tok', refreshProfile: auth.refreshProfile }) }));

const sub = vi.hoisted(() => ({
    status: { subscription_status: 'active', effective_status: 'active' } as { subscription_status: string; effective_status: string } | null,
    promptUpgrade: vi.fn(),
}));
vi.mock('../../../contexts/SubscriptionContext', () => ({ useSubscription: () => ({ status: sub.status, promptUpgrade: sub.promptUpgrade }) }));

const toastPush = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ push: toastPush }) }));

import { UsernameTagField, DISCRIMINATOR_HELD_MESSAGE } from './UsernameTagField';
import { DISCRIMINATOR_PRO_MESSAGE, DISCRIMINATOR_TRIAL_MESSAGE, DISCRIMINATOR_ZERO_MESSAGE, DISCRIMINATOR_FORMAT_MESSAGE } from '../../../utils/discriminatorField';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (...a: any[]) => React.ReactElement;
let host: HTMLDivElement; let root: Root;

const PAID = { subscription_status: 'active', effective_status: 'active' };
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    post.mockReset(); toastPush.mockReset(); sub.promptUpgrade.mockReset(); auth.refreshProfile.mockReset();
    auth.user = { user_id: 'u1', username: 'Shinobi', discriminator: 1 };
    sub.status = PAID;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const renderField = (opts: { usernameDirty?: boolean } = {}) => act(() => root.render(h(UsernameTagField, {
    label: 'Username',
    usernameInvalid: false,
    usernameDirty: opts.usernameDirty ?? false,
    usernameInput: h('input', { id: 'pf-username', className: 'ps-namefield-name', defaultValue: 'Shinobi' }),
    usernameMessages: null,
})));
const digits = () => host.querySelector<HTMLInputElement>('#pf-discriminator')!;
const segment = () => host.querySelector<HTMLElement>('[data-testid="pf-discriminator-segment"]')!;
const msg = () => host.querySelector('#sd-discriminator-msg')!.textContent ?? '';
const type = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); };

describe('UsernameTagField: one field, the number an attached segment', () => {
    it('renders the username and the #number inside ONE box, in tab order, with screen-reader labels', () => {
        renderField();
        const box = host.querySelector('.ps-namefield')!;
        expect(box.querySelector('#pf-username')).not.toBeNull();
        expect(box.querySelector('#pf-discriminator')).not.toBeNull();
        // DOM order = tab order: username first, then the digits.
        const inputs = [...box.querySelectorAll('input')].map((i) => i.id);
        expect(inputs).toEqual(['pf-username', 'pf-discriminator']);
        expect(host.querySelector('label[for="pf-username"]')!.textContent).toBe('Username');
        expect(digits().getAttribute('aria-label')).toBe('Number after your username');
        expect(digits().value).toBe('0001');
        // No separate "#number" row and no "Change" button any more.
        expect(host.textContent).not.toMatch(/#number/);
        expect([...host.querySelectorAll('button')].some((b) => /change/i.test(b.textContent ?? ''))).toBe(false);
    });

    it('keeps digits only, at most 4', () => {
        renderField();
        type(digits(), '#4a2');
        expect(digits().value).toBe('42');
        type(digits(), '123456');
        expect(digits().value).toBe('1234');
    });

    it('#0000 is invalid inline and Enter does not send it', async () => {
        renderField();
        type(digits(), '0000');
        expect(msg()).toContain(DISCRIMINATOR_ZERO_MESSAGE);
        expect(digits().getAttribute('aria-invalid')).toBe('true');
        expect(host.querySelector('.ps-namefield')!.getAttribute('data-invalid')).toBe('true');
        await key(digits(), 'Enter');
        expect(post).not.toHaveBeenCalled();
    });

    it.each(['1', '42', '123'])('a short number (%s) is not an error while typing, then says "use all 4 digits" after Enter, and never saves', async (short) => {
        renderField();
        type(digits(), short);
        expect(msg()).toBe('');
        expect(digits().getAttribute('aria-invalid')).toBeNull();
        await key(digits(), 'Enter');
        expect(msg()).toContain(DISCRIMINATOR_FORMAT_MESSAGE);
        expect(digits().getAttribute('aria-invalid')).toBe('true');
        expect(post).not.toHaveBeenCalled();
        // typing again hides the message until the next Enter / blur
        type(digits(), short + '0');
        if (short.length < 3) expect(msg()).toBe('');
    });

    it('"#7" (pasted with the hash) is cleaned to "7" and rejected on blur without a request', async () => {
        renderField();
        type(digits(), '#7');
        expect(digits().value).toBe('7');
        await act(async () => { digits().focus(); digits().blur(); });
        expect(msg()).toContain(DISCRIMINATOR_FORMAT_MESSAGE);
        expect(digits().value).toBe('7');
        expect(post).not.toHaveBeenCalled();
    });

    it('typing the saved number short ("1" when saved is 0001) is NOT treated as unchanged: it is rejected, not reverted', async () => {
        renderField();
        type(digits(), '1');
        await act(async () => { digits().focus(); digits().blur(); });
        expect(msg()).toContain(DISCRIMINATOR_FORMAT_MESSAGE);
        expect(post).not.toHaveBeenCalled();
    });

    it('Enter saves through POST /auth/discriminator, refreshes, toasts, and shows the check', async () => {
        post.mockResolvedValue({ data: { username: 'Shinobi', discriminator: 42, changed: true } });
        auth.refreshProfile.mockImplementation(async () => { auth.user = { ...auth.user, discriminator: 42 }; });
        renderField();
        type(digits(), '0042');
        expect(msg()).toContain('You will be Shinobi#0042');
        await key(digits(), 'Enter');
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toMatch(/\/auth\/discriminator$/);
        expect(post.mock.calls[0][1]).toEqual({ discriminator: '0042' }); // all 4 digits: the API refuses "42"
        expect(post.mock.calls[0][2]).toEqual({ headers: { Authorization: 'Bearer tok' } });
        expect(auth.refreshProfile).toHaveBeenCalled();
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', message: 'You are now Shinobi#0042.' }));
        expect(digits().value).toBe('0042');
        expect(host.querySelector('.ps-namefield-status')!.getAttribute('data-kind')).toBe('saved');
    });

    it('leaving the segment saves too; leaving it unchanged or empty just puts the number back', async () => {
        post.mockResolvedValue({ data: {} });
        renderField();
        type(digits(), '');
        await act(async () => { digits().focus(); digits().blur(); });
        expect(post).not.toHaveBeenCalled();
        expect(digits().value).toBe('0001');
        type(digits(), '0001');
        await act(async () => { digits().focus(); digits().blur(); });
        expect(post).not.toHaveBeenCalled();
        type(digits(), '0077');
        await act(async () => { digits().focus(); digits().blur(); });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][1]).toEqual({ discriminator: '0077' });
    });

    it('a 409 shows "taken" under the field, keeps the draft, and blurring again does not re-send it', async () => {
        post.mockRejectedValue({ response: { status: 409, data: { message: 'That number is taken. Try another.' } } });
        renderField();
        type(digits(), '0007');
        await key(digits(), 'Enter');
        expect(msg()).toContain('That number is taken. Try another.');
        expect(digits().value).toBe('0007');
        expect(digits().getAttribute('aria-invalid')).toBe('true');
        expect(toastPush).not.toHaveBeenCalled();
        await act(async () => { digits().focus(); digits().blur(); });
        expect(post).toHaveBeenCalledTimes(1);
        // A different number clears the error and can be tried.
        type(digits(), '0008');
        expect(msg()).not.toContain('taken');
    });

    it('a 403 (server says not Pro) says so under the field, and never opens the full-screen upsell', async () => {
        post.mockRejectedValue({ response: { status: 403, data: {} } });
        renderField();
        type(digits(), '0009');
        await key(digits(), 'Enter');
        expect(msg()).toContain(DISCRIMINATOR_PRO_MESSAGE);
        expect(sub.promptUpgrade).not.toHaveBeenCalled();
    });

    it('Escape reverts the digits to the saved number', async () => {
        renderField();
        type(digits(), '0055');
        act(() => digits().focus());
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(digits().value).toBe('0001');
        expect(msg()).toBe('');
        expect(post).not.toHaveBeenCalled();
    });
});

const tip = () => document.querySelector<HTMLElement>('[data-testid="pf-discriminator-protip"]');
/** React builds onPointerEnter / onPointerLeave from pointerover / pointerout. */
const pointer = (el: Element, kind: 'enter' | 'leave') => el.dispatchEvent(Object.assign(
    new MouseEvent(kind === 'enter' ? 'pointerover' : 'pointerout', { bubbles: true, relatedTarget: document.body }),
    { pointerType: 'mouse', pointerId: 1 },
));

describe('UsernameTagField: Pro lock (mirror only) - the crown popover', () => {
    it('free: read-only with a gold crown; focus opens the popover (ARIA tooltip, wired to the input); typing changes nothing', async () => {
        sub.status = { subscription_status: 'expired', effective_status: 'expired' };
        renderField();
        expect(digits().readOnly).toBe(true);
        expect(digits().getAttribute('aria-disabled')).toBe('true');
        expect(segment().getAttribute('data-state')).toBe('locked');
        expect(host.querySelector('.ps-namefield-status svg')).not.toBeNull();
        expect(tip()).toBeNull();
        act(() => digits().focus());
        const box = tip()!;
        expect(box).not.toBeNull();
        expect(box.getAttribute('role')).toBe('tooltip');
        expect(box.textContent).toBe(DISCRIMINATOR_PRO_MESSAGE);
        expect(DISCRIMINATOR_PRO_MESSAGE).toBe('Custom #numbers are a Pro feature.');
        expect(box.querySelector('svg')).not.toBeNull(); // the crown
        expect(box.querySelector('svg')!.getAttribute('stroke')).toContain('--cl-glow'); // yellow (the Pro gold token)
        expect(digits().getAttribute('aria-describedby')!.split(' ')).toContain(box.id);
        type(digits(), '0042');
        expect(digits().value).toBe('0001');
        await key(digits(), 'Enter');
        expect(post).not.toHaveBeenCalled();
        // Blur closes it (keyboard users tab away).
        act(() => digits().blur());
        expect(tip()).toBeNull();
        expect(digits().getAttribute('aria-describedby')).toBe('sd-discriminator-msg');
    });

    it('free: a click opens it and it stays until Escape or a click elsewhere; NEVER the full-screen upsell', async () => {
        sub.status = { subscription_status: 'expired', effective_status: 'expired' };
        renderField();
        act(() => segment().click());
        expect(tip()).not.toBeNull();
        act(() => { pointer(segment(), 'leave'); });
        expect(tip()).not.toBeNull(); // pinned by the click
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(tip()).toBeNull();
        act(() => segment().click());
        expect(tip()).not.toBeNull();
        act(() => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
        expect(tip()).toBeNull();
        expect(sub.promptUpgrade).not.toHaveBeenCalled();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('free: hovering opens it after a short delay; leaving closes it', () => {
        vi.useFakeTimers();
        try {
            sub.status = { subscription_status: 'expired', effective_status: 'expired' };
            renderField();
            act(() => { pointer(segment(), 'enter'); });
            expect(tip()).toBeNull();
            act(() => { vi.advanceTimersByTime(200); });
            expect(tip()).not.toBeNull();
            act(() => { pointer(segment(), 'leave'); });
            expect(tip()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('free: Enter / Space on the focused segment shows the box and does nothing else', async () => {
        sub.status = { subscription_status: 'expired', effective_status: 'expired' };
        renderField();
        act(() => digits().focus());
        await key(digits(), 'Enter');
        await key(digits(), ' ');
        expect(tip()).not.toBeNull();
        expect(sub.promptUpgrade).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('trial: the popover carries the trial copy (unlocks on paid Pro)', () => {
        sub.status = { subscription_status: 'trial', effective_status: 'active' };
        renderField();
        expect(digits().readOnly).toBe(true);
        act(() => digits().focus());
        expect(tip()!.textContent).toBe(DISCRIMINATOR_TRIAL_MESSAGE);
    });

    it('unknown billing status counts as locked (the server still decides)', () => {
        sub.status = null;
        renderField();
        expect(segment().getAttribute('data-state')).toBe('locked');
    });

    it('Pro / comp (status active): editable, and no popover at all', () => {
        renderField();
        expect(digits().readOnly).toBe(false);
        act(() => digits().focus());
        act(() => segment().click());
        expect(tip()).toBeNull();
    });
});

describe('UsernameTagField: the 24 h cooldown (mirror of the 429)', () => {
    it('inside the cooldown: read-only with "You can change your #number again in 7 h (...)", Enter does nothing', async () => {
        auth.user = { ...auth.user, next_discriminator_change_at: new Date(Date.now() + 6.5 * 3_600_000).toISOString() };
        renderField();
        expect(segment().getAttribute('data-state')).toBe('cooldown');
        expect(digits().readOnly).toBe(true);
        expect(digits().getAttribute('aria-disabled')).toBe('true');
        const line = host.querySelector('[data-testid="pf-discriminator-cooldown"]')!.textContent!;
        expect(line).toMatch(/^ ?You can change your #number again in 7 h \(.+\)\.$/);
        type(digits(), '0042');
        expect(digits().value).toBe('0001');
        await key(digits(), 'Enter');
        expect(post).not.toHaveBeenCalled();
        expect(tip()).toBeNull(); // not a Pro lock: no crown box
    });

    it('a cooldown that has already passed does not lock', () => {
        auth.user = { ...auth.user, next_discriminator_change_at: new Date(Date.now() - 1000).toISOString() };
        renderField();
        expect(segment().getAttribute('data-state')).toBe('edit');
        expect(host.querySelector('[data-testid="pf-discriminator-cooldown"]')).toBeNull();
    });

    it('a cooldown 429 (changed on another device) locks the segment at once and puts the saved number back', async () => {
        const next = new Date(Date.now() + 23 * 3_600_000).toISOString();
        post.mockRejectedValue({ response: { status: 429, data: { error: 'discriminator_change_cooldown', message: 'You can change your #number again in 23 h.', next_change_at: next, retry_after: 82_800 } } });
        renderField();
        type(digits(), '0042');
        await key(digits(), 'Enter');
        expect(segment().getAttribute('data-state')).toBe('cooldown');
        expect(digits().value).toBe('0001');
        expect(host.querySelector('[data-testid="pf-discriminator-cooldown"]')!.textContent).toMatch(/again in 23 h/);
        expect(auth.refreshProfile).toHaveBeenCalled();
    });

    it('the throttler\'s own 429 (no cooldown code) is still "too many tries", not a lock', async () => {
        post.mockRejectedValue({ response: { status: 429, data: { message: 'ThrottlerException: Too Many Requests' } } });
        renderField();
        type(digits(), '0042');
        await key(digits(), 'Enter');
        expect(segment().getAttribute('data-state')).toBe('edit');
        expect(msg()).toMatch(/Too many tries/);
    });

    it('the Pro lock wins over a cooldown (non-Pro sees the crown box, not the timer)', () => {
        sub.status = { subscription_status: 'expired', effective_status: 'expired' };
        auth.user = { ...auth.user, next_discriminator_change_at: new Date(Date.now() + 3_600_000).toISOString() };
        renderField();
        expect(segment().getAttribute('data-state')).toBe('locked');
        expect(host.querySelector('[data-testid="pf-discriminator-cooldown"]')).toBeNull();
    });
});

describe('UsernameTagField: a username change in progress', () => {
    it('holds the number (read-only) because the new name gets its own #number when it saves', async () => {
        renderField({ usernameDirty: true });
        expect(segment().getAttribute('data-state')).toBe('held');
        expect(digits().readOnly).toBe(true);
        act(() => digits().focus());
        expect(msg()).toContain(DISCRIMINATOR_HELD_MESSAGE);
        await key(digits(), 'Enter');
        expect(post).not.toHaveBeenCalled();
    });

    it('renders no segment for an account without a number yet', () => {
        auth.user = { user_id: 'u1', username: 'Shinobi', discriminator: null };
        renderField();
        expect(host.querySelector('#pf-discriminator')).toBeNull();
        expect(host.querySelector('#pf-username')).not.toBeNull();
    });
});
