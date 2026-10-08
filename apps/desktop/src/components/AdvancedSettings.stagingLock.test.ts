// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Settings → Advanced → Update channel with the staging lock: Staging asks
 * for the password only while this device is locked, Stable never asks, and
 * once unlocked the toggle switches freely. The "Lock again" action re-locks
 * via main. (Main's own refusal is covered in electron/staging-lock.test.ts.)
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

vi.mock('../utils/secureLocalStore', () => {
    const s = { getItem: () => null, setItem: () => {}, removeItem: () => {}, isAccountReady: () => true, whenAccountReady: async () => {} };
    return { default: s, secureLocalStore: s };
});
vi.mock('../contexts/UpdateContext', () => ({
    useUpdate: () => ({ state: { phase: 'idle' }, checkNow: async () => false }),
}));

const { AdvancedSettings } = await import('./AdvancedSettings');

type Lock = { enforced: boolean; isStagingBuild: boolean; unlocked: boolean; retryAfterMs: number };

let root: Root;
let host: HTMLDivElement;
let lock: Lock;
let channel: 'latest' | 'staging';
const api = {
    getUpdateChannel: vi.fn(async () => channel),
    setUpdateChannel: vi.fn(async (c: 'latest' | 'staging') => {
        // Mirrors main: refuse staging while locked.
        if (c === 'staging' && lock.enforced && !lock.unlocked) {
            throw new Error("Error invoking remote method 'updater:set-channel': Error: STAGING_LOCKED");
        }
        channel = c;
        return c;
    }),
    getStagingLockStatus: vi.fn(async () => ({ ...lock })),
    unlockStaging: vi.fn(async (pw: string) => {
        if (pw === 'correct-horse') { lock.unlocked = true; return { ok: true, retryAfterMs: 0 }; }
        return { ok: false, retryAfterMs: 0 };
    }),
    relockStaging: vi.fn(async () => {
        lock.unlocked = false;
        if (channel === 'staging') channel = 'latest';
        return { ...lock };
    }),
};

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    lock = { enforced: true, isStagingBuild: false, unlocked: false, retryAfterMs: 0 };
    channel = 'latest';
    Object.values(api).forEach((f) => f.mockClear());
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount() {
    await act(async () => { root.render(React.createElement(AdvancedSettings)); });
    await flush();
}
const radio = (title: string) =>
    [...document.querySelectorAll('button[role="radio"]')].find((b) => b.textContent?.includes(title)) as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"][aria-label="Unlock staging builds"]') as HTMLElement | null;
// ClModal keeps its card mounted ~260 ms for the exit animation; the prompt
// is "closed" once the password form inside it is gone.
const promptShowing = () => !!dialog()?.querySelector('input');
const buttonByText = (t: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

async function click(el: HTMLElement) { await act(async () => { el.click(); }); await flush(); }
function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submitPrompt(pw: string) {
    const input = dialog()!.querySelector('input') as HTMLInputElement;
    typeInto(input, pw);
    await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
}

describe('AdvancedSettings — staging lock', () => {
    it('locked: choosing Staging opens the password prompt and does NOT switch', async () => {
        await mount();
        await click(radio('Staging'));
        expect(dialog()).not.toBeNull();
        expect(api.setUpdateChannel).not.toHaveBeenCalled();
        expect(radio('Stable').getAttribute('aria-checked')).toBe('true');
    });

    it('a wrong password keeps the prompt open and the channel on Stable', async () => {
        await mount();
        await click(radio('Staging'));
        await submitPrompt('nope');
        expect(api.unlockStaging).toHaveBeenCalledWith('nope');
        expect(dialog()!.textContent).toContain('Wrong password');
        expect(api.setUpdateChannel).not.toHaveBeenCalled();
    });

    it('the right password unlocks, switches to Staging, and shows the unlocked line', async () => {
        await mount();
        await click(radio('Staging'));
        await submitPrompt('correct-horse');
        expect(api.setUpdateChannel).toHaveBeenCalledWith('staging');
        expect(radio('Staging').getAttribute('aria-checked')).toBe('true');
        expect(document.body.textContent).toContain('Staging access unlocked on this device');
    });

    it('once unlocked, toggling Stable ⇄ Staging never prompts again', async () => {
        lock.unlocked = true;
        await mount();
        await click(radio('Staging'));
        await click(radio('Stable'));
        await click(radio('Staging'));
        expect(api.unlockStaging).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
        expect(api.setUpdateChannel.mock.calls.map((c) => c[0])).toEqual(['staging', 'latest', 'staging']);
    });

    it('choosing Stable never asks, even while locked', async () => {
        channel = 'staging';
        await mount();
        await click(radio('Stable'));
        expect(dialog()).toBeNull();
        expect(api.setUpdateChannel).toHaveBeenCalledWith('latest');
    });

    it('if main refuses (re-locked elsewhere) the prompt opens instead of an error', async () => {
        lock.unlocked = true;
        await mount();
        lock.unlocked = false; // re-locked behind this page's back
        await click(radio('Staging'));
        expect(api.setUpdateChannel).toHaveBeenCalledWith('staging');
        expect(dialog()).not.toBeNull();
        expect(radio('Stable').getAttribute('aria-checked')).toBe('true');
    });

    it('"Lock again" asks to confirm, then re-locks via main and returns the channel to Stable', async () => {
        lock.unlocked = true;
        channel = 'staging';
        await mount();
        await click(buttonByText('Lock again')!);
        // Confirm dialog's own button (the second "Lock again").
        const confirmBtn = [...document.querySelectorAll('.mcard button')].find((b) => b.textContent?.trim() === 'Lock again') as HTMLButtonElement;
        await click(confirmBtn);
        expect(api.relockStaging).toHaveBeenCalledTimes(1);
        expect(radio('Stable').getAttribute('aria-checked')).toBe('true');
        expect(document.body.textContent).not.toContain('Staging access unlocked on this device');
    });

    it('Cancel closes the prompt and the channel stays on Stable (the card does not stick on Staging)', async () => {
        await mount();
        await click(radio('Staging'));
        expect(promptShowing()).toBe(true);
        await click(buttonByText('Cancel')!);
        expect(promptShowing()).toBe(false);
        expect(api.unlockStaging).not.toHaveBeenCalled();
        expect(api.setUpdateChannel).not.toHaveBeenCalled();
        expect(radio('Stable').getAttribute('aria-checked')).toBe('true');
        expect(radio('Staging').getAttribute('aria-checked')).toBe('false');
    });

    it('Esc cancels the same way', async () => {
        await mount();
        await click(radio('Staging'));
        expect(promptShowing()).toBe(true);
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await flush();
        expect(promptShowing()).toBe(false);
        expect(api.setUpdateChannel).not.toHaveBeenCalled();
        expect(radio('Stable').getAttribute('aria-checked')).toBe('true');
    });

    it('cancelling while the password is still being checked does NOT switch the channel afterwards', async () => {
        let release!: (r: { ok: boolean; retryAfterMs: number }) => void;
        api.unlockStaging.mockImplementationOnce(() => new Promise((res) => {
            release = (r) => { lock.unlocked = true; res(r); };
        }));
        await mount();
        await click(radio('Staging'));
        const input = dialog()!.querySelector('input') as HTMLInputElement;
        typeInto(input, 'correct-horse');
        await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await click(buttonByText('Cancel')!);          // user backs out mid-check
        await act(async () => { release({ ok: true, retryAfterMs: 0 }); });
        await flush();
        expect(api.unlockStaging).toHaveBeenCalledTimes(1);
        expect(api.setUpdateChannel).not.toHaveBeenCalled();
        expect(radio('Stable').getAttribute('aria-checked')).toBe('true');
    });

    it('Enter in the field submits (it is a real form)', async () => {
        await mount();
        await click(radio('Staging'));
        const input = dialog()!.querySelector('input') as HTMLInputElement;
        expect(input.form).not.toBeNull();
        expect(dialog()!.querySelector('button[type="submit"]')).not.toBeNull();
    });

    it('a backoff from main is shown and blocks submitting', async () => {
        lock.retryAfterMs = 30_000;
        await mount();
        await click(radio('Staging'));
        expect(dialog()!.textContent).toContain('Too many attempts');
        const submit = dialog()!.querySelector('button[type="submit"]') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
    });

    it('no lock UI at all where the lock is not enforced (dev build)', async () => {
        lock = { enforced: false, isStagingBuild: false, unlocked: true, retryAfterMs: 0 };
        await mount();
        expect(document.body.textContent).not.toContain('Staging access unlocked');
        await click(radio('Staging'));
        expect(dialog()).toBeNull();
        expect(api.setUpdateChannel).toHaveBeenCalledWith('staging');
    });
});
