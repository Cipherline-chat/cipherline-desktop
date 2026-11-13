// @vitest-environment jsdom
/**
 * Password-gated destructive confirm (delete server / transfer ownership):
 * the action stays disabled until a password is typed, Enter submits only
 * then, Cancel / Escape never submit, and a request in flight locks the dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { PasswordConfirmDialog } = await import('./PasswordConfirmDialog');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers();
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

type Props = React.ComponentProps<typeof PasswordConfirmDialog>;
async function mount(extra: Partial<Props> = {}) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const onPasswordChange = vi.fn();
    await act(async () => {
        root.render(React.createElement(PasswordConfirmDialog, {
            open: true, onClose, onSubmit, onPasswordChange,
            label: 'Delete Game night', title: 'Delete “Game night”?', icon: null,
            password: '', submitLabel: 'Delete server', busyLabel: 'Deleting…',
            children: React.createElement('div', { className: 'dlg-text' }, 'It cannot be undone.'),
            ...extra,
        }));
    });
    await act(async () => { vi.advanceTimersByTime(80); });
    return { onSubmit, onClose, onPasswordChange };
}
const input = () => document.querySelector('input[type="password"]') as HTMLInputElement;
const submitBtn = () => [...document.querySelectorAll('.dlg-foot-actions button')].find(b => /Delete server|Deleting/.test(b.textContent ?? '')) as HTMLButtonElement;
const cancelBtn = () => [...document.querySelectorAll('.dlg-foot-actions button')].find(b => b.textContent?.trim() === 'Cancel') as HTMLButtonElement;
const enter = () => act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});

describe('PasswordConfirmDialog', () => {
    it('renders a labelled dialog: title, password field focused, Cancel + the action', async () => {
        await mount();
        expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Delete Game night');
        expect(document.querySelector('.dlg-title')?.textContent).toBe('Delete “Game night”?');
        expect(document.activeElement).toBe(input());
        expect([...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim())).toEqual(['Cancel', 'Delete server']);
    });

    it('the action is disabled and Enter submits nothing while the password is empty or blank', async () => {
        const { onSubmit } = await mount({ password: '   ' });
        expect(submitBtn().disabled).toBe(true);
        await enter();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('with a password the action is enabled and submitting fires onSubmit once (control)', async () => {
        const { onSubmit } = await mount({ password: 'hunter2' });
        expect(submitBtn().disabled).toBe(false);
        await enter();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('typing reports the new value to the caller', async () => {
        const { onPasswordChange } = await mount();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => { setter.call(input(), 'abc'); input().dispatchEvent(new Event('input', { bubbles: true })); });
        expect(onPasswordChange).toHaveBeenCalledWith('abc');
    });

    it('shows the caller\'s error strip', async () => {
        await mount({ password: 'x', error: 'Incorrect password' });
        expect(document.querySelector('.dlg-error')?.textContent).toBe('Incorrect password');
    });

    it('Cancel closes without submitting', async () => {
        const { onSubmit, onClose } = await mount({ password: 'x' });
        await act(async () => { cancelBtn().click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('a request in flight locks Cancel and Escape, and Enter does not resubmit', async () => {
        const { onSubmit, onClose } = await mount({ password: 'x', busy: true });
        expect(cancelBtn().disabled).toBe(true);
        expect(input().disabled).toBe(true);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(onClose).not.toHaveBeenCalled();
        await enter();
        expect(onSubmit).not.toHaveBeenCalled();
    });
});
