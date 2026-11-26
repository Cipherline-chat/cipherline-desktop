import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    HIGH_PERFORMANCE_GPU_SWITCH, HIGH_PERFORMANCE_GPU_VALUE, USER_GPU_PREFERENCES_KEY,
    activeGpuVendor, ensureHighPerformancePreference, highPerformanceGpuSwitches, isHybridGpu,
    type GpuPreferenceDeps,
} from './hybrid-gpu';

const LAPTOP = { hybrid: false, vendors: ['Intel', 'NVIDIA', '0x1414'] };
const FLAGGED = { hybrid: true, vendors: ['AMD', 'NVIDIA'] };
const DESKTOP_TWO_CARDS = { hybrid: false, vendors: ['NVIDIA', 'AMD', '0x1414'] };
const SINGLE = { hybrid: false, vendors: ['NVIDIA'] };
const EXE = 'C:\\Users\\x\\AppData\\Local\\Programs\\Cipherline\\Cipherline.exe';

describe('isHybridGpu', () => {
    it('Intel beside a discrete GPU, or Chromium\'s own flag', () => {
        expect(isHybridGpu(LAPTOP)).toBe(true);
        expect(isHybridGpu(FLAGGED)).toBe(true);
        expect(isHybridGpu({ hybrid: false, vendors: ['Intel', 'AMD'] })).toBe(true);
    });

    it('not one GPU, not an unflagged pair of cards (the owner\'s desktop), not an unknown layout', () => {
        expect(isHybridGpu(SINGLE)).toBe(false);
        expect(isHybridGpu(DESKTOP_TWO_CARDS)).toBe(false);
        expect(isHybridGpu({ hybrid: false, vendors: ['Intel'] })).toBe(false);
        expect(isHybridGpu(null)).toBe(false);
    });
});

describe('highPerformanceGpuSwitches', () => {
    it('only on Windows, only with the setting on, only on a hybrid machine', () => {
        expect(highPerformanceGpuSwitches(true, 'win32', LAPTOP)).toEqual([HIGH_PERFORMANCE_GPU_SWITCH]);
        expect(highPerformanceGpuSwitches(false, 'win32', LAPTOP)).toEqual([]);
        expect(highPerformanceGpuSwitches(true, 'darwin', LAPTOP)).toEqual([]);
        expect(highPerformanceGpuSwitches(true, 'win32', SINGLE)).toEqual([]);
        expect(highPerformanceGpuSwitches(true, 'win32', null)).toEqual([]);
    });
});

describe('ensureHighPerformancePreference', () => {
    const deps = (over: Partial<GpuPreferenceDeps> = {}) => ({
        platform: 'win32', enabled: true, topology: LAPTOP, exePath: EXE,
        markerExists: vi.fn(() => false), writeMarker: vi.fn(), preferenceExists: vi.fn(async () => false as boolean | null), setHighPerformance: vi.fn(async () => true), ...over,
    });

    it('no value yet: writes the high-performance preference for this executable, then the marker', async () => {
        const d = deps();
        await expect(ensureHighPerformancePreference(d)).resolves.toBe('set');
        expect(d.preferenceExists).toHaveBeenCalledWith(EXE);
        expect(d.setHighPerformance).toHaveBeenCalledWith(EXE);
        expect(USER_GPU_PREFERENCES_KEY).toBe('HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences');
        expect(HIGH_PERFORMANCE_GPU_VALUE).toBe('GpuPreference=2;');
        expect(d.writeMarker).toHaveBeenCalledTimes(1);
    });

    it('a choice already made in Windows Settings is never overwritten', async () => {
        const d = deps({ preferenceExists: vi.fn(async () => true) });
        await expect(ensureHighPerformancePreference(d)).resolves.toBe('kept-existing');
        expect(d.setHighPerformance).not.toHaveBeenCalled();
        expect(d.writeMarker).toHaveBeenCalledTimes(1);
    });

    it('once only: with the marker there, the registry is not touched (a removed value stays removed)', async () => {
        const d = deps({ markerExists: vi.fn(() => true) });
        await expect(ensureHighPerformancePreference(d)).resolves.toBe('already-done');
        expect(d.preferenceExists).not.toHaveBeenCalled();
        expect(d.setHighPerformance).not.toHaveBeenCalled();
    });

    it('a failed write leaves no marker, so the next launch tries again; a throw never escapes', async () => {
        const failed = deps({ setHighPerformance: vi.fn(async () => false) });
        await expect(ensureHighPerformancePreference(failed)).resolves.toBe('failed');
        expect(failed.writeMarker).not.toHaveBeenCalled();
        // No helper (could not even ask): also a failure with no marker.
        const blind = deps({ preferenceExists: vi.fn(async () => null) });
        await expect(ensureHighPerformancePreference(blind)).resolves.toBe('failed');
        expect(blind.writeMarker).not.toHaveBeenCalled();
        const threw = deps({ preferenceExists: vi.fn(async () => { throw new Error('helper died'); }) });
        await expect(ensureHighPerformancePreference(threw)).resolves.toBe('failed');
    });

    it('does nothing with the setting off, off Windows, or on a machine with nothing to choose', async () => {
        for (const over of [{ enabled: false }, { platform: 'linux' }, { topology: SINGLE }, { topology: null }]) {
            const d = deps(over);
            await expect(ensureHighPerformancePreference(d)).resolves.toBe('skipped');
            expect(d.preferenceExists).not.toHaveBeenCalled();
            expect(d.writeMarker).not.toHaveBeenCalled();
        }
    });
});

describe('activeGpuVendor', () => {
    it('reads the vendor word out of the renderer string and nothing else', () => {
        const info = (glRenderer: unknown) => ({ auxAttributes: { glRenderer } });
        expect(activeGpuVendor(info('ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)'))).toBe('nvidia');
        expect(activeGpuVendor(info('ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'))).toBe('intel');
        expect(activeGpuVendor(info('ANGLE (AMD, AMD Radeon 780M Direct3D11, D3D11)'))).toBe('amd');
        expect(activeGpuVendor(info('Something Else'))).toBe('other');
        expect(activeGpuVendor(info(undefined))).toBe('unknown');
        expect(activeGpuVendor(null)).toBe('unknown');
    });
});

describe('wiring in main.ts', () => {
    const MAIN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

    it('the switch comes from the previous launch\'s layout and the gaming setting', () => {
        expect(MAIN).toContain('highPerformanceGpuSwitches(GAMING_VIDEO_AT_LAUNCH, process.platform, GPU_TOPOLOGY_AT_START)');
    });

    it('the preference uses this launch\'s layout and the helper, never reg.exe or a shell', () => {
        expect(MAIN).toContain('ensureHighPerformancePreference({');
        const at = MAIN.indexOf('ensureHighPerformancePreference({');
        const block = MAIN.slice(at, at + 900);
        expect(block).toContain('winSys().gpuPreferenceExists');
        expect(block).toContain('winSys().setHighPerformanceGpu');
        expect(block).not.toMatch(/reg\.exe|execFile|shell:\s*true/);
    });

    it('a report can show whether it worked: outcome and the GPU really in use', () => {
        expect(MAIN).toContain("freezeMonitor.event('gpu:preference'");
        expect(MAIN).toContain('activeGpuVendor(');
    });
});
