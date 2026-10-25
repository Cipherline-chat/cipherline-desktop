export function dbToLinear(db: number): number;
export function linearToDb(linear: number): number;

export const RX_TARGET_DB: number;
export const RX_DEADBAND_DB: number;
export const RX_MIN_GAIN_DB: number;
export const RX_MAX_GAIN_DB: number;
export const RX_RISE_DB_PER_SEC: number;
export const RX_FALL_DB_PER_SEC: number;
export const RX_LEVEL_SMOOTHING_SEC: number;
export const RX_BOOTSTRAP_SEC: number;
export const RX_BOOTSTRAP_RATE_MULT: number;
export const RX_MIN_EVIDENCE_SEC: number;
export const RX_FLOOR_DB: number;
export const RX_NOISE_MARGIN_DB: number;
export const RX_NOISE_FALL_FRACTION: number;
export const RX_NOISE_RISE_DB_PER_SEC: number;
export const RTP_LEVEL_BIAS_DB: number;
export const RX_BOOST_LATCH_SEC: number;

export function stepBoostLatch(
    accumSec: number,
    wantsBoost: boolean,
    dtSec: number,
): { accumSec: number; latched: boolean };

export interface ReceiveLevelerOptions {
    targetDb?: number;
    deadbandDb?: number;
    minGainDb?: number;
    maxGainDb?: number;
    riseDbPerSec?: number;
    fallDbPerSec?: number;
    smoothingSec?: number;
    bootstrapSec?: number;
    bootstrapMult?: number;
    minEvidenceSec?: number;
    floorDb?: number;
    noiseMarginDb?: number;
    biasDb?: number;
}

export class ReceiveLeveler {
    targetDb: number;
    deadbandDb: number;
    minGainDb: number;
    maxGainDb: number;
    gainDb: number;
    levelPower: number;
    activeSec: number;
    noiseFloorDb: number;
    readonly levelDb: number;

    constructor(opts?: ReceiveLevelerOptions);

    reset(): void;
    /** `audioLevel`: linear 0..1 from getSynchronizationSources(). Returns the gain (dB). */
    pushLinear(audioLevel: number | undefined, dtSec: number): number;
    /** `levelDb`: the RTP level already in dBov/dBFS RMS. Returns the gain (dB). */
    push(levelDb: number, dtSec: number): number;
}
