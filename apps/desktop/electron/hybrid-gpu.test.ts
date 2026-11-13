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
        markerExists: vi.fn(() => false), writeMarker: vi.fn(), reg: vi.fn(async (a: string[]) => (a[0] === 'add' ? 0 : 1)), ...over,
    });

    it('no value yet: writes the high-performance preference for this executable, then the marker', async () => {
        const d = deps();
        await expect(ensureHighPerformancePreference(d)).resolves.toBe('set');
        expect(d.reg).toHaveBeenCalledTimes(2);
        expect(d.reg).toHaveBeenNthCalledWith(1, ['query', USER_GPU_PREFERENCES_KEY, '/v', EXE]);
        expect(d.reg).toHaveBeenNthCalledWith(2, ['add', USER_GPU_PREFERENCES_KEY, '/v', EXE, '/t', 'REG_SZ', '/d', HIGH_PERFORMANCE_GPU_VALUE, '/f']);
        expect(HIGH_PERFORMANCE_GPU_VALUE).toBe('GpuPreference=2;');
        expect(d.writeMarker).toHaveBeenCalledTimes(1);
    });

    it('a choice already made in Windows Settings is never overwritten', async () => {
        const d = deps({ reg: vi.fn(async () => 0) });
        await expect(ensureHighPerformancePreference(d)).resolves.toBe('kept-existing');
        expect(d.reg).toHaveBeenCalledTimes(1);
        expect(d.writeMarker).toHaveBeenCalledTimes(1);
    });

    it('once only: with the marker there, the registry is not touched (a removed value stays removed)', async () => {
        const d = deps({ markerExists: vi.fn(() => true) });
        await expect(ensureHighPerformancePreference(d)).resolves.toBe('already-done');
        expect(d.reg).not.toHaveBeenCalled();
    });

    it('a failed write leaves no marker, so the next launch tries again; a throw never escapes', async () => {
        const failed = deps({ reg: vi.fn(async (a: string[]) => (a[0] === 'add' ? 5 : 1)) });
        await expect(ensureHighPerformancePreference(failed)).resolves.toBe('failed');
        expect(failed.writeMarker).not.toHaveBeenCalled();
        const threw = deps({ reg: vi.fn(async () => { throw new Error('spawn failed'); }) });
        await expect(ensureHighPerformancePreference(threw)).resolves.toBe('failed');
    });

    it('does nothing with the setting off, off Windows, or on a machine with nothing to choose', async () => {
        for (const over of [{ enabled: false }, { platform: 'linux' }, { topology: SINGLE }, { topology: null }]) {
            const d = deps(over);
            await expect(ensureHighPerformancePreference(d)).resolves.toBe('skipped');
            expect(d.reg).not.toHaveBeenCalled();
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

    it('the preference uses this launch\'s layout, reg.exe by full path, and no shell', () => {
        expect(MAIN).toContain('ensureHighPerformancePreference({');
        expect(MAIN).toMatch(/process\.env\.SystemRoot[^\n]*'System32', 'reg\.exe'/);
        const at = MAIN.indexOf('ensureHighPerformancePreference({');
        expect(MAIN.slice(at, at + 900)).not.toMatch(/shell:\s*true/);
    });

    it('a report can show whether it worked: outcome and the GPU really in use', () => {
        expect(MAIN).toContain("freezeMonitor.event('gpu:preference'");
        expect(MAIN).toContain('activeGpuVendor(');
    });
});
