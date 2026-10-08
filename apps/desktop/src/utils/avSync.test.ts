import { describe, expect, it } from 'vitest';
import {
    AUDIO_LAG_LIMIT_MS, AUDIO_LEAD_LIMIT_MS, LIMITER_LOOKAHEAD_MS, MSS_FIFO_ESTIMATE_MS, MSS_FIFO_UNCERTAINTY_MS,
    NS_RING_LATENCY_MS, VIDEO_RENDER_DELAY_MS,
    avSyncVerdict, choosePlaybackPath, elementVolumeFor, estimateAvSync, outputPathMs, webAudioExtraMs,
    type PlaybackInfo, type StatsEntry,
} from './avSync';

describe('choosePlaybackPath', () => {
    const base = { nsEnabled: false, perUserGain: 1, masterGain: 1 };
    it('defaults (unity volume, no NS) play through the element', () => {
        expect(choosePlaybackPath(base)).toBe('element');
    });
    it('any attenuation stays on the element path', () => {
        expect(choosePlaybackPath({ ...base, perUserGain: 0 })).toBe('element');
        expect(choosePlaybackPath({ ...base, perUserGain: 0.35, masterGain: 0.5 })).toBe('element');
    });
    it('per-user NS needs Web Audio regardless of volume', () => {
        expect(choosePlaybackPath({ ...base, nsEnabled: true })).toBe('webaudio');
        expect(choosePlaybackPath({ ...base, nsEnabled: true, perUserGain: 0.2 })).toBe('webaudio');
    });
    it('a combined boost above unity needs Web Audio (an element cannot boost)', () => {
        expect(choosePlaybackPath({ ...base, perUserGain: 1.01 })).toBe('webaudio');
        expect(choosePlaybackPath({ ...base, masterGain: 1.2 })).toBe('webaudio');
    });
    it('boundary: exactly unity (and float noise just above it) is still the element', () => {
        expect(choosePlaybackPath({ ...base, perUserGain: 1, masterGain: 1 })).toBe('element');
        expect(choosePlaybackPath({ ...base, perUserGain: 1 + 1e-9 })).toBe('element');
    });
    it('a per-user boost cancelled by a master cut stays on the element', () => {
        // 2.0 × 0.5 = 1.0 → the element can reproduce it exactly.
        expect(choosePlaybackPath({ ...base, perUserGain: 2, masterGain: 0.5 })).toBe('element');
    });
    it('non-finite gain falls back to Web Audio (the path that can represent anything)', () => {
        expect(choosePlaybackPath({ ...base, perUserGain: Number.NaN })).toBe('webaudio');
        expect(choosePlaybackPath({ ...base, perUserGain: Number.POSITIVE_INFINITY })).toBe('webaudio');
    });
});

describe('elementVolumeFor', () => {
    it('multiplies per-user by master', () => {
        expect(elementVolumeFor(0.5, 0.5, false)).toBeCloseTo(0.25);
    });
    it('clamps to [0, 1]', () => {
        expect(elementVolumeFor(2, 1, false)).toBe(1);
        expect(elementVolumeFor(-1, 1, false)).toBe(0);
    });
    it('silenced (mute / deafen) is 0 whatever the volume', () => {
        expect(elementVolumeFor(1, 1, true)).toBe(0);
    });
    it('NaN never reaches element.volume (which would throw)', () => {
        expect(elementVolumeFor(Number.NaN, 1, false)).toBe(0);
    });
});

