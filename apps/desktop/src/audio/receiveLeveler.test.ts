import { describe, it, expect } from 'vitest';
import {
    ReceiveLeveler,
    stepBoostLatch,
    linearToDb,
    dbToLinear,
    RX_TARGET_DB,
    RX_DEADBAND_DB,
    RX_MIN_GAIN_DB,
    RX_MAX_GAIN_DB,
    RX_RISE_DB_PER_SEC,
    RX_FALL_DB_PER_SEC,
    RX_BOOST_LATCH_SEC,
    RTP_LEVEL_BIAS_DB,
} from './receiveLeveler.js';

const POLL = 0.05; // the app polls every 50 ms

/** What the RTP header extension reads for a talker whose TRUE active-speech
 *  level is `trueDb`: ~1.4 dB under, quantised to whole dB like the wire. */
const rtpReading = (trueDb: number, quantise = true) => {
    const v = trueDb - RTP_LEVEL_BIAS_DB;
    return quantise ? Math.round(v) : v;
};

/**
 * Speech-like feed: 0.4 s syllable bursts at `trueDb` (+-1.5 dB wobble) separated by
 * 0.2 s pauses at digital silence. Returns the gain after each poll.
 */
function talk(l: ReceiveLeveler, trueDb: number, seconds: number, opts: { pauses?: boolean } = {}): number[] {
    const pauses = opts.pauses !== false;
    const gains: number[] = [];
    const n = Math.round(seconds / POLL);
    for (let i = 0; i < n; i++) {
        const t = i * POLL;
        const inBurst = !pauses || (t % 0.6) < 0.4;
        const wobble = ((i * 7) % 5 - 2) * 0.75; // deterministic -1.5..+1.5
        const reading = inBurst ? rtpReading(trueDb + wobble) : -90;
        gains.push(l.push(reading, POLL));
    }
    return gains;
}

describe('ReceiveLeveler — converges toward the target, within its range', () => {
    it('lifts a quiet talker, capped at the max boost', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -31, 60); // 11 dB under target: wants +8.5 after the dead band, capped
        expect(g[g.length - 1]).toBeCloseTo(RX_MAX_GAIN_DB, 1);
        expect(Math.max(...g)).toBeLessThanOrEqual(RX_MAX_GAIN_DB + 1e-9);
    });

    it('cuts a loud talker, capped at the max cut', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -5, 60); // 15 dB over target
        expect(g[g.length - 1]).toBeCloseTo(RX_MIN_GAIN_DB, 1);
        expect(Math.min(...g)).toBeGreaterThanOrEqual(RX_MIN_GAIN_DB - 1e-9);
    });

    it('brings a moderately loud talker to exactly the dead-band edge of the target', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -13, 60); // 7 dB over: after the dead band the correction is -4.5 dB
        const final = g[g.length - 1];
        expect(final).toBeCloseTo(-(7 - RX_DEADBAND_DB), 0);
        // i.e. the talker ends up 2.5 dB (the dead band) from target, not dead on it
        expect(-13 + final - RX_TARGET_DB).toBeCloseTo(RX_DEADBAND_DB, 0);
    });

    it('treats an unspoken-for level as an attenuation target only when the talker really is that loud', () => {
        const a = new ReceiveLeveler();
        const b = new ReceiveLeveler();
        talk(a, -8, 40);
        talk(b, -20, 40);
        expect(a.gainDb).toBeLessThan(-5);
        expect(Math.abs(b.gainDb)).toBeLessThan(0.1);
    });
});

