/**
 * The outgoing mic's loudness, for diagnostic reports.
 *
 * "My microphone is much quieter than on Discord" (2026-11-10) could not be
 * answered from a report: it had settings and packet stats but no level at all,
 * so nobody could tell a quiet mic from a quiet setting from a fine call. This
 * folds the voice processor's once-a-second numbers (voiceProcessor.ts
 * `MicLevelSecond`) into one `mic_level` call event every MIC_LEVEL_LOG_MS of
 * TALKING, so a report shows, for the stretch the user spoke:
 *
 *   raw_db      speech level of the raw capture (before noise suppression), dBFS
 *   ns_db       ... after noise suppression (raw_db - ns_db = what it removed;
 *               negative = it made the voice louder, Light compensates +3.5 dB)
 *   speech_db   ... going into auto gain control (after gate, EQ and the mic-volume stage:
 *               since 2026-11-11 the slider boost is IN this number, not added after)
 *   gain_db     the gain auto gain control applied, mean over speech
 *   out_db      speech level on the wire
 *   peak_db     loudest sample on the wire (> 0 = clipping)
 *   clip        samples at full scale on the wire
 *   lim_pct     share of speech the compressor / limiter held down by >= 1 dB
 *   talk_pct    share of the window the AGC heard voice
 *   gate_pct    share of the window the voice gate was open
 *   mic_gain_db the Settings mic-volume slider, as dB
 *
 * Numbers only, never audio, in memory until the user sends a report. Levels are
 * averaged as POWER (mean-square), not as dB, so one loud syllable does not
 * hide a quiet talker and silence does not drag the mean down (only voiced
 * quanta are counted).
 */
import { logCallEvent } from './callEventLog';
import type { MicLevelSecond } from './voiceProcessor';

/** One event per this much wall time, and only if there was speech in it. */
export const MIC_LEVEL_LOG_MS = 30_000;
/** Less speech than this in a window is not worth a level (a cough). */
export const MIC_LEVEL_MIN_VOICED_BLOCKS = 375; // ~1 s at 48 kHz

const db = (ms: number): number => 10 * Math.log10(Math.max(ms, 1e-14));
const r1 = (n: number): number => Math.round(n * 10) / 10;

export interface MicLevelAcc {
    sec: number;
    blocks: number; voiced: number; inMs: number; outMs: number; peak: number; held: number; clip: number;
    gainSum: number; gainN: number;
    gateSum: number; gateN: number;
    rawMs: number; nsMs: number; tapN: number;
    micGainDb: number;
}

const fresh = (): MicLevelAcc => ({
    sec: 0, blocks: 0, voiced: 0, inMs: 0, outMs: 0, peak: 0, held: 0, clip: 0,
    gainSum: 0, gainN: 0, gateSum: 0, gateN: 0, rawMs: 0, nsMs: 0, tapN: 0, micGainDb: 0,
});

let acc = fresh();

/** The `mic_level` detail for a window, or null when there was too little speech. Pure. */
export function summarizeMicLevel(a: MicLevelAcc): Record<string, number> | null {
    if (a.voiced < MIC_LEVEL_MIN_VOICED_BLOCKS || a.blocks <= 0) return null;
    const inMs = a.inMs / a.voiced;
    const outMs = a.outMs / a.voiced;
    const detail: Record<string, number> = {
        speech_db: r1(db(inMs)),
        gain_db: r1(a.gainN > 0 ? a.gainSum / a.gainN : 0),
        out_db: r1(db(outMs)),
        peak_db: r1(db(a.peak * a.peak)),
        clip: a.clip,
        lim_pct: Math.round((100 * a.held) / a.voiced),
        talk_pct: Math.round((100 * a.voiced) / a.blocks),
        mic_gain_db: r1(a.micGainDb),
    };
    if (a.gateN > 0) detail.gate_pct = Math.round((100 * a.gateSum) / a.gateN);
    if (a.tapN > 0) {
        detail.raw_db = r1(db(a.rawMs / a.tapN));
        detail.ns_db = r1(db(a.nsMs / a.tapN));
    }
    return detail;
}

/** Fold in one second from the voice processor; logs when a window is full. */
export function recordMicLevelSecond(s: MicLevelSecond): void {
    acc.sec += 1;
    acc.blocks += s.blocks; acc.voiced += s.voiced; acc.inMs += s.inMs; acc.outMs += s.outMs;
    if (s.peak > acc.peak) acc.peak = s.peak;
    acc.held += s.held; acc.clip += s.clip;
    if (s.voiceActive) { acc.gainSum += s.gainDb; acc.gainN++; }
    if (s.gateOpenFrac !== null) { acc.gateSum += s.gateOpenFrac; acc.gateN++; }
    if (s.rawMs !== null && s.nsMs !== null) { acc.rawMs += s.rawMs; acc.nsMs += s.nsMs; acc.tapN++; }
    acc.micGainDb = s.micGainDb;
    if (acc.sec * 1000 < MIC_LEVEL_LOG_MS) return;
    const detail = summarizeMicLevel(acc);
    acc = fresh();
    if (detail) logCallEvent('mic_level', detail);
}

/** A call ended (or a new one began): forget the partial window. */
export function resetMicLevelLog(): void {
    acc = fresh();
}
