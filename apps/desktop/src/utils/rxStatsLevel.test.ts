import { describe, it, expect } from 'vitest';
import {
    RxStatsLevel, readInboundAudioEnergy, pollRxLevel, newRxLevelPoll,
    RX_STATS_OVER_RTP_DB, RX_STATS_POLL_MS, RX_STATS_MIN_WINDOW_SEC, type InboundAudioEnergy, type RxLevelSrc,
} from './rxStatsLevel';
import { newRxPollTally, rxNoSpeechReason } from './rxLevelLog';
import { tallyRxPoll } from './rxLevelLog';
import { ReceiveLeveler, RX_INITIAL_GAIN_DB } from '../audio/receiveLeveler.js';

/** A Map shaped like an RTCStatsReport. */
const report = (...entries: Array<Record<string, unknown>>) => new Map(entries.map((e, i) => [String(e.id ?? i), e]));
const inbound = (id: string, energy: number, duration: number, audioLevel?: number) =>
    ({ id, type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: energy, totalSamplesDuration: duration, ...(audioLevel !== undefined ? { audioLevel } : {}) });

describe('readInboundAudioEnergy', () => {
    it('picks the AUDIO inbound-rtp entry and its three fields', () => {
        const r = report(
            { id: 'v', type: 'inbound-rtp', kind: 'video', totalAudioEnergy: 9 },
            { id: 'c', type: 'codec', mimeType: 'audio/opus' },
            inbound('A1', 0.5, 10, 0.1),
        );
        expect(readInboundAudioEnergy(r)).toEqual({ id: 'A1', energy: 0.5, duration: 10, audioLevel: 0.1 });
    });
    it('missing stats: no entry, not a report, non-numeric fields', () => {
        expect(readInboundAudioEnergy(report({ id: 'x', type: 'outbound-rtp', kind: 'audio' }))).toBeNull();
        expect(readInboundAudioEnergy(undefined)).toBeNull();
        expect(readInboundAudioEnergy({})).toBeNull();
        expect(readInboundAudioEnergy(report({ id: 'A', type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 'x', totalSamplesDuration: NaN })))
            .toEqual({ id: 'A', energy: undefined, duration: undefined, audioLevel: undefined });
    });
});

describe('RxStatsLevel: energy deltas -> dB', () => {
    const s = (energy: number, duration: number, id = 'A'): InboundAudioEnergy => ({ id, energy, duration });

    it('the level is 10 log10(dEnergy / dDuration) over the window, mapped onto the RTP scale', () => {
        const l = new RxStatsLevel();
        expect(l.push(s(1, 100), 0.25)).toBeUndefined(); // first sample: a baseline only
        // 0.25 s of audio whose envelope power was 0.01 (-20 dB)
        const r = l.push(s(1 + 0.01 * 0.25, 100.25), 0.25)!;
        expect(r.via).toBe('energy');
        expect(r.dtSec).toBeCloseTo(0.25, 9);
        expect(r.rtpDb).toBeCloseTo(-20 - RX_STATS_OVER_RTP_DB, 6);
        // next window: power 1e-4 (-40 dB) over 0.5 s
        expect(l.push(s(1.0025 + 1e-4 * 0.5, 100.75), 0.5)!.rtpDb).toBeCloseTo(-40 - RX_STATS_OVER_RTP_DB, 6);
    });

    it('a window with no energy at all is silence (a pause for the leveler), not "no reading"', () => {
        const l = new RxStatsLevel();
        l.push(s(2, 10), 0.25);
        const r = l.push(s(2, 10.25), 0.25)!;
        expect(r.rtpDb).toBeLessThan(-120);
    });

    it('a window shorter than RX_STATS_MIN_WINDOW_SEC is no reading, and the baseline is kept so the next one spans both', () => {
        const l = new RxStatsLevel();
        l.push(s(0, 0), 0.25);
        expect(l.push(s(0.0001, RX_STATS_MIN_WINDOW_SEC / 2), 0.02)).toBeUndefined();
        const r = l.push(s(0.0004, 0.2), 0.25)!;
        expect(r.dtSec).toBeCloseTo(0.2, 9);
        expect(r.rtpDb).toBeCloseTo(10 * Math.log10(0.0004 / 0.2) - RX_STATS_OVER_RTP_DB, 6);
    });

    it('counter resets on a track change: another stream id, or counters going backwards, start a new baseline', () => {
        const l = new RxStatsLevel();
        l.push(s(5, 50, 'A'), 0.25);
        expect(l.push(s(5.01, 50.25, 'A'), 0.25)).toBeDefined();
        // the publication's track was replaced: a new inbound-rtp with its own (small) counters
        expect(l.push(s(0.001, 0.25, 'B'), 0.25)).toBeUndefined();
        expect(l.push(s(0.002, 0.5, 'B'), 0.25)!.rtpDb).toBeCloseTo(10 * Math.log10(0.001 / 0.25) - RX_STATS_OVER_RTP_DB, 6);
        // same id, counters restarted (receiver re-created): never a negative / huge delta
        expect(l.push(s(0.0001, 0.1, 'B'), 0.25)).toBeUndefined();
        expect(l.push(s(0.0002, 0.35, 'B'), 0.25)).toBeDefined();
    });

    it('missing stats: null / no counters give no reading; audioLevel alone is the fallback (wall dt)', () => {
        const l = new RxStatsLevel();
        expect(l.push(null, 0.25)).toBeUndefined();
        expect(l.push({ id: 'A' }, 0.25)).toBeUndefined();
        const r = l.push({ id: 'A', audioLevel: 0.1 }, 0.25)!;
        expect(r.via).toBe('audio_level');
        expect(r.rtpDb).toBeCloseTo(-20 - RX_STATS_OVER_RTP_DB, 6);
        expect(r.dtSec).toBe(0.25);
    });
});

