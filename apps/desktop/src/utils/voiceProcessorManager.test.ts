import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceProcessorCallbacks } from './voiceProcessor';
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
    noiseSuppressionMode: 'strong',
    echoCancellation: true,
    volumeNormalization: true,
    normalizeIncomingVolume: true,
    voiceGate: true,
    voiceGateThreshold: -45,
    voiceGateAuto: true,
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

describe('voiceProcessorManager — every callback CallPane registers reaches the processor', () => {
    // 2026-11-10: CallPane registered onAgcStats but the manager's stableCallbacks had no
    // delegator for it, so the processor's `_callbacks.onAgcStats` was undefined in every
    // call: no AGC gain or mic speech level was ever recorded and diagnostic reports from
    // calls carried no loudness ("quiet mic" could not be told from "fine").
    const callbacksOf = (p: unknown) => (p as { _callbacks: VoiceProcessorCallbacks })._callbacks;

    it('delegates onAgcStats and onMicLevelStats to the latest registered callbacks', () => {
        const onAgcStats = vi.fn();
        const onMicLevelStats = vi.fn();
        updateCallbacks({ onAgcStats, onMicLevelStats });
        const cb = callbacksOf(getOrCreate('call-a', settings));
        cb.onAgcStats?.({ gainDb: 6, voiceActive: true, speechDb: -40 });
        expect(onAgcStats).toHaveBeenCalledWith({ gainDb: 6, voiceActive: true, speechDb: -40 });
        const sec = { gainDb: 1, voiceActive: true, speechDb: -30, blocks: 1, voiced: 1, inMs: 0, outMs: 0, peak: 0, held: 0, clip: 0, micGainDb: 0, gateOpenFrac: 1, rawMs: null, nsMs: null };
        cb.onMicLevelStats?.(sec);
        expect(onMicLevelStats).toHaveBeenCalledWith(sec);
        // ...and it follows a re-registration (CallPane does it every render).
        const later = vi.fn();
        updateCallbacks({ onAgcStats: later });
        cb.onAgcStats?.({ gainDb: 0, voiceActive: false });
        expect(later).toHaveBeenCalledTimes(1);
        expect(onAgcStats).toHaveBeenCalledTimes(1);
    });

    it('has a delegator for every on* key CallPane passes to updateCallbacks', () => {
        const src = readFileSync(join(__dirname, '..', 'components', 'CallPane.tsx'), 'utf8');
        const start = src.indexOf('voiceProcessorManager.updateCallbacks({');
        expect(start).toBeGreaterThan(0);
        const end = src.indexOf('}, [voice, toast]);', start);
        const keys = [...src.slice(start, end).matchAll(/^ {12}(on[A-Z]\w*):/gm)].map(m => m[1]);
        expect(keys).toContain('onAgcStats');
        const have = Object.keys(callbacksOf(getOrCreate('call-a', settings)));
        expect(keys.filter(k => !have.includes(k))).toEqual([]);
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
