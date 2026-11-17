// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The Windows/macOS AMD/Intel "help us make screen sharing smoother" card, below the UI: the primary-GPU rule
 * (gpuShareVendor), the pure decision (platform x vendor x seen x offered), the state machine and its OWN device flag,
 * and the trigger hook reading the share session. Rendering: components/diagnostics/GpuShareIntroCard.test.ts.
 */
const h = vi.hoisted(() => ({ kv: new Map<string, string>(), writes: [] as Array<[string, string]> }));
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => h.kv.get(k) ?? null,
        setItem: (k: string, v: string) => { h.writes.push([k, v]); h.kv.set(k, v); },
    },
}));

import {
    GPU_SHARE_INTRO_KEY, LINUX_SHARE_INTRO_KEY, gpuShareVendor, shouldOfferGpuShareIntro, noteGpuScreenShareStarted,
    noteScreenShareStarted, revealLinuxShareIntro, dismissLinuxShareIntro, getLinuxShareIntroState, hasSeenGpuShareIntro,
    hasSeenLinuxShareIntro, shareIntroVariant, useGpuShareIntroTrigger, __resetLinuxShareIntroForTests,
} from './linuxShareIntro';
import { setScreenShareSession, updateScreenShareSession, type MainShareDiagnostics, type ScreenShareSession } from './screenShareDiagnostics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDS: Record<string, number> = {
    AMD: 0x1002, Intel: 0x8086, NVIDIA: 0x10de, Apple: 0x106b, Qualcomm: 0x5143,
    'Microsoft (software)': 0x1414, Google: 0x1ae0, VMware: 0x15ad, VirtualBox: 0x80ee, Parallels: 0x1ab8, virtio: 0x1af4, qemu: 0x1b36,
};
const gpu = (vendor: string, active = false) => ({ vendor, vendorId: IDS[vendor] ?? 0x9999, deviceId: 1, active });

beforeEach(() => {
    h.kv.clear();
    h.writes.length = 0;
    __resetLinuxShareIntroForTests();
    setScreenShareSession(null);
});

describe('gpuShareVendor: shown ONLY for a real AMD / Intel GPU that is the one in use', () => {
    describe('shows', () => {
        it.each([
            ['AMD alone, no active flag', [gpu('AMD')], 'AMD'],
            ['Intel alone (integrated, real machine)', [gpu('Intel')], 'Intel'],
            ['Intel alone, active', [gpu('Intel', true)], 'Intel'],
            ['AMD primary + Intel, nothing active: first real (nvidiaIsPrimary rule)', [gpu('AMD'), gpu('Intel')], 'AMD'],
            ['Intel + AMD, AMD active: the active one wins', [gpu('Intel'), gpu('AMD', true)], 'AMD'],
            ['hybrid Intel + NVIDIA where Intel is ACTIVE', [gpu('Intel', true), gpu('NVIDIA')], 'Intel'],
            ['hybrid NVIDIA + AMD where AMD is ACTIVE', [gpu('NVIDIA'), gpu('AMD', true)], 'AMD'],
            ['software adapter listed first is ignored', [gpu('Microsoft (software)'), gpu('AMD')], 'AMD'],
            ['VM adapter listed alongside a real Intel', [gpu('VMware'), gpu('Intel')], 'Intel'],
        ] as const)('%s -> %s', (_n, gpus, want) => {
            expect(gpuShareVendor(gpus as never, 'enabled')).toBe(want);
        });
        it('AMD id 0x1022 counts as AMD', () => {
            expect(gpuShareVendor([{ vendor: 'AMD', vendorId: 0x1022, active: false }], 'enabled')).toBe('AMD');
        });
        it('videoEncode "enabled_readback" and an unreadable status (null / undefined) do not block', () => {
            expect(gpuShareVendor([gpu('AMD')], 'enabled_readback')).toBe('AMD');
            expect(gpuShareVendor([gpu('AMD')], null)).toBe('AMD');
            expect(gpuShareVendor([gpu('AMD')])).toBe('AMD');
        });
    });

    describe('never shows', () => {
        it.each([
            ['no GPU info (null)', null],
            ['no GPU info (undefined)', undefined],
            ['empty list', []],
            ['unknown vendor id', [gpu('mystery')]],
            ['vendorId 0 / missing', [{ vendor: '?', vendorId: 0, active: true }, { vendor: 'AMD' }]],
            ['NVIDIA alone', [gpu('NVIDIA')]],
            ['NVIDIA alone, active', [gpu('NVIDIA', true)]],
            ['Apple GPU', [gpu('Apple')]],
            ['Qualcomm', [gpu('Qualcomm')]],
            ['Microsoft Basic Render / WARP (0x1414)', [gpu('Microsoft (software)')]],
            ['SwiftShader / Google (0x1ae0)', [gpu('Google')]],
            ['VMware (0x15ad)', [gpu('VMware')]],
            ['VirtualBox (0x80ee)', [gpu('VirtualBox')]],
            ['Parallels (0x1ab8)', [gpu('Parallels')]],
            ['Red Hat virtio (0x1af4)', [gpu('virtio')]],
            ['QEMU (0x1b36)', [gpu('qemu')]],
            ['software adapter even when "active"', [gpu('Microsoft (software)', true)]],
            ['a virtual adapter that LOOKS like Intel by name only', [{ vendor: 'Intel', vendorId: 0x15ad, active: true }]],
            ['a display string "Intel" on an unknown vendor id (identity is the id)', [{ vendor: 'Intel', vendorId: 0x9999, active: true }]],
            ['hybrid: NVIDIA ACTIVE next to Intel', [gpu('Intel'), gpu('NVIDIA', true)]],
            ['hybrid: NVIDIA ACTIVE next to AMD', [gpu('AMD'), gpu('NVIDIA', true)]],
            ['hybrid Intel + NVIDIA, cannot tell which is active', [gpu('Intel'), gpu('NVIDIA')]],
            ['hybrid NVIDIA + Intel, cannot tell which is active', [gpu('NVIDIA'), gpu('Intel')]],
            ['hybrid AMD + NVIDIA, cannot tell which is active', [gpu('AMD'), gpu('NVIDIA')]],
            ['VM adapter + NVIDIA, nothing active', [gpu('VMware'), gpu('NVIDIA')]],
        ] as const)('%s', (_n, gpus) => {
            expect(gpuShareVendor(gpus as never, 'enabled')).toBeNull();
        });

        it.each(['disabled_software', 'disabled_off', 'unavailable_off', 'unavailable_software', ''])(
            'GPU process has acceleration disabled (videoEncode=%j) on an otherwise perfect AMD/Intel', (status) => {
                expect(gpuShareVendor([gpu('AMD', true)], status)).toBeNull();
                expect(gpuShareVendor([gpu('Intel', true)], status)).toBeNull();
            });
    });
});

