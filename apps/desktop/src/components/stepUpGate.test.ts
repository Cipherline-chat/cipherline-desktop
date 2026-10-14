// @vitest-environment jsdom
/**
 * Revealing a stored secret needs a fresh "Confirm it's you":
 *   - the saved backup passphrase (BackupSection's Show toggle), and
 *   - the storage recovery key (RecoveryKeyCard's Reveal button).
 * Hiding never does; typing a passphrase during backup setup never does.
 *
 * Real BackupSection / RecoveryKeyCard / useStepUp / StepUpModal; only the
 * network service (services/stepUp), auth, toast and the backup service are
 * mocked at their module boundaries.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const toastPush = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { user_id: 'u1' }, token: 'tok' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: toastPush }) }));

const store = vi.hoisted(() => ({ setItem: vi.fn() }));
vi.mock('../utils/secureLocalStore', () => ({
    default: { getItem: () => null, setItem: store.setItem, removeItem: vi.fn() },
    secureLocalStore: { getItem: () => null, setItem: store.setItem, removeItem: vi.fn() },
}));

const svc = vi.hoisted(() => ({
    setCachedPassword: vi.fn(async () => {}),
    getCachedPassword: vi.fn(async () => null as string | null),
}));
vi.mock('../services/driveBackup', () => ({
    restoreFromDrive: vi.fn(), restoreFromLocalFile: vi.fn(), runBackup: vi.fn(),
    setCachedPassword: svc.setCachedPassword,
    getCachedPassword: svc.getCachedPassword,
    getLastBackupAt: () => null,
    getDriveBackupInfo: async () => null,
    getDestinationStamps: () => ({}),
    backupFileName: (b: string) => `${b}.enc`,
    DEFAULT_MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
}));
vi.mock('../hooks/useBackupAutoSchedule', () => ({
    readBackupCfg: () => ({
        enabled: false, intervalMs: 86400000, driveIntervalMs: 86400000, localEnabled: false, localDir: null,
        driveEnabled: false, driveFolderName: 'Cipherline Backups', driveFolderId: null, backupFileBase: 'cipherline-backup-x',
        includeAttachments: true, maxAttachmentBytes: 25 * 1024 * 1024,
    }),
    writeBackupCfg: vi.fn(),
}));

// The network half of step-up. The real StepUpError class is kept so the hook's
// instanceof check is exercised; the window is long by default and shortened per
// test (stepSvc.ttlMs) where expiry is the thing under test.
const stepSvc = vi.hoisted(() => ({
    fetchStepUpMethod: vi.fn(),
    verifyStepUp: vi.fn(),
    ttlMs: 60_000,
}));
vi.mock('../services/stepUp', async () => {
    const actual = await vi.importActual<typeof import('../services/stepUp')>('../services/stepUp');
    return { ...actual, get STEP_UP_TTL_MS() { return stepSvc.ttlMs; }, fetchStepUpMethod: stepSvc.fetchStepUpMethod, verifyStepUp: stepSvc.verifyStepUp };
});

import { StepUpError } from '../services/stepUp';

let BackupSection: any;
let RecoveryKeyCard: any;
let root: Root;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ BackupSection } = await import('./BackupSection'));
    ({ default: RecoveryKeyCard } = await import('./RecoveryKeyCard'));
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function flush(ms = 30) { await act(async () => { await sleep(ms); }); }
/** Poll until `cond` holds (a settled UI state), instead of guessing a sleep. */
async function until(cond: () => boolean, ms = 6000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not reached');
        await act(async () => { await sleep(15); });
    }
}

