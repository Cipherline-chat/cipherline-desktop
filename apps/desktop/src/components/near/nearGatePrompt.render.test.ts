// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
});

import { NearGatePrompt } from './NearGatePrompt';
import { setNearStoreForTest, createNearStore } from '../../utils/nearStore';
import { nt } from '../../utils/nearStrings';
import type { NearGatePrompt as Prompt, NearGateSubmitResult } from '../../types/near';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root; let host: HTMLDivElement;
let emit: (p: Prompt) => void = () => undefined;
const submit = vi.fn<(t: string, v: string) => Promise<NearGateSubmitResult>>();
const cancel = vi.fn(async (_t: string) => undefined);

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    submit.mockReset(); cancel.mockClear();
    const api = {
        nearTransferRequest: vi.fn(),
        onNearGatePrompt: (cb: (p: Prompt) => void) => { emit = cb; return () => { emit = () => undefined; }; },
        nearGateSubmit: submit,
        nearGateCancel: cancel,
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    setNearStoreForTest(createNearStore({ ...api, nearGetState: async () => ({ seq: 1, role: 'own_sender', state: 'awaiting_approval', peer: { label: 'Dawson’s phone', platform: 'android', labelSealed: true } }) } as never));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount()); document.body.innerHTML = '';
    vi.unstubAllGlobals(); setNearStoreForTest(null); delete (window as { electronAPI?: unknown }).electronAPI;
});
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); };
const input = () => document.querySelector<HTMLInputElement>('[data-testid="near-gate-input"]');
const type = async (v: string) => {
    const el = input()!;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const confirm = async () => { await act(async () => { document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush(); };

describe('the password gate prompt (spec bio.pw.*) for hosts without a biometric', () => {
    it('renders nothing until main asks', async () => {
        act(() => root.render(React.createElement(NearGatePrompt)));
        await flush();
        expect(host.innerHTML).toBe('');
        expect(document.body.textContent).not.toContain(nt('bio.pw.title'));
    });

    it('shows the spec strings with a password field and hands the typed secret to main (never a verdict)', async () => {
        submit.mockResolvedValue('ok');
        act(() => root.render(React.createElement(NearGatePrompt)));
        await flush();
        act(() => emit({ ticket: 'T1', method: 'password' }));
        await flush();
        expect(document.body.textContent).toContain(nt('bio.pw.title'));
        expect(document.body.textContent).toContain(nt('bio.pw.label'));
        expect(input()!.type).toBe('password');
        expect(input()!.autocomplete).toBe('current-password');
        await type('hunter2');
        await confirm();
        expect(submit).toHaveBeenCalledWith('T1', 'hunter2');
        expect(input()).toBeNull(); // closed after "ok"; the typed value is gone with the component state
    });

    it('a wrong password says so and keeps the prompt, empty, for another try', async () => {
        submit.mockResolvedValue('rejected');
        act(() => root.render(React.createElement(NearGatePrompt)));
        act(() => emit({ ticket: 'T2', method: 'password' }));
        await flush();
        await type('nope');
        await confirm();
        expect(document.querySelector('[data-testid="near-gate-error"]')!.textContent).toBe(nt('bio.pw.err'));
        expect(input()!.value).toBe('');
    });

    it('a server limit / outage uses the calm "didn’t work" line, not the wrong-password one', async () => {
        for (const r of ['rate_limited', 'unavailable'] as const) {
            submit.mockResolvedValueOnce(r);
            act(() => root.render(React.createElement(NearGatePrompt)));
            act(() => emit({ ticket: 'T3', method: 'password' }));
            await flush();
            await type('x');
            await confirm();
            expect(document.querySelector('[data-testid="near-gate-error"]')!.textContent).toBe(nt('b.ap.bioFail'));
            act(() => emit({ ticket: 'T3', method: 'password', closed: true }));
            await flush();
        }
    });

    it('Cancel tells main to decline; main closing the prompt removes it', async () => {
        act(() => root.render(React.createElement(NearGatePrompt)));
        act(() => emit({ ticket: 'T4', method: 'password' }));
        await flush();
        const cancelBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
        await act(async () => { cancelBtn.click(); });
        expect(cancel).toHaveBeenCalledWith('T4');
        expect(input()).toBeNull();

        act(() => emit({ ticket: 'T5', method: 'password' }));
        await flush();
        expect(input()).not.toBeNull();
        act(() => emit({ ticket: 'T5', method: 'password', closed: true }));
        await flush();
        expect(input()).toBeNull();
    });

    it('asks for the authenticator code on an account with two-factor sign-in', async () => {
        submit.mockResolvedValue('ok');
        act(() => root.render(React.createElement(NearGatePrompt)));
        act(() => emit({ ticket: 'T6', method: 'totp' }));
        await flush();
        expect(input()!.type).toBe('text');
        expect(input()!.autocomplete).toBe('one-time-code');
        expect(document.body.textContent).toContain('authenticator');
    });

    it('does not submit an empty value', async () => {
        act(() => root.render(React.createElement(NearGatePrompt)));
        act(() => emit({ ticket: 'T7', method: 'password' }));
        await flush();
        await confirm();
        expect(submit).not.toHaveBeenCalled();
    });
});