describe('shouldOfferGpuShareIntro (decision table: platform x vendor x seen x offered)', () => {
    const platforms = ['windows', 'mac', 'linux', undefined] as const;
    const vendors = ['AMD', 'Intel', null] as const;
    const cases: Array<[typeof platforms[number], typeof vendors[number], boolean, boolean, boolean]> = [];
    for (const p of platforms) for (const v of vendors) for (const seen of [false, true]) for (const off of [false, true]) {
        cases.push([p, v, seen, off, (p === 'windows' || p === 'mac') && v !== null && !seen && !off]);
    }
    it.each(cases)('platform=%s vendor=%s seen=%s offered=%s -> %s', (p, v, seen, off, want) => {
        expect(shouldOfferGpuShareIntro(p, v, seen, off)).toBe(want);
    });
});

describe('state machine and the device flag', () => {
    it('pending writes nothing; revealing writes ONLY the gpu key; once', () => {
        noteGpuScreenShareStarted('AMD', 'windows');
        expect(getLinuxShareIntroState()).toEqual({ backend: 'normal', shown: false, gpuVendor: 'AMD' });
        expect(h.writes).toEqual([]);
        revealLinuxShareIntro();
        revealLinuxShareIntro();
        expect(h.writes).toEqual([[GPU_SHARE_INTRO_KEY, '1']]);
        expect(hasSeenGpuShareIntro()).toBe(true);
        expect(hasSeenLinuxShareIntro()).toBe(false);
        expect(shareIntroVariant(getLinuxShareIntroState()!)).toBe('gpu');
    });

    it('the Linux flag does not count as seen; the gpu flag does', () => {
        h.kv.set(LINUX_SHARE_INTRO_KEY, '1');
        noteGpuScreenShareStarted('Intel', 'mac');
        expect(getLinuxShareIntroState()).not.toBeNull();
        dismissLinuxShareIntro();
        h.kv.set(GPU_SHARE_INTRO_KEY, '1');
        noteGpuScreenShareStarted('Intel', 'mac');
        expect(getLinuxShareIntroState()).toBeNull();
    });

    it('never pending on Linux or for a null vendor', () => {
        noteGpuScreenShareStarted('AMD', 'linux');
        noteGpuScreenShareStarted(null, 'windows');
        expect(getLinuxShareIntroState()).toBeNull();
    });

    it('does not replace a card already pending', () => {
        noteGpuScreenShareStarted('AMD', 'windows');
        noteGpuScreenShareStarted('Intel', 'windows');
        expect(getLinuxShareIntroState()?.gpuVendor).toBe('AMD');
    });

    it('Linux card unchanged: no variant key, Linux flag only', () => {
        noteScreenShareStarted('vaapi', 'linux');
        expect(getLinuxShareIntroState()).toEqual({ backend: 'vaapi', shown: false });
        expect(shareIntroVariant(getLinuxShareIntroState()!)).toBe('linux');
        revealLinuxShareIntro();
        expect(h.writes).toEqual([[LINUX_SHARE_INTRO_KEY, '1']]);
    });

    it('the Linux note still ignores Windows/macOS', () => {
        noteScreenShareStarted('normal', 'windows');
        noteScreenShareStarted('normal', 'mac');
        expect(getLinuxShareIntroState()).toBeNull();
    });
});

