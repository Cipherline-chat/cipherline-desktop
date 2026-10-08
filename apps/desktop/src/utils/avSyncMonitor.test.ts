import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCallEvents, getCallEvents, validateCallEvent } from './callEventLog';
import {
    getAvSyncSnapshot, notePlaybackPath, noteWebAudioContext, recordAvSyncEstimate, resetAvSyncMonitor,
    sampleAvSync, slotFor, avSyncSnapshotEvents, setAvSyncSampler, sampleAvSyncNow,
} from './avSyncMonitor';
import type { AvSyncEstimate, StatsEntry } from './avSync';

const IDENTITY = 'user-7f3a9c-secret-identity';

const est = (offsetMs: number, over: Partial<AvSyncEstimate> = {}): AvSyncEstimate => ({
    audioPathMs: 100 + offsetMs, videoPathMs: 100, offsetMs, uncertaintyMs: 0,
    verdict: offsetMs > 125 ? 'audio-late' : 'ok', path: 'element',
    parts: { audioJbMs: 50, outputMs: 30, videoJbMs: 20, decodeMs: 5, renderMs: 30 },
    ...over,
});

beforeEach(() => { resetAvSyncMonitor(); clearCallEvents(); });

describe('A/V-sync events in the call event log', () => {
    it('every A/V-sync event satisfies the call-event contract (validateCallEvent)', () => {
        recordAvSyncEstimate(IDENTITY, 'camera', est(40));
        recordAvSyncEstimate(IDENTITY, 'screen_share', est(200, { path: 'webaudio' }));
        notePlaybackPath(IDENTITY, 'mic', 'webaudio', 46, 'volume-or-ns');
        noteWebAudioContext({ baseLatency: 0.01, outputLatency: 0.03, sampleRate: 48000 });
        const ev = getCallEvents();
        expect(ev.map(e => e.kind)).toEqual(['av_sync_offset', 'av_sync_offset', 'av_sync_playback_path', 'av_sync_webaudio_latency']);
        for (const e of ev) expect(validateCallEvent(e)).toEqual([]);
        // Nothing was silently dropped by the log's sanitiser (camelCase / reserved keys would be).
        expect(Object.keys(ev[0].detail!).sort()).toEqual(['audio_path_ms', 'offset_ms', 'path', 'slot', 'stream', 'uncertainty_ms', 'verdict', 'video_path_ms']);
        expect(Object.keys(ev[2].detail!).sort()).toEqual(['chain', 'path', 'reason', 'slot', 'web_audio_extra_ms']);
    });

    it('the snapshot as av_sync_estimate events: valid, identity-free, one per stream', () => {
        const now = Date.now();
        recordAvSyncEstimate(IDENTITY, 'camera', est(40), now);
        const ev = avSyncSnapshotEvents(getAvSyncSnapshot(15_000, now));
        expect(ev).toEqual([{ t: now, kind: 'av_sync_estimate', detail: expect.objectContaining({ slot: 'remote-av-1', stream: 'camera', offset_ms: 40, verdict: 'ok' }) }]);
        for (const e of ev) expect(validateCallEvent(e)).toEqual([]);
        expect(JSON.stringify(ev)).not.toContain(IDENTITY);
    });

    it('sampleAvSyncNow: no sampler → current snapshot; a registered sampler is used; a hung one times out', async () => {
        expect(await sampleAvSyncNow()).toEqual([]);
        const off = setAvSyncSampler(async () => { recordAvSyncEstimate(IDENTITY, 'camera', est(10)); return getAvSyncSnapshot(); });
        expect(await sampleAvSyncNow()).toEqual([expect.objectContaining({ offsetMs: 10 })]);
        off();
        setAvSyncSampler(() => new Promise(() => { /* never */ }));
        vi.useFakeTimers();
        const p = sampleAvSyncNow(50);
        await vi.advanceTimersByTimeAsync(60);
        expect(await p).toEqual([expect.objectContaining({ offsetMs: 10 })]);
        setAvSyncSampler(null);
    });
});