describe('latency model', () => {
    const wa: PlaybackInfo = { path: 'webaudio', nsEnabled: false, baseLatency: 0.010, outputLatency: 0.030 };
    it('NS ring = 20 ms prebuffer + one 10 ms RNNoise frame', () => {
        expect(NS_RING_LATENCY_MS).toBeCloseTo(30);
    });
    it('element path uses Chromium\'s reported playout delay, else the context output latency', () => {
        expect(outputPathMs({ path: 'element', nsEnabled: false, outputLatency: 0.02 }, 33)).toBe(33);
        expect(outputPathMs({ path: 'element', nsEnabled: false, outputLatency: 0.02 }, undefined)).toBeCloseTo(20);
    });
    it('Web Audio path = FIFO + render buffer + output + limiter (+ NS)', () => {
        expect(outputPathMs(wa, 30)).toBeCloseTo(MSS_FIFO_ESTIMATE_MS + 10 + 30 + LIMITER_LOOKAHEAD_MS);
        expect(outputPathMs({ ...wa, nsEnabled: true }, 30))
            .toBeCloseTo(MSS_FIFO_ESTIMATE_MS + 10 + 30 + LIMITER_LOOKAHEAD_MS + NS_RING_LATENCY_MS);
    });
    it('Web Audio extra over the element path; 0 on the element path', () => {
        // Same device: element playout 30 ms = context output 30 ms, so the
        // extra is FIFO + base + limiter.
        expect(webAudioExtraMs(wa, 30)).toBeCloseTo(MSS_FIFO_ESTIMATE_MS + 10 + LIMITER_LOOKAHEAD_MS);
        expect(webAudioExtraMs({ ...wa, path: 'element' }, 30)).toBe(0);
    });
});

describe('avSyncVerdict (ITU-R BT.1359 detectability, + = audio late)', () => {
    it.each([
        [0, 'ok'],
        [AUDIO_LAG_LIMIT_MS, 'ok'],
        [AUDIO_LAG_LIMIT_MS + 0.1, 'audio-late'],
        [-AUDIO_LEAD_LIMIT_MS, 'ok'],
        [-AUDIO_LEAD_LIMIT_MS - 0.1, 'audio-early'],
        [Number.NaN, 'unknown'],
        [undefined, 'unknown'],
    ] as const)('%s ms → %s', (ms, v) => {
        expect(avSyncVerdict(ms as number | undefined)).toBe(v);
    });
});

// ── estimateAvSync against canned getStats() reports ──

function audioReport(o: { jbDelay: number; emitted: number; playout?: number; samples?: number }): StatsEntry[] {
    const r: StatsEntry[] = [
        { id: 'IA', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1000, jitterBufferDelay: o.jbDelay, jitterBufferEmittedCount: o.emitted },
        { id: 'T', type: 'transport' },
    ];
    if (o.playout !== undefined) r.push({ id: 'AP', type: 'media-playout', kind: 'audio', totalPlayoutDelay: o.playout, totalSamplesCount: o.samples });
    return r;
}
function videoReport(o: { jbDelay: number; emitted: number; decode?: number; frames?: number }): StatsEntry[] {
    return [
        // A second, idle inbound-rtp (e.g. a stale layer) must not be picked.
        { id: 'IV0', type: 'inbound-rtp', kind: 'video', bytesReceived: 10, jitterBufferDelay: 999, jitterBufferEmittedCount: 1 },
        { id: 'IV', type: 'inbound-rtp', kind: 'video', bytesReceived: 50_000, jitterBufferDelay: o.jbDelay, jitterBufferEmittedCount: o.emitted, totalDecodeTime: o.decode ?? 0, framesDecoded: o.frames ?? 0 },
    ];
}
const element: PlaybackInfo = { path: 'element', nsEnabled: false, outputLatency: 0.03 };