describe('useGpuShareIntroTrigger', () => {
    let root: Root;
    let host: HTMLDivElement;
    const Probe: React.FC<{ sharing: boolean }> = ({ sharing }) => { useGpuShareIntroTrigger(sharing); return null; };
    const render = (sharing: boolean) => act(() => { root.render(React.createElement(Probe, { sharing })); });
    const session = (gpus: MainShareDiagnostics['gpus'] | null, videoEncode: string | null = 'enabled'): ScreenShareSession => ({
        sourceId: 's1', requestedFps: 60, codecPref: 'auto', codec: 'vp8', codecReason: 'x', hw: null,
        main: gpus ? { platform: 'win32', windowsBuild: 1, sourceKind: 'screen', displayHz: 60, displayHzSource: 'shared',
            capturer: { backend: 'wgc', why: '' }, capturerPref: 'auto', gpus, videoEncode, h264CbpHwEnabled: false, captureLog: false } : null,
    });
    const setPlatform = (platform: string) => { (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform }; };

    beforeEach(() => {
        setPlatform('windows');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });

    it('share goes live on an AMD primary: pending with the vendor', () => {
        setScreenShareSession(session([gpu('AMD')]));
        render(false);
        expect(getLinuxShareIntroState()).toBeNull();
        render(true);
        expect(getLinuxShareIntroState()).toEqual({ backend: 'normal', shown: false, gpuVendor: 'AMD' });
    });

    it('macOS Intel: pending; Apple / hybrid-undecidable / NVIDIA-active / acceleration-off: nothing', () => {
        setPlatform('mac');
        for (const s of [
            session([gpu('Apple')]),
            session([gpu('NVIDIA'), gpu('Intel')]),
            session([gpu('Intel'), gpu('NVIDIA', true)]),
            session([gpu('Intel', true)], 'disabled_software'),
        ]) {
            setScreenShareSession(s);
            render(true);
            expect(getLinuxShareIntroState()).toBeNull();
            render(false);
        }
        setScreenShareSession(session([gpu('Intel')]));
        render(true);
        expect(getLinuxShareIntroState()?.gpuVendor).toBe('Intel');
    });

    it('unknown (no session, no main diagnostics, empty list) never shows', () => {
        render(true);
        expect(getLinuxShareIntroState()).toBeNull();
        render(false);
        setScreenShareSession(session(null));
        render(true);
        expect(getLinuxShareIntroState()).toBeNull();
        render(false);
        setScreenShareSession(session([]));
        render(true);
        expect(getLinuxShareIntroState()).toBeNull();
    });

    it('main answered after the share went live: picked up from the late session patch', () => {
        setScreenShareSession(session(null));
        render(true);
        expect(getLinuxShareIntroState()).toBeNull();
        act(() => { updateScreenShareSession('s1', { main: session([gpu('Intel')]).main }); });
        expect(getLinuxShareIntroState()?.gpuVendor).toBe('Intel');
    });

    it('a share that ended before main answered does not trigger from a late patch', () => {
        setScreenShareSession(session(null));
        render(true);
        render(false);
        act(() => { updateScreenShareSession('s1', { main: session([gpu('AMD')]).main }); });
        expect(getLinuxShareIntroState()).toBeNull();
    });

    it('never on Linux or without the bridge', () => {
        setScreenShareSession(session([gpu('AMD')]));
        setPlatform('linux');
        render(true);
        expect(getLinuxShareIntroState()).toBeNull();
        render(false);
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
        render(true);
        expect(getLinuxShareIntroState()).toBeNull();
    });
});
