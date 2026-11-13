/**
 * The share telemetry's behaviour inside the call-event log: kinds registered,
 * the 12-key cap, steady-state coalescing of the 10 s samples, and the
 * "current share context" that survives the ring rotating.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    logCallEvent, getCallEvents, getPinnedCallEvents, clearCallEvents, markCallStart, markCallEnd, validateCallEvent,
    CALL_EVENT_KINDS, MAX_EVENTS, MAX_AGE_MS, PINNED_KINDS, SHARE_CONTEXT_KINDS, PIN_PER_GROUP, PIN_MAX, type CallEventKind,
} from './callEventLog';
import { BREADCRUMB_KINDS } from './crashBreadcrumbs';
import { isSteady, STEADY_KINDS, STEADY_MAX_REPEAT, STEADY_WINDOW_MS } from './shareSteady';

let clock = 0;
const EPOCH = 1_791_000_000_000;
beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(Date, 'now').mockImplementation(() => EPOCH + clock);
    clearCallEvents();
});
afterEach(() => vi.restoreAllMocks());

const REF = 'a1b2c3d4';
const rx = (o: Record<string, number | string | boolean> = {}) => ({
    share_ref: REF, track: 'remote-video-2', rx_fps: 88, dec_fps: 87.5, drop_fps: 0, disp_fps: 60, jb_ms: 18, res: '2560x1440', layer: 2, focus: true, tile: 540, ...o,
});
const net = (o: Record<string, number | string | boolean> = {}) => ({
    share_ref: REF, kbps: 14_200, cap_kbps: 16_000, avail_kbps: 38_000, rtt_ms: 41, loss_pct: 0, enc_ms: 4.2, ...o,
});

describe('registration', () => {
    it('every new kind is on the published list and obeys the kind pattern', () => {
        for (const k of ['share_net', 'share_display', 'share_rx_fps', 'share_rx_start', 'share_rx_snap', 'share_tx_snap']) {
            expect(CALL_EVENT_KINDS as readonly string[]).toContain(k);
            expect(k).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        }
    });
    it('the live kinds are mirrored to crash breadcrumbs; the report-only snapshot kinds are not', () => {
        for (const k of ['share_net', 'share_display', 'share_rx_fps', 'share_rx_start']) expect(BREADCRUMB_KINDS.has(k)).toBe(true);
        for (const k of ['share_rx_snap', 'share_tx_snap']) expect(BREADCRUMB_KINDS.has(k)).toBe(false);
    });
    it('fully-populated details are valid and fit the 12-key cap WITH the repeat slot', () => {
        for (const [kind, detail] of [['share_rx_fps', rx()], ['share_net', net()]] as const) {
            expect(Object.keys(detail).length).toBeLessThanOrEqual(11);
            logCallEvent(kind, detail);
        }
        logCallEvent('share_rx_start', { share_ref: REF, track: 'remote-video-2', codec: 'h264', decoder: 'ExternalDecoder', hw: true, res: '2560x1440', layer: 2 });
        logCallEvent('share_display', { share_ref: REF, role: 'viewer', hz: 144, hz_src: 'raf' });
        const events = getCallEvents();
        expect(events).toHaveLength(4);
        for (const e of events) expect(validateCallEvent(e)).toEqual([]);
        // nothing was dropped by the sanitiser's 11-key limit
        expect(Object.keys(events[0].detail!)).toHaveLength(Object.keys(rx()).length);
        expect(Object.keys(events[1].detail!)).toHaveLength(Object.keys(net()).length);
        expect(events[0].detail).toMatchObject({ share_ref: REF, rx_fps: 88, dec_fps: 87.5, disp_fps: 60, jb_ms: 18, layer: 2, tile: 540 });
    });
    it('absent measurements (undefined / NaN / empty) are dropped, not logged as 0', () => {
        logCallEvent('share_rx_fps', { share_ref: REF, rx_fps: 90, disp_fps: NaN, jb_ms: undefined as unknown as number, res: '' });
        expect(getCallEvents()[0].detail).toEqual({ share_ref: REF, rx_fps: 90 });
    });
});

describe('steady-state coalescing of the 10 s samples', () => {
    it('a steady viewer run is ONE entry with a repeat count, even with other events interleaved', () => {
        for (let i = 0; i < 6; i++) {
            logCallEvent('share_rx_fps', rx({ rx_fps: 88 + (i % 2), dec_fps: 87 + (i % 2) }));
            logCallEvent('share_fps', { src_fps: 90, enc_fps: 90, sent_fps: 90 });
            logCallEvent('share_net', net({ kbps: 14_000 + i * 100 }));
            clock += 10_000;
        }
        const e = getCallEvents();
        expect(e.filter(x => x.kind === 'share_rx_fps')).toHaveLength(1);
        expect(e.filter(x => x.kind === 'share_net')).toHaveLength(1);
        expect(e.find(x => x.kind === 'share_rx_fps')!.detail!.repeat).toBe(6);
        expect(e.find(x => x.kind === 'share_net')!.detail!.repeat).toBe(6);
        // share_fps is untouched (the existing 10 s stream keeps its own behaviour)
        expect(e.filter(x => x.kind === 'share_fps').length).toBeGreaterThan(1);
    });

    it('a real change starts a new entry: fps drop, drops appearing, loss, a new layer or resolution, focus', () => {
        logCallEvent('share_rx_fps', rx());
        const changes: Array<Record<string, number | string | boolean>> = [
            { rx_fps: 62, dec_fps: 62 }, { drop_fps: 6 }, { layer: 0 }, { res: '1280x720' }, { focus: false },
        ];
        for (const c of changes) { clock += 10_000; logCallEvent('share_rx_fps', rx(c)); clock += 10_000; logCallEvent('share_rx_fps', rx()); }
        expect(getCallEvents().filter(e => e.kind === 'share_rx_fps')).toHaveLength(1 + changes.length * 2);
        logCallEvent('share_net', net());
        clock += 10_000; logCallEvent('share_net', net({ loss_pct: 4 }));
        clock += 10_000; logCallEvent('share_net', net({ kbps: 4_000 }));
        expect(getCallEvents().filter(e => e.kind === 'share_net')).toHaveLength(3);
    });

    it('compares with the run\'s FIRST sample, so a slow drift cannot hide inside one entry', () => {
        for (let i = 0; i < 12; i++) { logCallEvent('share_rx_fps', rx({ rx_fps: 90 - i * 2 })); clock += 10_000; }
        const e = getCallEvents().filter(x => x.kind === 'share_rx_fps');
        expect(e.length).toBeGreaterThan(1);
        expect(e.length).toBeLessThan(12);
    });

    it('a run ends after STEADY_MAX_REPEAT samples and after a gap longer than the window', () => {
        for (let i = 0; i < STEADY_MAX_REPEAT + 3; i++) { logCallEvent('share_net', net()); clock += 10_000; }
        const e = getCallEvents().filter(x => x.kind === 'share_net');
        expect(e).toHaveLength(2);
        expect(e[0].detail!.repeat).toBe(STEADY_MAX_REPEAT);
        clearCallEvents();
        logCallEvent('share_net', net());
        clock += STEADY_WINDOW_MS + 1;
        logCallEvent('share_net', net());
        expect(getCallEvents().filter(x => x.kind === 'share_net')).toHaveLength(2);
    });

    it('two watched shares do not absorb each other', () => {
        logCallEvent('share_rx_fps', rx({ share_ref: '11111111' }));
        logCallEvent('share_rx_fps', rx({ share_ref: '22222222' }));
        clock += 10_000;
        logCallEvent('share_rx_fps', rx({ share_ref: '11111111' }));
        logCallEvent('share_rx_fps', rx({ share_ref: '22222222' }));
        const e = getCallEvents();
        expect(e).toHaveLength(2);
        expect(e.map(x => x.detail!.repeat)).toEqual([2, 2]);
    });

    it('a 30-minute steady share costs ~15 entries per kind, not 180', () => {
        for (let i = 0; i < 180; i++) { logCallEvent('share_rx_fps', rx()); logCallEvent('share_net', net()); clock += 10_000; }
        const e = getCallEvents();
        expect(e.filter(x => x.kind === 'share_rx_fps').length).toBeLessThanOrEqual(16);
        expect(e.filter(x => x.kind === 'share_net').length).toBeLessThanOrEqual(16);
    });

    it('isSteady: key sets must match; strings, booleans, layer and res are exact; loss/drops are tight', () => {
        expect(isSteady(rx(), rx({ rx_fps: 90 }))).toBe(true);
        expect(isSteady(rx(), { ...rx(), extra: 1 })).toBe(false);
        const { disp_fps, ...noDisp } = rx();
        void disp_fps;
        expect(isSteady(rx(), noDisp)).toBe(false);
        expect(isSteady(rx(), rx({ layer: 1 }))).toBe(false);
        expect(isSteady(net(), net({ loss_pct: 1 }))).toBe(true);
        expect(isSteady(net(), net({ loss_pct: 2.5 }))).toBe(false);
        expect(isSteady(undefined, rx())).toBe(false);
        expect([...STEADY_KINDS].sort()).toEqual(['share_net', 'share_rx_fps']);
    });
});

describe('the current share\'s context outlives the ring', () => {
    const startShare = () => {
        logCallEvent('share_clamp', { codec: 'h264', cap_res: '2560x1440', res: '2560x1440', scale: 1 });
        logCallEvent('share_codec', { codec: 'h264', profile: 'high', hardware: true, fps: 90 });
        logCallEvent('share_start', { verdict: 'published', ms: 900, share_ref: REF });
        logCallEvent('share_display', { share_ref: REF, role: 'sharer', hz: 144, hz_src: 'matched', share: 'screen' });
        logCallEvent('share_crop', { mode: 'worker' });
    };

    it('after 600 events and 40 minutes the report still has the share\'s start, codec, clamp, display and crop', () => {
        startShare();
        clock += MAX_AGE_MS + 60_000;
        for (let i = 0; i < MAX_EVENTS + 100; i++) { clock += 2_100; logCallEvent('camera_codec', { n: i }); }
        const ring = getCallEvents().map(e => e.kind);
        for (const k of ['share_start', 'share_codec', 'share_clamp', 'share_display', 'share_crop']) expect(ring).not.toContain(k);
        const pinned = getPinnedCallEvents();
        expect(pinned.map(e => e.kind).sort()).toEqual(['share_clamp', 'share_codec', 'share_crop', 'share_display', 'share_start']);
        expect(pinned.find(e => e.kind === 'share_start')!.detail).toMatchObject({ share_ref: REF, verdict: 'published' });
        for (const e of pinned) expect(validateCallEvent(e)).toEqual([]);
    });

    it('keeps the last PIN_PER_GROUP per kind and share, PIN_MAX overall; share_rx_start is pinned per watched share', () => {
        for (let i = 0; i < 10; i++) { clock += 3_000; logCallEvent('share_clamp', { scale: i }); }
        expect(getPinnedCallEvents().filter(e => e.kind === 'share_clamp').map(e => e.detail!.scale)).toEqual([7, 8, 9]);
        expect(PIN_PER_GROUP).toBe(3);
        for (let i = 0; i < 30; i++) { clock += 3_000; logCallEvent('share_rx_start', { share_ref: i.toString(16).padStart(8, '0'), decoder: 'D' }); }
        const pins = getPinnedCallEvents();
        expect(pins.length).toBeLessThanOrEqual(PIN_MAX);
        expect(pins.filter(e => e.kind === 'share_rx_start').length).toBeGreaterThan(20);
    });

    it('only the context kinds are pinned; periodic samples never are', () => {
        expect([...PINNED_KINDS].sort()).toEqual(['share_clamp', 'share_codec', 'share_crop', 'share_display', 'share_rx_start', 'share_start']);
        logCallEvent('share_rx_fps', rx());
        logCallEvent('share_net', net());
        logCallEvent('share_fps', { src_fps: 90 });
        expect(getPinnedCallEvents()).toEqual([]);
        for (const k of ['share_rx_snap', 'share_tx_snap']) expect(SHARE_CONTEXT_KINDS.has(k)).toBe(true);
    });

    it('survives the end of a call (a report right after still explains the share), not a new call or sign-out', () => {
        markCallStart();
        startShare();
        markCallEnd();
        expect(getPinnedCallEvents().length).toBe(5);
        markCallStart();
        expect(getPinnedCallEvents()).toEqual([]);
        startShare();
        clearCallEvents();
        expect(getPinnedCallEvents()).toEqual([]);
    });

    it('returns copies, and an identical immediate repeat is not pinned twice', () => {
        logCallEvent('share_clamp', { scale: 1 });
        logCallEvent('share_clamp', { scale: 1 });
        const p = getPinnedCallEvents();
        expect(p).toHaveLength(1);
        p[0].detail!.scale = 99;
        expect(getPinnedCallEvents()[0].detail!.scale).toBe(1);
    });
});

describe('unknown kinds', () => {
    it('a typo\'d share kind is dropped, not logged', () => {
        logCallEvent('share_rx_fpss' as CallEventKind, rx());
        expect(getCallEvents()).toEqual([]);
    });
});
