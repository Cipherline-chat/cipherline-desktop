// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

import { AgeGatePane } from './AgeGatePane';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const btn = (label: RegExp) => [...document.querySelectorAll('button')].find(b => label.test(b.textContent ?? '')) as HTMLButtonElement;

async function mount(over: Partial<{ onConfirm: () => Promise<void>; onBack: () => void }> = {}) {
    const onConfirm = over.onConfirm ?? vi.fn(async () => undefined);
    const onBack = over.onBack ?? vi.fn();
    await act(async () => { root.render(React.createElement(AgeGatePane, { channelName: 'spicy', onConfirm, onBack })); });
    await flush();
    return { onConfirm, onBack };
}

describe('AgeGatePane', () => {
    it('says what it is, and shows nothing of the channel but its name', async () => {
        await mount();
        const t = document.body.textContent ?? '';
        expect(t).toContain('This channel is age-restricted');
        expect(t).toContain('18 or older');
        expect(t).toContain('#spicy');
        expect(btn(/I'm 18 or older, continue/)).toBeTruthy();
        expect(btn(/Go back/)).toBeTruthy();
    });

    it('Continue confirms once (and stays busy: the parent unmounts the gate)', async () => {
        const { onConfirm, onBack } = await mount();
        await act(async () => { btn(/I'm 18 or older/).click(); });
        await flush();
        await act(async () => { btn(/Saving/)?.click(); });
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();
    });

    it('Go back goes back', async () => {
        const { onConfirm, onBack } = await mount();
        await act(async () => { btn(/Go back/).click(); });
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('a failed confirmation shows the reason and offers to try again', async () => {
        let n = 0;
        const onConfirm = vi.fn(async () => { n++; if (n === 1) throw new Error('No connection to the server'); });
        await mount({ onConfirm });
        await act(async () => { btn(/I'm 18 or older/).click(); });
        await flush();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('No connection to the server');
        await act(async () => { btn(/Try again/).click(); });
        await flush();
        expect(onConfirm).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    it('is a labelled region and focus starts on the safe answer', async () => {
        await mount();
        const region = document.querySelector('[data-testid="age-gate"]')!;
        expect(region.getAttribute('aria-labelledby')).toBe('age-gate-title');
        expect(document.getElementById('age-gate-title')).toBeTruthy();
        expect(document.activeElement?.textContent).toMatch(/Go back/);
    });
});
