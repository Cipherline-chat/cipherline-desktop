/**
 * How the share telemetry reaches a diagnostic report: the pinned share context
 * and the report-time snapshot merge into `call_events` (no wire-schema change),
 * within the 300-event cap, surviving size trimming - and nothing identifying
 * gets through the builder, even from a hostile producer.
 */
import { describe, it, expect } from 'vitest';
import { buildDiagnosticReport, mergeCallEvents, fitPayload, MAX_PINNED_IN_REPORT, MAX_SNAPSHOT_IN_REPORT, type BundleInput, type CallEventInput } from './bundle';
import { buildSettingsSnapshot } from './settingsSnapshot';
import { DIAGNOSTIC_LIMITS, type DiagnosticPayload, type SystemInfo } from './reportTypes';
import { SHARE_CONTEXT_KINDS } from '../callEventLog';

const NOW = Date.UTC(2026, 9, 26, 20, 0, 0);
const SYSTEM: SystemInfo = {
    app_version: '1.0.24', build_commit: '34f51243', channel: 'stable', electron: '43.2.0', chrome: '140.0.7339.133', node: '22.19.0',
    platform: 'win32', os_version: '10.0.22631', arch: 'x64', cpu_model: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', cpu_cores: 12, ram_gb: 15.9,
    gpu: { devices: [], feature_status: {} }, displays: [], hardware_acceleration: true, uptime_s: 5412,
};
const base = (over: Partial<BundleInput> = {}): BundleInput => ({
    category: 'screen_share', trigger: 'manual', now: NOW, system: SYSTEM,
    settings: buildSettingsSnapshot({ hardwareAcceleration: true }),
    entitlement: null, perfLog: [], webrtc: null, recentErrors: [],
    scrub: { sensitiveTerms: ['dawson_kraai', 'nightowl42'], homeDir: 'C:\\Users\\Dawson' },
    ...over,
});
const ev = (agoS: number, kind: string, detail?: CallEventInput['detail']): CallEventInput => ({ t: NOW - agoS * 1000, kind, ...(detail ? { detail } : {}) });
const REF = 'a1b2c3d4';

describe('pinned share context in a report', () => {
    it('events that rotated out of the ring are merged back in, in time order', () => {
        const ring = [ev(60, 'camera_codec', { codec: 'vp8' }), ev(30, 'share_rx_fps', { share_ref: REF, rx_fps: 70 })];
        const pinned = [ev(5400, 'share_start', { verdict: 'published', share_ref: REF }), ev(5401, 'share_codec', { codec: 'h264', hardware: true })];
        const out = buildDiagnosticReport(base({ callEvents: ring, pinnedCallEvents: pinned })).body.payload.call_events!;
        expect(out.map(e => e.event)).toEqual(['share_codec', 'share_start', 'camera_codec', 'share_rx_fps']);
        expect(out[1].t_s).toBe(-5400);
        expect(out[1].detail).toEqual({ verdict: 'published', share_ref: REF });
    });

    it('a pinned event the ring still holds is not duplicated', () => {
        const same = ev(120, 'share_clamp', { scale: 0.75 });
        const out = mergeCallEvents({ callEvents: [same, ev(10, 'camera_codec')], pinnedCallEvents: [same] }, NOW);
        expect(out.filter(e => e.event === 'share_clamp')).toHaveLength(1);
    });

    it('a pinned event the ring only holds beyond the cap is NOT lost with it', () => {
        const old = ev(9_000, 'share_start', { verdict: 'published' });
        const ring = [old, ...Array.from({ length: 500 }, (_, i) => ev(8_000 - i, 'camera_codec', { n: i }))];
        const out = buildDiagnosticReport(base({ callEvents: ring, pinnedCallEvents: [old] })).body.payload.call_events!;
        expect(out.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxCallEvents);
        expect(out.filter(e => e.event === 'share_start')).toHaveLength(1);
    });

    it('the total never exceeds maxCallEvents, whatever the producer sends', () => {
        const ring = Array.from({ length: 500 }, (_, i) => ev(2_000 - i, 'camera_codec', { n: i }));
        const pinned = Array.from({ length: 200 }, (_, i) => ev(9_000 + i, 'share_codec', { n: i }));
        const snap = Array.from({ length: 200 }, (_, i) => ev(10 - i * 0.01, 'share_rx_snap', { share_ref: REF, rx_fps: i }));
        const out = mergeCallEvents({ callEvents: ring, pinnedCallEvents: pinned, snapshotCallEvents: snap }, NOW);
        expect(out.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxCallEvents);
        expect(out.filter(e => e.event === 'share_codec').length).toBeLessThanOrEqual(MAX_PINNED_IN_REPORT);
        expect(out.filter(e => e.event === 'share_rx_snap').length).toBeLessThanOrEqual(MAX_SNAPSHOT_IN_REPORT);
    });

    it('call categories carry it; categories without call_events still do not', () => {
        const input = { callEvents: [], pinnedCallEvents: [ev(100, 'share_start', { verdict: 'published' })], snapshotCallEvents: [ev(1, 'share_rx_snap', { rx_fps: 60 })] };
        expect(buildDiagnosticReport(base({ ...input, category: 'crash' })).body.payload.call_events).toBeUndefined();
        expect(buildDiagnosticReport(base({ ...input, category: 'other' })).body.payload.call_events).toBeUndefined();
        expect(buildDiagnosticReport(base({ ...input, category: 'performance' })).body.payload.call_events).toHaveLength(2);
    });
});

