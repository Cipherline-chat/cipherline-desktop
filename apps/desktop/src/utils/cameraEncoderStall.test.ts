import { describe, it, expect } from 'vitest';
import { EncoderStallDetector, encoderStallSample, ENCODER_STALL_MS, ENCODER_STALL_SAMPLE_MS, type EncoderStallSample } from './cameraEncoderStall';

const S = ENCODER_STALL_SAMPLE_MS;

/** A sample with sensible defaults: encoding, capture moving, network fine. */
function sample(at: number, framesEncoded: number, framesCaptured: number | null, over: Partial<EncoderStallSample> = {}): EncoderStallSample {
    return { at, trackKey: 'cam-1', encoding: true, framesEncoded, framesCaptured, networkHeld: false, ...over };
}

/** Feed samples every 2 s: capture always +60 frames, encoded per `enc(i)`. */
function run(det: EncoderStallDetector, steps: number, enc: (i: number) => number, over: (i: number) => Partial<EncoderStallSample> = () => ({})) {
    const out: string[] = [];
    for (let i = 0; i < steps; i++) out.push(det.observe(sample(i * S, enc(i), i * 60, over(i))));
    return out;
}

describe('EncoderStallDetector', () => {
    it("the owner's report: 30 fps, then 3, then 0 with capture still running → stalled within ~6 s, once", () => {
        const det = new EncoderStallDetector();
        // 0..4: ~29 fps (58 per 2 s); 5: +6 (3 fps); 6..: nothing.
        const enc = (i: number) => (i <= 4 ? i * 58 : i === 5 ? 4 * 58 + 6 : 4 * 58 + 6);
        const v = run(det, 14, enc);
        const first = v.indexOf('stalled');
        expect(first).toBeGreaterThan(5);
        // Silent from sample 5 (t=10 s) → stalled at t ≥ 16 s, i.e. sample 8.
        expect(first).toBe(5 + ENCODER_STALL_MS / S);
        expect(v.filter(x => x === 'stalled')).toHaveLength(1);
        expect(v.slice(0, 5).every(x => x === 'watching' || x === 'ok')).toBe(true);
    });

    it('positive control: a healthy encoder never stalls', () => {
        const det = new EncoderStallDetector();
        expect(run(det, 30, i => i * 60)).not.toContain('stalled');
    });

    it('dynacast pause (no active layer) is never a stall, however long', () => {
        const det = new EncoderStallDetector();
        const v = run(det, 30, i => Math.min(i, 3) * 60, i => ({ encoding: i < 3 }));
        expect(v).not.toContain('stalled');
        expect(v.slice(3).every(x => x === 'paused')).toBe(true);
    });

    it('a layer that resumes after a pause gets a full window to produce its first frame', () => {
        const det = new EncoderStallDetector();
        // Paused for samples 1..5, active again from 6, encoder silent from then on.
        const v = run(det, 20, () => 0, i => ({ encoding: i === 0 || i >= 6 }));
        const first = v.indexOf('stalled');
        // Clock starts at sample 6 (not at the last paused sample).
        expect(first).toBe(6 + ENCODER_STALL_MS / S);
    });

    it('a capture that delivers nothing is not the encoder\'s fault', () => {
        const det = new EncoderStallDetector();
        const out: string[] = [];
        for (let i = 0; i < 20; i++) out.push(det.observe(sample(i * S, 100, 500)));
        expect(out).not.toContain('stalled');
        expect(out.slice(1).every(x => x === 'no-capture')).toBe(true);
    });

    it('network-held (bandwidth limitation / zero target / reconnecting) is never a stall', () => {
        const det = new EncoderStallDetector();
        expect(run(det, 20, () => 0, () => ({ networkHeld: true }))).not.toContain('stalled');
    });

    it('a muted publication is never a stall', () => {
        const det = new EncoderStallDetector();
        expect(run(det, 20, () => 0, () => ({ encoding: false }))).not.toContain('stalled');
    });

    it('a republished track starts a fresh watch (and may fire again)', () => {
        const det = new EncoderStallDetector();
        const a = run(det, 10, () => 0);
        expect(a).toContain('stalled');
        const b: string[] = [];
        for (let i = 0; i < 10; i++) b.push(det.observe(sample(100_000 + i * S, 0, i * 60, { trackKey: 'cam-2' })));
        expect(b[0]).toBe('watching');
        expect(b).toContain('stalled');
    });

    it('recovers to ok when frames resume before the threshold', () => {
        const det = new EncoderStallDetector();
        const v = run(det, 10, i => (i < 2 ? i * 60 : i < 4 ? 60 : i * 60));
        expect(v).not.toContain('stalled');
        expect(v[v.length - 1]).toBe('ok');
    });

    it('unknown capture counter (stats without media-source frames) still detects the stall', () => {
        const det = new EncoderStallDetector();
        const out: string[] = [];
        for (let i = 0; i < 10; i++) out.push(det.observe(sample(i * S, 0, null)));
        expect(out).toContain('stalled');
    });
});

