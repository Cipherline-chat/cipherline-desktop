// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The confirm step of "Sign in with your phone" ("You are about to sign in as
 * @name#1234"), rendered for real: picture vs letter tile, long names, the
 * action row's structure and its keyboard contract. jsdom does no layout, so
 * "labels never clip" is pinned two ways: the DOM structure that makes it true
 * (stacked, full-width, one button per row) and the stylesheet rules that let
 * a label wrap instead of overflowing. The real-pixel check is the harness
 * screenshot pass (docs/worklog/entries/2026-11-23-phone-signin-confirm.md).
 */

// ClButton's physics module reads matchMedia at import time; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    });
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));

import { QrConfirmStep, CONFIRM_ENTER_ARM_MS } from './QrSignInPanel';
import { userColor } from '../../utils/avatarColor';

type Identity = React.ComponentProps<typeof QrConfirmStep>['identity'];
const USER_ID = '9b2f3c1e-5d4a-4e8b-a1c2-7f6e5d4c3b2a';
const base: Identity = {
    userId: USER_ID, username: 'Shinobi', discriminator: 1,
    avatarUrl: '3f0b6f6e-9d1a-4c38-9a51-2b7c1e5d8a90', avatarSrc: null,
    approvedByDeviceName: 'Google Pixel 9 Pro XL',
};

let root: Root | null = null;
let container: HTMLDivElement;
const onContinue = vi.fn();
const onReject = vi.fn();
const onCancel = vi.fn();

async function render(identity: Partial<Identity> = {}) {
    await act(async () => {
        root!.render(React.createElement(QrConfirmStep, { identity: { ...base, ...identity }, onContinue, onReject, onCancel }));
    });
}

const avatar = () => container.querySelector('[data-testid="qr-confirm-avatar"]') as HTMLElement;
const buttons = () => Array.from(container.querySelectorAll('[data-testid="qr-confirm-actions"] button')) as HTMLButtonElement[];
function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    onContinue.mockReset(); onReject.mockReset(); onCancel.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container.remove();
    vi.useRealTimers();
});

describe('confirm step — profile picture', () => {
    it('shows the real picture when the controller has one, and no letter', async () => {
        await render({ avatarSrc: 'blob:http://x/avatar' });
        const img = avatar().querySelector('img');
        expect(img).not.toBeNull();
        expect(img!.getAttribute('src')).toBe('blob:http://x/avatar');
        expect(img!.getAttribute('alt')).toBe(''); // decorative: the handle is the text
        expect(avatar().dataset.avatar).toBe('picture');
        expect(avatar().textContent).toBe('');
    });

    it('without a picture: the identity-colour letter tile', async () => {
        await render({ avatarSrc: null });
        expect(avatar().querySelector('img')).toBeNull();
        expect(avatar().dataset.avatar).toBe('initial');
        expect(avatar().textContent).toBe('S');
        // jsdom normalises the colour; compare through the same parser.
        const probe = document.createElement('div');
        probe.style.background = userColor(USER_ID);
        expect(avatar().style.background).toBe(probe.style.background);
    });

    it('a picture that fails to decode falls back to the tile; a NEW picture is tried again', async () => {
        await render({ avatarSrc: 'blob:http://x/broken' });
        await act(async () => { avatar().querySelector('img')!.dispatchEvent(new Event('error')); });
        expect(avatar().querySelector('img')).toBeNull();
        expect(avatar().textContent).toBe('S');
        await render({ avatarSrc: 'blob:http://x/fresh' });
        expect(avatar().querySelector('img')?.getAttribute('src')).toBe('blob:http://x/fresh');
    });

    it('arrives late without remounting the step: tile first, then the picture', async () => {
        await render({ avatarSrc: null });
        const before = avatar();
        await render({ avatarSrc: 'blob:http://x/late' });
        expect(avatar()).toBe(before);
        expect(avatar().querySelector('img')).not.toBeNull();
    });
});

describe('confirm step — text', () => {
    it('handle with zero-padded discriminator, approving device, and the warning callout', async () => {
        await render();
        expect(container.querySelector('[data-testid="qr-confirm-handle"]')!.textContent).toBe('@Shinobi#0001');
        expect(container.querySelector('[data-testid="qr-confirm-device"]')!.textContent).toBe('Approved from Google Pixel 9 Pro XL');
        const warning = container.querySelector('[data-testid="qr-confirm-warning"]')!;
        expect(warning.getAttribute('role')).toBe('note');
        expect(warning.textContent).toContain('Only continue if this is your account and your phone.');
    });

    it('a long handle / device name renders whole (wrapping class + rule), never truncated in the DOM', async () => {
        const long = 'Shinobi_the_extremely_long_handle_32';
        await render({ username: long, discriminator: null, approvedByDeviceName: 'Samsung Galaxy Z Fold7 Enterprise Edition (work profile)' });
        const handle = container.querySelector('[data-testid="qr-confirm-handle"]') as HTMLElement;
        expect(handle.textContent).toBe(`@${long}`);
        expect(handle.classList.contains('qr-confirm-handle')).toBe(true);
        expect((container.querySelector('[data-testid="qr-confirm-device"]') as HTMLElement).style.overflowWrap).toBe('anywhere');
    });
});

