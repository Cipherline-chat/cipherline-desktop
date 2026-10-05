import { describe, it, expect } from 'vitest';
import {
    SilenceWatchdog,
    PIPELINE_ACTIVE_FLOOR_DBFS,
    OUTBOUND_SILENT_CEILING,
    TRIP_AFTER_MS,
    RECOVER_AFTER_MS,
} from './audioSilenceWatchdog';

const ACTIVE_DBFS = PIPELINE_ACTIVE_FLOOR_DBFS + 10; // comfortably above the floor
const QUIET_DBFS = PIPELINE_ACTIVE_FLOOR_DBFS - 20; // comfortably below it
const SILENT_OUTBOUND = 0; // definitely under the ceiling
const LOUD_OUTBOUND = 0.5; // definitely over the ceiling

describe('SilenceWatchdog — normal operation (no false positives)', () => {
    it('never trips when pipeline and outbound levels agree (both active)', () => {
        const wd = new SilenceWatchdog();
        let t = 0;
        for (let i = 0; i < 50; i++) {
            t += 200;
            expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: LOUD_OUTBOUND, micEnabled: true }, t)).toBe(false);
        }
    });

    it('never trips during genuine silence (both pipeline and outbound quiet) — the common case', () => {
        const wd = new SilenceWatchdog();
        let t = 0;
        for (let i = 0; i < 50; i++) {
            t += 200;
            expect(wd.update({ pipelineDbfs: QUIET_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, t)).toBe(false);
        }
    });

    it('never trips while muted, regardless of readings', () => {
        const wd = new SilenceWatchdog();
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: false }, 100)).toBe(false);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: false }, 10_000)).toBe(false);
    });
});

describe('SilenceWatchdog — trips on sustained mismatch', () => {
    it('does not trip on a brief mismatch shorter than TRIP_AFTER_MS', () => {
        const wd = new SilenceWatchdog();
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0)).toBe(false);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS - 100)).toBe(false);
    });

    it('trips once the mismatch has been sustained for TRIP_AFTER_MS', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        const tripped = wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 1);
        expect(tripped).toBe(true);
    });

    it('resets the mismatch timer if the mismatch clears before tripping (no false trip on a blip)', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        // Recovers briefly...
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: LOUD_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS / 2);
        // ...then mismatches again — this should restart the clock, not
        // continue counting from the first mismatch.
        const tripped = wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS);
        expect(tripped).toBe(false);
    });
});

describe('SilenceWatchdog — recovery', () => {
    it('clears after a sustained recovery (RECOVER_AFTER_MS of good readings)', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 1)).toBe(true);

        // Recovery starts...
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: LOUD_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 2);
        const cleared = wd.update(
            { pipelineDbfs: ACTIVE_DBFS, outboundLevel: LOUD_OUTBOUND, micEnabled: true },
            TRIP_AFTER_MS + 2 + RECOVER_AFTER_MS + 1,
        );
        expect(cleared).toBe(false);
    });

    it('does not clear on a single good sample immediately after tripping (avoids flapping)', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 1)).toBe(true);

        // One good sample immediately after — should still read tripped.
        const stillTripped = wd.update(
            { pipelineDbfs: ACTIVE_DBFS, outboundLevel: LOUD_OUTBOUND, micEnabled: true },
            TRIP_AFTER_MS + 2,
        );
        expect(stillTripped).toBe(true);
    });

    it('unmuting resets a tripped watchdog to a clean state', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 1)).toBe(true);

        // Mute — should clear immediately.
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: false }, TRIP_AFTER_MS + 2)).toBe(false);
    });
});

describe('SilenceWatchdog — boundary conditions', () => {
    it('treats a level exactly at the pipeline floor as active', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: PIPELINE_ACTIVE_FLOOR_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        expect(wd.update({ pipelineDbfs: PIPELINE_ACTIVE_FLOOR_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 1)).toBe(true);
    });

    it('treats a level exactly at the outbound silent ceiling as silent', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: OUTBOUND_SILENT_CEILING, micEnabled: true }, 0);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: OUTBOUND_SILENT_CEILING, micEnabled: true }, TRIP_AFTER_MS + 1)).toBe(true);
    });

    it('reset() clears all internal state unconditionally', () => {
        const wd = new SilenceWatchdog();
        wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, 0);
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 1)).toBe(true);
        wd.reset();
        // Right after reset, a fresh mismatch needs the full TRIP_AFTER_MS again.
        expect(wd.update({ pipelineDbfs: ACTIVE_DBFS, outboundLevel: SILENT_OUTBOUND, micEnabled: true }, TRIP_AFTER_MS + 2)).toBe(false);
    });
});
