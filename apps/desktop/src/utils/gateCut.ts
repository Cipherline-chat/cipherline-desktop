/**
 * "Your voice gate may be cutting you off": the decision, the suggested fix, and when the prompt may show.
 *
 * Owner 2026-11-17: "we should find a way to detect if people are talking and the noise gate is cutting them out to
 * prompt for it". The gate worklet's GateCutMeter (audio/gateCutMeter.js) reports once a second how many blocks of the
 * user's VOICED speech (pitch on 2+ analyses in a row) the fixed gate closed on, how many phrase starts there were and how
 * many of those it clipped, and the voice level. This module keeps a rolling window of those seconds and decides.
 *
 * Detection only, never automatic: the threshold never moves on its own. The prompt offers to LOWER it to a suggested
 * value (written through the same setter as the Settings slider) or to turn the gate off. When it may show:
 * gateCutPrompt.ts. Pure and DOM-free (the voice processor imports it).
 *
 * Thresholds (audit harness replays of real speech through the real chain, docs/worklog/entries/2026-11-17-audio-audit.md):
 * a quiet talker (-45 dBFS) behind the -45 default loses a large share of voiced blocks and most phrase starts; a normal
 * or loud talker behind -45, or a quiet one behind -60, loses almost none; rooms with nobody talking produce no voice.
 */

/** One second of GateCutMeter counts (gateStats.cut), plus that second's quietest block (gateStats.minDb). */
export interface GateCutSecond {
    voiced: number;
    gated: number;
    vms: number;
    starts: number;
    clipped: number;
    /** Mid-phrase closes: the gate closed on the talker inside a phrase. */
    closes: number;
    /** Quietest 128-sample block of the second at the gate (dBFS), null if none. */
    minDb: number | null;
}

/** Block length the counts are in (128 samples at 48 kHz). */
export const GC_BLOCK_SEC = 128 / 48000;
/** Seconds of VOICED speech a decision needs (about 50-60 s of conversation for a typical talker). */
export const GC_WINDOW_VOICED_SEC = 20;
/** The window looks back at most this far. */
export const GC_WINDOW_MAX_SEC = 180;
/** Trigger: at least this share of voiced blocks gated ... */
export const GC_GATED_SHARE = 0.08;
/** ... or at least this share of phrase starts clipped, over at least GC_MIN_STARTS starts. */
export const GC_CLIPPED_START_SHARE = 0.4;
export const GC_MIN_STARTS = 8;
/** ... or at least this many mid-phrase cuts in the window (15 per minute of voice). The operative rule on real speech:
 *  a -45 dBFS talker behind the -45 default is cut 16-40 times per voiced minute, a -30 or -16 talker behind it 0-6. */
export const GC_WINDOW_CLOSES = 5;
/** Suggested threshold: this far under the voice level, never closer than GC_SUGGEST_OVER_FLOOR_DB over the room. */
export const GC_SUGGEST_UNDER_SPEECH_DB = 15;
export const GC_SUGGEST_OVER_FLOOR_DB = 6;
/** The slider's range. */
export const GATE_MIN_DB = -60;
/** A suggestion must lower the threshold by at least this much to be worth offering. */
export const GC_MIN_LOWERING_DB = 3;

