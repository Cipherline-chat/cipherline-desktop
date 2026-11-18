/**
 * Where the receive leveler (audio/receiveLeveler.js, "Normalize voice volume") gets a remote talker's level.
 *
 * ── Why this exists
 *
 * The leveler was built on the RTP `ssrc-audio-level` header extension, read per packet through
 * RTCRtpReceiver.getSynchronizationSources(). 2026-11-17 (claude/call-audio-e2e-test, a real two-peer
 * LiveKit round trip): LiveKit server v1.9.12 does NOT forward that extension to subscribers, so
 * getSynchronizationSources() carried no audioLevel in all four modes tried (E2EE on/off x single/dual
 * peer connection). The leveler never got a reading and held every talker at its -3 dB join gain for
 * the whole call: listeners heard ~-19 dBFS where -16 was sent, 4-7 dB under the design.
 *
 * ── What this reads instead
 *
 * The receiver's inbound-rtp stats: `totalAudioEnergy` / `totalSamplesDuration` (and `audioLevel`
 * when those are missing). Chromium computes them from the DECODED audio — after the E2EE frame
 * transform decrypted it and after NetEq — and before any gain of ours (element volume, the Web Audio
 * gain node), so the leveler stays open loop: it can never chase its own output.
 *
 * What they measure, measured in Chromium 159 (loopback RTCPeerConnection, 2026-11-18): libwebrtc's
 * AudioLevel, a PEAK envelope — the largest |sample| of each ~100 ms block, held and decayed /4 per
 * block — and energy += envelope² x duration. A sine reads +3.0 dB over its RMS (its peak), Gaussian
 * noise +12 dB, and 4 Hz 50 % on/off bursts read the same as continuous noise. So it is NOT an RMS:
 * the energy delta over a poll window is the power mean of that envelope, and RX_STATS_OVER_RTP_DB
 * maps it onto the scale of the RTP header level (the scale every leveler constant was tuned on),
 * calibrated on speech through the real round trip (harness/call-audio-e2e, see the constant).
 *
 * The RTP header level stays first choice whenever a receiver has one (a server that forwards it):
 * it is per packet, needs no getStats and is the scale the leveler was designed on.
 *
 * ── Cost
 *
 * One receiver.getStats() per remote mic every RX_STATS_POLL_MS, from the leveler's existing
 * LEVELER_POLL_MS timer (no new timer), never two in flight for one receiver. Chromium serves every
 * getStats() of one peer connection within ~50 ms from one cached collection, so the receivers of a
 * call polled on the same tick cost about one stats collection, four times a second.
 */
import { pickRtpLevel, type RtpSourceLike } from './incomingLeveler';
import { type RxPollTally } from './rxLevelLog';

/** How often a remote mic's stats are read when the RTP header has no level. */
export const RX_STATS_POLL_MS = 250;
/** A stats window shorter than this is too short to call a level (decoded seconds). */
export const RX_STATS_MIN_WINDOW_SEC = 0.05;
/**
 * How far the inbound-rtp energy level (peak envelope, power mean over the window) reads ABOVE the RTP
 * header level of the same speech. Calibrated in the real round trip (harness/call-audio-e2e, 2026-11-18):
 * the value that makes the leveler's converged active-speech level with this source match the one it
 * reaches fed the RTP header level of the sent signal (callAudioE2E.sweep.test.ts intendedLeveler).
 * 19 rows (quiet / normal talker x NS off / Light / Strong x gate on / off, quiet room, shout, PTT, NS
 * switching, unmute after 60 s, the fake-mic capture path): at 11 the leveler sat 1.13 dB (sd 1.1) over the
 * intended gain; at 10 it sits +0.25 dB (sd 1.1, worst rows -1.7 / +2.4), inside its own +-2.5 dB dead band.
 */
export const RX_STATS_OVER_RTP_DB = 10;
/** RFC 6464's floor (127 = silence): a window with no energy at all. */
const SILENCE_DB = -127;

