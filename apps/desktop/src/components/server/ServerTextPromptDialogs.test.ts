// @vitest-environment jsdom
/** Rename-call and nickname prompts: validation, submit, cancel. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { RenameCallDialog, NicknameDialog } = await import('./ServerTextPromptDialogs');
const { cleanCallName } = await import('../../utils/callName');

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

const footBtn = (t: string) => [...document.querySelectorAll('.dlg-foot-actions button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement;
const submitForm = () => act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

describe('cleanCallName', () => {
    it('strips characters the API rejects and trims', () => {
        expect(cleanCallName("  Strategy <b>night</b>!  ")).toBe('Strategy bnightb');
        expect(cleanCallName("Dawn's call_1.0-x")).toBe("Dawn's call_1.0-x");
        expect(cleanCallName('###')).toBe('');
    });
});

describe('RenameCallDialog', () => {
    const mount = async (draft: string) => {
        const onSubmit = vi.fn(); const onClose = vi.fn();
        await act(async () => { root.render(React.createElement(RenameCallDialog, { open: true, draft, onDraftChange: () => {}, onSubmit, onClose })); });
        await act(async () => { vi.advanceTimersByTime(80); });
        return { onSubmit, onClose };
    };

    it('uses the house frame and says who sees the new name', async () => {
        await mount('Thursday');
        expect(document.querySelector('.dlg-title')?.textContent).toBe('Rename call');
        expect(document.querySelector('.dlg-subtitle')?.textContent).toMatch(/Everyone in the call/);
    });

    it('Rename is disabled and Enter submits nothing when nothing valid is typed', async () => {
        const { onSubmit } = await mount('###');
        expect(footBtn('Rename').disabled).toBe(true);
        await submitForm();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('a valid name submits once (control)', async () => {
        const { onSubmit } = await mount('Thursday');
        expect(footBtn('Rename').disabled).toBe(false);
        await submitForm();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('Cancel closes without submitting', async () => {
        const { onSubmit, onClose } = await mount('Thursday');
        await act(async () => { footBtn('Cancel').click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('NicknameDialog', () => {
    const mount = async (extra: Record<string, unknown> = {}) => {
        const onSubmit = vi.fn(); const onClose = vi.fn();
        await act(async () => {
            root.render(React.createElement(NicknameDialog, {
                open: true, isSelf: false, displayName: 'Alex', value: 'Al', onChange: () => {}, onSubmit, onClose, ...extra,
            }));
        });
        await act(async () => { vi.advanceTimersByTime(80); });
        return { onSubmit, onClose };
    };

    it('names whose nickname it is', async () => {
        await mount();
        expect(document.querySelector('.dlg-subtitle')?.textContent).toBe('Nickname for Alex');
    });

    it('your own nickname says so', async () => {
        await mount({ isSelf: true });
        expect(document.querySelector('.dlg-subtitle')?.textContent).toBe('Your nickname in this server');
    });

    it('an empty nickname is allowed (it resets to the username) and submits', async () => {
        const { onSubmit } = await mount({ value: '' });
        await submitForm();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('while saving, Enter does not resubmit and Cancel is locked', async () => {
        const { onSubmit } = await mount({ saving: true });
        await submitForm();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(footBtn('Cancel').disabled).toBe(true);
    });

    it('shows the error strip', async () => {
        await mount({ error: 'Nickname is taken' });
        expect(document.querySelector('.dlg-error')?.textContent).toBe('Nickname is taken');
    });
});
