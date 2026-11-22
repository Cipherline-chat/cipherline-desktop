import { describe, it, expect, beforeEach } from 'vitest';
import { getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';
import { recordMicLevelSecond, resetMicLevelLog, summarizeMicLevel, summarizeMicNoise, summarizeMicEngine, MIC_LEVEL_LOG_MS, MIC_LEVEL_MIN_VOICED_BLOCKS } from './micLevelLog';
import type { MicLevelSecond } from './voiceProcessor';

const lin = (db: number) => Math.pow(10, db / 20);
/** One second of 375 quanta, `talk` of them voiced, at the given input/output speech level. */
const second = (o: Partial<MicLevelSecond> & { inDb?: number; outDb?: number; talk?: number } = {}): MicLevelSecond => {
    const { inDb, outDb, talk: t, ...rest } = o;
    const talk = t ?? 375;
    return {
        gainDb: 8, voiceActive: talk > 0, speechDb: -40,
        blocks: 375, voiced: talk,
        inMs: talk * lin(inDb ?? -40) ** 2, outMs: talk * lin(outDb ?? -20) ** 2,
        peak: lin(-6), held: 0, clip: 0, micGainDb: 0, gateOpenFrac: 1, rawMs: null, nsMs: null,
        ...rest,
    };
};

beforeEach(() => { clearCallEvents(); resetMicLevelLog(); });

describe('mic_level call event', () => {
    it('logs nothing before a window of talking is full', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000 - 1; i++) recordMicLevelSecond(second());
        expect(getCallEvents().filter(e => e.kind === 'mic_level')).toEqual([]);
    });

    it('reports the speech level at each stage, the applied gain and the wire peak', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) {
            recordMicLevelSecond(second({ inDb: -42, outDb: -22, micGainDb: 4.4, gainDb: 10, rawMs: lin(-45) ** 2, nsMs: lin(-47) ** 2, gateOpenFrac: 0.8 }));
        }
        const ev = getCallEvents().filter(e => e.kind === 'mic_level');
        expect(ev).toHaveLength(1);
        const d = ev[0].detail!;
        expect(d.speech_db).toBeCloseTo(-42, 1);
        expect(d.out_db).toBeCloseTo(-22, 1); // wire = AGC out (the mic-volume stage is IN FRONT of the AGC now)
        expect(d.peak_db).toBeCloseTo(-6, 1);
        expect(d.gain_db).toBeCloseTo(10, 1);
        expect(d.raw_db).toBeCloseTo(-45, 1);
        expect(d.ns_db).toBeCloseTo(-47, 1);
        expect(d.gate_pct).toBe(80);
        expect(d.talk_pct).toBe(100);
        expect(d.mic_gain_db).toBeCloseTo(4.4, 1);
        expect(validateCallEvent(ev[0])).toEqual([]);
        expect(Object.keys(d).length).toBeLessThanOrEqual(11); // callEventLog keeps one slot for `repeat`
    });

    it('averages loudness as power over the voiced quanta, so silence does not drag it down', () => {
        // 10 s of speech at -30 dBFS and 20 s with nobody talking, then the window closes.
        for (let i = 0; i < 10; i++) recordMicLevelSecond(second({ outDb: -30 }));
        for (let i = 0; i < 20; i++) recordMicLevelSecond(second({ talk: 0, outDb: -90 }));
        const d = getCallEvents().find(e => e.kind === 'mic_level')!.detail!;
        expect(d.out_db).toBeCloseTo(-30, 1);
        expect(d.talk_pct).toBe(33);
    });

    it('counts clipping and compressor/limiter holds', () => {
        for (let i = 0; i < 30; i++) recordMicLevelSecond(second({ clip: 2, held: 75, peak: lin(-1), micGainDb: 4.4 }));
        const d = getCallEvents().find(e => e.kind === 'mic_level')!.detail!;
        expect(d.clip).toBe(60);
        expect(d.lim_pct).toBe(20);
        expect(d.peak_db as number).toBeCloseTo(-1, 1); // the wire peak as measured; the slider is IN it now, not added on top
        expect(d.mic_gain_db).toBeCloseTo(4.4, 1);
    });

    it('skips a window with only a cough in it', () => {
        expect(summarizeMicLevel({
            sec: 30, blocks: 11250, voiced: MIC_LEVEL_MIN_VOICED_BLOCKS - 1, inMs: 1, outMs: 1, peak: 0.1, held: 0, clip: 0,
            gainSum: 0, gainN: 0, gateSum: 0, gateN: 0, noiseSum: 0, noiseN: 0, bursts: 0, roomSum: 0, roomN: 0, rawMs: 0, nsMs: 0, tapN: 0, micGainDb: 0,
        })).toBeNull();
    });
});

