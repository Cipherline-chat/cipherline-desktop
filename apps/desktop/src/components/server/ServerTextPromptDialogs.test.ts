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

describe('cleanCallName / callNameDraftError', () => {
    it('only trims: nothing is stripped (the API rule allows emoji and punctuation)', () => {
        expect(cleanCallName("  Strategy <b>night</b>!  ")).toBe('Strategy <b>night</b>!');
        expect(cleanCallName("Dawn's call_1.0-x \u{1F3AE}")).toBe("Dawn's call_1.0-x \u{1F3AE}");
        expect(cleanCallName('###')).toBe('###');
    });

    it('reports a rejected character instead of removing it', async () => {
        const { callNameDraftError } = await import('../../utils/callName');
        expect(callNameDraftError('Raid night \u{1F468}\u200D\u{1F469}\u200D\u{1F467}!')).toBeNull();
        expect(callNameDraftError('')).toBeNull();
        expect(callNameDraftError('   ')).toBeNull();
        expect(callNameDraftError('a\u202Eb')).toMatch(/direction-control/);
        expect(callNameDraftError('a\u200Bb')).toMatch(/hidden/);
        expect(callNameDraftError('x'.repeat(61))).toMatch(/60/);
        expect(callNameDraftError('\u{1F525}'.repeat(60))).toBeNull();
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

    it('Rename is disabled and Enter submits nothing when the name is empty', async () => {
        const { onSubmit } = await mount('   ');
        expect(footBtn('Rename').disabled).toBe(true);
        await submitForm();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('a name with a rejected character shows why, and cannot be submitted; punctuation and emoji can', async () => {
        const bad = await mount('Strategy\u202E night');
        expect(document.querySelector('.dlg-error')?.textContent).toMatch(/direction-control/);
        expect(footBtn('Rename').disabled).toBe(true);
        await submitForm();
        expect(bad.onSubmit).not.toHaveBeenCalled();
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        const good = await mount('Strategy night! \u{1F3AE}');
        expect(document.querySelector('.dlg-error')).toBeNull();
        expect(footBtn('Rename').disabled).toBe(false);
        await submitForm();
        expect(good.onSubmit).toHaveBeenCalledTimes(1);
    });

    it('shows the server\u2019s refusal (an older API still on the plain-text rule)', async () => {
        const onSubmit = vi.fn(); const onClose = vi.fn();
        await act(async () => { root.render(React.createElement(RenameCallDialog, { open: true, draft: 'Night \u{1F3AE}', onDraftChange: () => {}, onSubmit, onClose, error: 'Name may only contain letters' })); });
        await act(async () => { vi.advanceTimersByTime(80); });
        expect(document.querySelector('.dlg-error')?.textContent).toBe('Name may only contain letters');
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
