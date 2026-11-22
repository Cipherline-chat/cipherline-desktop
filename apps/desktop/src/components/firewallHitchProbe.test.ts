import { describe, expect, it } from 'vitest';
import { BLOCKED_MS, describeSystem, displayTopology, glClass, heapHint, hitchBlock, hitchCadence, hitchProbeEnabled, loafPhases, probeRows } from './firewallHitchProbe';
import type { SystemInfo } from '../utils/diagnostics/reportTypes';

// hitchProbeEnabled picks the FULL probe (dev + staging); every other build runs the light one
// (the overlay always starts a probe, see FirewallOverlay.probe.test.ts).
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
        expect(rows[3].activity).toBe('firewall:hitch, fw:p:4, fw:score:3, fw:loaf:70, fw:scripts:0, fw:tasks:4, fw:raf:1, fw:render:66, fw:block:0');
        expect(rows[0].activity).toContain('fw:main-blocked:0');
    });
    it('caps the per-hitch rows', () => {
        const many = Array.from({ length: 40 }, (_, i) => hitch(40, i + 1));
        expect(probeRows(many, many.map((_, i) => i * 3000), null, 60, 0)).toHaveLength(13);
    });
    it('adds the display topology, log-safe, and says whether the refresh rates are mixed', () => {
        const topo = displayTopology([
            { displayFrequency: 165, isPrimary: true, hostsWindow: true },
            { displayFrequency: 180, isPrimary: false },
            { displayFrequency: 143.98, isPrimary: false },
        ]);
        expect(topo).toEqual({ hz: [165, 180, 144], onHz: 165 });
        const row = probeRows([hitch(61, 1)], [1000], null, 165, 1, topo, false)[0].activity;
        expect(row).toContain('fw:disp:3');
        expect(row).toContain('fw:disp-hz:165-180-144');
        expect(row).toContain('fw:mixed-hz:1');
        expect(row).toContain('fw:on-hz:165');
        expect(row).toContain('fw:build:light');
        expect(row.length).toBeLessThanOrEqual(300);
        for (const l of row.split(', ')) expect(l).toMatch(LABEL);
    });
    it('one rate across monitors is not mixed; no window display means no on-hz', () => {
        const topo = displayTopology([{ displayFrequency: 60, isPrimary: true }, { displayFrequency: 60, isPrimary: false }]);
        const row = probeRows([], [], null, 60, 0, topo)[0].activity;
        expect(row).toContain('fw:mixed-hz:0');
        expect(row).not.toContain('fw:on-hz');
        expect(row).toContain('fw:build:full');
    });
    it('displayTopology is null for an empty or bad list (positive control: a real list is not)', () => {
        expect(displayTopology([])).toBeNull();
        expect(displayTopology(undefined as never)).toBeNull();
        expect(displayTopology([{ displayFrequency: 60 }])).not.toBeNull();
    });
    it('a run with no hitches is one summary row', () => {
        const rows = probeRows([], [], null, 60, 0);
        expect(rows).toHaveLength(1);
        expect(rows[0].activity).toContain('fw:cadence:none');
        for (const l of rows[0].activity.split(', ')) expect(l).toMatch(LABEL);
    });
});

// A no-script "tasks" long frame is NOT evidence of main-thread work: LoAF counts the time the
// main thread spent WAITING for its frame too (measured 2026-11-22: 115 of 116 such frames in the
// real renderer had blockingDuration 0). The rows carry the blocking time so a report can tell.
describe('probeRows: blocked vs waiting', () => {
    const LABEL = /^[a-z][a-z0-9_.:-]{0,63}$/i;
    const waiting = { gap: 61, pillar: 1, score: 0, js: 0.4, loafs: [{ dur: 70, scripts: 0, block: 0, phases: { tasks: 68, raf: 0, render: 2 } }] };
    const blocked = { gap: 73, pillar: 2, score: 1, js: 0.5, loafs: [{ dur: 80, scripts: 0, block: 30, phases: { tasks: 78, raf: 0, render: 2 } }] };
    it('counts only frames really held by a long task as blocked, and says so per hitch', () => {
        const rows = probeRows([waiting, blocked, waiting], [0, 3080, 6160], null, 165, 3, null, false);
        expect(rows[0].activity).toContain('fw:main-busy:3');
        expect(rows[0].activity).toContain('fw:main-blocked:1');
        expect(rows[1].activity).toContain('fw:block:0');
        expect(rows[2].activity).toContain('fw:block:30');
        expect(rows[1].activity).toContain('fw:js:0');
        for (const r of rows) for (const l of r.activity.split(', ')) expect(l).toMatch(LABEL);
    });
    it('the threshold is the boundary: BLOCKED_MS counts, one below does not', () => {
        const at = (block: number) => probeRows([{ ...blocked, loafs: [{ ...blocked.loafs[0], block }] }], [0], null, 60, 1)[0].activity;
        expect(at(BLOCKED_MS)).toContain('fw:main-blocked:1');
        expect(at(BLOCKED_MS - 1)).toContain('fw:main-blocked:0');
    });
    it('hitchBlock is the largest blocking time of the hitch\'s frames (0 without frames or without the field)', () => {
        expect(hitchBlock({ gap: 1, pillar: 0, score: 0, loafs: [] })).toBe(0);
        expect(hitchBlock({ gap: 1, pillar: 0, score: 0, loafs: [{ dur: 60, scripts: 0, phases: null }] })).toBe(0);
        expect(hitchBlock({ gap: 1, pillar: 0, score: 0, loafs: [{ dur: 60, scripts: 0, phases: null, block: 4 }, { dur: 90, scripts: 1, phases: null, block: 40 }] })).toBe(40);
    });
    it('a hitch without a long frame still carries the game\'s own frame time, and no block label', () => {
        const row = probeRows([{ gap: 40, pillar: 3, score: 2, js: 12.6, loafs: [] }], [0], null, 144, 0)[1].activity;
        expect(row).toBe('firewall:hitch, fw:p:3, fw:score:2, fw:loaf:none, fw:js:13');
    });
    it('the fullest summary row (topology and all) stays under the row length cap', () => {
        const topo = displayTopology([{ displayFrequency: 165, hostsWindow: true }, { displayFrequency: 180 }, { displayFrequency: 144 }]);
        const row = probeRows([waiting, blocked], [0, 3080], { r: { frames: 9000, ms: 60000, fps: 164.9, busyAvgMs: 0.4, maxGapMs: 73.2 }, gl: 'NVIDIA GeForce RTX 2080 Ti' }, 165, 2, topo, true)[0].activity;
        expect(row.length).toBeLessThanOrEqual(300);
    });
});
