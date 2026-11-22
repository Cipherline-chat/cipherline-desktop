import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const vp = readFileSync(join(__dirname, 'voiceProcessor.ts'), 'utf8');
const worklet = readFileSync(join(__dirname, '../audio/clAudioWorklet.js'), 'utf8');

// Reports 85ff3561 / 538ab36e (2026-11-21): "strong noise suppression failed for me and went back to light".
describe('native Strong survives settings changes', () => {
    it('switching Strong off clears the built flag, so choosing Strong again re-attaches it', () => {
        const at = vp.indexOf("postMessage({ type: 'nativeOff' })");
        expect(at).toBeGreaterThan(0);
        expect(vp.slice(at, at + 700)).toContain('this._natBuilt = false;');
        // and the rebuild rule still keys off that flag
        expect(vp).toContain("!this._natBuilt && !this._natFailed && wantsNativeStrong(settings)");
    });

    it('the settings acknowledgement has 20 s, not 5 (a model load on a busy PC outlasted 5)', () => {
        expect(worklet).toContain('const CLA_NAT_ACK_TIMEOUT_FRAMES = 2000;');
        expect(worklet).toContain('this.natAckWait > CLA_NAT_ACK_TIMEOUT_FRAMES * 4');
    });
});
