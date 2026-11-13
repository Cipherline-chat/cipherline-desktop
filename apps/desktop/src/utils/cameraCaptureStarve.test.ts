import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CameraCaptureStarveDetector, capturedFrames, WARMUP_MS, GAP_RESET_MS, STRAINED_TICKS,
} from './callLoadMonitor';
import { choosePerfOffer } from './performanceOffer';

/** Feed one sample per second; `fpsAt(i)` is how many frames the capture delivered in tick i. */
function run(seconds: number, fpsAt: (i: number) => number, opts: { nominal?: number; step?: (i: number) => number } = {}) {
    const d = new CameraCaptureStarveDetector();
    let frames = 0;
    let at = 0;
    const out: boolean[] = [];
    for (let i = 0; i < seconds; i++) {
        const dt = opts.step ? opts.step(i) : 1000;
        at += dt;
        frames += fpsAt(i) * (dt / 1000);
        out.push(d.observe({ at, framesCaptured: Math.round(frames), nominalFps: opts.nominal ?? 30 }).starved);
    }
    return out;
}
const firstTrue = (v: boolean[]) => v.indexOf(true);

// Report 884b6045: the camera sender's capture_fps (media-source frames/s), one
// sample every 5 s from the first camera sample on; target 30. Held for 5
// one-second ticks each here.
const REPORT_884B6045_CAPTURE_FPS = [14.1, 0, 10, 10, 4, 0, 2, 0, 0, 1, 0, 0, 10];

describe('CameraCaptureStarveDetector — a camera that nominally runs at 30 but delivers 0-14 (report 884b6045)', () => {
    it('fires on the reported sequence, after the warm-up and 10 of 12 low ticks', () => {
        const v = run(5 * REPORT_884B6045_CAPTURE_FPS.length, i => REPORT_884B6045_CAPTURE_FPS[Math.floor(i / 5)]);
        expect(firstTrue(v)).toBe(WARMUP_MS / 1000); // every tick of the report is under 15 fps: the warm-up is the only wait
        expect(v.slice(WARMUP_MS / 1000).every(Boolean)).toBe(true);
    });

    it('the encoder is healthy in that report (encoded 9 of 10 captured, limit none) - the existing CPU detector is blind to it', () => {
        // CallLoadDetector reads qualityLimitation only: a layer with reason 'none' is never strained.
        // (Pinned in callLoadMonitor.test.ts; here only the wiring that routes capture starvation to the offer.)
        const src = readFileSync(join(__dirname, '../components/call/CallPerformanceGuard.tsx'), 'utf8');
        expect(src).toMatch(/CameraCaptureStarveDetector/);
        expect(src).toMatch(/encodeStrained: sv\.struggling \|\| cap\.starved/);
    });

    it('a healthy 30 fps camera with the odd dropped second never fires', () => {
        const v = run(120, i => (i % 15 === 0 ? 4 : 30));
        expect(v.some(Boolean)).toBe(false);
    });

    it('9 starved seconds of every 12 is not enough (STRAINED_TICKS = 10)', () => {
        const v = run(120, i => (i % 12 < 9 ? 3 : 30));
        expect(v.some(Boolean)).toBe(false);
        expect(STRAINED_TICKS).toBe(10);
    });

    it('a camera that really is slow by design is not starved: nominal 15 fps delivering 14', () => {
        expect(run(60, () => 14, { nominal: 15 }).some(Boolean)).toBe(false);
    });

    it('a 60 fps camera delivering 25 fps is below half of nominal but above the absolute floor: not starved', () => {
        expect(run(60, () => 25, { nominal: 60 }).some(Boolean)).toBe(false);
        expect(run(60, () => 9, { nominal: 60 }).some(Boolean)).toBe(true);
    });

    it('no frame counter in the report (stats without media-source) resets instead of guessing', () => {
        const d = new CameraCaptureStarveDetector();
        let frames = 0;
        for (let i = 1; i <= 40; i++) {
            frames += 2;
            expect(d.observe({ at: i * 1000, framesCaptured: i % 5 === 0 ? undefined : frames, nominalFps: 30 }).starved).toBe(false);
        }
    });

    it('a gap in sampling (hidden window, sleep) restarts the window instead of bridging it', () => {
        const v = run(60, () => 2, { step: i => (i === 30 ? GAP_RESET_MS + 5000 : 1000) });
        expect(firstTrue(v)).toBeGreaterThanOrEqual(0);
        // after the gap it has to earn the warm-up again
        const gapAt = v.slice(31).indexOf(true);
        expect(gapAt === -1 || gapAt + 1 >= WARMUP_MS / 1000).toBe(true);
    });

    it('a counter that restarts (a new track) is a new baseline, not a negative rate', () => {
        const d = new CameraCaptureStarveDetector();
        d.observe({ at: 1000, framesCaptured: 500, nominalFps: 30 });
        expect(d.observe({ at: 2000, framesCaptured: 3, nominalFps: 30 })).toEqual({ starved: false });
    });

    it('capturedFrames sums the media-source frames of the sender report and ignores everything else', () => {
        const rows = [
            { type: 'media-source', kind: 'video', frames: 120 },
            { type: 'media-source', kind: 'audio', frames: 9999 },
            { type: 'outbound-rtp', kind: 'video', framesEncoded: 77 },
        ];
        expect(capturedFrames({ forEach: cb => rows.forEach(cb) })).toBe(120);
        expect(capturedFrames({ forEach: () => {} })).toBeUndefined();
    });

    it('feeds the existing offer: starved capture on a >720p camera is a "camera" offer, a 720p camera has nothing to lower', () => {
        const base = { decodeStrained: false, incomingMode: 'auto' as const, remoteVideoCount: 0 };
        expect(choosePerfOffer({ ...base, encodeStrained: true, cameraHeight: 1440 })).toBe('camera');
        expect(choosePerfOffer({ ...base, encodeStrained: true, cameraHeight: 720 })).toBeNull();
    });
});
