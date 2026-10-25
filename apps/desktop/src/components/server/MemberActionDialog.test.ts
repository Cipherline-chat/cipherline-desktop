// @vitest-environment jsdom
/**
 * Kick / ban confirmation: names the member and the server, explains the
 * consequence, fires the caller's action ONLY from the danger button, and
 * starts focused on Cancel.
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

vi.mock('../EncryptedAvatar', () => ({ EncryptedAvatar: () => React.createElement('span', { 'data-testid': 'avatar' }) }));

const { MemberActionDialog } = await import('./MemberActionDialog');

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

async function mount(kind: 'kick' | 'ban') {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
        root.render(React.createElement(MemberActionDialog, {
            kind, serverName: 'Game night', memberId: 'u-alex', memberName: 'Alex', avatarUrl: null, token: 't', onConfirm, onClose,
        }));
    });
    await act(async () => { vi.advanceTimersByTime(50); });
    return { onConfirm, onClose };
}
const btn = (t: string) => [...document.querySelectorAll('.dlg-foot-actions button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

describe('MemberActionDialog', () => {
    it.each([['kick', 'Kick', /rejoin/i], ['ban', 'Ban', /not rejoin/i]] as const)(
        '%s: title names member + server, footer is Cancel + danger primary, text says what happens',
        async (kind, verb, rejoin) => {
            await mount(kind);
            expect(document.querySelector('.dlg-title')?.textContent).toBe(`${verb} Alex from Game night?`);
            expect([...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim())).toEqual(['Cancel', verb]);
            expect(document.querySelector('.mact-list')?.textContent).toMatch(rejoin);
        },
    );

    it('focus starts on Cancel', async () => {
        await mount('ban');
        expect(document.activeElement).toBe(btn('Cancel'));
    });

    it('the danger button fires onConfirm once, then closes after the exit animation', async () => {
        const { onConfirm, onClose } = await mount('kick');
        await act(async () => { btn('Kick')!.click(); });
        expect(onConfirm).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Cancel closes without confirming (control for the test above)', async () => {
        const { onConfirm, onClose } = await mount('ban');
        await act(async () => { btn('Cancel')!.click(); });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
