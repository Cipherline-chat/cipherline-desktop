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
 * A second event, `mic_noise` (same window; mic_level has no free detail slot), says what ELSE the gate let through, all
 * of which leaves with gain_db too (owner report 5ffa77e6, 2026-11-18: "background noise turned way up, also when
 * typing" could not be told apart from a quiet voice without it):
 *   noise_pct   share of the window the gate PASSED audible sound that was not the talker's voice (key clicks, a loud
 *               room, a TV; GateCutMeter `noise`), while the gate was on
 *   bursts_min  sounds that crossed the gate threshold away from voice with no voice after them (key clicks, knocks;
 *               GateCutMeter `bursts`), per minute of gate-on time
 *   room_db     the gate input's quietest block, mean over the window's seconds (dBFS, after noise suppression): the
 *               room as the gate sees it (a minimum, so it reads a few dB under the room's average level)
 * On the new engine (no automatic gate) `mic_noise` instead says what leaves BETWEEN words (call reports 2026-11-21:
 * "background noise like crazy" with auto gain at +17..+32 dB; nothing in a report said how loud a pause was):
 *   pause_pct     share of the window that was a pause (detector quiet for >= 130 ms, mic not muted at the device)
 *   pause_in_db   level of those pauses at the microphone, dBFS (the room as the mic hears it)
 *   pause_out_db  level of the same pauses on the wire (pause_out_db - pause_in_db = gain the room left with)
 *   pause_max_db  the loudest 2.7 ms of any pause on the wire
 *   loud_pct      share of the pause time that was louder than -50 dBFS on the wire (plainly audible)
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
    noiseSum: number; noiseN: number; bursts: number;
    roomSum: number; roomN: number;
    rawMs: number; nsMs: number; tapN: number;
    micGainDb: number;
    /** new engine: pause quanta and their levels (absent on the legacy chain) */
    pauseN?: number; pauseInMs?: number; pauseOutMs?: number; pauseMaxMs?: number; pauseLoud?: number;
    eNoise?: number;
    /** The new audio engine ('v2') produced these seconds: its own counters, summed over the window. Absent = legacy chain. */
    engine?: boolean; eFrames?: number; eBad?: number; eResets?: number; eIdle?: number; eUnder?: number; eMuted?: boolean;
    /** native Strong (DeepFilterNet in the utility process): counters summed over the window, hand-off latency worst of its seconds */
    nat?: boolean; nFrames?: number; nUnder?: number; nWatchdog?: number; nP50?: number; nP95?: number; nP99?: number; nMax?: number;
}

const fresh = (): MicLevelAcc => ({
    sec: 0, blocks: 0, voiced: 0, inMs: 0, outMs: 0, peak: 0, held: 0, clip: 0,
    gainSum: 0, gainN: 0, gateSum: 0, gateN: 0, noiseSum: 0, noiseN: 0, bursts: 0, roomSum: 0, roomN: 0, rawMs: 0, nsMs: 0, tapN: 0, micGainDb: 0,
});

let acc = fresh();

/** The `mic_level` detail for a window, or null when there was too little speech. Pure. */
export function summarizeMicLevel(a: MicLevelAcc): Record<string, number | string> | null {
    if (a.voiced < MIC_LEVEL_MIN_VOICED_BLOCKS || a.blocks <= 0) return null;
    const inMs = a.inMs / a.voiced;
    const outMs = a.outMs / a.voiced;
    const detail: Record<string, number | string> = {
        speech_db: r1(db(inMs)),
        gain_db: r1(a.gainN > 0 ? a.gainSum / a.gainN : 0),
        out_db: r1(db(outMs)),
        peak_db: r1(db(a.peak * a.peak)),
        clip: a.clip,
        talk_pct: Math.round((100 * a.voiced) / a.blocks),
        mic_gain_db: r1(a.micGainDb),
    };
    if (a.engine) detail.engine = 'v2';
    else detail.lim_pct = Math.round((100 * a.held) / a.voiced); // the new engine has no separate hold counter
    if (a.gateN > 0) detail.gate_pct = Math.round((100 * a.gateSum) / a.gateN);
    if (a.tapN > 0) {
        detail.raw_db = r1(db(a.rawMs / a.tapN));
        detail.ns_db = r1(db(a.nsMs / a.tapN));
    }
    return detail;
}

/** The `mic_noise` detail for a window (same speech rule as mic_level), or null. Pure. */
export function summarizeMicNoise(a: MicLevelAcc): Record<string, number> | null {
    if (a.voiced < MIC_LEVEL_MIN_VOICED_BLOCKS || a.blocks <= 0) return null;
    const detail: Record<string, number> = {};
    if (a.noiseN > 0) {
        detail.noise_pct = Math.round((100 * a.noiseSum) / a.noiseN);
        detail.bursts_min = r1((a.bursts * 60) / a.noiseN);
    }
    if (a.roomN > 0) detail.room_db = r1(a.roomSum / a.roomN);
    const pn = a.pauseN ?? 0;
    if (a.engine && pn > 0) {
        detail.pause_pct = Math.round((100 * pn) / a.blocks);
        detail.pause_in_db = r1(db((a.pauseInMs ?? 0) / pn));
        detail.pause_out_db = r1(db((a.pauseOutMs ?? 0) / pn));
        detail.pause_max_db = r1(db(a.pauseMaxMs ?? 0));
        detail.loud_pct = Math.round((100 * (a.pauseLoud ?? 0)) / pn);
    }
    return Object.keys(detail).length ? detail : null;
}