describe('the report-time snapshot in a report', () => {
    it('carries the 1 s samples of both ends with their share_ref, at negative-or-zero times', () => {
        const snap = [
            ...Array.from({ length: 10 }, (_, i) => ev(10 - i, 'share_rx_snap', { share_ref: REF, track: 'remote-video-1', rx_fps: 70 + i, disp_fps: 60, layer: 2 })),
            ...Array.from({ length: 10 }, (_, i) => ev(10 - i, 'share_tx_snap', { share_ref: REF, kbps: 12_000, avail_kbps: 40_000, rtt_ms: 31 })),
        ];
        const out = buildDiagnosticReport(base({ snapshotCallEvents: snap })).body.payload.call_events!;
        expect(out.filter(e => e.event === 'share_rx_snap')).toHaveLength(10);
        expect(out.filter(e => e.event === 'share_tx_snap')).toHaveLength(10);
        for (const e of out) { expect(e.t_s).toBeLessThanOrEqual(0); expect(e.detail!.share_ref).toBe(REF); }
    });
});

describe('size trimming keeps the share context', () => {
    it('fitPayload drops ordinary call events first, then the context', () => {
        const filler = Array.from({ length: 280 }, (_, i) => ({ t_s: -2_000 + i, event: 'camera_codec', detail: { n: i, pad: 'x'.repeat(60) } }));
        const ctx = [
            { t_s: -5_000, event: 'share_start', detail: { verdict: 'published', share_ref: REF } },
            { t_s: -4_999, event: 'share_codec', detail: { codec: 'h264' } },
            { t_s: -1, event: 'share_rx_snap', detail: { share_ref: REF, rx_fps: 70 } },
        ];
        const p = { generated_at: 'x', trigger: 'manual', system: SYSTEM, settings: {}, call_events: [...ctx.slice(0, 2), ...filler, ctx[2]] } as unknown as DiagnosticPayload;
        const before = JSON.stringify(p).length;
        const trimmed = fitPayload(p, Math.floor(before / 3));
        expect(trimmed).toContain('call_events');
        const kinds = p.call_events!.map(e => e.event);
        for (const k of ['share_start', 'share_codec', 'share_rx_snap']) expect(kinds, k).toContain(k);
        expect(p.call_events!.length).toBeLessThan(283);
        expect([...SHARE_CONTEXT_KINDS].every(k => /^share_/.test(k))).toBe(true);
    });
});

describe('PRIVACY: a hostile producer cannot smuggle addresses, candidates, SIDs or names into the new events', () => {
    const SECRETS = ['203.0.113.77', '192.168.1.20', '2001:db8::dead:beef', 'TR_RealSid123', 'PA_ident77', 'dawson_kraai', 'nightowl42', 'candidate:842163049'];
    it('nested values and non-identifier keys are dropped by the builder; oversized strings too', () => {
        const hostile = [
            ev(5, 'share_net', { share_ref: REF, kbps: 1, remote_address: 'x' }),
            { t: NOW - 4000, kind: 'share_rx_fps', detail: { share_ref: REF, rx_fps: 60, 'bad key': '192.168.1.20', nested: { ip: '203.0.113.77' } as never, list: ['x'] as never, long: 'y'.repeat(500) } },
            { t: NOW - 3000, kind: 'share_display', detail: { share_ref: REF, role: 'viewer', hz: 144, Camel: 'TR_RealSid123' } },
            { t: NOW - 2000, kind: 'Share Net!', detail: { a: 1 } },
        ] as CallEventInput[];
        const text = JSON.stringify(buildDiagnosticReport(base({ snapshotCallEvents: hostile, callEvents: hostile })).body);
        for (const s of ['192.168.1.20', '203.0.113.77', 'TR_RealSid123', 'bad key', 'nested', 'Share Net!']) expect(text, s).not.toContain(s);
        expect(text).not.toContain('y'.repeat(100));
    });

    it('the scrubber is the last line of defence: a planted address or name in a string value is still removed', () => {
        const events = [ev(5, 'share_rx_start', { share_ref: REF, decoder: 'dawson_kraai on 203.0.113.77 TR_RealSid123' })];
        const body = buildDiagnosticReport(base({ pinnedCallEvents: events })).body;
        const text = JSON.stringify(body);
        for (const s of SECRETS) expect(text, s).not.toContain(s);
    });
});
