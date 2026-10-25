export function dbToLinear(db: number): number;
export function linearToDb(linear: number): number;

export const DEFAULT_TARGET_DB: number;
export const DEFAULT_FLOOR_DB: number;
export const DEFAULT_NOISE_MARGIN_DB: number;
export const DEFAULT_OUTPUT_NOISE_LIMIT_DB: number;
export const DEFAULT_MIN_GAIN_DB: number;
export const DEFAULT_MAX_GAIN_DB: number;
export const DEFAULT_RISE_DB_PER_SEC: number;
export const DEFAULT_FALL_DB_PER_SEC: number;
export const DEFAULT_LEVEL_SMOOTHING_SEC: number;
export const DEFAULT_BOOTSTRAP_SEC: number;
export const DEFAULT_BOOTSTRAP_RATE_MULT: number;
export const DEFAULT_MIN_EVIDENCE_SEC: number;
export const DEFAULT_BURST_MARGIN_DB: number;
export const DEFAULT_BURST_SMOOTHING_SEC: number;
export const DEFAULT_BURST_FALL_DB_PER_SEC: number;
export const DEFAULT_ACTIVITY_SMOOTHING_SEC: number;
export const DEFAULT_NOISE_FALL_FRACTION: number;
export const DEFAULT_NOISE_RISE_DB_PER_SEC: number;
export const DEFAULT_SPEECH_TO_FLOOR_DB: number;
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
    sampleRate?: number;
    targetRms?: number;
    floorRms?: number;
    minGain?: number;
    maxGain?: number;
    riseDbPerSec?: number;
    fallDbPerSec?: number;
    levelSmoothingSec?: number;
    noiseMarginDb?: number;
    outputNoiseLimitDb?: number;
    bootstrapSec?: number;
    bootstrapRateMult?: number;
    minEvidenceSec?: number;
    burstMarginDb?: number;
    burstSmoothingSec?: number;
    burstFallDbPerSec?: number;
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
    gain: number;
    voiceActive: boolean;
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
    bootstrapSec: number;
    bootstrapRateMult: number;
    minEvidenceSec: number;
    burstMarginDb: number;
    burstSmoothingSec: number;
    burstFallDbPerSec: number;
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
    gain: number;
    levelPower: number;
    levelEstimate: number;
    burstPower: number;
    activeSec: number;
    noiseFloorDb: number;
    limiterGain: number;
    actPower: number;
    compEnv: number;
    compReductionDb: number;

    constructor(opts?: AgcProcessorOptions);

    setEnabled(enabled: boolean): void;
    process(inp: Float32Array | null, out: Float32Array): AgcProcessResult;
}
