// @vitest-environment jsdom
/**
 * Block / remove-friend confirmation: names the person, says what happens,
 * fires the caller's action ONLY from the danger button (and only once), and
 * starts focused on Cancel. Each behavioural claim has a control.
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

vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => React.createElement('span', { 'data-testid': 'avatar' }) }));

const { FriendActionDialog } = await import('./FriendActionDialog');

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

async function mount(kind: 'block' | 'unfriend', username = 'Mira') {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
        root.render(React.createElement(FriendActionDialog, {
            kind, userId: 'u-mira', username, avatarUrl: null, token: 't', onConfirm, onClose,
        }));
    });
    await act(async () => { vi.advanceTimersByTime(50); });
    return { onConfirm, onClose };
}
const btn = (t: string) => [...document.querySelectorAll('.dlg-foot-actions button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const escape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });

describe('FriendActionDialog', () => {
    it.each([
        ['block', 'Block', 'Block Mira?', /message you/i],
        ['unfriend', 'Remove', 'Remove Mira as a friend?', /history/i],
    ] as const)('%s: names the person, footer is Cancel + danger primary, text says what happens', async (kind, verb, title, text) => {
        await mount(kind);
        expect(document.querySelector('.dlg-title')?.textContent).toBe(title);
        expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(title);
        expect(document.querySelector('.dlg-head-icon--danger')).not.toBeNull();
        expect([...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim())).toEqual(['Cancel', verb]);
        expect(document.querySelector('.mact-list')?.textContent).toMatch(text);
    });

    it('block copy states the friend removal and that they are not notified', async () => {
        await mount('block');
        const t = document.querySelector('.mact-list')?.textContent ?? '';
        expect(t).toMatch(/Removed from your friends/);
        expect(t).toMatch(/aren.t notified/);
    });

    it('a blank name falls back to "this person"', async () => {
        await mount('block', '   ');
        expect(document.querySelector('.dlg-title')?.textContent).toBe('Block this person?');
    });

    it('focus starts on Cancel, so a stray Enter cannot block anyone', async () => {
        await mount('block');
        expect(document.activeElement).toBe(btn('Cancel'));
    });

    it('the danger button fires onConfirm once, then closes after the exit animation', async () => {
        const { onConfirm, onClose } = await mount('block');
        await act(async () => { btn('Block')!.click(); });
        expect(onConfirm).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a second click during the exit animation does not fire the request again', async () => {
        const { onConfirm } = await mount('unfriend');
        const b = btn('Remove')!;
        await act(async () => { b.click(); b.click(); });
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('Cancel closes without acting (control for the tests above)', async () => {
        const { onConfirm, onClose } = await mount('block');
        await act(async () => { btn('Cancel')!.click(); });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Escape cancels without acting', async () => {
        const { onConfirm, onClose } = await mount('unfriend');
        await escape();
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
