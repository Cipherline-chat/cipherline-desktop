/**
 * Cadence of the `rx_level` call event (useParticipantAudio.pollLevelers): what ONE
 * remote talker sends us (the leveler's estimate of their active-speech level on the
 * wire, dBFS), the gain our listener-side leveler applied, and the level that adds up
 * to, before the listener's own volume sliders. A per-call `slot` placeholder
 * (remote-av-N, avSyncMonitor.slotFor) stands in for the person. Levels only.
 *
 * Together with the sender's own `mic_level` this lets a report say whose mic is
 * quiet: a low wire_db from a talker whose mic_level says out_db is fine means the
 * loss is in transit or in the listener's chain; a low out_db means the mic.
 */
export const RX_LEVEL_LOG_MS = 30_000;
/** Seconds of NEW speech the leveler must have heard since the last event. */
export const RX_LEVEL_MIN_NEW_SPEECH_SEC = 3;

/**
 * Why a report can have NO `rx_level` (2026-11-11, owner + friend reports, both with
 * "Normalize voice volume" on and a talker on the line, neither carrying a single
 * `rx_level`): the event is only written after RX_LEVEL_MIN_NEW_SPEECH_SEC of speech READ OFF
 * THE RTP audio-level header, so "the talker was quiet", "the receiver reports no sources /
 * no audioLevel at all" (the E2EE frame transform can drop the per-packet source info that
 * getSynchronizationSources() is built from) and "the readings are stale" all looked the same:
 * silence. The tally below counts what each poll got, so a window with no speech still says
 * which of those it was (`rx_level` with `reason` instead of `wire_db`).
 */
import { pickRtpLevel, type RtpSourceLike } from './incomingLeveler';

export interface RxPollTally { polls: number; withLevel: number; fresh: number }
export const newRxPollTally = (): RxPollTally => ({ polls: 0, withLevel: 0, fresh: 0 });

/** Count one poll of getSynchronizationSources() and return the fresh level (or undefined). Pure but for `t`. */
export function tallyRxPoll(t: RxPollTally, sources: readonly RtpSourceLike[] | undefined, nowMs: number): number | undefined {
    t.polls++;
    if (sources && sources.some(s => typeof s.audioLevel === 'number' && Number.isFinite(s.audioLevel))) t.withLevel++;
    const level = pickRtpLevel(sources, nowMs);
    if (level !== undefined) t.fresh++;
    return level;
}

export type RxNoSpeechReason = 'no_source' | 'stale' | 'quiet';

/** Which of the three it was, for a window that heard no speech. null = nothing was polled. */
export function rxNoSpeechReason(t: RxPollTally): RxNoSpeechReason | null {
    if (t.polls <= 0) return null;
    if (t.withLevel === 0) return 'no_source';
    if (t.fresh === 0) return 'stale';
    return 'quiet';
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((100 * n) / d) : 0);
/** The poll-health fields every rx_level carries: share of polls with a source+level, and with a fresh one. */
export function rxPollFields(t: RxPollTally): { src_pct: number; fresh_pct: number } {
    return { src_pct: pct(t.withLevel, t.polls), fresh_pct: pct(t.fresh, t.polls) };
}

/** A no-speech window is reported when its reason changed, or this long after the last one. */
export const RX_LEVEL_DIAG_REPEAT_MS = 5 * 60_000;
