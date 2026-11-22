import { describe, it, expect } from 'vitest';
import {
    engineSettingsFor, isAudioEngine, strongUsesLight, strongUnavailableNote, CL_MANUAL_GAIN_LIMIT_DB, DEFAULT_AUDIO_ENGINE,
} from './clAudioSettings';
import { wantsNativeStrong } from './clAudioNative';
import { micSliderToDb, micSliderToGain } from './micGainLaw';
import { voiceChainNeedsProcessor, planVoiceChain, LIVE_PROCESSOR_SETTING_KEYS, liveProcessorSettingsKey } from './voiceChain';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY } from '../hooks/useVoiceSettings';
import { noisePromptApplies } from './noiseFloorPrompt';
import { voiceSettingsDetail } from './voiceDiagLog';
import { classifyKvKey } from '../services/backupRegistry';
import { INPUT_PROFILE_FIELDS } from './audioDeviceProfiles';

type In = Parameters<typeof engineSettingsFor>[0];
const base: In = { noiseSuppression: true, noiseSuppressionMode: 'light', volumeNormalization: true, micVolume: 100 };

describe('settings -> engine settings', () => {
    it('noise suppression off -> Off profile; on (light) -> Light', () => {
        expect(engineSettingsFor({ ...base, noiseSuppression: false }).noise).toBe(0);
        expect(engineSettingsFor(base).noise).toBe(1);
    });

    it("Off / Light / Strong are three profiles; Strong's models run in a worker and the in-page engine runs Light beside it", () => {
        expect(engineSettingsFor({ ...base, noiseSuppression: false }).noise).toBe(0);
        expect(engineSettingsFor({ ...base, noiseSuppressionMode: 'light' }).noise).toBe(1);
        expect(engineSettingsFor({ ...base, noiseSuppressionMode: 'strong' }).noise).toBe(2);
        const strong = { audioEngine: 'v2', noiseSuppression: true, noiseSuppressionMode: 'strong' } as const;
        // without the worker Strong runs in its in-page form; unknown (still probing) is not reported as missing
        expect(strongUsesLight(strong, false)).toBe(true);
        expect(strongUsesLight(strong, true)).toBe(false);
        expect(strongUsesLight(strong, null)).toBe(false);
        expect(wantsNativeStrong({ ...strong })).toBe(true);
        expect(wantsNativeStrong({ ...strong, noiseSuppressionMode: 'light' })).toBe(false);
    });

    it('volumeNormalization -> auto gain; the mic volume is ignored while it is on', () => {
        const on = engineSettingsFor({ ...base, micVolume: 180 });
        expect(on.autoGain).toBe(true);
        expect(on.manualGainDb).toBe(0);
        expect(on.originalSound).toBe(false);
    });

    it('auto gain off: the mic volume is the manual gain in dB, by the same slider law as the legacy chain', () => {
        for (const slider of [10, 50, 100, 150, 200]) {
            const e = engineSettingsFor({ ...base, volumeNormalization: false, micVolume: slider });
            expect(e.manualGainDb).toBeCloseTo(micSliderToDb(slider), 1);
            expect(micSliderToDb(slider)).toBeCloseTo(20 * Math.log10(micSliderToGain(slider)), 9);
        }
        expect(engineSettingsFor({ ...base, volumeNormalization: false, micVolume: 100 }).manualGainDb).toBe(0);
        expect(engineSettingsFor({ ...base, volumeNormalization: false, micVolume: 200 }).manualGainDb).toBeCloseTo(7.5, 1);
    });

    it('the manual gain is clamped to the engine range, never NaN', () => {
        expect(engineSettingsFor({ ...base, volumeNormalization: false, micVolume: 0 }).manualGainDb).toBe(-CL_MANUAL_GAIN_LIMIT_DB);
        expect(engineSettingsFor({ ...base, volumeNormalization: false, micVolume: 1e9 }).manualGainDb).toBe(CL_MANUAL_GAIN_LIMIT_DB);
        expect(Number.isFinite(engineSettingsFor({ ...base, volumeNormalization: false, micVolume: NaN }).manualGainDb)).toBe(true);
    });

    it('original sound = NS off AND auto gain off AND mic volume 100 %: a true bypass; anything else is not', () => {
        const o = (p: Partial<In>) => engineSettingsFor({ ...base, noiseSuppression: false, volumeNormalization: false, micVolume: 100, ...p }).originalSound;
        expect(o({})).toBe(true);
        expect(o({ noiseSuppression: true })).toBe(false);
        expect(o({ volumeNormalization: true })).toBe(false);
        expect(o({ micVolume: 101 })).toBe(false);
        expect(o({ micVolume: 99 })).toBe(false);
    });

    it('the LEGACY voice gate settings do not enter the mapping: the legacy gate on or off gives the same engine settings', () => {
        expect(engineSettingsFor({ ...base, voiceGate: true, voiceGateThreshold: -30 } as In)).toEqual(engineSettingsFor(base as In));
        expect(Object.keys(engineSettingsFor(base as In)).sort()).toEqual(['autoGain', 'gate', 'manualGainDb', 'noise', 'originalSound']);
    });
});

