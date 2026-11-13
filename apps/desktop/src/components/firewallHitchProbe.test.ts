import { describe, expect, it } from 'vitest';
import { describeSystem, heapHint, hitchProbeEnabled, loafPhases } from './firewallHitchProbe';
import type { SystemInfo } from '../utils/diagnostics/reportTypes';

// The probe must reach testers on
// staging builds and never appear in a stable one.
describe('hitchProbeEnabled', () => {
    it('is on in a dev build whatever the version says', () => {
        expect(hitchProbeEnabled('1.0.23', true)).toBe(true);
    });
    it('is on in a staging build', () => {
        expect(hitchProbeEnabled('1.0.24-staging.209', false)).toBe(true);
        expect(hitchProbeEnabled('1.0.24-staging', false)).toBe(true);
    });
    it('is off in a stable build', () => {
        expect(hitchProbeEnabled('1.0.23', false)).toBe(false);
        expect(hitchProbeEnabled('0.1.0', false)).toBe(false);
    });
    it('is off for anything that only looks like staging, or no version at all', () => {
        expect(hitchProbeEnabled('1.0.24-stagingx.1', false)).toBe(false);
        expect(hitchProbeEnabled('staging-1.0.24', false)).toBe(false);
        expect(hitchProbeEnabled('1.0.24-beta.3', false)).toBe(false);
        expect(hitchProbeEnabled('', false)).toBe(false);
    });
});

describe('loafPhases', () => {
    it('splits a frame at renderStart and styleAndLayoutStart', () => {
        expect(loafPhases(100, 130, 140, 70)).toEqual({ tasks: 30, raf: 10, render: 30 });
    });
    it('puts everything after renderStart in render when there is no style mark', () => {
        expect(loafPhases(100, 110, undefined, 70)).toEqual({ tasks: 10, raf: 0, render: 60 });
    });
    it('is null without marks', () => {
        expect(loafPhases(100, undefined, undefined, 70)).toBeNull();
        expect(loafPhases(100, 0, 0, 70)).toBeNull();
    });
});

describe('heapHint', () => {
    const mb = 1048576;
    it('reports growth without a GC note', () => {
        expect(heapHint([{ at: 1, used: 10 * mb }, { at: 2, used: 11 * mb }], 0, 3)).toBe('+1.0MB');
    });
    it('flags a drop as a collection', () => {
        expect(heapHint([{ at: 1, used: 20 * mb }, { at: 2, used: 12 * mb }], 0, 3)).toContain('GC ran');
    });
    it('is n/a with too few samples', () => {
        expect(heapHint([{ at: 1, used: mb }], 0, 3)).toBe('n/a');
    });
});

describe('describeSystem', () => {
    it('lists GPUs with the active one starred, features and displays', () => {
        const sys = {
            gpu: { devices: [{ vendor_id: '0x10de', device_id: '0x1e07', active: true }, { vendor_id: '0x1002', device_id: '0x6995', active: false }], feature_status: { gpu_compositing: 'enabled' } },
            hardware_acceleration: true,
            displays: [{ width: 2560, height: 1440, scale_factor: 1, refresh_hz: 120, primary: true }],
        } as unknown as SystemInfo;
        const out = describeSystem(sys).join('\n');
        expect(out).toContain('0x10de:0x1e07*');
        expect(out).toContain('0x1002:0x6995,'.replace(',', '') );
        expect(out).toContain('gpu_compositing=enabled');
        expect(out).toContain('2560x1440@120p');
    });
});