/** The `mic_engine` detail for a window of the new audio engine (counters it keeps itself), or null on the legacy chain. Pure. */
export function summarizeMicEngine(a: MicLevelAcc): Record<string, number | string | boolean> | null {
    if (!a.engine || a.voiced < MIC_LEVEL_MIN_VOICED_BLOCKS || a.blocks <= 0) return null;
    const d: Record<string, number | string | boolean> = {
        engine: 'v2',
        bad: a.eBad ?? 0,
        resets: a.eResets ?? 0,
        idle: Math.round((100 * (a.eIdle ?? 0)) / Math.max(1, a.eFrames ?? 0)), // idle (digital-silence) 10 ms frames as % of the window's frames
        under: a.eUnder ?? 0,
        muted_dev: !!a.eMuted,
        engine_native: !!a.nat,
        // the noise profile that actually ran: native = Strong in the utility process, else what the page's engine reports
        ns: a.nat ? 'strong' : (['off', 'light', 'strong', 'strong_std'][a.eNoise ?? -1] ?? 'unknown'),
    };
    return d;
}

/** The `mic_native` detail for a window of native Strong (frames the page needed from the utility process, how many were not there in time
 *  and played as Light, frames the watchdog passed around the model, the worklet -> utility process -> worklet hand-off in ms: worst
 *  second of the window per percentile), or null when native did not run. Pure. */
export function summarizeMicNative(a: MicLevelAcc): Record<string, number> | null {
    if (!a.nat) return null;
    return {
        frames: a.nFrames ?? 0, under: a.nUnder ?? 0, watchdog: a.nWatchdog ?? 0,
        p50_ms: a.nP50 ?? 0, p95_ms: a.nP95 ?? 0, p99_ms: a.nP99 ?? 0, max_ms: a.nMax ?? 0,
    };
}

/** Fold in one second from the voice processor; logs when a window is full. */
export function recordMicLevelSecond(s: MicLevelSecond): void {
    acc.sec += 1;
    acc.blocks += s.blocks; acc.voiced += s.voiced; acc.inMs += s.inMs; acc.outMs += s.outMs;
    if (s.peak > acc.peak) acc.peak = s.peak;
    acc.held += s.held; acc.clip += s.clip;
    if (s.voiceActive) { acc.gainSum += s.gainDb; acc.gainN++; }
    if (s.gateOpenFrac !== null) { acc.gateSum += s.gateOpenFrac; acc.gateN++; }
    if (s.gateNoiseFrac != null) { acc.noiseSum += s.gateNoiseFrac; acc.noiseN++; acc.bursts += s.gateBursts ?? 0; }
    // a digitally silent second (muted, -240) would drag a mean of dB down without saying anything about the room
    if (s.gateMinDb != null && Number.isFinite(s.gateMinDb) && s.gateMinDb > -120) { acc.roomSum += s.gateMinDb; acc.roomN++; }
    if (s.rawMs !== null && s.nsMs !== null) { acc.rawMs += s.rawMs; acc.nsMs += s.nsMs; acc.tapN++; }
    acc.micGainDb = s.micGainDb;
    if (s.engine === 'v2') {
        acc.engine = true;
        acc.eBad = (acc.eBad ?? 0) + (s.engineBad ?? 0); acc.eResets = (acc.eResets ?? 0) + (s.engineResets ?? 0);
        acc.eFrames = (acc.eFrames ?? 0) + (s.engineFrames ?? 0); acc.eIdle = (acc.eIdle ?? 0) + (s.engineIdle ?? 0); acc.eUnder = (acc.eUnder ?? 0) + (s.engineUnder ?? 0);
        acc.eMuted = acc.eMuted || !!s.mutedAtDevice;
        acc.pauseN = (acc.pauseN ?? 0) + (s.pauseN ?? 0); acc.pauseInMs = (acc.pauseInMs ?? 0) + (s.pauseInMs ?? 0);
        acc.pauseOutMs = (acc.pauseOutMs ?? 0) + (s.pauseOutMs ?? 0); acc.pauseLoud = (acc.pauseLoud ?? 0) + (s.pauseLoud ?? 0);
        acc.pauseMaxMs = Math.max(acc.pauseMaxMs ?? 0, s.pauseMaxMs ?? 0);
        if (typeof s.engineNoise === 'number' && s.engineNoise >= 0) acc.eNoise = s.engineNoise;
        if (s.engineNative) {
            acc.nat = true;
            acc.nFrames = (acc.nFrames ?? 0) + (s.nativeFrames ?? 0); acc.nUnder = (acc.nUnder ?? 0) + (s.nativeUnder ?? 0); acc.nWatchdog = (acc.nWatchdog ?? 0) + (s.nativeWatchdog ?? 0);
            acc.nP50 = Math.max(acc.nP50 ?? 0, s.nativeP50 ?? 0); acc.nP95 = Math.max(acc.nP95 ?? 0, s.nativeP95 ?? 0);
            acc.nP99 = Math.max(acc.nP99 ?? 0, s.nativeP99 ?? 0); acc.nMax = Math.max(acc.nMax ?? 0, s.nativeMax ?? 0);
        }
    }
    if (acc.sec * 1000 < MIC_LEVEL_LOG_MS) return;
    const detail = summarizeMicLevel(acc);
    const noise = summarizeMicNoise(acc);
    const eng = summarizeMicEngine(acc);
    const nat = summarizeMicNative(acc);
    acc = fresh();
    if (detail) logCallEvent('mic_level', detail);
    if (detail && eng) logCallEvent('mic_engine', eng);
    if (detail && eng && nat) logCallEvent('mic_native', nat);
    if (detail && noise) logCallEvent('mic_noise', noise);
}

/** A call ended (or a new one began): forget the partial window. */
export function resetMicLevelLog(): void {
    acc = fresh();
}