describe('ReceiveLeveler — dead band (does not fight the sender AGC)', () => {
    it('leaves a talker the sender AGC already put on target at exactly 0 dB', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, RX_TARGET_DB, 60);
        expect(Math.max(...g.map(Math.abs))).toBeLessThan(0.05);
    });

    it('stays at 0 dB across +-2 dB of sender-AGC wobble around the target', () => {
        for (const offset of [-2, -1, 1, 2]) {
            const l = new ReceiveLeveler();
            const g = talk(l, RX_TARGET_DB + offset, 60);
            expect(Math.abs(g[g.length - 1])).toBeLessThan(0.3);
        }
    });

    it('only acts on the part of the error beyond the dead band (no jump at its edge)', () => {
        const near = new ReceiveLeveler();
        const far = new ReceiveLeveler();
        talk(near, RX_TARGET_DB - (RX_DEADBAND_DB + 0.2), 80);
        talk(far, RX_TARGET_DB - (RX_DEADBAND_DB + 2.2), 80);
        expect(near.gainDb).toBeLessThan(0.8); // ~0.2 dB wanted (quantisation/wobble tolerance)
        expect(far.gainDb).toBeGreaterThan(1.2);
        expect(far.gainDb).toBeLessThan(3);
    });
});

describe('ReceiveLeveler — slew and evidence', () => {
    it('never moves faster than the configured rate (x bootstrap multiplier while bootstrapping)', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -31, 30, { pauses: false });
        const rate = (a: number, b: number) => Math.abs(b - a) / POLL;
        for (let i = 1; i < g.length; i++) {
            const bootstrapping = i * POLL < 3.2;
            const limit = RX_RISE_DB_PER_SEC * (bootstrapping ? 3 : 1);
            expect(rate(g[i - 1], g[i])).toBeLessThanOrEqual(limit + 1e-6);
        }
        const l2 = new ReceiveLeveler();
        const g2 = talk(l2, -5, 30, { pauses: false });
        for (let i = 1; i < g2.length; i++) {
            const limit = RX_FALL_DB_PER_SEC * (i * POLL < 3.2 ? 3 : 1);
            expect(rate(g2[i - 1], g2[i])).toBeLessThanOrEqual(limit + 1e-6);
        }
    });

    it('cuts faster than it boosts', () => {
        expect(RX_FALL_DB_PER_SEC).toBeGreaterThan(RX_RISE_DB_PER_SEC);
    });

    it('makes no change during the first second of speech', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -5, 0.9, { pauses: false });
        expect(g.every(v => v === 0)).toBe(true);
    });

    it('moves in the right direction once there is evidence (control for the test above)', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -5, 3, { pauses: false });
        expect(g[g.length - 1]).toBeLessThan(-2);
    });
});

describe('ReceiveLeveler — pauses and noise are not speech', () => {
    it('freezes the gain across a long silence (does not decay, does not jump)', () => {
        const l = new ReceiveLeveler();
        talk(l, -8, 40);
        const settled = l.gainDb;
        expect(settled).toBeLessThan(-5); // control: it really had a gain to hold
        for (let i = 0; i < 20 * 60; i++) l.push(-90, POLL); // a full minute of silence
        expect(l.gainDb).toBe(settled);
    });

    it('does not treat a steady quiet room hiss as a quiet talker to boost', () => {
        const l = new ReceiveLeveler();
        // The sender has NS off; between words it sends a steady -48 dB hiss and never speaks.
        for (let i = 0; i < 20 * 60; i++) l.push(-48 + ((i % 3) - 1) * 0.5, POLL);
        expect(l.gainDb).toBe(0);
    });

    it('ignores anything under the absolute floor even with no history', () => {
        const l = new ReceiveLeveler();
        for (let i = 0; i < 20 * 60; i++) l.push(-60, POLL);
        expect(l.gainDb).toBe(0);
        expect(l.levelPower).toBe(0);
    });

    it('measures speech riding on that hiss (control: the same level WITH speech bursts is active)', () => {
        const l = new ReceiveLeveler();
        let speaking = 0;
        for (let i = 0; i < 20 * 60; i++) {
            const burst = (i * POLL) % 0.6 < 0.4;
            const v = burst ? rtpReading(-31) : -48;
            if (burst) speaking++;
            l.push(v, POLL);
        }
        expect(speaking).toBeGreaterThan(0);
        expect(l.gainDb).toBeGreaterThan(3); // quiet talker over hiss: boosted
    });

    it('never lets a talker who never pauses teach the floor tracker that their voice is noise', () => {
        const l = new ReceiveLeveler();
        const g = talk(l, -5, 90, { pauses: false });
        expect(g[g.length - 1]).toBeCloseTo(RX_MIN_GAIN_DB, 1);
    });
});

