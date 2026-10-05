import { describe, it, expect, afterEach } from 'vitest';
import { setCurrentPipelineDbfs, getCurrentPipelineDbfs, resetPipelineDbfs } from './micLevelRegistry';

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
