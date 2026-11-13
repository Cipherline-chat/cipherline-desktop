import { describe, it, expect } from 'vitest';
import {
    SilenceWatchdog,
    PIPELINE_ACTIVE_FLOOR_DBFS,
    SOURCE_SILENT_RMS,
    START_GRACE_MS,
    RECOVER_AFTER_MS,
    QUIET_CLEAR_MS,
    MAX_SAMPLE_GAP_MS,
    PIPELINE_STALE_MS,
    type SilenceWatchdogSample,
} from './audioSilenceWatchdog';
import type { WireReading } from './outboundAudioStats';

const ACTIVE = PIPELINE_ACTIVE_FLOOR_DBFS + 10; // the user is talking, per our own meter
const QUIET = PIPELINE_ACTIVE_FLOOR_DBFS - 20;
const LIVE_RMS = 0.05; // what a healthy encoder is fed while the user talks
const DEAD_RMS = SOURCE_SILENT_RMS / 10;

/**
 * A fake mic sender, advanced one second at a time. `bytesPerSec` 0 = not
 * sending; `rms` is the level of the samples fed to the encoder.
 */
class FakeSender {
    bytes = 5_000;
    energy = 1;
    duration = 100;
    t = 0;
    tick(sec: number, bytesPerSec: number, rms: number | null): WireReading {
        this.bytes += bytesPerSec * sec;
        if (rms !== null) {
            this.energy += rms * rms * sec;
            this.duration += sec;
        }
        this.t += sec * 1000;
        return { bytesSent: this.bytes, energy: rms === null ? null : this.energy, duration: rms === null ? null : this.duration };
    }
}

function sample(wire: WireReading | null, over: Partial<SilenceWatchdogSample> = {}): SilenceWatchdogSample {
    return { pipelineDbfs: ACTIVE, pipelineAgeMs: 100, micEnabled: true, transportUp: true, wire, ...over };
}

/** Run `seconds` 1 s ticks and return the final state. */
function drive(wd: SilenceWatchdog, s: FakeSender, seconds: number, bytesPerSec: number, rms: number | null, over: Partial<SilenceWatchdogSample> = {}) {
    let st = wd.state();
    for (let i = 0; i < seconds; i++) {
        const wire = s.tick(1, bytesPerSec, rms);
        st = wd.update(sample(wire, over), s.t);
    }
    return st;
}

describe('SilenceWatchdog: a healthy sender never trips', () => {
    it('bytes flowing, encoder fed live audio, user talking', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        expect(drive(wd, s, 60, 4000, LIVE_RMS).tripped).toBe(false);
    });

    it('bytes flowing while the user is silent: the idle floor is not an outage', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        expect(drive(wd, s, 60, 1700, DEAD_RMS, { pipelineDbfs: QUIET }).tripped).toBe(false);
    });

    it('the 2026-11-02 mac report: ~60 kbps on the wire while the SFU reported no speaker level does not trip (the SFU level is not an input any more)', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        // 61 kbps = 7625 B/s of live audio. Nothing in the sample carries the SFU's level.
        expect(drive(wd, s, 30, 7625, LIVE_RMS).tripped).toBe(false);
    });

    it('natural pauses in speech (meter quiet most seconds) never trip', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        let st = wd.state();
        for (let i = 0; i < 40; i++) {
            const talking = i % 4 === 0;
            st = wd.update(sample(s.tick(1, 4000, talking ? LIVE_RMS : DEAD_RMS), { pipelineDbfs: talking ? ACTIVE : QUIET }), s.t);
        }
        expect(st.tripped).toBe(false);
    });
});

