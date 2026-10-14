// @vitest-environment jsdom
/**
 * Restore asks for the BACKUP'S password in a prompt — it no longer reads the
 * Settings passphrase field (which is for setting backups up).
 *
 * Integration level: the real BackupSection + RestorePasswordModal, with the
 * backup service, auth and toast mocked at their module boundaries.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 }); // BackupSection's import graph is heavy under box load
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

const store = vi.hoisted(() => ({ setItem: vi.fn(), cachedPw: null as string | null }));
vi.mock('../utils/secureLocalStore', () => ({
    default: { getItem: () => null, setItem: store.setItem, removeItem: vi.fn() },
    secureLocalStore: { getItem: () => null, setItem: store.setItem, removeItem: vi.fn() },
}));

const svc = vi.hoisted(() => ({
    restoreFromDrive: vi.fn(),
    restoreFromLocalFile: vi.fn(),
    setCachedPassword: vi.fn(async () => {}),
    getCachedPassword: vi.fn(async () => null as string | null),
    runBackup: vi.fn(),
}));
vi.mock('../services/driveBackup', () => ({
    restoreFromDrive: svc.restoreFromDrive,
    restoreFromLocalFile: svc.restoreFromLocalFile,
    setCachedPassword: svc.setCachedPassword,
    getCachedPassword: svc.getCachedPassword,
    runBackup: svc.runBackup,
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

import { BackupWrongPasswordError } from '../utils/backupErrors';

let BackupSection: any;
let root: Root;
let host: HTMLDivElement;
let reloads = 0;

beforeAll(async () => { ({ BackupSection } = await import('./BackupSection')); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function flush(ms = 30) { await act(async () => { await sleep(ms); }); }

function button(text: string | RegExp): HTMLButtonElement | null {
    const all = Array.from(document.body.querySelectorAll('button'));
    return (all.find(b => (typeof text === 'string' ? (b.textContent?.trim() === text || b.getAttribute('aria-label') === text) : text.test(b.textContent ?? ''))) as HTMLButtonElement) ?? null;
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
const promptInput = () => document.body.querySelector('.mod.open input[type="password"], .mod.open input[type="text"]') as HTMLInputElement | null;
const promptOpen = () => !!document.body.querySelector('.mod.open [role="dialog"], .mod.open.mcard, .mod.open');
const alertText = () => document.body.querySelector('.mod.open [role="alert"]')?.textContent ?? '';
const restoreBtn = () => document.body.querySelector('.mod.open button[type="submit"]') as HTMLButtonElement | null;

beforeEach(async () => {
    vi.clearAllMocks();
    reloads = 0;
    svc.getCachedPassword.mockResolvedValue(null);
    const realST = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
        ms === 1400 ? (reloads++, 0 as unknown as ReturnType<typeof setTimeout>) : realST(fn, ms, ...a)) as typeof setTimeout);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        gdriveAuthStatus: async () => ({ linked: true, email: 'a@b.c' }),
        getDeviceName: async () => 'box',
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/home/u/backups/old.enc'] })),
        secureReplaceMany: vi.fn(async () => {}),
        secureGetMany: vi.fn(async () => ({})),
    };
    localStorage.clear(); sessionStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(BackupSection)); await sleep(5); });
    await flush();
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('restore asks for the backup password in a prompt', () => {
    it('Restore from Drive opens the prompt without needing the Settings passphrase field', async () => {
        // The top passphrase field is EMPTY. The old code toasted "Enter your backup passphrase."
        await click(button(/Restore from Drive/));
        await flush(60);
        expect(promptOpen()).toBe(true);
        expect(promptInput()).not.toBeNull();
        expect(document.body.textContent).toContain('overwrites this device');
        expect(document.body.textContent).toContain('may differ from your current backup password');
        expect(toastPush).not.toHaveBeenCalled();
        expect(svc.restoreFromDrive).not.toHaveBeenCalled();
    });

    it('an empty password keeps Restore disabled; typing enables it', async () => {
        await click(button(/Restore from Drive/));
        await flush(60);
        expect(restoreBtn()!.disabled).toBe(true);
        await type(promptInput()!, 'x');
        expect(restoreBtn()!.disabled).toBe(false);
        await type(promptInput()!, '');
        expect(restoreBtn()!.disabled).toBe(true);
    });

    it('drive: restores with the TYPED password, not the Settings field, and success closes the prompt', async () => {
        svc.restoreFromDrive.mockResolvedValue({ restored: true });
        // A different password sits in the Settings field; it must not be used.
        const top = document.body.querySelector('input[placeholder="Choose a strong passphrase"]') as HTMLInputElement;
        await type(top, 'settings-field-passphrase');
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'the-backups-own-password');
        await click(restoreBtn());
        await flush(60);
        expect(svc.restoreFromDrive).toHaveBeenCalledTimes(1);
        expect(svc.restoreFromDrive.mock.calls[0][0]).toMatchObject({ userId: 'u1', password: 'the-backups-own-password' });
        await flush(300);
        expect(promptOpen()).toBe(false);
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Restored' }));
        expect(reloads).toBe(1);
    });

    it('local: picks the file FIRST, then prompts, then restores that path with the typed password', async () => {
        svc.restoreFromLocalFile.mockResolvedValue({ restored: true });
        const open = (window.electronAPI as unknown as { showOpenDialog: ReturnType<typeof vi.fn> }).showOpenDialog;
        await click(button(/Restore from file/));
        await flush(60);
        expect(open).toHaveBeenCalledTimes(1);
        expect(promptOpen()).toBe(true);
        expect(document.body.textContent).toContain('old.enc');
        expect(svc.restoreFromLocalFile).not.toHaveBeenCalled();
        await type(promptInput()!, 'old-password');
        await click(restoreBtn());
        await flush(60);
        expect(svc.restoreFromLocalFile.mock.calls[0][0]).toMatchObject({ userId: 'u1', filePath: '/home/u/backups/old.enc', password: 'old-password' });
        await flush(300);
        expect(promptOpen()).toBe(false);
    });

    it('local: cancelling the file picker never shows the prompt', async () => {
        (window.electronAPI as unknown as { showOpenDialog: unknown }).showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
        await click(button(/Restore from file/));
        await flush(60);
        expect(promptOpen()).toBe(false);
    });

    it.each(['drive', 'local'] as const)('%s: a wrong password keeps the prompt open with an inline error and the typed password intact', async (src) => {
        const fn = src === 'drive' ? svc.restoreFromDrive : svc.restoreFromLocalFile;
        fn.mockRejectedValueOnce(new BackupWrongPasswordError());
        await click(button(src === 'drive' ? /Restore from Drive/ : /Restore from file/));
        await flush(60);
        await type(promptInput()!, 'nope-nope');
        await click(restoreBtn());
        await flush(60);
        expect(promptOpen()).toBe(true);
        expect(alertText()).toBe("That password didn't unlock this backup");
        expect(promptInput()!.value).toBe('nope-nope');
        expect(promptInput()!.disabled).toBe(false);
        expect(toastPush).not.toHaveBeenCalled();
        // Correcting it and trying again works, and the error clears on edit.
        fn.mockResolvedValueOnce({ restored: true });
        await type(promptInput()!, 'right-one');
        expect(alertText()).toBe('');
        await click(restoreBtn());
        await flush(300);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn.mock.calls[1][0]).toMatchObject({ password: 'right-one' });
        expect(promptOpen()).toBe(false);
    });

    it('a non-password failure (no backup found) closes the prompt and toasts the real message', async () => {
        svc.restoreFromDrive.mockRejectedValueOnce(new Error('No backup found in Google Drive.'));
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'pw');
        await click(restoreBtn());
        await flush(300);
        expect(promptOpen()).toBe(false);
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', title: 'Restore failed', message: 'No backup found in Google Drive.' }));
    });

    it('declining the stale-backup question is a quiet no-op: prompt closed, no reload, no error', async () => {
        svc.restoreFromDrive.mockResolvedValue({ restored: false });
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'pw');
        await click(restoreBtn());
        await flush(300);
        expect(promptOpen()).toBe(false);
        expect(reloads).toBe(0);
        expect(toastPush).not.toHaveBeenCalled();
    });

    it('stale-backup question is still asked mid-restore: the prompt steps aside and Restore anyway proceeds', async () => {
        let resolved!: (r: { restored: boolean }) => void;
        svc.restoreFromDrive.mockImplementation(async (o: { onStaleBackup: (w: unknown) => Promise<boolean> }) => {
            const ok = await o.onStaleBackup({ title: 'Older backup', message: 'This is older than your last backup.' });
            return new Promise(res => { resolved = res; if (!ok) res({ restored: false }); else res({ restored: true }); });
        });
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'pw');
        await click(restoreBtn());
        await flush(60);
        expect(document.body.textContent).toContain('Older backup');
        await click(button('Restore anyway'));
        await flush(300);
        expect(resolved).toBeDefined();
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restored' }));
    });

    it('Cancel closes the prompt and discards the typed password; reopening starts empty', async () => {
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'secret-typed');
        await click(button('Cancel'));
        await flush(300);
        expect(promptOpen()).toBe(false);
        await click(button(/Restore from Drive/));
        await flush(60);
        expect(promptInput()!.value).toBe('');
        expect(svc.restoreFromDrive).not.toHaveBeenCalled();
    });

    it('Escape cancels', async () => {
        await click(button(/Restore from Drive/));
        await flush(60);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(5); });
        await flush(300);
        expect(promptOpen()).toBe(false);
    });

    it('Enter in the field submits', async () => {
        svc.restoreFromDrive.mockResolvedValue({ restored: true });
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'via-enter');
        await act(async () => {
            promptInput()!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await sleep(5);
        });
        await flush(60);
        expect(svc.restoreFromDrive.mock.calls[0][0]).toMatchObject({ password: 'via-enter' });
    });

    it('the input is labelled, focused, and the error region is an assertive live region', async () => {
        await click(button(/Restore from Drive/));
        await flush(60);
        const input = promptInput()!;
        const label = document.body.querySelector(`.mod.open label[for="${input.id}"]`);
        expect(label?.textContent).toBe('Backup password');
        expect(document.activeElement).toBe(input);
        const region = document.body.querySelector('.mod.open [role="alert"]')!;
        expect(region.getAttribute('aria-live')).toBe('assertive');
        expect(document.body.querySelector('.mod.open [role="dialog"]')!.getAttribute('aria-modal')).toBe('true');
    });

    it('the show/hide toggle reveals what the user is typing in the prompt', async () => {
        await click(button(/Restore from Drive/));
        await flush(60);
        expect(promptInput()!.type).toBe('password');
        await click(button('Show password'));
        expect(promptInput()!.type).toBe('text');
    });

    it('NEVER persists the restore password: no cache write, no secure-store write, no web storage', async () => {
        svc.restoreFromDrive.mockResolvedValue({ restored: true });
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'super-secret-restore-pw');
        await click(restoreBtn());
        await flush(300);
        expect(svc.restoreFromDrive).toHaveBeenCalled();
        expect(svc.setCachedPassword).not.toHaveBeenCalled();
        const api = window.electronAPI as unknown as { secureReplaceMany: ReturnType<typeof vi.fn> };
        expect(api.secureReplaceMany).not.toHaveBeenCalled();
        expect(store.setItem).not.toHaveBeenCalled();
        const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
        expect(dump).not.toContain('super-secret-restore-pw');
        // ...and a wrong-password round trip doesn't leak it either.
        svc.restoreFromLocalFile.mockRejectedValueOnce(new BackupWrongPasswordError());
        await click(button(/Restore from file/));
        await flush(60);
        await type(promptInput()!, 'super-secret-restore-pw');
        await click(restoreBtn());
        await flush(60);
        expect(svc.setCachedPassword).not.toHaveBeenCalled();
        expect(store.setItem).not.toHaveBeenCalled();
    });

    describe('current-password convenience', () => {
        it('is offered only when a password is saved, starts empty, and is explicit opt-in', async () => {
            // Nothing saved: no link.
            await click(button(/Restore from Drive/));
            await flush(60);
            expect(button('Use my current backup password')).toBeNull();
            await click(button('Cancel'));
            await flush(300);
        });

        it('opting in labels it, sends the saved password, and never reveals it', async () => {
            await act(async () => { root.unmount(); });
            svc.getCachedPassword.mockResolvedValue('saved-current-pw');
            svc.restoreFromDrive.mockResolvedValue({ restored: true });
            root = createRoot(host);
            await act(async () => { root.render(React.createElement(BackupSection)); await sleep(5); });
            await flush();
            await click(button(/Restore from Drive/));
            await flush(60);
            expect(promptInput()!.value).toBe('');           // not pre-filled
            expect(restoreBtn()!.disabled).toBe(true);
            await click(button('Use my current backup password'));
            expect(document.body.textContent).toContain('Using your current backup password');
            expect(document.body.textContent).not.toContain('saved-current-pw');
            expect(promptInput()).toBeNull();                // no field, so no reveal toggle either
            expect(button('Show password')).toBeNull();
            await click(restoreBtn());
            await flush(60);
            expect(svc.restoreFromDrive.mock.calls[0][0]).toMatchObject({ password: 'saved-current-pw' });
        });
    });

    it('NEGATIVE CONTROL: the old gate (top field required) is really gone', async () => {
        // If doRestore still demanded the top field, this restore would have been
        // blocked by an "Enter your backup passphrase." toast with the service
        // never called. Prove the harness would see that: type nothing at the
        // top, restore with a prompt password, and observe the service call.
        svc.restoreFromDrive.mockResolvedValue({ restored: true });
        const top = document.body.querySelector('input[placeholder="Choose a strong passphrase"]') as HTMLInputElement;
        expect(top.value).toBe('');
        await click(button(/Restore from Drive/));
        await flush(60);
        await type(promptInput()!, 'only-in-prompt');
        await click(restoreBtn());
        await flush(60);
        expect(svc.restoreFromDrive).toHaveBeenCalledTimes(1);
        expect(toastPush).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Enter your backup passphrase.' }));
    });
});