// Owner report 5ffa77e6 (2026-11-18): what else the gate let through, next to each mic_level window.
describe('mic_noise call event', () => {
    it('reports the share the gate passed non-voice sound, key-click bursts per minute and the room at the gate', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) {
            recordMicLevelSecond(second({ gateNoiseFrac: i < 15 ? 0.4 : 0, gateBursts: i < 15 ? 4 : 0, gateMinDb: i % 2 ? -60 : -64 }));
        }
        const ev = getCallEvents().filter(e => e.kind === 'mic_noise');
        expect(ev).toHaveLength(1);
        const d = ev[0].detail!;
        expect(d.noise_pct).toBe(20);       // 15 s at 40 % of a 30 s window
        expect(d.bursts_min).toBeCloseTo(120, 1); // 60 bursts in half a minute
        expect(d.room_db).toBeCloseTo(-62, 1);
        expect(validateCallEvent(ev[0])).toEqual([]);
        // mic_level itself is unchanged and still fits its slots
        const lvl = getCallEvents().find(e => e.kind === 'mic_level')!;
        expect(Object.keys(lvl.detail!)).not.toContain('noise_pct');
    });

    it('a muted second (-240 dBFS minimum) does not drag the room down; the gate off reports no noise share', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(second({ gateNoiseFrac: null, gateMinDb: i < 10 ? -240 : -58 }));
        const d = getCallEvents().find(e => e.kind === 'mic_noise')!.detail!;
        expect(d.room_db).toBeCloseTo(-58, 1);
        expect(d.noise_pct).toBeUndefined();
    });

    it('nothing without speech in the window (same rule as mic_level)', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(second({ talk: 0, gateNoiseFrac: 0.5, gateMinDb: -50 }));
        expect(getCallEvents().filter(e => e.kind === 'mic_noise')).toEqual([]);
        expect(summarizeMicNoise({
            sec: 30, blocks: 11250, voiced: 0, inMs: 0, outMs: 0, peak: 0, held: 0, clip: 0, gainSum: 0, gainN: 0, gateSum: 0, gateN: 0,
            noiseSum: 15, noiseN: 30, bursts: 9, roomSum: -1500, roomN: 30, rawMs: 0, nsMs: 0, tapN: 0, micGainDb: 0,
        })).toBeNull();
    });
});

