// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Wrong PIN / cooldown feedback on the Screen Lock (2026-11-22 follow-up):
 *   - "Wrong PIN" used to live only as long as the 500 ms red flash, so it was
 *     effectively never readable (the real-app shots caught red boxes and an
 *     empty status line). It now stays until the next digit and says how many
 *     tries are left;
 *   - the input is disabled during the 30 s cooldown (which drops focus) and
 *     nothing gave focus back, so typing after the cooldown went nowhere until
 *     you clicked (prod build too, not a StrictMode artifact). Focus now
 *     returns when the cooldown ends.
 */
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ logout: vi.fn() }) }));
vi.mock('./LockScreenField', () => ({ default: () => null }));
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { default: ScreenLockOverlay } = await import('./ScreenLockOverlay');
type Lock = Parameters<typeof ScreenLockOverlay>[0]['screenLock'];

let host: HTMLDivElement;
let root: Root;
let lock: { attempts: number; lockedOutUntil: number | null; unlock: ReturnType<typeof vi.fn> };
const render = () => act(() => {
    root.render(React.createElement(ScreenLockOverlay, {
        screenLock: {
            settings: { pinLength: 4, enabled: true, verifier: null, timeoutMinutes: 5, lockOnOsLock: true },
            isLocked: true, lockNow: vi.fn(), setPin: vi.fn(), changePin: vi.fn(), disable: vi.fn(),
            forgotPinReset: vi.fn(), setTimeoutMinutes: vi.fn(), setLockOnOsLock: vi.fn(),
            ...lock,
        } as unknown as Lock,
    }));
});
const input = () => document.querySelector('[data-screen-lock] input') as HTMLInputElement;
const status = () => document.querySelector('.sl-status') as HTMLElement;
const type = async (v: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        set.call(input(), v);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
};

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    lock = { attempts: 0, lockedOutUntil: null, unlock: vi.fn() };
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

describe('Screen Lock wrong-PIN message', () => {
    it('stays after the red flash ends, says how many tries are left, and clears on the next digit', async () => {
        // The hook counts the failure before unlock() resolves (as useScreenLock does).
        lock.unlock = vi.fn(async () => { lock.attempts = 1; render(); return false; });
        render();
        await type('1234');
        expect(lock.unlock).toHaveBeenCalledWith('1234');
        expect(status().textContent).toBe('Wrong PIN. 4 tries left.');
        expect(status().classList.contains('is-bad')).toBe(true);
        await act(async () => { vi.advanceTimersByTime(2000); }); // well past the 500 ms flash
        expect(status().textContent).toBe('Wrong PIN. 4 tries left.');
        await type('5');
        expect(status().textContent).toBe('');
        expect(status().classList.contains('is-bad')).toBe(false);
    });

    it('warns about the wait on the last try', async () => {
        lock.attempts = 3;
        lock.unlock = vi.fn(async () => { lock.attempts = 4; render(); return false; });
        render();
        await type('0000');
        expect(status().textContent).toBe('Wrong PIN. 1 try left, then a 30-second wait.');
    });

    it('negative control: nothing is shown before any attempt', () => {
        render();
        expect(status().textContent).toBe('');
    });
});

describe('Screen Lock cooldown', () => {
    it('shows the countdown, then gives the PIN input focus back when it ends (no click needed)', async () => {
        vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
        lock.lockedOutUntil = Date.now() + 3000;
        render();
        expect(status().textContent).toBe('Too many attempts. Try again in 3s.');
        expect(input().disabled).toBe(true);
        // A real browser drops focus from a disabled input; jsdom does not, so move it away explicitly.
        (document.querySelector('.sl-forgot') as HTMLButtonElement).focus();
        expect(document.activeElement).not.toBe(input());
        await act(async () => { vi.advanceTimersByTime(3500); });
        expect(input().disabled).toBe(false);
        expect(document.activeElement).toBe(input());
        expect(status().textContent).toBe('');
    });
});