function button(text: string | RegExp): HTMLButtonElement | null {
    const all = Array.from(document.body.querySelectorAll('button'));
    return (all.find(b => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''))) as HTMLButtonElement) ?? null;
}
async function click(el: Element | null) {
    if (!el) throw new Error('element not found');
    await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(5); });
}
async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(5);
    });
}
const dialog = () => document.body.querySelector('.mod.open [role="dialog"]') as HTMLElement | null;
const dialogInput = () => document.body.querySelector('.mod.open input') as HTMLInputElement | null;
const dialogAlert = () => document.body.querySelector('.mod.open [role="alert"]')?.textContent ?? '';
const confirmBtn = () => document.body.querySelector('.mod.open button[type="submit"]') as HTMLButtonElement | null;
const passphraseField = () => document.body.querySelector('input[placeholder$="(saved on this device)"], input[placeholder="Choose a strong passphrase"]') as HTMLInputElement;
const showToggle = () => button('Show') ?? button('Hide');

async function mount(el: React.ReactElement) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(el); await sleep(5); });
    await flush();
}

beforeEach(() => {
    vi.clearAllMocks();
    stepSvc.ttlMs = 60_000;
    svc.getCachedPassword.mockResolvedValue(null);
    stepSvc.fetchStepUpMethod.mockResolvedValue('totp');
    stepSvc.verifyStepUp.mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        gdriveAuthStatus: async () => ({ linked: false }),
        getDeviceName: async () => 'box',
        secureReplaceMany: vi.fn(async () => {}),
        secureGetMany: vi.fn(async () => ({})),
        revealRecoveryKey: vi.fn(async () => ({ ok: true, keyB64: 'RECOVERY-KEY-B64' })),
    };
    localStorage.clear(); sessionStorage.clear();
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
});

