import { describe, it, expect } from 'vitest';
import {
    readSourceFrames, diagnoseNoFrames, decideCaptureStallAction, captureStallNotice, type StatsLike,
} from './shareHealth';

const report = (rows: Record<string, unknown>[]): StatsLike => ({ forEach: cb => rows.forEach(cb) });
const outbound = { type: 'outbound-rtp', kind: 'video', framesEncoded: 0 };

describe('readSourceFrames', () => {
    it('sums media-source frames over video sources; undefined when none is reported', () => {
        expect(readSourceFrames(report([{ type: 'media-source', kind: 'video', frames: 10 }, { type: 'media-source', kind: 'video', frames: 5 }]))).toBe(15);
        expect(readSourceFrames(report([{ type: 'media-source', kind: 'audio', frames: 10 }, outbound]))).toBeUndefined();
        expect(readSourceFrames(report([{ type: 'media-source', kind: 'video' }]))).toBeUndefined();
        expect(readSourceFrames(null)).toBeUndefined();
    });
});

describe('diagnoseNoFrames: whose fault is "nothing was encoded"?', () => {
    // The owner's Surround share (report 83da3af8): the crop pipeline handed
    // the sender nothing, and the H.264 High check blamed the encoder.
    it('no frame ever reached the sender -> the capture', () => {
        expect(diagnoseNoFrames(report([outbound, { type: 'media-source', kind: 'video', frames: 0 }]))).toEqual({ cause: 'capture', srcFrames: 0 });
    });

    it('frames reached the sender and none came out -> the encoder (unchanged behaviour)', () => {
        expect(diagnoseNoFrames(report([outbound, { type: 'media-source', kind: 'video', frames: 180 }]))).toEqual({ cause: 'encoder', srcFrames: 180 });
    });

    it('media-source wins over the (laggy) crop counters', () => {
        expect(diagnoseNoFrames(report([{ type: 'media-source', kind: 'video', frames: 90 }]), { framesIn: 0, framesOut: 0 }).cause).toBe('encoder');
        expect(diagnoseNoFrames(report([{ type: 'media-source', kind: 'video', frames: 0 }]), { framesIn: 400, framesOut: 400 }).cause).toBe('capture');
    });

    it('without media-source, the crop pipeline decides; without either it is unknown (= blame the encoder, as before)', () => {
        expect(diagnoseNoFrames(report([outbound]), { framesIn: 0, framesOut: 0 })).toEqual({ cause: 'capture', cropIn: 0, cropOut: 0 });
        expect(diagnoseNoFrames(report([outbound]), { framesIn: 30, framesOut: 30 }).cause).toBe('encoder');
        expect(diagnoseNoFrames(report([outbound])).cause).toBe('unknown');
        expect(diagnoseNoFrames(null).cause).toBe('unknown');
    });
});

describe('decideCaptureStallAction', () => {
    it('a single screen of an ultra-wide display falls back to the whole display - once', () => {
        expect(decideCaptureStallAction({ slice: true, triedWhole: false })).toEqual({ kind: 'whole' });
        expect(decideCaptureStallAction({ slice: true, triedWhole: true })).toEqual({ kind: 'notify' });
    });

    it('a whole-display or window share stays up and the user is told what blocks capture', () => {
        expect(decideCaptureStallAction({ slice: false, triedWhole: false })).toEqual({ kind: 'notify' });
        expect(captureStallNotice({ kind: 'notify' })).toMatch(/exclusive fullscreen/);
        expect(captureStallNotice({ kind: 'whole' })).toMatch(/whole display/);
    });
});