describe('pollRxLevel: the RTP header level when there is one, else getStats', () => {
    const flush = () => new Promise(r => setTimeout(r, 0));

    it('a receiver whose sources carry an RTP level never calls getStats (and a stale one is a pause)', async () => {
        let statsCalls = 0;
        const rx = { getSynchronizationSources: () => [{ timestamp: 1000, audioLevel: 0.1 }], getStats: async () => { statsCalls++; return report(); } };
        const got: Array<[number, RxLevelSrc]> = [];
        const t = newRxPollTally();
        expect(pollRxLevel(rx, newRxLevelPoll(), t, 1000, 0.05, (db, _dt, src) => got.push([db, src]))).toBe(true);
        expect(got[0][0]).toBeCloseTo(-20, 6);
        expect(got[0][1]).toBe('rtp');
        expect(pollRxLevel(rx, newRxLevelPoll(), t, 5000, 0.05, () => got.push([0, 'rtp']))).toBe(false); // stale
        await flush();
        expect(statsCalls).toBe(0);
        expect(got).toHaveLength(1);
    });

    it('the RTP path hands the leveler exactly what pushLinear did before (same gain trajectory)', () => {
        const a = new ReceiveLeveler(), b = new ReceiveLeveler();
        const t = newRxPollTally(), t2 = newRxPollTally();
        for (let i = 0; i < 200; i++) {
            const lvl = i % 5 === 0 ? 0.002 : 0.05 + 0.01 * (i % 3);
            const src = [{ timestamp: i * 50, audioLevel: lvl }];
            const old = tallyRxPoll(t, src, i * 50);
            if (old !== undefined) a.pushLinear(old, 0.05);
            pollRxLevel({ getSynchronizationSources: () => src }, newRxLevelPoll(), t2, i * 50, 0.05, (db, dt) => b.push(db, dt));
        }
        expect(b.gainDb).toBeCloseTo(a.gainDb, 9);
        expect(b.levelDb).toBeCloseTo(a.levelDb, 9);
    });

    it('no RTP level (LiveKit): getStats every RX_STATS_POLL_MS, one in flight at most, readings delivered async', async () => {
        let energy = 0, duration = 0, calls = 0;
        let release: (() => void) | null = null;
        const rx = {
            getSynchronizationSources: () => [{ timestamp: 0 }], // a source, but no audioLevel
            getStats: () => { calls++; energy += 0.01 * 0.25; duration += 0.25; const rep = report(inbound('A', energy, duration)); return new Promise<unknown>(r => { release = () => r(rep); }); },
        };
        const p = newRxLevelPoll();
        const t = newRxPollTally();
        const got: number[] = [];
        const on = (db: number) => got.push(db);
        pollRxLevel(rx, p, t, 0, 0.05, on);
        pollRxLevel(rx, p, t, 50, 0.05, on); // too soon
        expect(calls).toBe(1);
        pollRxLevel(rx, p, t, RX_STATS_POLL_MS + 1, 0.05, on); // due, but the first is still in flight
        expect(calls).toBe(1);
        release!(); await flush();
        pollRxLevel(rx, p, t, RX_STATS_POLL_MS + 10, 0.05, on);
        expect(calls).toBe(2);
        pollRxLevel(rx, p, t, RX_STATS_POLL_MS + 60, 0.05, on); // in flight again
        expect(calls).toBe(2);
        release!(); await flush();
        expect(got).toHaveLength(1); // the first sample is only a baseline
        expect(got[0]).toBeCloseTo(-20 - RX_STATS_OVER_RTP_DB, 6);
        expect(t.stats).toBe(1);
        expect(rxNoSpeechReason(t)).toBe('quiet'); // not "no_source": the stats gave levels
    });

    it('a reading that lands after the caller started a new tally window is counted in the new window', async () => {
        let e = 0, d = 0;
        const rx = { getStats: async () => { e += 0.001; d += 0.25; return report(inbound('A', e, d)); } };
        const p = newRxLevelPoll();
        let tally = newRxPollTally();
        pollRxLevel(rx, p, () => tally, 0, 0.05, () => {});
        await flush();
        pollRxLevel(rx, p, () => tally, RX_STATS_POLL_MS, 0.05, () => {});
        const old = tally;
        tally = newRxPollTally(); // the 30 s window rolled over while getStats ran
        await flush();
        expect(old.stats).toBe(0);
        expect(tally.stats).toBe(1);
    });

    it('a getStats that throws or rejects is no reading and does not wedge the poll', async () => {
        const p = newRxLevelPoll();
        const t = newRxPollTally();
        const got: number[] = [];
        pollRxLevel({ getStats: () => { throw new Error('gone'); } }, p, t, 0, 0.05, db => got.push(db));
        expect(p.inFlight).toBe(false);
        pollRxLevel({ getStats: () => Promise.reject(new Error('gone')) }, p, t, 1000, 0.05, db => got.push(db));
        await flush(); await flush();
        expect(p.inFlight).toBe(false);
        expect(got).toHaveLength(0);
        expect(rxNoSpeechReason(t)).toBe('no_source');
    });
});