describe('avSyncMonitor', () => {
    it('names participants by placeholder, stable per call', () => {
        expect(slotFor('a')).toBe('remote-av-1');
        expect(slotFor('b')).toBe('remote-av-2');
        expect(slotFor('a')).toBe('remote-av-1');
        resetAvSyncMonitor();
        expect(slotFor('b')).toBe('remote-av-1');
    });

    it('never leaks the identity into the snapshot or the log', () => {
        recordAvSyncEstimate(IDENTITY, 'camera', est(40));
        notePlaybackPath(IDENTITY, 'mic', 'webaudio', 46, 'volume-or-ns');
        const blob = JSON.stringify({ s: getAvSyncSnapshot(), e: getCallEvents() });
        expect(blob).not.toContain(IDENTITY);
        expect(blob).toContain('remote-av-1');
    });

    it('log details are scalars only', () => {
        recordAvSyncEstimate(IDENTITY, 'camera', est(40));
        noteWebAudioContext({ baseLatency: 0.01, outputLatency: 0.03, sampleRate: 48000 });
        for (const e of getCallEvents()) {
            for (const v of Object.values(e.detail ?? {})) expect(['string', 'number', 'boolean']).toContain(typeof v);
        }
    });

    it('logs the first estimate, then only moves of ≥ 40 ms or a verdict/path change', () => {
        const n = () => getCallEvents().filter(e => e.kind === 'av_sync_offset').length;
        recordAvSyncEstimate(IDENTITY, 'camera', est(40));
        expect(n()).toBe(1);
        recordAvSyncEstimate(IDENTITY, 'camera', est(70)); // +30: below the step
        expect(n()).toBe(1);
        recordAvSyncEstimate(IDENTITY, 'camera', est(80)); // +40 from the LOGGED value
        expect(n()).toBe(2);
        recordAvSyncEstimate(IDENTITY, 'camera', est(80, { path: 'webaudio' }));
        expect(n()).toBe(3);
        recordAvSyncEstimate(IDENTITY, 'screen_share', est(80)); // separate stream
        expect(n()).toBe(4);
    });

    it('snapshot keeps the latest per stream and drops stale ones', () => {
        recordAvSyncEstimate(IDENTITY, 'camera', est(10), 1_000);
        recordAvSyncEstimate(IDENTITY, 'camera', est(20), 2_000);
        expect(getAvSyncSnapshot(15_000, 3_000)).toEqual([expect.objectContaining({ offsetMs: 20, source: 'camera' })]);
        expect(getAvSyncSnapshot(15_000, 20_000)).toEqual([]);
    });

    it('logs the Web Audio context latencies once per context', () => {
        const ctx = { baseLatency: 0.0100208, outputLatency: 0.03, sampleRate: 48000 };
        noteWebAudioContext(ctx);
        noteWebAudioContext(ctx);
        const ev = getCallEvents().filter(e => e.kind === 'av_sync_webaudio_latency');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ base_latency_ms: 10, output_latency_ms: 30, sample_rate: 48000 });
    });

    it('records the playback path with what Web Audio costs', () => {
        notePlaybackPath(IDENTITY, 'mic', 'element', 0, 'join');
        expect(getCallEvents()[0]).toMatchObject({
            kind: 'av_sync_playback_path',
            detail: { slot: 'remote-av-1', chain: 'mic', path: 'element', reason: 'join', web_audio_extra_ms: 0 },
        });
    });
});

describe('sampleAvSync', () => {
    afterEach(() => { vi.useRealTimers(); });

    function track(reports: StatsEntry[][]) {
        let i = 0;
        return { getRTCStatsReport: async () => reports[Math.min(i++, reports.length - 1)] };
    }
    const a = (d: number, n: number): StatsEntry[] => [{ id: 'a', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: d, jitterBufferEmittedCount: n }];
    const v = (d: number, n: number): StatsEntry[] => [{ id: 'v', type: 'inbound-rtp', kind: 'video', jitterBufferDelay: d, jitterBufferEmittedCount: n }];

    it('pairs camera+mic and screen+screen-audio, samples an interval, and stays identity-free', async () => {
        vi.useFakeTimers();
        const pubs = [
            { source: 'camera', track: track([v(0.2, 10), v(0.4, 20)]) },
            { source: 'microphone', track: track([a(0.5, 10), a(1.5, 20)]) },  // 2nd interval: 100 ms
            { source: 'screen_share', track: track([v(0.2, 10)]) },           // no share audio → skipped
        ];
        const room = { remoteParticipants: new Map([['x', { identity: IDENTITY, trackPublications: new Map(pubs.map((p, i) => [String(i), p])) }]]) };
        const p = sampleAvSync(room, () => ({ path: 'element', nsEnabled: false, outputLatency: 0.03 }), 1000);
        await vi.advanceTimersByTimeAsync(1000);
        const out = await p;
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ slot: 'remote-av-1', source: 'camera', path: 'element' });
        // audio 100 + 30 − video (20 + 0 + render 30)
        expect(out[0].offsetMs).toBe(80);
        expect(JSON.stringify(out)).not.toContain(IDENTITY);
    });

    it('skips participants with no audio chain (no playback info)', async () => {
        vi.useFakeTimers();
        const pubs = [
            { source: 'camera', track: track([v(0.2, 10)]) },
            { source: 'microphone', track: track([a(0.5, 10)]) },
        ];
        const room = { remoteParticipants: new Map([['x', { identity: IDENTITY, trackPublications: new Map(pubs.map((p, i) => [String(i), p])) }]]) };
        const p = sampleAvSync(room, () => null, 10);
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toEqual([]);
    });
});
