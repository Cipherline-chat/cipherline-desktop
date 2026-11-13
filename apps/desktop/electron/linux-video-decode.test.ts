import { describe, it, expect } from 'vitest';
import {
    decideLinuxHwDecode, parseLinuxHwDecodeMode, probeLinuxGpus, readLinuxGpus, nvidiaVaapiPackage, parseOsRelease,
    parseLinuxHwDecodeLedger, recordLinuxHwDecodeFailure, isLinuxHwDecodeLockedOut, LinuxHwDecodeFailureGate,
    LINUX_HW_DECODE_LOCKOUT_LAUNCHES, LINUX_HW_DECODE_LEDGER_WINDOW_MS,
    type LinuxGpuProbe, type ProbeFs, type LinuxHwDecodeInput,
} from './linux-video-decode';

const probe = (over: Partial<LinuxGpuProbe> = {}): LinuxGpuProbe => ({
    gpus: [{ vendor: 'nvidia', driver: 'nvidia' }], nvidiaVaapiDriver: true, nvidiaDrmModeset: true, distro: { id: 'cachyos', like: ['arch'] }, ...over,
});
const input = (over: Partial<LinuxHwDecodeInput> = {}): LinuxHwDecodeInput => ({
    platform: 'linux', mode: 'auto', setting: true, hasSwitch: () => false, probe: probe(), env: {}, appVersion: '1.0.24', now: 1_000_000, ...over,
});

