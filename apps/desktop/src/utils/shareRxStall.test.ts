import { describe, it, expect } from 'vitest';
import { RxStallWatch, STALL_MS } from './shareRxStall';
import type { ShareRxSnapshot } from './shareRxStats';

// The Windows viewer of the 2026-11-02 Mac share: D3D11 H.265, size change 3024x1964 -> 2268x1472.
const snap = (at: number, o: Partial<ShareRxSnapshot> = {}): ShareRxSnapshot => ({
    at, framesReceived: 0, framesDecoded: 0, framesDropped: 0, jbDelay: 0, jbEmitted: 0, keyFrames: 4, kfRequests: 0,
    width: 3024, height: 1964, decoder: 'ExternalDecoder (D3D11VideoDecoder)', ...o,
});

/** Feed a scripted run at a 2 s cadence; return every detail logged, with its time. */
function play(steps: Array<{ rx: number; dec: number; emit?: number; drop?: number; w?: number; h?: number; kf?: number; pli?: number }>) {
    const w = new RxStallWatch();
    w.setRef('980bc5fd');
    let fr = 0, fd = 0, fe = 0, fdr = 0, kf = 4, pli = 0, cw = 3024, ch = 1964;
    const out: Array<{ t: number; d: Record<string, string | number | boolean> }> = [];
    w.observe(0, snap(0), 'remote-video-3');
    steps.forEach((s, i) => {
        const t = (i + 1) * 2;
        if (s.w) { cw = s.w; ch = s.h as number; }
        fr += s.rx * 2; fd += s.dec * 2; fe += (s.emit ?? s.dec) * 2; fdr += (s.drop ?? 0) * 2; kf += s.kf ?? 0; pli += s.pli ?? 0;
        const d = w.observe(t * 1000, snap(t * 1000, {
            framesReceived: fr, framesDecoded: fd, jbEmitted: fe, framesDropped: fdr, keyFrames: kf, kfRequests: pli,
            width: cw, height: ch,
        }), 'remote-video-3');
        if (d) out.push({ t, d });
    });
    return out;
}

describe('RxStallWatch: frames arrive, none is decoded', () => {
    it('the reported run: a downscale, then 90 fps received / 0 decoded / 90 dropped, no keyframe request, until the size flips back', () => {
        const run = [
            { rx: 60, dec: 50 }, { rx: 60, dec: 41 },
            { rx: 62, dec: 41.7, w: 2268, h: 1472, kf: 1 }, // the new size's keyframe decodes
            ...Array.from({ length: 12 }, () => ({ rx: 89.7, dec: 0, emit: 89.7, drop: 90 })),
            { rx: 90, dec: 90, w: 3024, h: 1964, kf: 1 },
        ];
        const ev = play(run);
        expect(ev.map(e => e.d.phase)).toEqual(['start', 'end']);
        const start = ev[0].d;
        expect(start).toMatchObject({ phase: 'start', share_ref: '980bc5fd', track: 'remote-video-3', pli: 0, resized: true, decoder: 'ExternalDecoder (D3D11VideoDecoder)', res: '2268x1472' });
        expect(start.rx_fps).toBeCloseTo(89.7);
        expect(start.emit_fps).toBeCloseTo(89.7); // handed to the decoder: the stall is AT the decoder, not the frame buffer
        expect(start.drop_fps).toBeCloseTo(90);
        const end = ev[1].d;
        expect(end.phase).toBe('end');
        expect(end.kf).toBe(1);
        expect(end.pli).toBe(0);
        expect(end.ms).toBeGreaterThanOrEqual(20_000);
    });
    it('says "dropped before the decoder" when the jitter buffer emits nothing', () => {
        const ev = play(Array.from({ length: 6 }, () => ({ rx: 60, dec: 0, emit: 0, drop: 60 })));
        expect(ev[0].d.emit_fps).toBe(0);
    });
    it('records keyframe requests when the viewer did ask', () => {
        const ev = play([...Array.from({ length: 5 }, (_, i) => ({ rx: 60, dec: 0, drop: 60, pli: i === 3 ? 1 : 0 })), { rx: 60, dec: 60, kf: 1 }]);
        expect(ev.map(e => e.d.phase)).toEqual(['start', 'end']);
        expect(ev[1].d.pli).toBe(1);
    });
    it('waits STALL_MS: one or two quiet ticks are not a stall', () => {
        expect(STALL_MS).toBeGreaterThan(2_000);
        expect(play([{ rx: 60, dec: 0 }, { rx: 60, dec: 60 }, { rx: 60, dec: 0 }, { rx: 60, dec: 60 }])).toEqual([]);
    });
    it('NEGATIVE: a still screen (few frames received, none decoded) is not a stall', () => {
        expect(play(Array.from({ length: 10 }, () => ({ rx: 1, dec: 0 })))).toEqual([]);
    });
    it('NEGATIVE: normal decoding, and a counter reset (new SSRC), never log', () => {
        expect(play(Array.from({ length: 10 }, () => ({ rx: 60, dec: 60 })))).toEqual([]);
    });
    it('a stall with no recent size change is recorded as not resized', () => {
        const ev = play(Array.from({ length: 8 }, () => ({ rx: 60, dec: 0, drop: 60 })));
        expect(ev[0].d.resized).toBe(false);
    });
    it('each detail is content-free and fits the event log\'s 11 keys', () => {
        const ev = play(Array.from({ length: 6 }, () => ({ rx: 60, dec: 0, drop: 60 })));
        expect(Object.keys(ev[0].d).length).toBeLessThanOrEqual(11);
        expect(JSON.stringify(ev)).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    });
});