describe('backup passphrase: Show needs "Confirm it\'s you"', () => {
    beforeEach(async () => {
        svc.getCachedPassword.mockResolvedValue('stored-passphrase');
        await mount(React.createElement(BackupSection));
    });

    it('a stored passphrase is masked, and Show opens the dialog INSTEAD of revealing (negative control: old code revealed at once)', async () => {
        expect(passphraseField().type).toBe('password');
        await click(showToggle());
        await flush(30);
        expect(dialog()).not.toBeNull();
        expect(passphraseField().type).toBe('password');          // still masked while the dialog is up
        expect(stepSvc.fetchStepUpMethod).toHaveBeenCalledWith('tok');
        expect(stepSvc.verifyStepUp).not.toHaveBeenCalled();
    });

    it('an empty code keeps Confirm disabled', async () => {
        await click(showToggle());
        await flush(30);
        expect(confirmBtn()!.disabled).toBe(true);
        await type(dialogInput()!, '123456');
        expect(confirmBtn()!.disabled).toBe(false);
    });

    it('a wrong code keeps it masked and the dialog open with an inline, announced error; the code stays editable', async () => {
        stepSvc.verifyStepUp.mockRejectedValueOnce(new StepUpError('rejected'));
        await click(showToggle());
        await flush(30);
        await type(dialogInput()!, '000000');
        await click(confirmBtn());
        await flush(40);
        expect(dialog()).not.toBeNull();
        expect(dialogAlert()).toMatch(/didn't work/);
        expect(document.body.querySelector('.mod.open [role="alert"]')!.getAttribute('aria-live')).toBe('assertive');
        expect(dialogInput()!.value).toBe('000000');
        expect(dialogInput()!.disabled).toBe(false);
        expect(passphraseField().type).toBe('password');
    });

    it('a rate-limited attempt says so', async () => {
        stepSvc.verifyStepUp.mockRejectedValueOnce(new StepUpError('rate_limited'));
        await click(showToggle());
        await flush(30);
        await type(dialogInput()!, '123456');
        await click(confirmBtn());
        await flush(40);
        expect(dialogAlert()).toMatch(/Too many attempts/);
    });

    it('a valid code reveals the passphrase and closes the dialog; the TOTP form is used for a 2FA account', async () => {
        await click(showToggle());
        await flush(30);
        expect(document.body.querySelector('.mod.open label')!.textContent).toBe('Authenticator or backup code');
        expect(document.activeElement).toBe(dialogInput());
        await type(dialogInput()!, '123456');
        await click(confirmBtn());
        await flush(300);
        expect(stepSvc.verifyStepUp).toHaveBeenCalledWith('tok', 'totp', '123456');
        expect(passphraseField().type).toBe('text');
        expect(passphraseField().value).toBe('stored-passphrase');
        expect(document.body.querySelector('.mod.open')).toBeNull();
    });

    it('Enter (form submit) verifies', async () => {
        await click(showToggle());
        await flush(30);
        await type(dialogInput()!, '654321');
        await act(async () => { dialogInput()!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await sleep(5); });
        await flush(40);
        expect(stepSvc.verifyStepUp).toHaveBeenCalledWith('tok', 'totp', '654321');
    });

    it('hiding needs no verification, and while unlocked Show needs no second prompt', async () => {
        await click(showToggle());
        await flush(30);
        await type(dialogInput()!, '123456');
        await click(confirmBtn());
        await flush(300);
        expect(passphraseField().type).toBe('text');
        await click(button('Hide'));
        expect(passphraseField().type).toBe('password');
        expect(stepSvc.verifyStepUp).toHaveBeenCalledTimes(1);
        await click(button('Show'));
        await flush(30);
        expect(passphraseField().type).toBe('text');
        expect(dialog()).toBeNull();
        expect(stepSvc.verifyStepUp).toHaveBeenCalledTimes(1);
        expect(stepSvc.fetchStepUpMethod).toHaveBeenCalledTimes(1);
    });

    it('the unlock EXPIRES: the field re-masks, and Show asks again', async () => {
        stepSvc.ttlMs = 1200;
        await click(showToggle());
        await flush(30);
        await type(dialogInput()!, '123456');
        await click(confirmBtn());
        await until(() => passphraseField().type === 'text');
        await until(() => passphraseField().type === 'password');   // the window lapsed on its own
        await click(showToggle());
        await flush(30);
        expect(dialog()).not.toBeNull();
        expect(passphraseField().type).toBe('password');
    });

    it('Cancel and Escape leave it masked', async () => {
        await click(showToggle());
        await flush(30);
        await click(button('Cancel'));
        await flush(300);
        expect(dialog()).toBeNull();
        expect(passphraseField().type).toBe('password');
        await click(showToggle());
        await flush(30);
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(5); });
        await flush(300);
        expect(dialog()).toBeNull();
        expect(passphraseField().type).toBe('password');
        expect(stepSvc.verifyStepUp).not.toHaveBeenCalled();
    });

    it('if the method lookup fails the gate fails CLOSED: no dialog, still masked, user told', async () => {
        stepSvc.fetchStepUpMethod.mockRejectedValueOnce(new Error('offline'));
        await click(showToggle());
        await flush(40);
        expect(dialog()).toBeNull();
        expect(passphraseField().type).toBe('password');
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    });

    it('nothing about the step-up is persisted: no secure store, no web storage', async () => {
        await click(showToggle());
        await flush(30);
        await type(dialogInput()!, '987654');
        await click(confirmBtn());
        await flush(300);
        expect(store.setItem).not.toHaveBeenCalled();
        expect(svc.setCachedPassword).not.toHaveBeenCalled();
        const api = window.electronAPI as unknown as { secureReplaceMany: ReturnType<typeof vi.fn> };
        expect(api.secureReplaceMany).not.toHaveBeenCalled();
        const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
        expect(dump).not.toContain('987654');
        expect(dump.toLowerCase()).not.toContain('step');
    });
});

describe('backup passphrase: account without 2FA uses the password', () => {
    it('asks for the account password and verifies it with method=password', async () => {
        svc.getCachedPassword.mockResolvedValue('stored-passphrase');
        stepSvc.fetchStepUpMethod.mockResolvedValue('password');
        await mount(React.createElement(BackupSection));
        await click(showToggle());
        await flush(30);
        expect(document.body.querySelector('.mod.open label')!.textContent).toBe('Account password');
        expect(dialogInput()!.type).toBe('password');
        await type(dialogInput()!, 'my-account-pw');
        await click(confirmBtn());
        await until(() => passphraseField().type === 'text');
        expect(stepSvc.verifyStepUp).toHaveBeenCalledWith('tok', 'password', 'my-account-pw');
    });
});