describe('SilenceWatchdog: no verdict (never an outage)', () => {
    it('muted: even a flat sender is fine, and unmuting starts clean', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        expect(drive(wd, s, 30, 0, null, { micEnabled: false }).tripped).toBe(false);
        // unmuted: the baseline is re-taken, so the first seconds cannot trip on the muted stretch.
        expect(drive(wd, s, 3, 4000, LIVE_RMS).tripped).toBe(false);
    });

    it('reconnecting (transport down): a flat sender is not judged', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        expect(drive(wd, s, 30, 0, null, { transportUp: false }).tripped).toBe(false);
    });

    it('counters unreadable (getStats threw / no sender yet): no verdict, however long', () => {
        const wd = new SilenceWatchdog();
        let st = wd.state();
        for (let i = 1; i <= 40; i++) st = wd.update(sample(null), i * 1000);
        expect(st.tripped).toBe(false);
    });

    it('a restarted sender (counters go backwards) is not read as a stall', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 5, 4000, LIVE_RMS);
        const fresh = new FakeSender(); fresh.bytes = 100; fresh.t = s.t;
        let st = wd.state();
        for (let i = 0; i < 3; i++) st = wd.update(sample(fresh.tick(1, 4000, LIVE_RMS)), (s.t += 1000));
        expect(st.tripped).toBe(false);
    });

    it('a sampling gap (sleep/wake, frozen renderer) is not evidence: the clock restarts', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 3, 0, null); // 3 s flat, 1 s short of tripping
        // The machine slept for an hour; the next two samples are flat, but the hour counts for nothing.
        s.t += 3_600_000;
        let st = wd.update(sample(s.tick(0, 0, null)), s.t);
        expect(st.tripped).toBe(false);
        st = wd.update(sample(s.tick(1, 0, null)), s.t);
        expect(st.tripped).toBe(false);
    });

    it('a gap exactly at the limit still counts as observation', () => {
        const wd = new SilenceWatchdog();
        const w = (b: number): WireReading => ({ bytesSent: b, energy: null, duration: null });
        wd.update(sample(w(5000)), 0);
        wd.update(sample(w(5000)), MAX_SAMPLE_GAP_MS);
        expect(wd.update(sample(w(5000)), MAX_SAMPLE_GAP_MS * 2).tripped).toBe(true);
    });
});

describe('SilenceWatchdog: no_rtp (the sender stopped sending)', () => {
    it('trips after TRIP_AFTER_MS of flat bytes, whatever the meter says (a suspended AudioContext sends nothing)', () => {
        for (const dbfs of [ACTIVE, QUIET, -Infinity]) {
            const wd = new SilenceWatchdog(); const s = new FakeSender();
            drive(wd, s, 3, 4000, LIVE_RMS);
            expect(drive(wd, s, 3, 0, null, { pipelineDbfs: dbfs }).tripped).toBe(false);
            const st = drive(wd, s, 2, 0, null, { pipelineDbfs: dbfs });
            expect(st).toEqual({ tripped: true, cause: 'no_rtp' });
        }
    });

    it('a blip shorter than the trip time resets the clock', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 3, 0, null);
        drive(wd, s, 1, 4000, LIVE_RMS);
        expect(drive(wd, s, 3, 0, null).tripped).toBe(false);
    });

    it('a sender that has never sent a byte gets START_GRACE_MS (ICE may still be coming up)', () => {
        const wd = new SilenceWatchdog();
        const zero: WireReading = { bytesSent: 0, energy: 0, duration: 0 };
        let st = wd.update(sample(zero), 0);
        for (let t = 1000; t < START_GRACE_MS; t += 1000) st = wd.update(sample(zero), t);
        expect(st.tripped).toBe(false);
        st = wd.update(sample(zero), START_GRACE_MS);
        expect(st).toEqual({ tripped: true, cause: 'no_rtp' });
    });
});

