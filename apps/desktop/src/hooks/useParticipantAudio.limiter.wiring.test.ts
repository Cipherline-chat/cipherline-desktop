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