describe('the leveler on the stats source: same targets, limits and guards as designed', () => {
    // Feed stats-scale readings (envelope dB = RTP dB + RX_STATS_OVER_RTP_DB) of a talker whose active speech sits at
    // `rtpDb` on the RTP scale, 250 ms windows, with pauses; the leveler must end where it ends fed the RTP level.
    const feed = (rtpDb: number, viaStats: boolean, seconds = 20) => {
        const lv = new ReceiveLeveler();
        const statsLvl = new RxStatsLevel();
        let e = 0, d = 0;
        statsLvl.push({ id: 'A', energy: e, duration: d }, 0.25);
        for (let i = 0; i < seconds * 4; i++) {
            const pause = i % 4 === 3;
            const db = pause ? -70 : rtpDb;
            if (viaStats) {
                e += Math.pow(10, (db + RX_STATS_OVER_RTP_DB) / 10) * 0.25; d += 0.25;
                const r = statsLvl.push({ id: 'A', energy: e, duration: d }, 0.25)!;
                lv.push(r.rtpDb, r.dtSec);
            } else {
                for (let k = 0; k < 5; k++) lv.push(db, 0.05);
            }
        }
        return lv;
    };
    it.each([-30, -22, -16, -11, -6])('a talker at %i dB lands on the same gain either way', (db) => {
        expect(feed(db, true).gainDb).toBeCloseTo(feed(db, false).gainDb, 1);
    });
    it('never boosts silence or room noise: a talker that is only a -60 dB hiss keeps the join gain', () => {
        expect(feed(-60, true).gainDb).toBe(RX_INITIAL_GAIN_DB);
    });
    it('the boost is still capped at RX_MAX_GAIN_DB (+6) for a very quiet talker', () => {
        expect(feed(-40, true).gainDb).toBeLessThanOrEqual(6);
        expect(feed(-40, true).gainDb).toBeGreaterThan(5.9);
    });
});
