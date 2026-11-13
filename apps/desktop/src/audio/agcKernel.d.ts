export function dbToLinear(db: number): number;
export function linearToDb(linear: number): number;

export const DEFAULT_TARGET_DB: number;
export const DEFAULT_FLOOR_DB: number;
export const DEFAULT_INITIAL_NOISE_FLOOR_DB: number;
export const DEFAULT_NOISE_MARGIN_DB: number;
export const DEFAULT_OUTPUT_NOISE_LIMIT_DB: number;
export const DEFAULT_QUIET_BOOST_RATIO: number;
export const DEFAULT_MAX_QUIET_BOOST_DB: number;
export const DEFAULT_QUIET_KNEE_DB: number;
export const DEFAULT_NO_BOOST_DB: number;
export const DEFAULT_MIN_GAIN_DB: number;
export const DEFAULT_MAX_GAIN_DB: number;
export const DEFAULT_RISE_DB_PER_SEC: number;
export const DEFAULT_FALL_DB_PER_SEC: number;
export const DEFAULT_LEVEL_SMOOTHING_SEC: number;
export const DEFAULT_LOUDER_JUMP_RATIO: number;
export const DEFAULT_LOUDER_JUMP_SEC: number;
export const DEFAULT_BOOTSTRAP_SEC: number;
export const DEFAULT_BOOTSTRAP_RATE_MULT: number;
export const DEFAULT_MIN_EVIDENCE_SEC: number;
export const DEFAULT_FAST_MARGIN_DB: number;
export const DEFAULT_FAST_ATTACK_SEC: number;
export const DEFAULT_FAST_RELEASE_SEC: number;
export const DEFAULT_FAST_FALL_DB_PER_SEC: number;
export const FALL_RAMP_SAMPLES: number;
export const DEFAULT_ACTIVITY_SMOOTHING_SEC: number;
export const DEFAULT_NOISE_FALL_FRACTION: number;
export const DEFAULT_NOISE_RISE_DB_PER_SEC: number;
export const DEFAULT_SPEECH_TO_FLOOR_DB: number;
export const DEFAULT_VOICED_THRESHOLD: number;
export const DEFAULT_VOICE_HANGOVER_SEC: number;
export const DEFAULT_LEVEL_VOICE_HOLD_SEC: number;
export const DEFAULT_COMP_THRESHOLD_DB: number;
export const DEFAULT_COMP_RATIO: number;
export const DEFAULT_COMP_KNEE_DB: number;
export const DEFAULT_COMP_ATTACK_SEC: number;
export const DEFAULT_COMP_RELEASE_SEC: number;
export const DEFAULT_LIMITER_CEILING_DB: number;
export const DEFAULT_LIMITER_LOOKAHEAD_SEC: number;
export const DEFAULT_LIMITER_ATTACK_SEC: number;
export const DEFAULT_LIMITER_RELEASE_SEC: number;

export interface AgcProcessorOptions {
    /** Output-noise SNR rule: the noise may sit at most (target - this) dB under the speech target (default 6). */
    minSnrDb?: number;
    /** Voiced seconds with no block admitted to the level estimate before it decays (Infinity = never; tests). */
    levelStaleSec?: number;
    sampleRate?: number;
    targetRms?: number;
    floorRms?: number;
    minGain?: number;
    maxGain?: number;
    /** Slow gain the AGC starts from (dB). Default 0. */
    initialGainDb?: number;
    riseDbPerSec?: number;
    fallDbPerSec?: number;
    levelSmoothingSec?: number;
    noiseMarginDb?: number;
    outputNoiseLimitDb?: number;
    /** Fraction of the distance to the target a talker below it is brought up by. */
    quietBoostRatio?: number;
    /** Most boost, in dB, for a talker below the target. */
    maxQuietBoostDb?: number;
    /** Below this (dBFS) the allowed boost shrinks toward noBoostDb. */
    quietKneeDb?: number;
    /** Speech at or below this (dBFS) is never boosted. */
    noBoostDb?: number;
    bootstrapSec?: number;
    bootstrapRateMult?: number;
    minEvidenceSec?: number;
    fastMarginDb?: number;
    fastAttackSec?: number;
    fastReleaseSec?: number;
    fastFallDbPerSec?: number;
    louderJumpRatio?: number;
    louderJumpSec?: number;
    voicedThreshold?: number;
    voiceHangoverSec?: number;
    compThresholdDb?: number;
    compRatio?: number;
    compKneeDb?: number;
    compAttackSec?: number;
    compReleaseSec?: number;
    /** false = gain + limiter only (no compressor). Default true. */
    compressor?: boolean;
    limiterCeiling?: number;
    limiterLookaheadSec?: number;
    limiterAttackSec?: number;
    limiterReleaseSec?: number;
    enabled?: boolean;
}

