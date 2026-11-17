// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The GPU variant of the share intro card (Windows/macOS, real AMD or Intel GPU in use): the share going live
 * (useGpuShareIntroTrigger) -> pending -> on screen only when the window is visible AND focused -> its OWN device flag
 * written at that moment. The Linux variant is covered, unchanged, by LinuxShareIntroCard.test.ts. The GPU rule itself
 * (every exclusion): utils/gpuShareIntro.test.ts.
 */
const h = vi.hoisted(() => {
    const state = { kv: new Map<string, string>(), writes: [] as Array<[string, string]>, focused: true, reduced: false };
    window.matchMedia = ((q: string) => ({
        matches: q.includes('reduced-motion') ? state.reduced : false, media: q,
        addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    return state;
});
vi.mock('../../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => h.kv.get(k) ?? null,
        setItem: (k: string, v: string) => { h.writes.push([k, v]); h.kv.set(k, v); },
    },
}));

import { LinuxShareIntroCard, LinuxShareIntroCardView } from './LinuxShareIntroCard';
import {
    GPU_SHARE_INTRO_KEY, LINUX_SHARE_INTRO_KEY, useGpuShareIntroTrigger, useLinuxShareIntroTrigger, __resetLinuxShareIntroForTests,
} from '../../utils/linuxShareIntro';
import { setScreenShareSession } from '../../utils/screenShareDiagnostics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
const IDS: Record<string, number> = { AMD: 0x1002, Intel: 0x8086, NVIDIA: 0x10de, Apple: 0x106b, Qualcomm: 0x5143, VMware: 0x15ad };

let root: Root;
let host: HTMLDivElement;
const App: React.FC<{ sharing: boolean }> = ({ sharing }) => {
    useLinuxShareIntroTrigger(sharing, () => undefined);
    useGpuShareIntroTrigger(sharing);
    return React.createElement(LinuxShareIntroCard);
};
const render = (sharing: boolean) => act(() => { root.render(React.createElement(App, { sharing })); });
const card = () => document.body.querySelector('.lsi-card');
const setPlatform = (platform: string) => { (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform }; };
const withGpus = (...gpus: Array<[string, boolean?]>) => setScreenShareSession({
    sourceId: 's1', requestedFps: 60, codecPref: 'auto', codec: 'vp8', codecReason: 'x', hw: null,
    main: { platform: 'win32', windowsBuild: 1, sourceKind: 'screen', displayHz: 60, displayHzSource: 'shared',
        capturer: { backend: 'wgc', why: '' }, capturerPref: 'auto',
        gpus: gpus.map(([vendor, active]) => ({ vendor, vendorId: IDS[vendor] ?? 0x9999, deviceId: 1, active: !!active })),
        videoEncode: 'enabled', h264CbpHwEnabled: false, captureLog: false },
});