describe('ReceiveLeveler — inputs and state', () => {
    it('pushLinear is push() of the same level in dB', () => {
        const a = new ReceiveLeveler();
        const b = new ReceiveLeveler();
        for (let i = 0; i < 400; i++) {
            const lin = dbToLinear(-12 + ((i % 4) - 1.5));
            a.pushLinear(lin, POLL);
            b.push(linearToDb(lin), POLL);
        }
        expect(a.gainDb).toBeCloseTo(b.gainDb, 9);
    });

    it('undefined / NaN / negative / zero dt readings are ignored without NaN state', () => {
        const l = new ReceiveLeveler();
        talk(l, -8, 10);
        const before = { g: l.gainDb, p: l.levelPower };
        l.pushLinear(undefined as unknown as number, POLL);
        l.pushLinear(NaN, POLL);
        l.push(NaN, POLL);
        l.push(-10, 0);
        l.push(-10, -1);
        l.push(-10, NaN);
        expect(l.gainDb).toBe(before.g);
        expect(l.levelPower).toBe(before.p);
        for (const v of [l.gainDb, l.levelPower, l.noiseFloorDb, l.activeSec]) expect(Number.isFinite(v)).toBe(true);
    });

    it('a huge dt (a stalled timer) is clamped, not a free pass to jump the gain', () => {
        const l = new ReceiveLeveler();
        talk(l, -5, 3, { pauses: false });
        const before = l.gainDb;
        l.push(rtpReading(-5), 60);
        expect(Math.abs(l.gainDb - before)).toBeLessThanOrEqual(RX_FALL_DB_PER_SEC * 0.5 + 1e-6);
    });

    it('reset() forgets the talker', () => {
        const l = new ReceiveLeveler();
        talk(l, -8, 30);
        expect(l.gainDb).not.toBe(0);
        l.reset();
        expect(l.gainDb).toBe(0);
        expect(l.levelPower).toBe(0);
        expect(l.activeSec).toBe(0);
        expect(l.levelDb).toBe(-Infinity);
    });

    it('is configurable (range, target)', () => {
        const l = new ReceiveLeveler({ targetDb: -30, maxGainDb: 3, minGainDb: -3 });
        talk(l, -5, 60);
        expect(l.gainDb).toBeCloseTo(-3, 1);
    });
});

describe('stepBoostLatch — when a boost is worth the Web Audio path', () => {
    it('latches only after the boost has been wanted for RX_BOOST_LATCH_SEC', () => {
        let acc = 0;
        let latched = false;
        let t = 0;
        while (!latched && t < 60) {
            ({ accumSec: acc, latched } = stepBoostLatch(acc, true, POLL));
            t += POLL;
        }
        expect(t).toBeGreaterThanOrEqual(RX_BOOST_LATCH_SEC - 1e-9);
        expect(t).toBeLessThan(RX_BOOST_LATCH_SEC + 2 * POLL);
    });

    it('a blip never accumulates across minutes (decays while the boost is not wanted)', () => {
        let acc = 0;
        let latched = false;
        // 0.5 s wanted, 5 s not, repeated for ten minutes.
        for (let rep = 0; rep < 100 && !latched; rep++) {
            for (let i = 0; i < 10; i++) ({ accumSec: acc, latched } = stepBoostLatch(acc, true, POLL));
            for (let i = 0; i < 100; i++) ({ accumSec: acc, latched } = stepBoostLatch(acc, false, POLL));
        }
        expect(latched).toBe(false);
        expect(acc).toBe(0);
    });

    it('never goes negative', () => {
        expect(stepBoostLatch(0, false, 1).accumSec).toBe(0);
    });
});