export interface AgcProcessResult {
    /** Total linear gain applied this block (slow gain + loud-onset cut). */
    gain: number;
    /** Same in dB. */
    gainDb: number;
    /** Voiced speech was detected (the only state in which the gain adapts). */
    voiceActive: boolean;
}

export class VoiceDetector {
    constructor(sampleRate: number);
    /** Normalized autocorrelation peak (70-500 Hz) of the latest analysed frame. */
    score: number;
    /** Feed samples; true when a new frame was analysed. */
    push(block: Float32Array): boolean;
}

export class AgcProcessor {
    sampleRate: number;
    targetRms: number;
    floorRms: number;
    minGain: number;
    maxGain: number;
    riseDbPerSec: number;
    fallDbPerSec: number;
    levelSmoothingSec: number;
    noiseMarginDb: number;
    outputNoiseLimitDb: number;
    quietBoostRatio: number;
    maxQuietBoostDb: number;
    quietKneeDb: number;
    noBoostDb: number;
    quietBoostCapDb(levelDb: number, targetDb: number): number;
    bootstrapSec: number;
    bootstrapRateMult: number;
    minEvidenceSec: number;
    fastMarginDb: number;
    fastAttackSec: number;
    fastReleaseSec: number;
    fastFallDbPerSec: number;
    louderJumpRatio: number;
    louderJumpSec: number;
    voicedThreshold: number;
    voiceHangoverSec: number;
    compThresholdDb: number;
    compRatio: number;
    compKneeDb: number;
    compAttackSec: number;
    compReleaseSec: number;
    compressorEnabled: boolean;
    limiterCeiling: number;
    limiterAttackSec: number;
    limiterReleaseSec: number;
    lookahead: number;
    enabled: boolean;
    /** Slow gain (dB) - holds unless voiced speech is heard. */
    gainDb: number;
    /** Total applied linear gain (slow + cut) as of the last block. */
    gain: number;
    /** Loud-onset guard's current reduction (dB, <= 0). */
    cutDb: number;
    levelPower: number;
    levelEstimate: number;
    fastPower: number;
    activeSec: number;
    noiseFloorDb: number;
    limiterGain: number;
    actPower: number;
    compEnv: number;
    compReductionDb: number;
    voicedHoldSec: number;
    detector: VoiceDetector;

    constructor(opts?: AgcProcessorOptions);

    setEnabled(enabled: boolean): void;
    /** The returned object is reused between calls. */
    process(inp: Float32Array | null, out: Float32Array): AgcProcessResult;
    /** The mic-volume slider in dB (it sits in front of the AGC); moves the target and compressor threshold. */
    setMicGainDb(db: number): void;
}
export const DEFAULT_LEVEL_STALE_SEC: number;
export const DEFAULT_LEVEL_STALE_FALL_DB_PER_SEC: number;
export const DEFAULT_MIN_SNR_DB: number;
export const MIC_BOOST_TARGET_SHARE: number;
export const MIC_BOOST_TARGET_MAX_DB: number;
