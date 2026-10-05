import { describe, it, expect } from 'vitest';
import {
    parseMainDiagnostics, parseCaptureTiming,
    setScreenShareSession, updateScreenShareSession, getScreenShareSession,
    type ScreenShareSession,
} from './screenShareDiagnostics';

describe('parseMainDiagnostics', () => {
    const good = {
        platform: 'win32', windowsBuild: 22631, sourceKind: 'screen', displayHz: 144, displayHzSource: 'matched',
        capturer: { backend: 'dxgi', why: 'auto: Windows build 22631 < 24H2' }, capturerPref: 'auto',
        gpus: [{ vendor: 'NVIDIA', vendorId: 0x10de, deviceId: 0x2684, name: 'NVIDIA GeForce RTX 4090', active: true }],
        videoEncode: 'enabled', h264CbpHwEnabled: true, captureLog: false,
    };

    it('passes a well-formed payload through', () => {
        expect(parseMainDiagnostics(good)).toEqual(good);
    });

    it('rejects non-objects', () => {
        for (const v of [null, undefined, 'x', 3, []]) expect(parseMainDiagnostics(v)).toBeNull();
    });

    it('coerces unknown enums and junk fields to safe defaults instead of trusting them', () => {
        const d = parseMainDiagnostics({
            ...good, sourceKind: 'tab', capturerPref: 'gdi', displayHz: 0,
            capturer: { backend: 'magic', why: 7 }, gpus: [null, { vendor: 5 }], videoEncode: 1, captureLog: 'yes',
            extra: 'dropped',
        })!;
        expect(d.sourceKind).toBe('unknown');
        expect(d.capturerPref).toBe('auto');
        expect(d.displayHz).toBeNull();
        expect(d.displayHzSource).toBeNull();
        expect(d.capturer).toEqual({ backend: 'unknown', why: '' });
        expect(d.gpus).toEqual([{ vendor: '?', vendorId: 0, deviceId: 0, name: undefined, active: false }]);
        expect(d.videoEncode).toBeNull();
        expect(d.captureLog).toBe(false);
        expect('extra' in d).toBe(false);
    });

    it('keeps a known Hz source, drops an unknown one, and never labels a missing rate', () => {
        expect(parseMainDiagnostics({ ...good, displayHzSource: 'primary' })!.displayHzSource).toBe('primary');
        expect(parseMainDiagnostics({ ...good, displayHzSource: 'guess' })!.displayHzSource).toBeNull();
        expect(parseMainDiagnostics({ ...good, displayHz: null, displayHzSource: 'matched' })!.displayHzSource).toBeNull();
    });
});

describe('parseCaptureTiming', () => {
    it('requires the three core numbers', () => {
        expect(parseCaptureTiming(null)).toBeNull();
        expect(parseCaptureTiming({ samples: 10, captureMs: 9 })).toBeNull();
    });

    it('fills pollFps from the period when absent', () => {
        expect(parseCaptureTiming({ samples: 50, captureMs: 9, periodMs: 20 })).toEqual({
            samples: 50, captureMs: 9, periodMs: 20, pollFps: 50, unchangedRatio: 0,
            requestedFps: undefined, maxCpuPercent: undefined, wgcScreenAllowed: undefined,
        });
    });

    it('carries the measured grab interval only when it is a positive number', () => {
        expect(parseCaptureTiming({ samples: 50, captureMs: 3.6, periodMs: 11, intervalMs: 12.1 })!.intervalMs).toBe(12.1);
        expect(parseCaptureTiming({ samples: 50, captureMs: 3.6, periodMs: 11, intervalMs: 0 })!.intervalMs).toBeUndefined();
        expect(parseCaptureTiming({ samples: 50, captureMs: 3.6, periodMs: 11, intervalMs: '12' })!.intervalMs).toBeUndefined();
    });
});

describe('screen-share session store', () => {
    const s = (sourceId: string): ScreenShareSession => ({
        sourceId, requestedFps: 90, codecPref: 'auto', codec: 'vp8', codecReason: 'auto: no HW encoder → VP8', hw: null, main: null,
    });

    it('updates only the share it was written for', () => {
        setScreenShareSession(s('screen:1:0'));
        updateScreenShareSession('screen:2:0', { codecReason: 'stale' });
        expect(getScreenShareSession()!.codecReason).toBe('auto: no HW encoder → VP8');
        updateScreenShareSession('screen:1:0', { codecReason: 'fresh' });
        expect(getScreenShareSession()!.codecReason).toBe('fresh');
        setScreenShareSession(null);
        expect(getScreenShareSession()).toBeNull();
    });
});