describe('backup SETUP is not gated', () => {
    it('with nothing stored, typing is allowed and Show works with no step-up at all', async () => {
        await mount(React.createElement(BackupSection));
        const f = passphraseField();
        expect(f.placeholder).toBe('Choose a strong passphrase');
        expect(f.type).toBe('password');                            // masked while typing
        await type(f, 'new-passphrase');
        expect(f.value).toBe('new-passphrase');
        await click(showToggle());
        await flush(30);
        expect(passphraseField().type).toBe('text');
        expect(dialog()).toBeNull();
        expect(stepSvc.fetchStepUpMethod).not.toHaveBeenCalled();
        expect(stepSvc.verifyStepUp).not.toHaveBeenCalled();
    });

    it('a field revealed before the stored passphrase finishes loading is re-masked when it arrives', async () => {
        let resolvePw!: (v: string) => void;
        svc.getCachedPassword.mockReturnValue(new Promise<string | null>(r => { resolvePw = r; }));
        await mount(React.createElement(BackupSection));
        await click(showToggle());                                  // nothing known to be stored yet -> allowed
        expect(passphraseField().type).toBe('text');
        await act(async () => { resolvePw('stored-passphrase'); await sleep(10); });
        await flush();
        expect(passphraseField().type).toBe('password');            // the stored secret must not appear unmasked
    });
});

describe('recovery key: Reveal needs "Confirm it\'s you" too', () => {
    const reveal = () => (window.electronAPI as unknown as { revealRecoveryKey: ReturnType<typeof vi.fn> }).revealRecoveryKey;

    beforeEach(async () => { await mount(React.createElement(RecoveryKeyCard)); });

    it('Reveal opens the dialog and does NOT touch the key until verified (negative control)', async () => {
        await click(button(/Reveal recovery key/));
        await flush(30);
        expect(dialog()).not.toBeNull();
        expect(reveal()).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toContain('RECOVERY-KEY-B64');
    });

    it('a wrong code never reads the key', async () => {
        stepSvc.verifyStepUp.mockRejectedValueOnce(new StepUpError('rejected'));
        await click(button(/Reveal recovery key/));
        await flush(30);
        await type(dialogInput()!, '000000');
        await click(confirmBtn());
        await flush(40);
        expect(dialog()).not.toBeNull();
        expect(reveal()).not.toHaveBeenCalled();
    });

    it('a valid code reads and shows the key; Hide clears it without verification', async () => {
        await click(button(/Reveal recovery key/));
        await flush(30);
        await type(dialogInput()!, '123456');
        await click(confirmBtn());
        await flush(300);
        expect(reveal()).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('RECOVERY-KEY-B64');
        await click(button('Hide'));
        expect(document.body.textContent).not.toContain('RECOVERY-KEY-B64');
        expect(stepSvc.verifyStepUp).toHaveBeenCalledTimes(1);
    });

    it('the revealed key is wiped from view when the step-up window lapses', async () => {
        stepSvc.ttlMs = 1200;
        await click(button(/Reveal recovery key/));
        await flush(30);
        await type(dialogInput()!, '123456');
        await click(confirmBtn());
        await until(() => document.body.textContent!.includes('RECOVERY-KEY-B64'));
        await until(() => !document.body.textContent!.includes('RECOVERY-KEY-B64'));
    });

    it('cancelling reads nothing', async () => {
        await click(button(/Reveal recovery key/));
        await flush(30);
        await click(button('Cancel'));
        await flush(300);
        expect(reveal()).not.toHaveBeenCalled();
    });
});
