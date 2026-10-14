/**
 * Which stages of the outgoing voice chain are live, decided from the user's
 * settings and from which worklet stages actually came up.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * "The noise gate doesn't work when noise suppression is turned off" (owner,
 * 2026-10). The gate is a per-user stage in its own right; nothing about it may
 * depend on noise suppression. Two things tied them together:
 *
 *   1. Construction. voiceProcessor.ts built the gate inside the same try as
 *      RNNoise and only wired it in when the RNNoise node existed
 *      (`if (workletsOk && this.rnnoiseWorkletNode && this.gateWorkletNode)`),
 *      so a machine where RNNoise could not be registered got no gate (and no
 *      AGC) either. Every stage is now built and wired on its own.
 *   2. The Settings gate meter read a different signal than the gate. The gate
 *      compares the level at ITS input (after RNNoise, before EQ/AGC/mic
 *      volume); the meter under the threshold slider showed the end of the
 *      chain — after the gate itself, AGC (−18…+12 dB) and the mic-volume gain.
 *      With NS on that hardly mattered: RNNoise removes steady room noise
 *      before the gate, so the gate closed whatever the threshold. With NS off
 *      the raw room noise reaches the gate, and on a hot mic AGC pulls the
 *      meter several dB below what the gate measures: the bar sat under the
 *      thumb while the gate stayed open, i.e. the gate "did nothing". The meter
 *      now reads the gate's own detector (see GATE_METER_REPORT_MS).
 *
 * Pure and DOM-free so the composition is a decision table under test.
 */
import type { VoiceSettings } from '../hooks/useVoiceSettings';

/** The settings that decide the chain. */
export type VoiceChainSettings = Pick<
    VoiceSettings,
    'noiseSuppression' | 'voiceGate' | 'eqEnabled' | 'eqBands' | 'volumeNormalization' | 'micVolume'
>;

/** Which worklet stages were successfully constructed on this context. EQ,
 *  the compressor and the gain are plain WebAudio nodes and cannot fail the
 *  way worklet registration can. */
export interface VoiceChainAvailability {
    ns: boolean;
    gate: boolean;
    agc: boolean;
}

export const ALL_STAGES_AVAILABLE: VoiceChainAvailability = { ns: true, gate: true, agc: true };

export interface VoiceChainPlan {
    /** RNNoise processes (else its worklet passes audio through untouched). */
    ns: boolean;
    /** The gate closes below the threshold (else pass-through). */
    gate: boolean;
    /** EQ bands carry the user's gains (else all flat). */
    eq: boolean;
    /** AGC + compressor level the voice (else unity / 1:1). */
    agc: boolean;
    /** The mic-volume gain is not unity. */
    micGain: boolean;
    /**
     * Does the call need a processor at all? False only when every per-user
     * stage is off: the raw capture is then published with no processor and
     * no WebAudio graph (zero overhead), see voiceProcessorManager.
     */
    needsProcessor: boolean;
}

/** True when any per-user stage is on — decided from the settings alone, so a
 *  stage that failed to load never detaches the others. */
export function voiceChainNeedsProcessor(s: VoiceChainSettings): boolean {
    return s.noiseSuppression
        || s.voiceGate
        || s.eqEnabled
        || s.volumeNormalization
        || s.micVolume !== 100;
}

/** The stage composition. Each stage depends only on its own setting and its
 *  own availability — never on another stage. */
export function planVoiceChain(
    s: VoiceChainSettings,
    available: VoiceChainAvailability = ALL_STAGES_AVAILABLE,
): VoiceChainPlan {
    return {
        ns: s.noiseSuppression && available.ns,
        gate: s.voiceGate && available.gate,
        eq: s.eqEnabled,
        agc: s.volumeNormalization && available.agc,
        micGain: s.micVolume !== 100,
        needsProcessor: voiceChainNeedsProcessor(s),
    };
}

/**
 * How often the gate worklet reports its detector level to a meter that asked
 * for it (the Settings mic test). The value reported is the LOUDEST 128-sample
 * block of the interval — the gate opens on any single block at or above the
 * threshold, so the peak, not an average, is what decides it.
 */
export const GATE_METER_REPORT_MS = 50;