describe('estimateAvSync', () => {
    it('returns nothing without both an audio and a video inbound-rtp', () => {
        expect(estimateAvSync([], videoReport({ jbDelay: 1, emitted: 10 }), element, null).estimate).toBeNull();
        expect(estimateAvSync(audioReport({ jbDelay: 1, emitted: 10 }), [], element, null).estimate).toBeNull();
    });

    it('lifetime averages on the first sample (element path)', () => {
        // audio jb 50 ms avg, playout 30 ms (totalPlayoutDelay sums the delay
        // of EVERY sample: 48 000 × 0.03 s); video jb 20 ms, decode 5 ms.
        const a = audioReport({ jbDelay: 5, emitted: 100, playout: 1440, samples: 48_000 });
        const v = videoReport({ jbDelay: 0.6, emitted: 30, decode: 0.15, frames: 30 });
        const { estimate, snapshot } = estimateAvSync(a, v, element, null);
        expect(snapshot).not.toBeNull();
        expect(estimate!.parts.audioJbMs).toBeCloseTo(50);
        expect(estimate!.parts.outputMs).toBeCloseTo(30);
        expect(estimate!.parts.videoJbMs).toBeCloseTo(20);
        expect(estimate!.parts.decodeMs).toBeCloseTo(5);
        expect(estimate!.audioPathMs).toBeCloseTo(80);
        expect(estimate!.videoPathMs).toBeCloseTo(20 + 5 + VIDEO_RENDER_DELAY_MS);
        expect(estimate!.offsetMs).toBeCloseTo(80 - 55);
        expect(estimate!.uncertaintyMs).toBe(0);
        expect(estimate!.verdict).toBe('ok');
    });

    it('interval averages once a previous snapshot exists', () => {
        const a1 = audioReport({ jbDelay: 5, emitted: 100, playout: 1440, samples: 48_000 });
        const v1 = videoReport({ jbDelay: 0.6, emitted: 30, decode: 0.15, frames: 30 });
        const first = estimateAvSync(a1, v1, element, null);
        // Next second: audio jb grew to 200 ms per emitted sample-batch.
        const a2 = audioReport({ jbDelay: 5 + 20, emitted: 200, playout: 2880, samples: 96_000 });
        const v2 = videoReport({ jbDelay: 0.6 + 0.6, emitted: 60, decode: 0.3, frames: 60 });
        const { estimate } = estimateAvSync(a2, v2, element, first.snapshot);
        expect(estimate!.parts.audioJbMs).toBeCloseTo(200);
        expect(estimate!.offsetMs).toBeCloseTo(200 + 30 - (20 + 5 + VIDEO_RENDER_DELAY_MS));
        expect(estimate!.verdict).toBe('audio-late');
    });

    it('falls back to lifetime averages when a counter did not advance', () => {
        const a = audioReport({ jbDelay: 5, emitted: 100 });
        const v = videoReport({ jbDelay: 0.6, emitted: 30 });
        const first = estimateAvSync(a, v, element, null);
        const { estimate } = estimateAvSync(a, v, element, first.snapshot);
        expect(estimate!.parts.audioJbMs).toBeCloseTo(50);
    });

    it('Web Audio path adds its latency and carries the FIFO uncertainty', () => {
        const a = audioReport({ jbDelay: 5, emitted: 100, playout: 1440, samples: 48_000 });
        const v = videoReport({ jbDelay: 0.6, emitted: 30, decode: 0.15, frames: 30 });
        const wa: PlaybackInfo = { path: 'webaudio', nsEnabled: true, baseLatency: 0.01, outputLatency: 0.03 };
        const el = estimateAvSync(a, v, element, null).estimate!;
        const w = estimateAvSync(a, v, wa, null).estimate!;
        expect(w.offsetMs - el.offsetMs).toBeCloseTo(MSS_FIFO_ESTIMATE_MS + 10 + LIMITER_LOOKAHEAD_MS + NS_RING_LATENCY_MS);
        expect(w.uncertaintyMs).toBe(MSS_FIFO_UNCERTAINTY_MS);
        expect(w.path).toBe('webaudio');
    });

    it('accepts a Map-like report (RTCStatsReport.forEach)', () => {
        const m = new Map<string, StatsEntry>();
        for (const e of audioReport({ jbDelay: 5, emitted: 100 })) m.set(e.id, e);
        const { estimate } = estimateAvSync(m, videoReport({ jbDelay: 0.6, emitted: 30 }), element, null);
        expect(estimate).not.toBeNull();
    });

    it('ignores garbage fields instead of producing NaN', () => {
        const a: StatsEntry[] = [{ id: 'IA', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 'x', jitterBufferEmittedCount: 10 }];
        const { estimate } = estimateAvSync(a, videoReport({ jbDelay: 0.6, emitted: 30 }), element, null);
        expect(Number.isFinite(estimate!.offsetMs)).toBe(true);
    });
});
