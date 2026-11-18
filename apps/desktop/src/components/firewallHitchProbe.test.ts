import { describe, expect, it } from 'vitest';
import { describeSystem, glClass, heapHint, hitchCadence, hitchProbeEnabled, loafPhases, probeRows } from './firewallHitchProbe';
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

describe('hitchCadence', () => {
    it('reads the 2026-11-12 report as a steady ~3.1 s clock', () => {
        // The six hitches' times (ms), rebuilt from their pillar offsets with the game's rules.
        const c = hitchCadence([1428, 4507, 7580, 10670, 13756, 16838]);
        expect(c).not.toBeNull();
        expect(c!.gaps).toBe(5);
        expect(c!.medianMs).toBeGreaterThan(3070);
        expect(c!.medianMs).toBeLessThan(3095);
        expect(c!.steady).toBe(true);
    });
    it('calls scattered hitches irregular', () => {
        expect(hitchCadence([0, 900, 3100, 3500, 7000])!.steady).toBe(false);
    });
    it('needs three hitches', () => {
        expect(hitchCadence([])).toBeNull();
        expect(hitchCadence([0, 3000])).toBeNull();
    });
});

describe('glClass', () => {
    it('reduces a renderer string to a vendor word', () => {
        expect(glClass('ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti (0x00001E07) Direct3D11 vs_5_0 ps_5_0, D3D11) (powerPreference high-performance)')).toBe('nvidia');
        expect(glClass('ANGLE (AMD, AMD Radeon RX 6600 Direct3D11)')).toBe('amd');
        expect(glClass('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe('swiftshader');
        expect(glClass('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)')).toBe('warp');
        expect(glClass('')).toBe('unknown');
    });
});

describe('probeRows', () => {
    const LABEL = /^[a-z][a-z0-9_.:-]{0,63}$/i; // freezeLog's LABEL_RE: main drops a row with any other label
    const hitch = (gap: number, pillar: number) => ({ gap, pillar, score: pillar - 1, loafs: [{ dur: 70.4, scripts: 0, phases: { tasks: 4, raf: 0.6, render: 65.8 } }] });
    it('writes a summary row and one row per hitch, every label log-safe', () => {
        const at = [1428, 4507, 7580, 10670];
        const rows = probeRows([hitch(61, 1), hitch(61, 3), hitch(73, 4), hitch(73, 6)], at,
            { r: { frames: 900, ms: 6000, fps: 149.8, busyAvgMs: 0.4, maxGapMs: 73.2 }, gl: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti)' }, 165, 4);
        expect(rows).toHaveLength(5);
        for (const r of rows) {
            expect(r.activity.length).toBeLessThanOrEqual(300);
            for (const l of r.activity.split(', ')) expect(l).toMatch(LABEL);
        }
        expect(rows[0].activity).toContain('firewall:probe');
        expect(rows[0].activity).toContain('fw:gl:nvidia');
        expect(rows[0].activity).toContain('fw:split:render');
        expect(rows[0].activity).toMatch(/fw:cadence:30\d\d/);
        expect(rows[0].ms).toBe(73);
        expect(rows[3].activity).toBe('firewall:hitch, fw:p:4, fw:score:3, fw:loaf:70, fw:scripts:0, fw:tasks:4, fw:raf:1, fw:render:66');
    });
    it('caps the per-hitch rows', () => {
        const many = Array.from({ length: 40 }, (_, i) => hitch(40, i + 1));
        expect(probeRows(many, many.map((_, i) => i * 3000), null, 60, 0)).toHaveLength(13);
    });
    it('a run with no hitches is one summary row', () => {
        const rows = probeRows([], [], null, 60, 0);
        expect(rows).toHaveLength(1);
        expect(rows[0].activity).toContain('fw:cadence:none');
        for (const l of rows[0].activity.split(', ')) expect(l).toMatch(LABEL);
    });
});