export interface GateCutDetection {
    voicedSec: number;
    /** Share of voiced blocks the gate closed on (0..1). */
    gatedShare: number;
    starts: number;
    clipped: number;
    /** Mid-phrase closes per minute of voice. */
    closesPerMin: number;
    /** Level of the voiced blocks (dBFS RMS, at the gate). */
    speechDb: number;
    /** Median quietest-block level over the window (dBFS), null if unknown. */
    floorDb: number | null;
    thresholdDb: number;
    /** A lower threshold to offer, or null when lowering cannot help (the voice is too close to the room). */
    suggestDb: number | null;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** The threshold to offer for a voice at `speechDb` in a room at `floorDb` behind a gate at `thresholdDb`. Pure. */
export function suggestThreshold(speechDb: number, floorDb: number | null, thresholdDb: number): number | null {
    let s = Math.round(speechDb - GC_SUGGEST_UNDER_SPEECH_DB);
    if (floorDb !== null && Number.isFinite(floorDb)) s = Math.max(s, Math.ceil(floorDb + GC_SUGGEST_OVER_FLOOR_DB));
    s = Math.max(GATE_MIN_DB, s);
    return s <= thresholdDb - GC_MIN_LOWERING_DB ? s : null;
}

/** Decide over a window of seconds (oldest first). Pure. */
export function decideGateCut(window: readonly GateCutSecond[], thresholdDb: number): GateCutDetection | null {
    let voiced = 0, gated = 0, vms = 0, starts = 0, clipped = 0, closes = 0;
    const floors: number[] = [];
    for (let i = window.length - 1; i >= 0 && window.length - i <= GC_WINDOW_MAX_SEC; i--) {
        const w = window[i];
        voiced += w.voiced; gated += w.gated; vms += w.vms; starts += w.starts; clipped += w.clipped; closes += w.closes;
        if (w.minDb !== null && Number.isFinite(w.minDb)) floors.push(w.minDb);
        if (voiced * GC_BLOCK_SEC >= GC_WINDOW_VOICED_SEC) break;
    }
    const voicedSec = voiced * GC_BLOCK_SEC;
    if (voicedSec < GC_WINDOW_VOICED_SEC || voiced <= 0) return null;
    const gatedShare = gated / voiced;
    const startsHit = starts >= GC_MIN_STARTS && clipped / starts >= GC_CLIPPED_START_SHARE;
    const closesPerMin = closes / (voicedSec / 60);
    if (gatedShare < GC_GATED_SHARE && !startsHit && closes < GC_WINDOW_CLOSES) return null;
    const speechDb = 10 * Math.log10(Math.max(vms / voiced, 1e-20));
    const floorDb = floors.length ? median(floors) : null;
    return { voicedSec, gatedShare, starts, clipped, closesPerMin, speechDb, floorDb, thresholdDb, suggestDb: suggestThreshold(speechDb, floorDb, thresholdDb) };
}

/** Rolling window of seconds; cleared whenever the evidence stops applying (threshold changed, gate toggled). */
export class GateCutWatcher {
    private secs: GateCutSecond[] = [];
    push(sec: GateCutSecond): void {
        this.secs.push(sec);
        if (this.secs.length > GC_WINDOW_MAX_SEC) this.secs.shift();
    }
    reset(): void { this.secs = []; }
    decide(thresholdDb: number): GateCutDetection | null { return decideGateCut(this.secs, thresholdDb); }
}

/** Parse a `gateStats` message's `cut` / `minDb` into a second, or null if it carries none. */
export function gateCutSecondFrom(data: { cut?: unknown; minDb?: unknown }): GateCutSecond | null {
    const c = data.cut as Partial<Record<keyof GateCutSecond, unknown>> | undefined;
    if (!c || typeof c !== 'object') return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
        voiced: n(c.voiced), gated: n(c.gated), vms: n(c.vms), starts: n(c.starts), clipped: n(c.clipped), closes: n(c.closes),
        minDb: typeof data.minDb === 'number' && Number.isFinite(data.minDb) ? data.minDb : null,
    };
}

// ── From the gate worklet to whoever shows the prompt ────────────────────────
// The voice processor publishes each second here (voiceProcessor.ts, gateStats); the in-call prompt subscribes
// (useGateCutPrompt). Module-level because the processor outlives any one component.
type Listener = (sec: GateCutSecond) => void;
const listeners = new Set<Listener>();
export function publishGateCutSecond(sec: GateCutSecond): void {
    listeners.forEach(l => { try { l(sec); } catch { /* a listener's problem is not the audio thread's */ } });
}
export function subscribeGateCutSeconds(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}
