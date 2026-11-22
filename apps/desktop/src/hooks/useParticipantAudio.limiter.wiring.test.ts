import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, 'useParticipantAudio.ts'), 'utf8');

// Chromium's DynamicsCompressorNode adds automatic make-up gain that depends on
// its threshold, so these two numbers only make sense as a pair. Measured with an
// OfflineAudioContext, knee 0 / ratio 20: -6 dBFS = +3.4 dB, -3 dBFS = +1.7 dB.
describe('master limiter is unity below its threshold', () => {
    it('threshold and make-up trim stay a measured pair', () => {
        expect(source).toContain('export const MASTER_LIMITER_THRESHOLD_DB = -3;');
        expect(source).toContain('export const MASTER_LIMITER_MAKEUP_DB = 1.7;');
    });

    it('the limiter reaches the destination only through the trim', () => {
        expect(source).toContain('masterLimiter.connect(makeupTrim);');
        expect(source).toContain('makeupTrim.connect(ctx.destination);');
        expect(source).not.toContain('masterLimiter.connect(ctx.destination)');
    });
});

// Call reports 245dd270 / 05713bab / 25b4800b (2026-11-21): releasing a talker's chain dropped their boost latch, the
// re-acquire went back to the element path, which latched again 3 s later: the chain was rebuilt every ~3.3 s.
describe('the boost latch survives the release its own path change causes', () => {
    it('releaseMicChain does not drop the latch synchronously', () => {
        const start = source.indexOf('function releaseMicChain(');
        const body = source.slice(start, source.indexOf('\n}\n', start));
        const forget = body.indexOf('setTimeout(');
        expect(forget).toBeGreaterThan(0);
        expect(body.slice(0, forget)).not.toContain('levelBoostLatched.delete');
        expect(body).toContain('micChains.has(identity) || micChainBuilds.has(identity)');
        expect(body).toContain('BOOST_LATCH_FORGET_MS');
    });
});
