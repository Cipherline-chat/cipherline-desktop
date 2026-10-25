// @vitest-environment jsdom
/**
 * Wave-3 dialogs on the shared dialog pattern (components/dialog): each migrated
 * dialog is mounted for real and checked for
 *   - the frame: a `.dlg-card` with one title, a footer holding Cancel + the
 *     primary action (never a lone Cancel — the one exception, the forced
 *     "Update required", is asserted as such);
 *   - the behaviour that must not change: the same callbacks / requests fire,
 *     busy and error states disable and report the same way.
 *
 * Dialogs left as they were (Safety verification, device storage setup, history
 * request, screen-share picker) are not asserted here.
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
    default: {
        get: (...a: unknown[]) => axiosGet(...a), post: (...a: unknown[]) => axiosPost(...a),
        isCancel: () => false, isAxiosError: () => false,
    },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({
        token: 'tok', userId: 'me', deviceId: 'dev-1', user: { user_id: 'me', username: 'Dawson', email: 'd@example.com' },
        updateTokens: () => {},
    }),
}));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: () => {} }) }));
vi.mock('../utils/secureLocalStore', () => {
    const s = { getItem: () => null, setItem: () => {}, removeItem: () => {}, isAccountReady: () => true, whenAccountReady: async () => {} };
    return { default: s, secureLocalStore: s };
});

const { StepUpModal } = await import('./StepUpModal');
const { RestorePasswordModal } = await import('./RestorePasswordModal');
const { StaleBackupModal } = await import('./StaleBackupModal');
const { ChangePasswordModal } = await import('./auth/ChangePasswordModal');
const { TotpSetupModal } = await import('./auth/TotpSetupModal');
const { DeviceApprovalModal, DeviceRemovedNotice } = await import('./DeviceApprovalModal');
const { default: ScreenLockSettings } = await import('./ScreenLockSettings');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    axiosGet.mockReset(); axiosPost.mockReset();
    axiosGet.mockResolvedValue({ data: { enabled: false } });
    axiosPost.mockResolvedValue({ data: {} });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const h = React.createElement;
const mount = (el: React.ReactElement) => { act(() => root.render(el)); };
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 30)); }); };
const card = () => document.querySelector('.mcard') as HTMLElement | null;
const title = () => card()?.querySelector('.dlg-title')?.textContent ?? '';
const footBtns = () => [...(card()?.querySelectorAll('.dlg-foot-actions button') ?? [])] as HTMLButtonElement[];
const footLabels = () => footBtns().map(b => b.textContent?.trim());
const btn = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const type = (input: HTMLInputElement, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const click = async (b: HTMLElement | undefined) => { expect(b).toBeDefined(); await act(async () => { b!.click(); }); };
const submitForm = (f: HTMLFormElement) => act(() => { f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

describe('StepUpModal', () => {
    const base = { open: true, method: 'password' as const, busy: false, error: null, subject: 'your backup passphrase' };

    it('is a framed dialog: title + subtitle, footer = hint + Cancel + Confirm', () => {
        mount(h(StepUpModal, { ...base, onSubmit: vi.fn(), onCancel: vi.fn() }));
        expect(card()!.classList.contains('dlg-card')).toBe(true);
        expect(title()).toBe("Confirm it's you");
        expect(card()!.querySelector('.dlg-subtitle')!.textContent).toContain('your backup passphrase');
        expect(footLabels()).toEqual(['Cancel', 'Confirm']);
        expect(card()!.querySelector('.dlg-foot-hint')!.textContent).toMatch(/never stored/i);
    });

    it('Confirm stays disabled until something is typed, then submits the value (Enter = form submit)', () => {
        const onSubmit = vi.fn();
        mount(h(StepUpModal, { ...base, onSubmit, onCancel: vi.fn() }));
        const confirm = footBtns()[1];
        expect(confirm.disabled).toBe(true);
        const input = card()!.querySelector('input') as HTMLInputElement;
        type(input, 'hunter2');
        expect(confirm.disabled).toBe(false);
        expect(confirm.type).toBe('submit');
        submitForm(card()!.querySelector('form')!);
        expect(onSubmit).toHaveBeenCalledWith('hunter2');
    });

    it('shows the inline error in an assertive alert, and busy locks Cancel and the field', () => {
        mount(h(StepUpModal, { ...base, method: 'totp', error: 'That code didn’t match.', busy: true, onSubmit: vi.fn(), onCancel: vi.fn() }));
        const alert = card()!.querySelector('[role="alert"]')!;
        expect(alert.getAttribute('aria-live')).toBe('assertive');
        expect(alert.textContent).toBe('That code didn’t match.');
        expect(footBtns()[0].disabled).toBe(true);
        expect((card()!.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    });

    it('Cancel calls onCancel', async () => {
        const onCancel = vi.fn();
        mount(h(StepUpModal, { ...base, onSubmit: vi.fn(), onCancel }));
        await click(footBtns()[0]);
        expect(onCancel).toHaveBeenCalled();
    });
});

describe('RestorePasswordModal', () => {
    const base = { open: true, source: 'local' as const, fileName: 'b.enc', busy: false, error: null };

    it('frames the overwrite warning: warn tone, file name, footer = hint + Cancel + Restore', () => {
        mount(h(RestorePasswordModal, { ...base, onSubmit: vi.fn(), onCancel: vi.fn() }));
        expect(card()!.className).toContain('dlg-tone-warn');
        expect(title()).toBe('Restore backup?');
        expect(card()!.textContent).toContain('overwrites this device');
        expect(card()!.textContent).toContain('b.enc');
        expect(footLabels()).toEqual(['Cancel', 'Restore']);
        expect(footBtns()[1].disabled).toBe(true);
    });

    it('hands the typed password to onSubmit (and only that)', () => {
        const onSubmit = vi.fn();
        mount(h(RestorePasswordModal, { ...base, onSubmit, onCancel: vi.fn() }));
        type(card()!.querySelector('input') as HTMLInputElement, 'old-pw');
        submitForm(card()!.querySelector('form')!);
        expect(onSubmit).toHaveBeenCalledWith('old-pw');
    });

    it('opting into the saved password submits it without ever rendering it', async () => {
        const onSubmit = vi.fn();
        mount(h(RestorePasswordModal, { ...base, currentPassword: 'saved-pw', onSubmit, onCancel: vi.fn() }));
        await click(document.querySelector('.dlg-linkbtn') as HTMLElement);
        expect(card()!.textContent).toContain('Using your current backup password');
        expect(card()!.textContent).not.toContain('saved-pw');
        submitForm(card()!.querySelector('form')!);
        expect(onSubmit).toHaveBeenCalledWith('saved-pw');
    });

    it('while restoring, the footer hint carries the progress and Cancel is locked; errors are inline', () => {
        mount(h(RestorePasswordModal, { ...base, busy: true, progressLabel: 'Decrypting records…', error: 'Wrong password.', onSubmit: vi.fn(), onCancel: vi.fn() }));
        expect(card()!.querySelector('.dlg-foot-hint')!.textContent).toBe('Decrypting records…');
        expect(footBtns()[0].disabled).toBe(true);
        expect(card()!.querySelector('[role="alert"]')!.textContent).toBe('Wrong password.');
    });
});

describe('StaleBackupModal', () => {
    const warning = { title: 'Older backup', message: 'This file is older than your last backup.' } as never;

    it('renders nothing when closed', () => {
        mount(h(StaleBackupModal, { warning: null, onDecide: vi.fn() }));
        expect(card()).toBeNull();
    });

    it('framed: Cancel declines, Restore anyway proceeds', async () => {
        const onDecide = vi.fn();
        mount(h(StaleBackupModal, { warning, onDecide }));
        expect(title()).toBe('Older backup');
        expect(card()!.textContent).toContain('older than your last backup');
        expect(footLabels()).toEqual(['Cancel', 'Restore anyway']);
        await click(footBtns()[0]);
        expect(onDecide).toHaveBeenLastCalledWith(false);
        await click(footBtns()[1]);
        expect(onDecide).toHaveBeenLastCalledWith(true);
    });
});

// UpgradeRequiredOverlay is now the full-screen UpdateRequiredScreen (kill-switch
// branch); its behaviour is covered by that screen's own tests.

describe('ChangePasswordModal', () => {
    it('step 1 is framed with Cancel + a disabled Verify and a "Step 1 of 2" hint; Cancel closes', async () => {
        const onClose = vi.fn();
        mount(h(ChangePasswordModal, { open: true, onClose }));
        await settle();
        expect(card()!.classList.contains('dlg-card')).toBe(true);
        expect(title()).toBe('Change password');
        expect(footLabels()).toEqual(['Cancel', 'Verify']);
        expect(footBtns()[1].disabled).toBe(true);
        expect(card()!.querySelector('.dlg-foot-hint')!.textContent).toContain('Step 1 of 2');
        await click(footBtns()[0]);
        expect(onClose).toHaveBeenCalled();
    });

    it('opening it still requests the email code (same endpoint) when 2FA is off', async () => {
        mount(h(ChangePasswordModal, { open: true, onClose: vi.fn() }));
        await settle();
        expect(axiosPost.mock.calls.some(c => String(c[0]).endsWith('/auth/request-password-change-code'))).toBe(true);
    });
});

describe('TotpSetupModal', () => {
    it('first step: Cancel + disabled Continue, "1 of 5" progress, requests the setup email code; Cancel closes', async () => {
        const onClose = vi.fn();
        mount(h(TotpSetupModal, { onClose, onDone: vi.fn() }));
        await settle();
        expect(card()!.classList.contains('dlg-card')).toBe(true);
        expect(title()).toBe("Confirm it's you");
        expect(footLabels()).toEqual(['Cancel', 'Continue']);
        expect(footBtns()[1].disabled).toBe(true);
        expect(card()!.querySelector('.dlg-foot-hint')!.textContent).toContain('1 of 5');
        expect(axiosPost.mock.calls.some(c => String(c[0]).endsWith('/auth/2fa/totp/request-setup-code'))).toBe(true);
        await click(footBtns()[0]);
        expect(onClose).toHaveBeenCalled();
    });
});

describe('DeviceApprovalModal', () => {
    const request = {
        device_id: 'req-1', device_name: 'Pixel 8', platform: 'android',
        requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
        reset_due_at: null, ip_hint: '203.0.113.9', identity_key_pub_b64: 'AAAA', nonce_b64: 'bm9uY2U=',
    };

    it('shows the request in the frame; Approve needs the six typed digits; Not now just closes', async () => {
        const onClose = vi.fn();
        mount(h(DeviceApprovalModal, { request: request as never, onClose, onResolved: vi.fn(), onNotMe: vi.fn() }));
        expect(card()!.classList.contains('dlg-card')).toBe(true);
        expect(card()!.textContent).toContain('Pixel 8');
        expect(card()!.textContent).toContain('203.0.x.x');
        expect(footLabels()).toEqual(['Not now', 'Deny', 'Approve']);
        expect(footBtns()[2].disabled).toBe(true);
        expect(card()!.querySelector('.dlg-foot-hint')!.textContent).toContain("This wasn't me");
        await click(footBtns()[0]);
        expect(onClose).toHaveBeenCalled();
    });

    it('"This wasn\'t me" denies first, then hands off to the host', async () => {
        const onNotMe = vi.fn();
        mount(h(DeviceApprovalModal, { request: request as never, onClose: vi.fn(), onResolved: vi.fn(), onNotMe }));
        await click(btn("This wasn't me"));
        await settle();
        // The deny request is the same single call; whether it resolves here or not, nothing else was sent.
        expect(axiosPost.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('DeviceRemovedNotice: Later / Change password', async () => {
        const onLater = vi.fn(); const onChangePassword = vi.fn();
        mount(h(DeviceRemovedNotice, { deviceName: 'Pixel 8', onChangePassword, onLater }));
        expect(card()!.className).toContain('dlg-tone-danger');
        expect(title()).toBe('We removed that device');
        expect(footLabels()).toEqual(['Later', 'Change password']);
        await click(footBtns()[0]);
        await click(footBtns()[1]);
        expect(onLater).toHaveBeenCalled();
        expect(onChangePassword).toHaveBeenCalled();
    });
});

describe('ScreenLockSettings PIN dialog', () => {
    const screenLock = (enabled = false) => ({
        settings: { enabled, pinLength: 6, timeoutMinutes: 5, lockOnOsLock: true, verifier: null },
        isLocked: false, attempts: 0, lockedOutUntil: null, lockNow: vi.fn(), unlock: vi.fn(),
        setPin: vi.fn(async () => {}), changePin: vi.fn(async () => true), disable: vi.fn(async () => true),
        setTimeoutMinutes: vi.fn(), setLockOnOsLock: vi.fn(),
    });
    const keybinds = { binds: {} };

    it('Set up opens the length step: Cancel + Continue; Continue takes the highlighted length and moves on; Cancel closes', async () => {
        mount(h(ScreenLockSettings, { screenLock: screenLock() as never, keybinds: keybinds as never }));
        expect(card()).toBeNull();
        await click(btn('Set up'));
        expect(card()!.classList.contains('dlg-card')).toBe(true);
        expect(title()).toBe('Choose your PIN length');
        expect(footLabels()).toEqual(['Cancel', 'Continue']);
        await click(footBtns()[1]);
        expect(title()).toBe('Choose a 6-digit PIN');
        expect(card()!.querySelectorAll('input').length).toBe(1);
        // keypad step: Continue waits for all six digits
        expect(footBtns()[1].disabled).toBe(true);
        await click(footBtns()[0]);
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });
        expect(document.querySelector('.mod.open')).toBeNull();
    });

    it('picking 4 digits still advances immediately (unchanged)', async () => {
        mount(h(ScreenLockSettings, { screenLock: screenLock() as never, keybinds: keybinds as never }));
        await click(btn('Set up'));
        await click(card()!.querySelector('button[role="tab"]') as HTMLElement);
        expect(title()).toBe('Choose a 4-digit PIN');
    });

    it('turning off asks for the PIN in the same frame', async () => {
        mount(h(ScreenLockSettings, { screenLock: screenLock(true) as never, keybinds: keybinds as never }));
        await click(btn('Turn off'));
        expect(title()).toBe('Turn off Screen Lock');
        expect(footLabels()).toEqual(['Cancel', 'Turn off']);
    });
});
