import { describe, it, expect } from 'vitest';
import {
    cpuModelClass, ramBucket, normalizeGpuRenderer, gpuVendorName, audioApiFor, networkTypeOf, localeLang, buildProfile, wireToken,
} from './profile';
import { fallbackSystemInfo } from '../diagnostics/ipc';

describe('device profile reducers', () => {
    it('CPU model → family + generation class', () => {
        expect(cpuModelClass('Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz')).toBe('Intel Core i7-8xxx');
        expect(cpuModelClass('12th Gen Intel(R) Core(TM) i7-12700H')).toBe('12th Gen Intel Core i7-12xxx');
        expect(cpuModelClass('AMD Ryzen 7 5800X 8-Core Processor')).toBe('AMD Ryzen 7 5xxx');
        expect(cpuModelClass('AMD Ryzen 9 7940HS w/ Radeon 780M Graphics')).toBe('AMD Ryzen 9 7xxx');
        expect(cpuModelClass('Apple M2 Pro')).toBe('Apple M2 Pro');
        expect(cpuModelClass('Intel(R) Core(TM) Ultra 7 155H')).toBe('Intel Core Ultra 7 1xx');
        expect(cpuModelClass('')).toBe('unknown');
        expect(cpuModelClass(undefined)).toBe('unknown');
        expect(cpuModelClass('x'.repeat(200)).length).toBeLessThanOrEqual(64);
    });
    it('RAM → bucket', () => {
        expect([2, 3.8, 7.7, 8, 15.9, 16.6, 24, 31.2, 48, 63.9, 96, 128, 512].map(ramBucket))
            .toEqual([4, 4, 8, 8, 16, 16, 32, 32, 64, 64, 128, 128, 128]);
        expect(ramBucket(0)).toBe(4);
    });
    it('GPU renderer string is unwrapped from ANGLE and stripped of API noise', () => {
        expect(normalizeGpuRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('NVIDIA GeForce RTX 3070');
        expect(normalizeGpuRenderer('ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('Intel(R) UHD Graphics 630');
        expect(normalizeGpuRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')).toBe('Apple M2 Pro');
        expect(normalizeGpuRenderer('ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)')).toBe('Mesa Intel(R) UHD Graphics 630 (CFL GT2)');
        expect(normalizeGpuRenderer(undefined)).toBe('unknown');
    });
    it('vendor, audio API, network, locale', () => {
        expect(gpuVendorName('0x10de')).toBe('NVIDIA');
        expect(gpuVendorName('0x0', 'Mesa Intel(R) UHD Graphics')).toBe('Intel');
        expect(gpuVendorName(undefined, 'Google SwiftShader')).toBe('SwiftShader');
        expect(audioApiFor('win32')).toBe('wasapi');
        expect(audioApiFor('darwin')).toBe('coreaudio');
        expect(audioApiFor('linux')).toBe('unknown');
        expect(networkTypeOf({ type: 'wifi' })).toBe('wifi');
        expect(networkTypeOf({ type: 'bluetooth' })).toBe('unknown');
        expect(networkTypeOf(undefined)).toBe('unknown');
        expect(localeLang('de-AT')).toBe('de');
        expect(localeLang('')).toBe('xx');
    });
    it('buildProfile fills every contract field and flags a software GPU', () => {
        const sys = {
            ...fallbackSystemInfo('1.0.23'),
            platform: 'win32' as const, os_version: '10.0.22631', arch: 'x64', cpu_model: 'Intel(R) Core(TM) i5-9400F CPU @ 2.90GHz',
            cpu_cores: 6, ram_gb: 15.9, electron: '43.2.0', chrome: '150.0.7000.0', build_commit: 'abc1234',
            gpu: { devices: [{ vendor_id: '0x10de', device_id: '0x2484', active: true, driver_version: '32.0.15.6094' }], feature_status: { gpu_compositing: 'enabled' } },
            displays: [{ width: 2560, height: 1440, scale_factor: 1.25, refresh_hz: 144, primary: true }, { width: 1920, height: 1080, scale_factor: 1, refresh_hz: 60, primary: false }],
            hardware_acceleration: true,
        };
        const p = buildProfile(sys, {
            webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)',
            audioInputs: 2, audioOutputs: 3, webcams: 1, networkType: 'unknown', localeLang: 'en', devicePixelRatio: 1.25,
        });
        expect(p).toEqual({
            build_commit: 'abc1234', os_version: '10.0.22631', arch: 'x64', cpu_model_class: 'Intel Core i5-9xxx', cpu_cores: 6,
            ram_gb_bucket: 16, gpu_vendor: 'NVIDIA', gpu_renderer: 'NVIDIA GeForce RTX 3070', gpu_driver: '32.0.15.6094', gpu_accel: true,
            displays: 2, max_scale_factor: 1.25, audio_inputs: 2, audio_outputs: 3, audio_api: 'wasapi', webcam_count: 1,
            network_type: 'unknown', locale_lang: 'en', electron: '43.2.0', chrome: '150.0.7000.0',
        });
        expect(buildProfile({ ...sys, gpu: { ...sys.gpu, feature_status: { gpu_compositing: 'disabled_software' } } }, { audioInputs: 0, audioOutputs: 0, webcams: 0, networkType: 'unknown', localeLang: 'en', devicePixelRatio: 1 }).gpu_accel).toBe(false);
        expect(buildProfile(sys, { webglRenderer: 'Google SwiftShader', audioInputs: 0, audioOutputs: 0, webcams: 0, networkType: 'unknown', localeLang: 'en', devicePixelRatio: 1 }).gpu_accel).toBe(false);
        expect(buildProfile({ ...sys, hardware_acceleration: false }, { audioInputs: 0, audioOutputs: 0, webcams: 0, networkType: 'unknown', localeLang: 'en', devicePixelRatio: 1 }).gpu_accel).toBe(false);
    });
});

describe('wire tokens (what the API accepts; a refused profile is dropped silently)', () => {
    const probe = { audioInputs: 0, audioOutputs: 0, webcams: 0, networkType: 'unknown' as const, localeLang: 'en', devicePixelRatio: 1 };
    const sys = { ...fallbackSystemInfo('1.0.23'), platform: 'linux' as const };

    it('wireToken keeps the strict alphabet and never returns an empty string', () => {
        expect(wireToken('6.1.0+rpt-rpi-v8', 64, true)).toBe('6.1.0.rpt-rpi-v8');
        expect(wireToken('10.0.26200', 64, true)).toBe('10.0.26200');
        expect(wireToken('5.15 (WSL2)', 64, true)).toBe('5.15.(WSL2)');
        expect(wireToken('x86 64', 16)).toBe('x86.64');
        expect(wireToken('552.22 (beta)', 40)).toBe('552.22.beta');
        expect(wireToken('', 8)).toBe('unknown');
        expect(wireToken(undefined, 8)).toBe('unknown');
        expect(wireToken('!!!', 8)).toBe('unknown');
        expect(wireToken('a'.repeat(100), 16)).toHaveLength(16);
    });
    it('build_commit: a hex sha, with or without -dirty, else unknown', () => {
        const commit = (c: string) => buildProfile({ ...sys, build_commit: c }, probe).build_commit;
        expect(commit('9fd5304b')).toBe('9fd5304b');
        expect(commit('9fd5304b-dirty')).toBe('9fd5304b-dirty');
        expect(commit('unknown')).toBe('unknown');
        expect(commit('v1.0.22')).toBe('unknown');
        expect(commit('9fd5304b-dirty-x')).toBe('unknown');
        expect(commit('')).toBe('unknown');
    });
    it('electron / chrome: a version string, else unknown', () => {
        const p = buildProfile({ ...sys, electron: '43.0.0-beta.1', chrome: '150.0.7339.133' }, probe);
        expect([p.electron, p.chrome]).toEqual(['43.0.0-beta.1', '150.0.7339.133']);
        const q = buildProfile({ ...sys, electron: 'unknown', chrome: 'weird build' }, probe);
        expect([q.electron, q.chrome]).toEqual(['unknown', 'unknown']);
    });
    it('os_version, arch and gpu_driver are reduced to the API alphabet', () => {
        const p = buildProfile({
            ...sys, os_version: '6.1.0+rpt-rpi-v8', arch: 'arm 64',
            gpu: { devices: [{ vendor_id: '0x10de', device_id: '0x1', active: true, driver_version: '552.22+x' }], feature_status: {} },
        }, probe);
        expect(p.os_version).toBe('6.1.0.rpt-rpi-v8');
        expect(p.arch).toBe('arm.64');
        expect(p.gpu_driver).toBe('552.22.x');
    });
    it('a GPU renderer with nothing readable left is unknown, not punctuation', () => {
        expect(normalizeGpuRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('unknown');
    });
});