describe('encoderStallSample', () => {
    const base = { at: 1, trackKey: 'k', publicationMuted: false, trackLive: true, roomConnected: true };

    it('sums framesEncoded across layers and reads the capture counter from the linked media-source', () => {
        const s = encoderStallSample({
            ...base,
            encodings: [{ active: true }, { active: false }],
            stats: [
                { type: 'outbound-rtp', kind: 'video', framesEncoded: 100, mediaSourceId: 'ms1', active: true, qualityLimitationReason: 'none', targetBitrate: 4_000_000 },
                { type: 'outbound-rtp', kind: 'video', framesEncoded: 20, mediaSourceId: 'ms1', active: false },
                { type: 'media-source', kind: 'video', id: 'ms1', frames: 900 },
                { type: 'media-source', kind: 'audio', id: 'ms2', frames: 5 },
            ],
        });
        expect(s).toMatchObject({ framesEncoded: 120, framesCaptured: 900, encoding: true, networkHeld: false });
    });

    it('all encodings inactive (dynacast) → not encoding', () => {
        const s = encoderStallSample({ ...base, encodings: [{ active: false }], stats: [] });
        expect(s.encoding).toBe(false);
    });

    it('muted publication or an ended track → not encoding', () => {
        expect(encoderStallSample({ ...base, publicationMuted: true, encodings: [{}], stats: [] }).encoding).toBe(false);
        expect(encoderStallSample({ ...base, trackLive: false, encodings: [{}], stats: [] }).encoding).toBe(false);
    });

    it('bandwidth limitation, a zero target bitrate or a disconnected room hold the encoder on purpose', () => {
        const rtp = (o: Record<string, unknown>) => ({ type: 'outbound-rtp', kind: 'video', framesEncoded: 1, ...o });
        expect(encoderStallSample({ ...base, encodings: [{}], stats: [rtp({ qualityLimitationReason: 'bandwidth' })] }).networkHeld).toBe(true);
        expect(encoderStallSample({ ...base, encodings: [{}], stats: [rtp({ targetBitrate: 0 })] }).networkHeld).toBe(true);
        expect(encoderStallSample({ ...base, roomConnected: false, encodings: [{}], stats: [rtp({})] }).networkHeld).toBe(true);
        // A PAUSED layer's limitation does not count.
        expect(encoderStallSample({ ...base, encodings: [{}], stats: [rtp({ active: false, qualityLimitationReason: 'bandwidth' })] }).networkHeld).toBe(false);
        // The owner's report: reason "none", healthy target → not held.
        expect(encoderStallSample({ ...base, encodings: [{}], stats: [rtp({ qualityLimitationReason: 'none', targetBitrate: 4_020_000 })] }).networkHeld).toBe(false);
    });

    it('no media-source in the report → capture counter unknown (null)', () => {
        expect(encoderStallSample({ ...base, encodings: [{}], stats: [{ type: 'outbound-rtp', kind: 'video', framesEncoded: 3 }] }).framesCaptured).toBeNull();
    });
});
