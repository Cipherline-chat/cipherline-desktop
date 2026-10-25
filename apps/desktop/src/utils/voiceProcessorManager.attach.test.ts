import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    bindMicTrack,
    updateSettings,
    updateCallbacks,
    destroyForCall,
    getCurrentProcessor,
    type ProcessorHostTrack,
} from './voiceProcessorManager';
import type { VoiceSettings } from '../hooks/useVoiceSettings';

/**
 * Attach / detach of the voice processor on the published mic, driven by the
 * settings (utils/voiceChain.ts):
 *   - every per-user stage off → the RAW capture is published, no processor;
 *   - any stage on → processor attached; live, without a rejoin or unpublish
 *     (LiveKit's setProcessor/stopProcessor swap the sender's track in place);
 *   - in particular "gate on, NS off" keeps a processor attached — the gate
 *     lives in it.
 */

const ALL_OFF: VoiceSettings = {
    noiseSuppression: false, noiseSuppressionMode: 'strong', echoCancellation: false, volumeNormalization: false, normalizeIncomingVolume: true, voiceGate: false, voiceGateThreshold: -45,
    pushToTalk: false, pushToTalkKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
    micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
};

/** The slice of livekit-client's LocalAudioTrack the manager drives. */
class FakeMicTrack implements ProcessorHostTrack {
    processor: unknown = undefined;
    // Pre-set so the manager never needs a real (guard) AudioContext here.
    audioContext: unknown = {};
    calls: string[] = [];
    failNextStop = false;
    getProcessor() { return this.processor; }
    async setProcessor(p: unknown) { this.calls.push('set'); this.processor = p; }
    async stopProcessor() {
        this.calls.push('stop');
        if (this.failNextStop) { this.failNextStop = false; throw new Error('applyConstraints failed'); }
        this.processor = undefined;
    }
    setAudioContext(c: unknown) { this.audioContext = c; }
}

afterEach(async () => {
    await destroyForCall('call-1');
    updateCallbacks({});
});

describe('voiceProcessorManager — processor only while a stage needs it', () => {
    it('every stage off at join → the raw capture is published (no processor)', async () => {
        const t = new FakeMicTrack();
        await bindMicTrack('call-1', t, ALL_OFF);
        expect(t.calls).toEqual([]);
        expect(t.getProcessor()).toBeUndefined();
    });

    it('defaults (NS + gate + AGC) at join → attached', async () => {
        const t = new FakeMicTrack();
        await bindMicTrack('call-1', t, { ...ALL_OFF, noiseSuppression: true, voiceGate: true, volumeNormalization: true });
        expect(t.calls).toEqual(['set']);
        expect(t.getProcessor()).toBe(getCurrentProcessor());
    });

    it('gate turned on mid-call with NS off → attached live; everything off again → detached live', async () => {
        const levels: number[] = [];
        updateCallbacks({ onInputLevel: (d) => levels.push(d) });
        const t = new FakeMicTrack();
        await bindMicTrack('call-1', t, ALL_OFF);

        updateSettings({ ...ALL_OFF, voiceGate: true });
        await bindMicTrackSettled();
        expect(t.calls).toEqual(['set']);
        expect(t.getProcessor()).toBe(getCurrentProcessor());

        // A further change while attached is a settings update, not a re-attach.
        updateSettings({ ...ALL_OFF, voiceGate: true, voiceGateThreshold: -38 });
        await bindMicTrackSettled();
        expect(t.calls).toEqual(['set']);

        updateSettings(ALL_OFF);
        await bindMicTrackSettled();
        expect(t.calls).toEqual(['set', 'stop']);
        expect(t.getProcessor()).toBeUndefined();
        // The silence watchdog must not keep reading the last level of a meter that is gone.
        expect(levels.at(-1)).toBe(-Infinity);

        // …and back on: the SAME processor instance is re-attached (re-init'd by setProcessor).
        const proc = getCurrentProcessor();
        updateSettings({ ...ALL_OFF, eqEnabled: true });
        await bindMicTrackSettled();
        expect(t.calls).toEqual(['set', 'stop', 'set']);
        expect(t.getProcessor()).toBe(proc);
    });

    it('a burst of toggles coalesces to the final state', async () => {
        const t = new FakeMicTrack();
        await bindMicTrack('call-1', t, ALL_OFF);
        updateSettings({ ...ALL_OFF, voiceGate: true });
        updateSettings(ALL_OFF);
        updateSettings({ ...ALL_OFF, micVolume: 150 });
        await bindMicTrackSettled();
        expect(t.getProcessor()).toBe(getCurrentProcessor());
        expect(t.calls.filter(c => c === 'set').length).toBe(1);
    });

    it('a detach that fails half-way re-attaches rather than leaving the sender on a dead track', async () => {
        const t = new FakeMicTrack();
        await bindMicTrack('call-1', t, { ...ALL_OFF, voiceGate: true });
        t.failNextStop = true;
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        updateSettings(ALL_OFF);
        await bindMicTrackSettled();
        err.mockRestore();
        expect(t.calls).toEqual(['set', 'stop', 'set']);
        expect(t.getProcessor()).toBe(getCurrentProcessor());
    });

    it('a new publication (reconnect republish) is bound again and follows the current settings', async () => {
        const first = new FakeMicTrack();
        await bindMicTrack('call-1', first, { ...ALL_OFF, voiceGate: true });
        const republished = new FakeMicTrack();
        await bindMicTrack('call-1', republished, { ...ALL_OFF, voiceGate: true });
        expect(republished.getProcessor()).toBe(getCurrentProcessor());
    });
});

/** Let the manager's serialised reconcile chain settle. */
async function bindMicTrackSettled() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
}
