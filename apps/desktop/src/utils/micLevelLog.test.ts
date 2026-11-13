import { describe, it, expect, beforeEach } from 'vitest';
import { getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';
import { recordMicLevelSecond, resetMicLevelLog, summarizeMicLevel, MIC_LEVEL_LOG_MS, MIC_LEVEL_MIN_VOICED_BLOCKS } from './micLevelLog';
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
            gainSum: 0, gainN: 0, gateSum: 0, gateN: 0, rawMs: 0, nsMs: 0, tapN: 0, micGainDb: 0,
        })).toBeNull();
    });
});
