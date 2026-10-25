// @vitest-environment jsdom
/**
 * Moment: Add Friend with your OWN tag → "You played yourself." Mounted for
 * real (network and store faked). What must hold:
 *   - your exact tag: NO request reaches the network, the error slot says so,
 *     and the self-friend moment is asked for;
 *   - anyone else (including a case-variant of your name — the server matches
 *     exactly, so that is a different person): the request goes out as before,
 *     and no moment.
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

const axiosPost = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => axiosPost(...a), get: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', user: { user_id: 'me', username: 'Dawson', discriminator: 42 } }),
}));
const kv = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const secureLocalStore = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => { kv.set(k, v); } };
    return { secureLocalStore, default: secureLocalStore };
});

const { AddFriendModal } = await import('./AddFriendModal');
const { MOMENT_EVENT } = await import('../utils/moments');
const { SELF_FRIEND_ERRORS } = await import('../utils/eggPools');

let root: Root;
let host: HTMLDivElement;
const requested: string[] = [];
const onMoment = (e: Event) => requested.push((e as CustomEvent<{ id: string }>).detail.id);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    kv.clear();
    axiosPost.mockReset();
    axiosPost.mockResolvedValue({ data: {} });
    requested.length = 0;
    window.addEventListener(MOMENT_EVENT, onMoment);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(AddFriendModal, { onClose: () => {} })));
});
afterEach(() => {
    window.removeEventListener(MOMENT_EVENT, onMoment);
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
});

async function send(tag: string) {
    const input = document.getElementById('add-friend-tag') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, tag); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.form!.requestSubmit(); });
}
const errorText = () => document.querySelector('.dlg-form')?.textContent ?? '';

describe('Add Friend → yourself', () => {
    it('your own tag is NOT sent; the error slot says so; the moment is asked for', async () => {
        await send('Dawson#0042');
        expect(axiosPost).not.toHaveBeenCalled();
        expect(requested).toEqual(['self-friend']);
        expect(errorText()).toContain(SELF_FRIEND_ERRORS[0]);
    });

    it('trying again still sends nothing and rotates the line', async () => {
        await send('Dawson#0042');
        await send('Dawson#0042');
        expect(axiosPost).not.toHaveBeenCalled();
        expect(errorText()).toContain(SELF_FRIEND_ERRORS[1]);
    });

    it('someone else is sent as before, with no moment', async () => {
        await send('Mira#4821');
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost.mock.calls[0][1]).toEqual({ target_username: 'Mira', target_discriminator: 4821 });
        expect(requested).toEqual([]);
    });

    it('a case-variant of your name is a different person: sent, no moment', async () => {
        await send('dawson#0042');
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(requested).toEqual([]);
    });

    it('same name, different number: sent', async () => {
        await send('Dawson#0043');
        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(requested).toEqual([]);
    });
});