describe('decideLinuxHwDecode', () => {
    it('NVIDIA-only with the driver and modeset: VaapiOnNvidiaGPUs + libva env', () => {
        const d = decideLinuxHwDecode(input());
        expect(d.enable).toBe(true);
        expect(d.enableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL', 'VaapiOnNvidiaGPUs', 'VaapiIgnoreDriverChecks']);
        expect(d.env).toEqual({ LIBVA_DRIVER_NAME: 'nvidia', NVD_BACKEND: 'direct' });
        expect(d.nvidia).toBe('ready');
        expect(d.hint).toBeUndefined();
    });
    it('NVIDIA without nvidia-vaapi-driver: no NVIDIA flags and a hint naming the Arch package', () => {
        const d = decideLinuxHwDecode(input({ probe: probe({ nvidiaVaapiDriver: false }) }));
        expect(d.enableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL']);
        expect(d.env).toEqual({});
        expect(d.nvidia).toBe('missing_driver');
        expect(d.hint?.pkg).toBe('libva-nvidia-driver');
        expect(d.hint?.text).toContain('libva-nvidia-driver');
    });
    it('NVIDIA with modeset off: hint, no flags', () => {
        const d = decideLinuxHwDecode(input({ probe: probe({ nvidiaDrmModeset: false }) }));
        expect(d.nvidia).toBe('no_modeset');
        expect(d.enableFeatures).not.toContain('VaapiOnNvidiaGPUs');
        expect(d.hint?.kind).toBe('enable_modeset');
    });
    it('keeps a LIBVA_DRIVER_NAME / NVD_BACKEND the user already set', () => {
        const d = decideLinuxHwDecode(input({ env: { LIBVA_DRIVER_NAME: 'nvidia', NVD_BACKEND: 'egl' } }));
        expect(d.env).toEqual({});
        expect(d.enableFeatures).toContain('VaapiOnNvidiaGPUs');
    });
    it('Intel / AMD: only the (default-on) decode feature, no NVIDIA flags, no env', () => {
        for (const vendor of ['intel', 'amd'] as const) {
            const d = decideLinuxHwDecode(input({ probe: probe({ gpus: [{ vendor, driver: 'x' }] }) }));
            expect(d.enableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL']);
            expect(d.env).toEqual({});
            expect(d.nvidia).toBe('not_applicable');
        }
    });
    it('hybrid iGPU + NVIDIA dGPU: left on the iGPU (LIBVA_DRIVER_NAME=nvidia would break its decoder)', () => {
        const d = decideLinuxHwDecode(input({ probe: probe({ gpus: [{ vendor: 'intel', driver: 'i915' }, { vendor: 'nvidia', driver: 'nvidia' }] }) }));
        expect(d.nvidia).toBe('hybrid');
        expect(d.env).toEqual({});
        expect(d.enableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL']);
    });
    it('nouveau gets no NVIDIA flags', () => {
        const d = decideLinuxHwDecode(input({ probe: probe({ gpus: [{ vendor: 'nvidia', driver: 'nouveau' }] }) }));
        expect(d.nvidia).toBe('nouveau');
        expect(d.enableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL']);
    });
    it('not Linux: nothing at all', () => {
        for (const platform of ['win32', 'darwin']) {
            const d = decideLinuxHwDecode(input({ platform }));
            expect(d).toMatchObject({ enable: false, enableFeatures: [], disableFeatures: [], switches: [], env: {} });
        }
    });
    it('Settings off and env off really DISABLE the Chromium feature', () => {
        expect(decideLinuxHwDecode(input({ setting: false })).disableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL']);
        const e = decideLinuxHwDecode(input({ mode: 'off' }));
        expect(e.enable).toBe(false);
        expect(e.disableFeatures).toEqual(['AcceleratedVideoDecodeLinuxGL']);
        expect(e.env).toEqual({});
    });
    it('--disable-gpu / --disable-accelerated-video-decode block it', () => {
        for (const sw of ['disable-gpu', 'disable-accelerated-video-decode']) {
            const d = decideLinuxHwDecode(input({ hasSwitch: n => n === sw }));
            expect(d.enable).toBe(false);
            expect(d.reason).toContain(sw);
        }
    });
    it('env =1 forces NVIDIA on without the driver/modeset checks; =gl adds the ANGLE GL switches', () => {
        const noDriver = probe({ nvidiaVaapiDriver: false, nvidiaDrmModeset: null });
        const on = decideLinuxHwDecode(input({ mode: 'on', probe: noDriver, setting: false }));
        expect(on.enableFeatures).toContain('VaapiOnNvidiaGPUs');
        expect(on.nvidia).toBe('forced');
        expect(on.switches).toEqual([]);
        const gl = decideLinuxHwDecode(input({ mode: 'gl', probe: noDriver }));
        expect(gl.switches).toEqual([['use-gl', 'angle'], ['use-angle', 'gl']]);
    });
    it('GPU-crash ledger: locked out after 2 launches on this version, retried on a new one; env=1 bypasses', () => {
        const now = 1_000_000;
        let l = parseLinuxHwDecodeLedger('');
        l = recordLinuxHwDecodeFailure(l, { at: now - 2000, version: '1.0.24', kind: 'gpu_crash' });
        expect(decideLinuxHwDecode(input({ ledger: l })).enable).toBe(true);
        l = recordLinuxHwDecodeFailure(l, { at: now - 1000, version: '1.0.24', kind: 'gpu_crash' });
        expect(LINUX_HW_DECODE_LOCKOUT_LAUNCHES).toBe(2);
        const locked = decideLinuxHwDecode(input({ ledger: l }));
        expect(locked).toMatchObject({ enable: false, lockedOut: true, disableFeatures: ['AcceleratedVideoDecodeLinuxGL'] });
        expect(decideLinuxHwDecode(input({ ledger: l, appVersion: '1.0.25' })).enable).toBe(true);
        expect(decideLinuxHwDecode(input({ ledger: l, mode: 'on' })).enable).toBe(true);
        expect(isLinuxHwDecodeLockedOut(l, '1.0.24', now + LINUX_HW_DECODE_LEDGER_WINDOW_MS)).toBe(false);
    });
});

describe('probe', () => {
    const files: Record<string, string> = {
        '/sys/class/drm/card0/device/vendor': '0x10de\n',
        '/sys/module/nvidia_drm/parameters/modeset': 'Y\n',
        '/etc/os-release': 'NAME="CachyOS Linux"\nID=cachyos\nID_LIKE="arch"\n',
        '/usr/lib/dri/nvidia_drv_video.so': '',
    };
    const fake: ProbeFs = {
        readdir: p => (p === '/sys/class/drm' ? ['card0', 'card0-DP-1', 'renderD128', 'version'] : []),
        readFile: p => (p in files ? files[p] : null),
        readlink: p => (p === '/sys/class/drm/card0/device/driver' ? '../../../bus/pci/drivers/nvidia' : null),
        exists: p => p in files,
    };
    it('reads vendor, kernel driver, VA driver file, modeset and distro; ignores connector entries', () => {
        expect(readLinuxGpus(fake)).toEqual([{ vendor: 'nvidia', driver: 'nvidia' }]);
        expect(probeLinuxGpus({}, fake)).toEqual({
            gpus: [{ vendor: 'nvidia', driver: 'nvidia' }], nvidiaVaapiDriver: true, nvidiaDrmModeset: true, distro: { id: 'cachyos', like: ['arch'] },
        });
    });
    it('honours LIBVA_DRIVERS_PATH', () => {
        const only: ProbeFs = { ...fake, exists: p => p === '/opt/va/nvidia_drv_video.so' };
        expect(probeLinuxGpus({}, only).nvidiaVaapiDriver).toBe(false);
        expect(probeLinuxGpus({ LIBVA_DRIVERS_PATH: '/opt/va' }, only).nvidiaVaapiDriver).toBe(true);
    });
});

describe('helpers', () => {
    it('mode parsing', () => {
        expect(parseLinuxHwDecodeMode('0')).toBe('off');
        expect(parseLinuxHwDecodeMode('GL')).toBe('gl');
        expect(parseLinuxHwDecodeMode('1')).toBe('on');
        expect(parseLinuxHwDecodeMode(undefined)).toBe('auto');
        expect(parseLinuxHwDecodeMode('banana')).toBe('auto');
    });
    it('package name by distro family', () => {
        expect(nvidiaVaapiPackage(parseOsRelease('ID=endeavouros\nID_LIKE=arch')).pkg).toBe('libva-nvidia-driver');
        expect(nvidiaVaapiPackage(parseOsRelease('ID=ubuntu\nID_LIKE=debian')).install).toContain('apt');
        expect(nvidiaVaapiPackage(parseOsRelease('ID=fedora')).install).toContain('dnf');
        expect(nvidiaVaapiPackage(parseOsRelease('ID=void')).pkg).toBe('nvidia-vaapi-driver');
    });
    it('the failure gate accepts one per launch and none while inactive', () => {
        const g = new LinuxHwDecodeFailureGate();
        expect(g.accept(false)).toBe(false);
        expect(g.accept(true)).toBe(true);
        expect(g.accept(true)).toBe(false);
    });
    it('ledger parsing drops garbage', () => {
        expect(parseLinuxHwDecodeLedger('{"entries":[{"at":1,"version":"x","kind":"nope"},{"at":5,"version":"v","kind":"gpu_crash"}]}').entries).toHaveLength(1);
        expect(parseLinuxHwDecodeLedger('not json').entries).toEqual([]);
    });
});