describe('confirm step — action row', () => {
    it('Continue is the primary, first; "This isn\'t my account" is a red-tinted ghost under it', async () => {
        await render();
        const [first, second] = buttons();
        expect(buttons()).toHaveLength(2);
        expect(first.textContent?.trim()).toBe('Continue');
        expect(second.textContent?.trim()).toBe("This isn't my account");
        const firstClb = first.closest('.clb')!;
        const secondClb = second.closest('.clb')!;
        expect(firstClb.classList.contains('clb--ghost')).toBe(false);
        expect(secondClb.classList.contains('clb--ghost')).toBe(true);
        expect(secondClb.classList.contains('qr-confirm-reject')).toBe(true);
        // Both full width, each on its own row of a column: no shared row to squeeze them.
        expect(firstClb.classList.contains('w-full')).toBe(true);
        expect(secondClb.classList.contains('w-full')).toBe(true);
        expect(firstClb.parentElement).toBe(secondClb.parentElement);
        expect(firstClb.parentElement!.classList.contains('qr-confirm-actions')).toBe(true);
        // Neither button grabs focus (Continue must not be one stray key away).
        expect(document.activeElement === first || document.activeElement === second).toBe(false);
    });

    it('clicks route to the right action', async () => {
        await render();
        await act(async () => { buttons()[0].click(); });
        expect(onContinue).toHaveBeenCalledTimes(1);
        await act(async () => { buttons()[1].click(); });
        expect(onReject).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('the stylesheet stacks the row and lets labels wrap instead of clipping (beats the kit\'s nowrap)', () => {
        const css = readFileSync(resolve(__dirname, '../../styles/link-signin.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const rule = (sel: string) => {
            const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
            if (!m) throw new Error(`no rule ${sel}`);
            return m[1].replace(/\s+/g, ' ');
        };
        expect(rule('.qr-confirm-actions')).toContain('flex-direction: column');
        const cap = rule('.qr-confirm-actions .cl-kit.clb .cap');
        expect(cap).toContain('white-space: normal');
        expect(cap).toContain('text-overflow: clip');
        expect(rule('.qr-confirm-handle')).toContain('overflow-wrap: anywhere');
        // The kit's own rule this must beat (cl-kit-ext.css, @scope (.cl-kit) .cap — one class).
        const kit = readFileSync(resolve(__dirname, '../../styles/cl-kit-ext.css'), 'utf8');
        expect(kit).toMatch(/\.cap\{white-space:nowrap;text-overflow:ellipsis\}/);
        // Theme tokens only.
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*(?!var\()/);
    });
});

describe('confirm step — keyboard', () => {
    it('Enter = Continue once armed; not before, not a held/repeated Enter, not with a modifier', async () => {
        await render();
        key('Enter');
        expect(onContinue).not.toHaveBeenCalled(); // not armed yet
        vi.setSystemTime(Date.now() + CONFIRM_ENTER_ARM_MS + 1);
        key('Enter', { repeat: true });
        key('Enter', { ctrlKey: true });
        key('Enter', { shiftKey: true });
        expect(onContinue).not.toHaveBeenCalled();
        key('Enter');
        expect(onContinue).toHaveBeenCalledTimes(1);
        expect(onReject).not.toHaveBeenCalled();
    });

    it('Enter while a button has focus is left to that button (focus on "This isn\'t my account" never confirms)', async () => {
        await render();
        vi.setSystemTime(Date.now() + CONFIRM_ENTER_ARM_MS + 1);
        const reject = buttons()[1];
        reject.focus();
        key('Enter', {}, reject);
        expect(onContinue).not.toHaveBeenCalled();
    });

    it('Esc = cancel (back to "Show a code"), immediately — no arming delay', async () => {
        await render();
        key('Escape');
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onContinue).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
    });

    it('focus order follows the visual order: Continue, then "This isn\'t my account"', async () => {
        await render();
        const focusable = Array.from(container.querySelectorAll('button, [tabindex]:not([tabindex="-1"])'));
        expect(focusable.map((b) => b.textContent?.trim())).toEqual(['Continue', "This isn't my account"]);
    });

    it('unmounting removes the key listener', async () => {
        await render();
        await act(async () => { root!.unmount(); });
        root = null;
        vi.setSystemTime(Date.now() + CONFIRM_ENTER_ARM_MS + 1);
        key('Enter');
        key('Escape');
        expect(onContinue).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();
    });
});