describe('audioEngine setting', () => {
    it('defaults to v2 (the new engine is the only engine) and only the two known values are engines', () => {
        expect(DEFAULT_AUDIO_ENGINE).toBe('v2');
        expect(DEFAULT_VOICE_SETTINGS.audioEngine).toBe('v2');
        expect(isAudioEngine('v2')).toBe(true);
        expect(isAudioEngine('legacy')).toBe(true);
        for (const v of ['v3', '', null, undefined, 2, true]) expect(isAudioEngine(v)).toBe(false);
    });

    it('is not remembered per microphone (a device-wide choice)', () => {
        expect(INPUT_PROFILE_FIELDS as readonly string[]).not.toContain('audioEngine');
    });

    it('is part of the live-settings change key (a mid-call switch reaches the processor)', () => {
        expect(LIVE_PROCESSOR_SETTING_KEYS as readonly string[]).toContain('audioEngine');
        const k0 = liveProcessorSettingsKey(DEFAULT_VOICE_SETTINGS);
        expect(liveProcessorSettingsKey({ ...DEFAULT_VOICE_SETTINGS, audioEngine: 'legacy' })).not.toBe(k0);
    });
});

describe('chain decisions under v2', () => {
    const off = { ...DEFAULT_VOICE_SETTINGS, noiseSuppression: false, volumeNormalization: false, eqEnabled: false, micVolume: 100 };
    it('the (default-on) voice gate alone keeps a processor attached on legacy but NOT on v2 (original sound is a true bypass)', () => {
        expect(voiceChainNeedsProcessor({ ...off, voiceGate: true, audioEngine: 'legacy' })).toBe(true);
        expect(voiceChainNeedsProcessor({ ...off, voiceGate: true, audioEngine: 'v2' })).toBe(false);
    });
    it('every other stage still needs the processor under v2', () => {
        for (const p of [{ noiseSuppression: true }, { volumeNormalization: true }, { eqEnabled: true }, { micVolume: 120 }]) {
            expect(voiceChainNeedsProcessor({ ...off, voiceGate: true, audioEngine: 'v2', ...p })).toBe(true);
        }
    });
    it('the plan never has a gate under v2', () => {
        expect(planVoiceChain({ ...DEFAULT_VOICE_SETTINGS, voiceGate: true, audioEngine: 'v2' }).gate).toBe(false);
        expect(planVoiceChain({ ...DEFAULT_VOICE_SETTINGS, voiceGate: true, audioEngine: 'legacy' }).gate).toBe(true);
    });
});

describe('prompts and diagnostics under v2', () => {
    it('the background-noise prompt never applies under v2 (it needs the gate\'s noise floor and offers Strong)', () => {
        expect(noisePromptApplies({ noiseSuppression: true, noiseSuppressionMode: 'light', audioEngine: 'legacy' })).toBe(true);
        expect(noisePromptApplies({ noiseSuppression: true, noiseSuppressionMode: 'light', audioEngine: 'v2' })).toBe(false);
        expect(noisePromptApplies({ noiseSuppression: false, noiseSuppressionMode: 'light', audioEngine: 'v2' })).toBe(false);
    });
    it("voice_settings carries engine: 'v2' (now always) and reports the MANUAL noise gate, not the old automatic gate", () => {
        expect(voiceSettingsDetail({ ...DEFAULT_VOICE_SETTINGS, audioEngine: 'v2' }).engine).toBe('v2');
        expect(voiceSettingsDetail(DEFAULT_VOICE_SETTINGS).engine).toBe('v2');
        // the old gate's default (on, -45) must not leak into the new engine's entry
        expect(voiceSettingsDetail(DEFAULT_VOICE_SETTINGS)).toMatchObject({ gate: false, thrDb: -55 });
        expect(voiceSettingsDetail({ ...DEFAULT_VOICE_SETTINGS, voiceGateManual: true, voiceGateManualDb: -48 })).toMatchObject({ gate: true, thrDb: -48 });
        // an entry for the legacy chain (fallback logging, old tests) is unchanged
        const legacy = voiceSettingsDetail({ ...DEFAULT_VOICE_SETTINGS, audioEngine: 'legacy' });
        expect('engine' in legacy).toBe(false);
        expect(legacy).toMatchObject({ gate: true, thrDb: -45 });
    });
    it('new-engine defaults: noise suppression on in Light, manual gate off, auto gain on', () => {
        expect(DEFAULT_VOICE_SETTINGS).toMatchObject({ noiseSuppression: true, noiseSuppressionMode: 'light', voiceGateManual: false, volumeNormalization: true });
    });
});

describe('backups', () => {
    it('the per-microphone gain map is classified and EXCLUDED (device-specific); the voice-settings blob (with audioEngine) is carried by vault.voiceSettings', () => {
        expect(classifyKvKey('cipherline_mic_device_gain', 'u1')).toBe('exclude');
        expect(classifyKvKey(VOICE_SETTINGS_STORAGE_KEY, 'u1')).toBe('exclude'); // excluded from the generic kv map because the vault field carries it whole
    });
});

