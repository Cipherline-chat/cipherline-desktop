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

// Owner 2026-11-24: a heavy game once starved the audio thread and nobody could hear each other (Oct: Strong ran on that thread).
describe('new engine: an overloaded audio thread gives Strong up for the call', () => {
    it('the load guard sees Strong as running on the new engine (it used to see only the old engine\'s worklets)', () => {
        expect(vp).toContain("if (this._engineBuilt === 'v2') {");
        expect(vp).toContain("return this._settings.noiseSuppressionMode === 'strong' && this._natBuilt && !this._natFailed ? 'strong' : 'light';");
    });
    it('a trip on the new engine tells the worklet to drop Strong, announces it once, and the worker is closed by the failure path', () => {
        const at = vp.indexOf("d.trip && this._engineBuilt === 'v2'");
        expect(at).toBeGreaterThan(0);
        const body = vp.slice(at, at + 1200);
        expect(body).toContain("postMessage({ type: 'nativeOverload' })");
        expect(body).toContain('onNsLoadFallback');
        expect(worklet).toContain("d.type === 'nativeOverload'");
        expect(worklet).toContain("this.natFail('render-overload')");
        // the worklet's nativeFailed comes back to onNativeFailed, which closes the worker but does not toast a second time
        expect(vp).toContain("if (reason === 'render-overload') return;");
    });
});
