/**
 * Voice settings -> the new audio engine ('v2', crates/cl-audio). Pure.
 *
 * The engine replaces noise suppression + gate + mic gain + AGC + limiter with ONE worklet stage, so the settings that
 * drove those stages map onto its small set of switches:
 *
 *   noiseSuppression off            -> profile Off (levelling + gain control only)
 *   noiseSuppression on, 'light'    -> profile Light (classic RNNoise + leveller + WebRTC AGC2/limiter)
 *   noiseSuppression on, 'strong'   -> the in-page engine runs Light here (the worklet maps a Strong request to Light) as the
 *                                      safety net, kept time-aligned with the worker's Strong; the sound the user hears is
 *                                      Strong (FastEnhancer B+S, in a Web Worker: utils/clAudioNative.ts) whenever the worker is
 *                                      up and keeping pace; otherwise, frame by frame, Light.
 *   volumeNormalization (auto gain) -> auto_gain
 *   micVolume                       -> manual gain in dB (the same slider law as the legacy chain) while auto gain is
 *                                      off; ignored while it is on (the leveller owns the gain)
 *   voiceGate / voiceGateThreshold  -> ignored. The legacy gate (automatic and manual alike) does not exist under v2; a
 *                                      user who had it on gets NO gate here, it is never converted.
 *   voiceGateManual / voiceGateManualDb -> the engine's MANUAL gate: a fixed threshold on the raw mic level (dBFS, RMS
 *                                      per 10 ms, after an 80 Hz high-pass), off unless the user turns it on. Separate
 *                                      keys because the legacy threshold is measured after noise suppression, which is
 *                                      a different quantity.
 *   "original sound"                -> noise suppression off AND auto gain off AND mic volume 100 % AND no manual gate: a
 *                                      true bypass (bit-exact at 48 kHz, apart from the engine's fixed delay). A gate that is
 *                                      ON prevents the bypass (the engine would not gate in it).
 * Echo cancellation is the browser's, untouched. EQ stays a chain of biquads after the engine.
 */
import type { VoiceSettings } from '../hooks/useVoiceSettings';
import { micSliderToDb } from './micGainLaw';

export type AudioEngine = 'legacy' | 'v2';
export const AUDIO_ENGINES: readonly AudioEngine[] = ['legacy', 'v2'];
export const DEFAULT_AUDIO_ENGINE: AudioEngine = 'v2';

export function isAudioEngine(v: unknown): v is AudioEngine {
    return v === 'legacy' || v === 'v2';
}

/** The engine's manual-gain range (cl-audio: +-40 dB). */
export const CL_MANUAL_GAIN_LIMIT_DB = 40;

/** The manual gate's threshold range and default (dBFS of the raw mic input). Wider than the legacy -60..-20: a quiet room sits lower here. */
export const CL_GATE_MIN_DB = -80;
export const CL_GATE_MAX_DB = -20;
export const CL_GATE_DEFAULT_DB = -55;

export function clampGateDb(v: unknown): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : CL_GATE_DEFAULT_DB;
    return Math.max(CL_GATE_MIN_DB, Math.min(CL_GATE_MAX_DB, Math.round(n)));
}

export interface ClEngineSettings {
    /** 0 = Off, 1 = Light (RNNoise at full strength), 2 = Strong. The worklet runs Light for 2 (the Strong models are too heavy for an
     *  audio thread); the real Strong runs in a worker (utils/clAudioNative.ts) and takes over frame by frame while it keeps up. */
    noise: 0 | 1 | 2;
    autoGain: boolean;
    manualGainDb: number;
    originalSound: boolean;
    /** The manual gate. enabled=false = no gate (the default). */
    gate: { enabled: boolean; thresholdDb: number };
}

type EngineInput = Pick<VoiceSettings, 'noiseSuppression' | 'noiseSuppressionMode' | 'volumeNormalization' | 'micVolume'>
    & Partial<Pick<VoiceSettings, 'voiceGateManual' | 'voiceGateManualDb'>>;

export function engineSettingsFor(s: EngineInput): ClEngineSettings {
    const autoGain = !!s.volumeNormalization;
    const mic = Number.isFinite(s.micVolume) ? s.micVolume : 100;
    const db = Math.max(-CL_MANUAL_GAIN_LIMIT_DB, Math.min(CL_MANUAL_GAIN_LIMIT_DB, micSliderToDb(mic)));
    const gateOn = s.voiceGateManual === true;
    return {
        noise: !s.noiseSuppression ? 0 : s.noiseSuppressionMode === 'strong' ? 2 : 1,
        autoGain,
        manualGainDb: autoGain ? 0 : Math.round(db * 100) / 100,
        originalSound: !s.noiseSuppression && !autoGain && mic === 100 && !gateOn,
        gate: { enabled: gateOn, thresholdDb: clampGateDb(s.voiceGateManualDb) },
    };
}

/** True when the engine is asked for AND this build can run it (the context must be 48 kHz). */
export function engineWanted(s: Pick<VoiceSettings, 'audioEngine'>): boolean {
    return s.audioEngine === 'v2';
}

/**
 * v2 + Strong selected but the Strong worker cannot run here (no Worker / WebAssembly): Strong plays as Light. `nativeAvailable` comes from utils/clAudioNative.ts `nativeEngineAvailable()`; unknown (null) is treated as available so
 * the note does not flash while the probe is in flight.
 */
export function strongUsesLight(s: Pick<VoiceSettings, 'audioEngine' | 'noiseSuppression' | 'noiseSuppressionMode'>, nativeAvailable: boolean | null = false): boolean {
    return s.audioEngine === 'v2' && s.noiseSuppression && s.noiseSuppressionMode === 'strong' && nativeAvailable !== true && nativeAvailable !== null;
}

/**
 * The plain-language note under the Strong option when Strong cannot run natively on this install (v2 + Strong selected). null = nothing
 * to say: native is available, still being probed (status null), or the legacy engine is in use (it has its own Strong).
 */
export function strongUnavailableNote(
    s: Pick<VoiceSettings, 'audioEngine' | 'noiseSuppression' | 'noiseSuppressionMode'>,
    status: { available: true } | { available: false; reason: string } | null,
): string | null {
    if (s.audioEngine !== 'v2' || !s.noiseSuppression || s.noiseSuppressionMode !== 'strong' || status === null || status.available) return null;
    // what plays instead is Light: say so
    switch (status.reason) {
        case 'no-bridge': return 'This device cannot run Strong, so it uses Light instead.';
        default: return 'Strong could not start on this device, so it uses Light instead.';
    }
}