// The new audio engine ('v2'): the same mic_level window with engine: 'v2', plus its own counters in mic_engine.
describe('mic_level / mic_engine under the new audio engine', () => {
    const v2second = (o: Partial<MicLevelSecond> = {}) => second({
        engine: 'v2', gateOpenFrac: null, gainDb: 17, speechDb: -45, engineFrames: 100, engineBad: 1, engineResets: 0, engineIdle: 10, engineUnder: 0, mutedAtDevice: false, ...o,
    });

    it('mic_level carries engine: v2, the engine gain as gain_db, and none of the gate / hold / tap fields', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(v2second());
        const ev = getCallEvents().filter(e => e.kind === 'mic_level');
        expect(ev).toHaveLength(1);
        const d = ev[0].detail!;
        expect(d.engine).toBe('v2');
        expect(d.gain_db).toBeCloseTo(17, 1);
        for (const k of ['lim_pct', 'gate_pct', 'raw_db', 'ns_db']) expect(k in d, k).toBe(false);
        expect(validateCallEvent(ev[0])).toEqual([]);
        expect(Object.keys(d).length).toBeLessThanOrEqual(11);
    });

    it('mic_engine reports bad samples, resets, idle share, output underruns and muted-at-device over the window', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(v2second({ engineUnder: i === 3 ? 7 : 0, engineResets: i === 5 ? 1 : 0, mutedAtDevice: i === 9 }));
        const ev = getCallEvents().filter(e => e.kind === 'mic_engine');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ engine: 'v2', bad: 30, resets: 1, idle: 10, under: 7, muted_dev: true, engine_native: false, ns: 'unknown' });
        expect(validateCallEvent(ev[0])).toEqual([]);
    });

    it('mic_noise on the new engine says how loud the pauses were at the mic and on the wire, and names the noise profile', () => {
        // each second: 375 quanta, 100 of them pauses at -70 dBFS in, -45 dBFS out, 20 of them over -50 dBFS, loudest -30
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(v2second({
            engineNoise: 1, pauseN: 100, pauseInMs: 100 * 1e-7, pauseOutMs: 100 * 10 ** -4.5, pauseMaxMs: i === 4 ? 1e-3 : 1e-5, pauseLoud: 20,
        }));
        const noise = getCallEvents().filter(e => e.kind === 'mic_noise');
        expect(noise).toHaveLength(1);
        expect(noise[0].detail).toEqual({ pause_pct: Math.round((100 * 100) / second().blocks), pause_in_db: -70, pause_out_db: -45, pause_max_db: -30, loud_pct: 20 });
        expect(validateCallEvent(noise[0])).toEqual([]);
        expect(getCallEvents().filter(e => e.kind === 'mic_engine')[0].detail!.ns).toBe('light');
    });

    it('native Strong adds engine_native, frame / underrun / watchdog counts and hand-off percentiles (numbers only, worst second per percentile)', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(v2second({
            engineNative: true, nativeFrames: 100, nativeUnder: i === 4 ? 2 : 0, nativeWatchdog: i === 7 ? 30 : 0,
            nativeP50: 6, nativeP95: i === 2 ? 18 : 9, nativeP99: 14, nativeMax: i === 2 ? 31 : 20,
        }));
        const ev = getCallEvents().filter(e => e.kind === 'mic_engine');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toMatchObject({ engine: 'v2', engine_native: true });
        const nat = getCallEvents().filter(e => e.kind === 'mic_native');
        expect(nat).toHaveLength(1);
        expect(nat[0].detail).toEqual({ frames: 100 * (MIC_LEVEL_LOG_MS / 1000), under: 2, watchdog: 30, p50_ms: 6, p95_ms: 18, p99_ms: 14, max_ms: 31 });
        expect(validateCallEvent(nat[0])).toEqual([]);
        expect(validateCallEvent(ev[0])).toEqual([]);
    });

    it('the legacy chain never logs mic_engine or mic_native and keeps lim_pct', () => {
        for (let i = 0; i < MIC_LEVEL_LOG_MS / 1000; i++) recordMicLevelSecond(second());
        expect(getCallEvents().filter(e => e.kind === 'mic_engine' || e.kind === 'mic_native')).toEqual([]);
        expect('lim_pct' in getCallEvents().find(e => e.kind === 'mic_level')!.detail!).toBe(true);
        expect(summarizeMicEngine({ sec: 30, blocks: 1, voiced: 1000, inMs: 1, outMs: 1, peak: 0, held: 0, clip: 0, gainSum: 0, gainN: 0, gateSum: 0, gateN: 0, noiseSum: 0, noiseN: 0, bursts: 0, roomSum: 0, roomN: 0, rawMs: 0, nsMs: 0, tapN: 0, micGainDb: 0 })).toBeNull();
    });
});