export interface InboundAudioEnergy { id: string; energy?: number; duration?: number; audioLevel?: number }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The audio inbound-rtp entry of a receiver's stats report (null: none, or not a report). */
export function readInboundAudioEnergy(report: unknown): InboundAudioEnergy | null {
    const r = report as { forEach?: (cb: (s: Record<string, unknown>) => void) => void } | null | undefined;
    if (!r || typeof r.forEach !== 'function') return null;
    let out: InboundAudioEnergy | null = null;
    r.forEach(s => {
        if (out || !s || s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
        out = { id: String(s.id ?? s.ssrc ?? ''), energy: num(s.totalAudioEnergy), duration: num(s.totalSamplesDuration), audioLevel: num(s.audioLevel) };
    });
    return out;
}

export interface RxStatsReading {
    /** The level on the RTP header scale (dBov-like, what receiveLeveler.push takes). */
    rtpDb: number;
    /** Seconds of audio the reading stands for. */
    dtSec: number;
    via: 'energy' | 'audio_level';
}

/** Turns successive inbound-rtp samples of ONE receiver into level readings (energy deltas). */
export class RxStatsLevel {
    private last: { id: string; energy: number; duration: number } | null = null;

    reset(): void { this.last = null; }

    /**
     * One stats sample. `wallDtSec` is only used for the audioLevel fallback (no counters to diff).
     * undefined = no reading (first sample, a counter reset / new stream, too short a window, no stats).
     */
    push(s: InboundAudioEnergy | null, wallDtSec: number): RxStatsReading | undefined {
        if (!s) return undefined;
        if (s.energy !== undefined && s.duration !== undefined) {
            const last = this.last;
            if (!last || last.id !== s.id || s.duration < last.duration || s.energy < last.energy) {
                // First sample, another stream (track replaced), or the counters restarted: a new baseline.
                this.last = { id: s.id, energy: s.energy, duration: s.duration };
                return undefined;
            }
            const dDur = s.duration - last.duration;
            if (dDur < RX_STATS_MIN_WINDOW_SEC) return undefined; // keep the baseline: the window grows
            const power = (s.energy - last.energy) / dDur;
            this.last = { id: s.id, energy: s.energy, duration: s.duration };
            const db = power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB;
            return { rtpDb: db - RX_STATS_OVER_RTP_DB, dtSec: dDur, via: 'energy' };
        }
        this.last = null;
        if (s.audioLevel !== undefined && wallDtSec > 0) {
            const db = s.audioLevel > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(s.audioLevel)) : SILENCE_DB;
            return { rtpDb: db - RX_STATS_OVER_RTP_DB, dtSec: wallDtSec, via: 'audio_level' };
        }
        return undefined;
    }
}

/** The slice of RTCRtpReceiver this reads. */
export interface RxReceiverLike {
    getSynchronizationSources?: () => readonly RtpSourceLike[];
    getStats?: () => Promise<unknown>;
}

/** Per remote mic: the stats reader and its poll bookkeeping. */
export interface RxLevelPoll { stats: RxStatsLevel; statsAtMs: number; inFlight: boolean }
export const newRxLevelPoll = (): RxLevelPoll => ({ stats: new RxStatsLevel(), statsAtMs: -Infinity, inFlight: false });

export type RxLevelSrc = 'rtp' | 'stats';

/**
 * One leveler tick (LEVELER_POLL_MS) for one remote mic. When the receiver's sources carry an RTP header
 * level, that is the reading: delivered now (fresh) or not at all (stale = a pause). When they carry none,
 * the receiver's stats are read, at most every RX_STATS_POLL_MS and never two at once, and the reading is
 * delivered when getStats() resolves. Counts what it got in `tally` (rxLevelLog.ts; a getter, so a reading that
 * arrives after the caller started a new tally window counts in the new one). Returns true when a reading was
 * delivered synchronously.
 */
export function pollRxLevel(
    receiver: RxReceiverLike, p: RxLevelPoll, tallyOf: RxPollTally | (() => RxPollTally), nowMs: number, rtpDtSec: number,
    onReading: (rtpDb: number, dtSec: number, src: RxLevelSrc) => void,
): boolean {
    const tallyNow = (): RxPollTally => (typeof tallyOf === 'function' ? tallyOf() : tallyOf);
    const tally = tallyNow();
    const sources = typeof receiver.getSynchronizationSources === 'function' ? receiver.getSynchronizationSources() : undefined;
    tally.polls++;
    const hasRtp = !!sources && sources.some(s => typeof s.audioLevel === 'number' && Number.isFinite(s.audioLevel));
    if (hasRtp) {
        tally.withLevel++;
        const level = pickRtpLevel(sources, nowMs);
        if (level === undefined) return false;
        tally.fresh++;
        onReading(20 * Math.log10(Math.max(level, 1e-12)), rtpDtSec, 'rtp'); // = receiveLeveler.pushLinear's conversion
        return true;
    }
    if (p.inFlight || nowMs - p.statsAtMs < RX_STATS_POLL_MS || typeof receiver.getStats !== 'function') return false;
    const wallDt = Number.isFinite(p.statsAtMs) ? Math.min(0.5, (nowMs - p.statsAtMs) / 1000) : RX_STATS_POLL_MS / 1000;
    p.inFlight = true;
    p.statsAtMs = nowMs;
    let pending: Promise<unknown>;
    try { pending = receiver.getStats(); } catch { p.inFlight = false; return false; }
    void Promise.resolve(pending).then(rep => {
        const r = p.stats.push(readInboundAudioEnergy(rep), wallDt);
        if (!r) return;
        const t = tallyNow();
        t.stats = (t.stats ?? 0) + 1;
        onReading(r.rtpDb, r.dtSec, 'stats');
    }).catch(() => { /* the track went away mid-read */ }).finally(() => { p.inFlight = false; });
    return false;
}
