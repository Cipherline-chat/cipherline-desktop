export const GC_MIN_DB: number;
export const GC_SCORE: number;
export const GC_MIN_RUN: number;
export const GC_RUN_GAP_SEC: number;
export const GC_PHRASE_GAP_SEC: number;
export const GC_START_BLOCKS: number;
export const GC_CLOSE_AFTER_VOICE_SEC: number;
export const GC_CLOSE_RESUME_SEC: number;
export const GC_NOISE_AFTER_VOICE_SEC: number;
export const GC_BURST_CONFIRM_SEC: number;

export interface GateCutCounts {
    /** Voice blocks (128 samples) in the interval. */
    voiced: number;
    /** ... of which the gate passed less than half. */
    gated: number;
    /** Sum of the voice blocks' mean-square. */
    vms: number;
    /** Phrase starts (first voice after GC_PHRASE_GAP_SEC without any). */
    starts: number;
    /** ... of which the gate was closed on at least half of the first GC_START_BLOCKS voice blocks. */
    clipped: number;
    /** Mid-phrase closes (closed right after voice, voice back within GC_CLOSE_RESUME_SEC). */
    closes: number;
    /** All blocks of the interval (while the gate is on). */
    blocks: number;
    /** Audible blocks the gate passed more than GC_NOISE_AFTER_VOICE_SEC from any voice (keys, a loud room). */
    noise: number;
    /** Threshold crossings away from voice that no voice followed (key clicks, knocks). */
    bursts: number;
}

export class GateCutMeter {
    constructor(sampleRate: number);
    push(block: Float32Array, rms: number, passed: boolean, over?: boolean): void;
    clearState(): void;
    take(): GateCutCounts;
}
