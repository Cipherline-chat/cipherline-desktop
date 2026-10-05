export const RNNOISE_FRAME: number;
export const RING_FRAMES: number;
export const RING_SIZE: number;
export const MAX_INLINE_FRAMES_PER_QUANTUM: number;
export const PREBUFFER_SAMPLES: number;
export const CROSSFADE_SAMPLES: number;
export const UNDERRUN_TRIP_COUNT: number;
export const UNDERRUN_WINDOW_QUANTA: number;
export const BYPASS_COOLDOWN_QUANTA: number;
export const BYPASS_BACKOFF_QUANTA: number;
export const STATS_INTERVAL_QUANTA: number;

export function quantaFor(ms: number): number;

export type NsStateValue = 'priming' | 'active' | 'bypass';

export const NsState: Readonly<{
    PRIMING: 'priming';
    ACTIVE: 'active';
    BYPASS: 'bypass';
}>;

export interface NsOutputRingOptions {
    ringSize?: number;
    prebufferSamples?: number;
    crossfadeSamples?: number;
    compGain?: number;
}

export interface NsProcessOptions {
    bypassed?: boolean;
}

export interface NsProcessResult {
    underrun: boolean;
    bypassTripped: boolean;
    bypassRecovered: boolean;
}

export class NsOutputRing {
    size: number;
    buf: Float32Array;
    w: number;
    r: number;
    prebufferSamples: number;
    crossfadeSamples: number;
    compGain: number;
    state: NsStateValue;
    fadeRemaining: number;
    quanta: number;
    underrunLog: number[];
    bypassUntilQuanta: number;
    consecutiveFastTrips: number;
    lastTripQuanta: number;

    constructor(opts?: NsOutputRingOptions);

    reset(): void;
    setCompGain(gain: number): void;
    available(): number;
    push(sample: number): void;
    process(raw: Float32Array | null | undefined, out: Float32Array, opts?: NsProcessOptions): NsProcessResult;
}
