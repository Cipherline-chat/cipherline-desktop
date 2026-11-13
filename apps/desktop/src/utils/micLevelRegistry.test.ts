import { describe, it, expect, afterEach } from 'vitest';
import { setCurrentPipelineDbfs, getCurrentPipelineDbfs, resetPipelineDbfs, takePipelinePeak } from './micLevelRegistry';

afterEach(() => {
    resetPipelineDbfs();
});

describe('micLevelRegistry', () => {
    it('starts at -Infinity (silence) before anything reports', () => {
        expect(getCurrentPipelineDbfs()).toBe(-Infinity);
    });

    it('reflects the most recently set value', () => {
        setCurrentPipelineDbfs(-20);
        expect(getCurrentPipelineDbfs()).toBe(-20);
        setCurrentPipelineDbfs(-45.5);
        expect(getCurrentPipelineDbfs()).toBe(-45.5);
    });

    it('resetPipelineDbfs() clears back to -Infinity', () => {
        setCurrentPipelineDbfs(-10);
        resetPipelineDbfs();
        expect(getCurrentPipelineDbfs()).toBe(-Infinity);
    });
});

describe('micLevelRegistry — peak hold and age (what the silence watchdog reads)', () => {
    it('before anything reports: -Infinity and an infinite age (a dead meter, not a quiet user)', () => {
        expect(takePipelinePeak(1000)).toEqual({ dbfs: -Infinity, ageMs: Infinity });
    });

    it('returns the LOUDEST reading since the last take, so a word between two samples is not missed', () => {
        setCurrentPipelineDbfs(-60, 1000);
        setCurrentPipelineDbfs(-20, 1100);
        setCurrentPipelineDbfs(-70, 1200);
        expect(takePipelinePeak(1300)).toEqual({ dbfs: -20, ageMs: 100 });
        // the peak resets on take; the live value does not
        expect(takePipelinePeak(1400)).toEqual({ dbfs: -Infinity, ageMs: 200 });
        expect(getCurrentPipelineDbfs()).toBe(-70);
    });

    it('age keeps growing when the meter stops reporting', () => {
        setCurrentPipelineDbfs(-30, 1000);
        takePipelinePeak(1000);
        expect(takePipelinePeak(6000).ageMs).toBe(5000);
    });

    it('resetPipelineDbfs() forgets the peak and the age', () => {
        setCurrentPipelineDbfs(-10, 1000);
        resetPipelineDbfs();
        expect(takePipelinePeak(2000)).toEqual({ dbfs: -Infinity, ageMs: Infinity });
    });
});
