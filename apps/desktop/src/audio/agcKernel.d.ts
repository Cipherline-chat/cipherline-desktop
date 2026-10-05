export function dbToLinear(db: number): number;
export function linearToDb(linear: number): number;

export const DEFAULT_TARGET_DB: number;
export const DEFAULT_FLOOR_DB: number;
export const DEFAULT_MIN_GAIN_DB: number;
export const DEFAULT_MAX_GAIN_DB: number;
export const DEFAULT_RISE_DB_PER_SEC: number;
export const DEFAULT_FALL_DB_PER_SEC: number;
export const DEFAULT_LEVEL_SMOOTHING_SEC: number;
export const DEFAULT_LIMITER_CEILING_DB: number;
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
    limiterCeiling?: number;
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
    limiterCeiling: number;
    limiterAttackSec: number;
    limiterReleaseSec: number;
    enabled: boolean;
    gain: number;
    levelEstimate: number;
    limiterGain: number;

    constructor(opts?: AgcProcessorOptions);

    setEnabled(enabled: boolean): void;
    process(inp: Float32Array | null, out: Float32Array): AgcProcessResult;
}