describe('strongUnavailableNote: say plainly when Strong cannot run and Light plays instead', () => {
    const strong = { audioEngine: 'v2', noiseSuppression: true, noiseSuppressionMode: 'strong' } as const;
    it('no Worker / WebAssembly says this device cannot run Strong; anything else says it could not start; both say Light is what plays', () => {
        expect(strongUnavailableNote(strong, { available: false, reason: 'no-bridge' })).toBe('This device cannot run Strong, so it uses Light instead.');
        expect(strongUnavailableNote(strong, { available: false, reason: 'unknown' })).toBe('Strong could not start on this device, so it uses Light instead.');
    });
    it('says nothing when native works, while probing, on the legacy engine, or when Strong is not the selected mode', () => {
        expect(strongUnavailableNote(strong, { available: true })).toBeNull();
        expect(strongUnavailableNote(strong, null)).toBeNull();
        expect(strongUnavailableNote({ ...strong, audioEngine: 'legacy' }, { available: false, reason: 'no-bridge' })).toBeNull();
        expect(strongUnavailableNote({ ...strong, noiseSuppressionMode: 'light' }, { available: false, reason: 'no-bridge' })).toBeNull();
        expect(strongUnavailableNote({ ...strong, noiseSuppression: false }, { available: false, reason: 'no-bridge' })).toBeNull();
    });
});

describe('manual gate mapping (v2)', () => {
    const base = { noiseSuppression: true, noiseSuppressionMode: 'light' as const, volumeNormalization: true, micVolume: 100 };
    const gateOf = (extra: Record<string, unknown>) => engineSettingsFor({ ...base, ...extra }).gate;

    it.each([
        ['nothing saved (no manual-gate keys)', {}, { enabled: false, thresholdDb: -55 }],
        ['legacy gate ON at the default threshold (what the automatic gate left behind) -> NO gate', { voiceGate: true, voiceGateThreshold: -45 }, { enabled: false, thresholdDb: -55 }],
        ['legacy manual gate ON at -30 -> NO gate (never converted)', { voiceGate: true, voiceGateThreshold: -30 }, { enabled: false, thresholdDb: -55 }],
        ['v2 manual gate off, with a threshold saved', { voiceGateManual: false, voiceGateManualDb: -40 }, { enabled: false, thresholdDb: -40 }],
        ['v2 manual gate on', { voiceGateManual: true, voiceGateManualDb: -42 }, { enabled: true, thresholdDb: -42 }],
        ['v2 manual gate on, threshold missing -> the default', { voiceGateManual: true }, { enabled: true, thresholdDb: -55 }],
        ['threshold above the range is clamped', { voiceGateManual: true, voiceGateManualDb: -5 }, { enabled: true, thresholdDb: -20 }],
        ['threshold below the range is clamped', { voiceGateManual: true, voiceGateManualDb: -120 }, { enabled: true, thresholdDb: -80 }],
        ['NaN threshold -> the default', { voiceGateManual: true, voiceGateManualDb: NaN }, { enabled: true, thresholdDb: -55 }],
        ['a truthy non-boolean does not switch it on', { voiceGateManual: 1 }, { enabled: false, thresholdDb: -55 }],
    ])('%s', (_name, extra, want) => {
        expect(gateOf(extra)).toEqual(want);
    });

    it('a manual gate that is ON prevents the true bypass; off keeps it', () => {
        const bypassIn = { noiseSuppression: false, noiseSuppressionMode: 'light' as const, volumeNormalization: false, micVolume: 100 };
        expect(engineSettingsFor(bypassIn).originalSound).toBe(true);
        expect(engineSettingsFor({ ...bypassIn, voiceGateManual: false }).originalSound).toBe(true);
        expect(engineSettingsFor({ ...bypassIn, voiceGateManual: true }).originalSound).toBe(false);
        // legacy gate on does not matter
        expect(engineSettingsFor({ ...bypassIn, voiceGate: true } as never).originalSound).toBe(true);
    });
});

describe('manual gate persistence and processor attach', () => {
    it('defaults to off with a -55 dBFS threshold', () => {
        expect(DEFAULT_VOICE_SETTINGS.voiceGateManual).toBe(false);
        expect(DEFAULT_VOICE_SETTINGS.voiceGateManualDb).toBe(-55);
    });
    it('the processor is attached for a manual gate alone under v2, not for the legacy gate', () => {
        const off = { ...DEFAULT_VOICE_SETTINGS, noiseSuppression: false, eqEnabled: false, volumeNormalization: false, micVolume: 100, audioEngine: 'v2' as const };
        expect(voiceChainNeedsProcessor({ ...off, voiceGate: true })).toBe(false);
        expect(voiceChainNeedsProcessor({ ...off, voiceGate: false, voiceGateManual: true })).toBe(true);
    });
    it('both keys are in the live-update key list', () => {
        expect(LIVE_PROCESSOR_SETTING_KEYS).toContain('voiceGateManual');
        expect(LIVE_PROCESSOR_SETTING_KEYS).toContain('voiceGateManualDb');
    });
});