describe('SilenceWatchdog: silent_source (RTP flows, the encoder is fed silence)', () => {
    it('trips when the meter says talking but the encoder heard nothing for TRIP_AFTER_MS', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 3, 4000, LIVE_RMS);
        expect(drive(wd, s, 3, 1700, DEAD_RMS).tripped).toBe(false);
        expect(drive(wd, s, 2, 1700, DEAD_RMS)).toEqual({ tripped: true, cause: 'silent_source' });
    });

    it('a stale meter is a dead meter, not a talking user: no verdict', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        expect(drive(wd, s, 30, 1700, DEAD_RMS, { pipelineAgeMs: PIPELINE_STALE_MS + 1 }).tripped).toBe(false);
    });

    it('the encoder counters missing: cannot tell, does not trip', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        expect(drive(wd, s, 30, 1700, null).tripped).toBe(false);
    });

    it('a quiet moment in the middle holds the evidence; a live word clears it', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 1, 1700, DEAD_RMS); // baseline
        drive(wd, s, 3, 1700, DEAD_RMS); // 3 s of silent-while-talking
        drive(wd, s, 5, 1700, DEAD_RMS, { pipelineDbfs: QUIET }); // pause: held, not counted
        expect(drive(wd, s, 1, 4000, LIVE_RMS).tripped).toBe(false); // the encoder hears a word: evidence cleared
        expect(drive(wd, s, 3, 1700, DEAD_RMS).tripped).toBe(false); // needs the full 4 s again
    });
});

describe('SilenceWatchdog: recovery (the state machine)', () => {
    function trippedNoRtp() {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 2, 4000, LIVE_RMS);
        expect(drive(wd, s, 5, 0, null).cause).toBe('no_rtp');
        return { wd, s };
    }

    it('no_rtp clears once bytes flow again for RECOVER_AFTER_MS, whether or not the user talks', () => {
        const { wd, s } = trippedNoRtp();
        expect(drive(wd, s, 1, 1700, DEAD_RMS, { pipelineDbfs: QUIET }).tripped).toBe(true); // one good sample: hold
        expect(drive(wd, s, RECOVER_AFTER_MS / 1000, 1700, DEAD_RMS, { pipelineDbfs: QUIET }).tripped).toBe(false);
    });

    it('does not flap: a flat second after a good one restarts the recovery', () => {
        const { wd, s } = trippedNoRtp();
        drive(wd, s, 1, 1700, DEAD_RMS);
        drive(wd, s, 1, 0, null);
        expect(drive(wd, s, 1, 1700, DEAD_RMS).tripped).toBe(true);
    });

    it('silent_source needs a talking user to be proven fixed: quiet seconds hold the banner', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 1, 1700, DEAD_RMS);
        drive(wd, s, 4, 1700, DEAD_RMS);
        expect(wd.state().cause).toBe('silent_source');
        expect(drive(wd, s, 5, 1700, DEAD_RMS, { pipelineDbfs: QUIET }).tripped).toBe(true);
        expect(drive(wd, s, 2, 4000, LIVE_RMS).tripped).toBe(false);
    });

    it('a tripped state with no new evidence for QUIET_CLEAR_MS goes stale and clears', () => {
        const wd = new SilenceWatchdog(); const s = new FakeSender();
        drive(wd, s, 1, 1700, DEAD_RMS);
        drive(wd, s, 4, 1700, DEAD_RMS);
        expect(wd.state().tripped).toBe(true);
        const st = drive(wd, s, QUIET_CLEAR_MS / 1000 + 1, 1700, DEAD_RMS, { pipelineDbfs: QUIET });
        expect(st.tripped).toBe(false);
    });

    it('muting clears a tripped watchdog at once and reset() clears everything', () => {
        const { wd, s } = trippedNoRtp();
        expect(wd.update(sample(s.tick(1, 0, null), { micEnabled: false }), s.t).tripped).toBe(false);
        const t2 = trippedNoRtp();
        t2.wd.reset();
        expect(t2.wd.state()).toEqual({ tripped: false, cause: null });
        // after reset a fresh outage needs the full time again
        expect(drive(t2.wd, t2.s, 3, 0, null).tripped).toBe(false);
    });
});
