/**
 * Wire protocol between the page's audio worklet and the native audio utility process (electron/audio-engine-host.ts).
 * Pure: no electron / node imports, so the host, main and the tests share ONE validator. The worklet speaks the same
 * shapes (src/audio/clAudioWorklet.js, "native mode"); src/utils/clAudioNativeProtocol.test.ts pins them together.
 *
 * Only three things may cross: 10 ms PCM frames (exactly 480 floats), settings (enums and finite numbers) and
 * numbers (stats). Everything else is dropped by `parseWorkletMessage` BEFORE it reaches the addon.
 */

export const NATIVE_FRAME = 480;
/** Sequence numbers are integers in [0, 2^48): doubles stay exact, and a corrupt value is rejected outright. */
export const MAX_SEQ = 2 ** 48;

export type WorkletToHost =
    | { t: 'f'; seq: number; ts: number; pcm: Float32Array }
    | { t: 's'; id: number; noise: 0 | 1 | 2 | 3; autoGain: boolean; manualGainDb: number; originalSound: boolean }
    | { t: 'dc'; hasGain: boolean; gainDb: number }
    | { t: 'g'; db: number }
    | { t: 'gate'; enabled: boolean; thresholdDb: number }
    | { t: 'stats' }
    | { t: 'bye' };

export type HostToWorklet =
    | { t: 'o'; seq: number; ts: number; pcm: Float32Array; st: 0 | 1 | 2; us: number }
    | { t: 'ready'; delaySamples: number; effectiveNoise: number }
    | { t: 'ack'; id: number; ok: boolean; effectiveNoise: number }
    | { t: 'stats'; [k: string]: number | boolean | string }
    | { t: 'failed'; error: string };

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v < hi;
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate one message from the worklet's port. Returns null for anything that is not exactly one of the allowed shapes.
 * A frame must be a Float32Array of exactly 480 floats (NaN/Inf inside it are the engine's input guard's business: they
 * are made safe, not rejected, so one glitchy sample does not cost the whole frame).
 */
export function parseWorkletMessage(raw: unknown): WorkletToHost | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    switch (m.t) {
        case 'f': {
            if (!isInt(m.seq, 0, MAX_SEQ) || !isFin(m.ts)) return null;
            if (!(m.pcm instanceof Float32Array) || m.pcm.length !== NATIVE_FRAME) return null;
            return { t: 'f', seq: m.seq, ts: m.ts, pcm: m.pcm };
        }
        case 's': {
            if (!isInt(m.id, 0, MAX_SEQ) || !isInt(m.noise, 0, 4)) return null;
            if (typeof m.autoGain !== 'boolean' || typeof m.originalSound !== 'boolean' || !isFin(m.manualGainDb)) return null;
            return { t: 's', id: m.id, noise: m.noise as 0 | 1 | 2 | 3, autoGain: m.autoGain, manualGainDb: Math.max(-40, Math.min(40, m.manualGainDb)), originalSound: m.originalSound };
        }
        case 'dc': {
            if (typeof m.hasGain !== 'boolean' || !isFin(m.gainDb)) return null;
            return { t: 'dc', hasGain: m.hasGain, gainDb: Math.max(-60, Math.min(60, m.gainDb)) };
        }
        case 'gate': {
            // the user's manual noise gate: applied by the engine on its own output, so native and Light frames are gated the same way
            if (typeof m.enabled !== 'boolean' || !isFin(m.thresholdDb)) return null;
            return { t: 'gate', enabled: m.enabled, thresholdDb: Math.max(-100, Math.min(0, m.thresholdDb)) };
        }
        case 'g': return isFin(m.db) ? { t: 'g', db: Math.max(-60, Math.min(60, m.db)) } : null;
        case 'stats': return { t: 'stats' };
        case 'bye': return { t: 'bye' };
        default: return null;
    }
}

/**
 * Decides what the host does with an arriving frame: process it, drop it as a duplicate/old one, or drop it because it is stale (so the
 * host never spends CPU on audio the page has already given up on, e.g. the backlog that queues up behind a ~1 s model rebuild).
 *
 * `lastSeq` strictly increases: a frame with `seq <= lastSeq` (duplicate or out of order) is dropped, because the model is recurrent and
 * must see time in order. A gap (lost frames) is allowed and reported.
 * Staleness is the frame's AGE: host wall clock minus the wall-clock stamp the worklet put on it when it sent it (both are `Date.now()` on
 * the same machine, so there is no clock to calibrate; an earlier version compared arrival time against the audio clock, which drifts
 * apart from the wall clock exactly when the machine is starved, and then dropped a healthy stream for minutes). An age above `STALE_MS`
 * is stale; a negative age (the stamp is ahead: 1 ms rounding) counts as 0; an age above `CLOCK_JUMP_MS` means the system clock was
 * stepped, and the frame is processed rather than dropped.
 */
export const STALE_MS = 60;
export const CLOCK_JUMP_MS = 5000;
export type FrameVerdict = { act: 'process'; gap: number } | { act: 'drop'; why: 'dup' | 'old' | 'stale' };

export class FrameGate {
    lastSeq = -1;
    dropped = { dup: 0, old: 0, stale: 0 };
    lost = 0;
    judge(seq: number, nowMs: number, stampMs: number): FrameVerdict {
        if (seq === this.lastSeq) { this.dropped.dup++; return { act: 'drop', why: 'dup' }; }
        if (seq < this.lastSeq) { this.dropped.old++; return { act: 'drop', why: 'old' }; }
        const age = nowMs - stampMs;
        if (age > STALE_MS && age < CLOCK_JUMP_MS) {
            // do not advance lastSeq: the next fresh frame is processed and the model sees a gap, not stale audio
            this.dropped.stale++;
            return { act: 'drop', why: 'stale' };
        }
        const gap = this.lastSeq < 0 ? 0 : seq - this.lastSeq - 1;
        this.lost += gap;
        this.lastSeq = seq;
        return { act: 'process', gap };
    }
    /** a new stream (the page re-opened the port) */
    reset(): void { this.lastSeq = -1; }
}
