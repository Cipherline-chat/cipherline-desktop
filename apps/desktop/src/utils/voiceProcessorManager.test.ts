import { describe, it, expect, afterEach } from 'vitest';
import {
    getOrCreate,
    updateCallbacks,
    updateSettings,
    destroyForCall,
    getCurrentProcessor,
} from './voiceProcessorManager';
import type { VoiceSettings } from '../hooks/useVoiceSettings';

/**
 * These tests exercise only the manager's identity/lifecycle bookkeeping —
 * NOT the underlying CipherlineVoiceProcessor's audio graph (that requires
 * real Web Audio APIs and is covered by voiceProcessor.rate.test.ts and
 * manual testing instead). The processor's constructor is a trivial field
 * copy and destroy() is a no-op on an un-init'd instance (every node
 * disconnect is optional-chained and try/catched), so it's safe to use the
 * real class here rather than mocking it — what matters for this module is
 * "does getOrCreate return the same instance", not "does the audio graph
 * sound right".
 */

const settings: VoiceSettings = {
    noiseSuppression: true,
    volumeNormalization: true,
    voiceGate: true,
    voiceGateThreshold: -45,
    pushToTalk: false,
    pushToTalkKey: null,
    micDeviceId: '',
    speakerDeviceId: '',
    cameraDeviceId: '',
    micVolume: 100,
    speakerVolume: 100,
    eqEnabled: false,
    eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100,
    cameraContrast: 100,
    cameraSaturation: 100,
};

// Every test must leave the module-level singleton clean, or an earlier
// test's processor leaks into a later one and produces confusing failures.
afterEach(async () => {
    const current = getCurrentProcessor();
    if (current) {
        // Whatever callId is currently held, destroy it directly rather than
        // guessing the id — getOrCreate() in the NEXT test would otherwise
        // warn about a stale processor and destroy it anyway, but cleaning up
        // here keeps each test's own assertions about warnings accurate.
        await current.destroy().catch(() => {});
    }
    // Reach into the module to force-clear `current` even if the id-based
    // destroyForCall above didn't match — tests intentionally use mismatched
    // ids to exercise that path, so a plain call isn't always enough.
    await destroyForCall('call-a').catch(() => {});
    await destroyForCall('call-b').catch(() => {});
});

describe('voiceProcessorManager — identity', () => {
    it('returns the SAME processor instance for repeat calls with the same callId', () => {
        const first = getOrCreate('call-a', settings);
        const second = getOrCreate('call-a', settings);
        expect(second).toBe(first);
    });

    it('creates a NEW processor for a different callId', async () => {
        const first = getOrCreate('call-a', settings);
        const second = getOrCreate('call-b', settings);
        expect(second).not.toBe(first);
        expect(getCurrentProcessor()).toBe(second);
    });
});

describe('voiceProcessorManager — settings updates', () => {
    it('forwards updateSettings to whatever processor is currently live', () => {
        const processor = getOrCreate('call-a', settings);
        // updateSettings on the class itself just assigns _settings — no
        // observable side effect without init(), so this exercises that the
        // manager's updateSettings doesn't throw when routed to a live
        // processor with no keying required (see the doc comment on why it's
        // keyless).
        expect(() => updateSettings({ ...settings, micVolume: 150 })).not.toThrow();
        expect(processor).toBe(getCurrentProcessor());
    });

    it('is a silent no-op when no processor is live', () => {
        expect(getCurrentProcessor()).toBeNull();
        expect(() => updateSettings(settings)).not.toThrow();
    });
});

describe('voiceProcessorManager — callbacks indirection', () => {
    it('accepts a callbacks update without needing a processor to exist yet', () => {
        expect(() => updateCallbacks({ onNsAutoBypass: () => {} })).not.toThrow();
    });
});

describe('voiceProcessorManager — teardown', () => {
    it('destroyForCall clears the singleton when the callId matches', async () => {
        getOrCreate('call-a', settings);
        expect(getCurrentProcessor()).not.toBeNull();
        await destroyForCall('call-a');
        expect(getCurrentProcessor()).toBeNull();
    });

    it('destroyForCall is a no-op when the callId does not match', async () => {
        const processor = getOrCreate('call-a', settings);
        await destroyForCall('some-other-call');
        expect(getCurrentProcessor()).toBe(processor);
    });

    it('a fresh getOrCreate after teardown creates a genuinely new processor', async () => {
        const first = getOrCreate('call-a', settings);
        await destroyForCall('call-a');
        const second = getOrCreate('call-a', settings);
        expect(second).not.toBe(first);
    });
});

describe('voiceProcessorManager — stale-processor guard', () => {
    it('destroys a previous callId processor if getOrCreate is called for a new one without teardown', () => {
        // This models the defensive path noted in the manager's doc comment:
        // CallPane is always supposed to call destroyForCall() before a new
        // call's processor is created, but if that invariant is ever broken,
        // getOrCreate() must not silently leak the old processor.
        const first = getOrCreate('call-a', settings);
        const destroySpy = vi_spy(first);
        const second = getOrCreate('call-b', settings);
        expect(second).not.toBe(first);
        expect(destroySpy.called).toBe(true);
    });
});

// Minimal manual spy helper — avoids pulling in vi.spyOn just for one method
// on a class whose constructor has no browser-API side effects to mock away.
function vi_spy(instance: { destroy: () => Promise<void> }) {
    const original = instance.destroy.bind(instance);
    const state = { called: false };
    instance.destroy = () => {
        state.called = true;
        return original();
    };
    return state;
}