beforeEach(() => {
    h.kv.clear();
    h.writes.length = 0;
    h.focused = true;
    h.reduced = false;
    __resetLinuxShareIntroForTests();
    setScreenShareSession(null);
    setPlatform('windows');
    vi.spyOn(document, 'hasFocus').mockImplementation(() => h.focused);
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('GPU share intro card: once per device, Windows/macOS on a real AMD or Intel GPU', () => {
    it('shows after the share is live, names the vendor, writes ONLY its own flag at that moment', async () => {
        withGpus(['AMD']);
        render(false);
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
        render(true);
        await act(async () => {});
        expect(card()).not.toBeNull();
        expect(h.writes).toEqual([[GPU_SHARE_INTRO_KEY, '1']]);
        const text = card()!.textContent!;
        expect(text).toContain('Help us make screen sharing smoother');
        expect(text).toContain('New');
        expect(text).toContain('Your AMD graphics');
        expect(text).toContain('tuned most on NVIDIA');
        expect(text).toContain('send a report from the share menu');
        expect(text).toContain('never your messages');
        expect(text).not.toContain('Linux');
        expect(card()!.getAttribute('role')).toBe('dialog');
        expect(card()!.getAttribute('aria-modal')).toBe('false');
    });

    it('names Intel for an Intel GPU, on macOS too', async () => {
        setPlatform('mac');
        withGpus(['Intel']);
        render(true);
        await act(async () => {});
        expect(card()!.textContent).toContain('Your Intel graphics');
        expect(card()!.textContent).not.toContain('Your AMD graphics');
    });

    it('hybrid with the Intel iGPU actually in use: shows', async () => {
        withGpus(['Intel', true], ['NVIDIA']);
        render(true);
        await act(async () => {});
        expect(card()!.textContent).toContain('Your Intel graphics');
    });

    it('waits while the window is not focused, shows when it is (nothing written before)', async () => {
        withGpus(['Intel']);
        h.focused = false;
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
        act(() => { h.focused = true; window.dispatchEvent(new Event('focus')); });
        expect(card()).not.toBeNull();
        expect(h.writes).toEqual([[GPU_SHARE_INTRO_KEY, '1']]);
    });

    it.each([
        ['NVIDIA', [['NVIDIA']]],
        ['Apple', [['Apple']]],
        ['a VM adapter', [['VMware', true]]],
        ['hybrid with NVIDIA active', [['Intel'], ['NVIDIA', true]]],
        ['hybrid, cannot tell which is active', [['Intel'], ['NVIDIA']]],
    ] as Array<[string, Array<[string, boolean?]>]>)('never for %s', async (_n, gpus) => {
        withGpus(...gpus);
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
    });

    it('never when the vendor is unknown (no GPU info)', async () => {
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
    });

    it('never on Linux (that device gets the Linux card, with the Linux flag)', async () => {
        setPlatform('linux');
        withGpus(['AMD']);
        render(true);
        await act(async () => {});
        expect(card()!.textContent).toContain('Screen sharing on Linux is new');
        expect(card()!.textContent).not.toContain('Help us make screen sharing smoother');
        expect(h.writes).toEqual([[LINUX_SHARE_INTRO_KEY, '1']]);
    });

    it('not again once this device saw it; the Linux flag does not suppress it', async () => {
        h.kv.set(GPU_SHARE_INTRO_KEY, '1');
        withGpus(['AMD']);
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
        render(false);
        h.kv.clear();
        h.kv.set(LINUX_SHARE_INTRO_KEY, '1');
        render(true);
        await act(async () => {});
        expect(card()).not.toBeNull();
    });

    it('"Got it" closes it, writes nothing more, and the next share does not bring it back', async () => {
        withGpus(['AMD']);
        render(true);
        await act(async () => {});
        const gotIt = [...card()!.querySelectorAll('button')].find(b => b.textContent === 'Got it')!;
        act(() => { gotIt.click(); });
        expect(card()).toBeNull();
        expect(h.writes).toHaveLength(1);
        render(false);
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toHaveLength(1);
    });

    it('Esc closes it and writes nothing more', async () => {
        withGpus(['Intel']);
        render(true);
        await act(async () => {});
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(card()).toBeNull();
        expect(h.writes).toHaveLength(1);
    });
});

describe('LinuxShareIntroCardView, gpu variant', () => {
    const view = (props: Partial<React.ComponentProps<typeof LinuxShareIntroCardView>> = {}) =>
        act(() => { root.render(React.createElement(LinuxShareIntroCardView, { backend: 'normal', variant: 'gpu', vendor: 'AMD', onDismiss: () => {}, videoSrc: 'blob:clip', ...props })); });

    it('shows the owner\'s how-to clip (muted, looping) and names the vendor', () => {
        view();
        const v = host.querySelector('video')!;
        expect(v.muted).toBe(true);
        expect(v.loop).toBe(true);
        expect(v.getAttribute('aria-label')).toMatch(/Report a Quality Problem/);
        expect(host.textContent).toContain('Your AMD graphics');
        expect(host.querySelector('.lsi-card--gpu')).not.toBeNull();
    });

    it('has no Linux encoder line; the close button only calls onDismiss', () => {
        const onDismiss = vi.fn();
        view({ onDismiss, vendor: 'Intel' });
        expect(host.querySelector('.lsi-backend--nvenc, .lsi-backend--vaapi, .lsi-backend--normal')).toBeNull();
        act(() => { host.querySelector<HTMLButtonElement>('.rp-close')!.click(); });
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(h.writes).toEqual([]);
    });

    it('default variant is still the Linux copy', () => {
        act(() => { root.render(React.createElement(LinuxShareIntroCardView, { backend: 'nvenc', onDismiss: () => {}, videoSrc: 'blob:clip' })); });
        expect(host.textContent).toContain('Screen sharing on Linux is new');
    });
});

describe('wiring (read from source)', () => {
    it('SidebarConference starts the GPU trigger when our own share goes live', () => {
        expect(SRC('SidebarConference.tsx')).toMatch(/useGpuShareIntroTrigger\(!!localScreenShare\)/);
    });
});
