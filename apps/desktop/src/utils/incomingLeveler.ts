/**
 * "Normalize voice volume" — the glue around audio/receiveLeveler.js that does
 * not need React, LiveKit or the DOM: the on/off switch (with subscribers), the
 * pure pieces of reading a level off an RTCRtpReceiver, and the playback-path
 * policy for a boost. useParticipantAudio.ts owns the per-participant state and
 * the poll timer; everything decidable without a browser lives here so it is a
 * table under test.
 *
 * Scope, deliberately: remote MICROPHONE tracks only. Screen-share audio (game
 * or music a person is streaming) has its own volume slider and must keep its
 * dynamics and its level — it never gets a leveler.
 */

/** How often each remote talker's level is read (ms). One RTP packet = 20 ms;
 *  the leveler is slow, so a few packets per read is plenty. */
export const LEVELER_POLL_MS = 50;

/** A getSynchronizationSources() entry older than this is not "now": the
 *  talker is silent / not sending (DTX), so it is a pause, not a reading. */
export const LEVEL_STALE_MS = 400;

/** The slice of RTCRtpSynchronizationSource we read (typed loosely: the DOM lib
 *  types it, Electron's runtime may omit fields). */
export interface RtpSourceLike {
    timestamp?: number;
    audioLevel?: number;
}

/**
 * The talker's current RTP audio level (linear 0..1, RFC 6464), or undefined
 * when there is no fresh reading. `nowMs` is performance.now() — the same clock
 * as `timestamp`.
 */
export function pickRtpLevel(sources: readonly RtpSourceLike[] | undefined, nowMs: number): number | undefined {
    if (!sources || sources.length === 0) return undefined;
    let best: RtpSourceLike | undefined;
    for (const s of sources) {
        if (typeof s.audioLevel !== 'number' || !Number.isFinite(s.audioLevel)) continue;
        if (typeof s.timestamp !== 'number' || nowMs - s.timestamp > LEVEL_STALE_MS) continue;
        if (!best || (s.timestamp ?? 0) > (best.timestamp ?? 0)) best = s;
    }
    return best?.audioLevel;
}

/**
 * Does the (per-user x master x leveler) gain exceed what an <audio> element
 * can play (its volume tops out at 1)? Only then does a boost need the Web
 * Audio path — which costs 30-100 ms of audio-only latency (utils/avSync.ts) —
 * so a cut, or a boost that fits under the user's own headroom, never switches
 * path. `minBoostDb` keeps a hair of boost (float noise, the dead band) from
 * counting as "wants a boost".
 */
export function boostNeedsWebAudio(
    perUserGain: number,
    masterGain: number,
    levelGainDb: number,
    minBoostDb = 1,
): boolean {
    if (!(levelGainDb >= minBoostDb)) return false;
    const combined = perUserGain * masterGain * Math.pow(10, levelGainDb / 20);
    return Number.isFinite(combined) && combined > 1 + 1e-6;
}

// ── The setting ───────────────────────────────────────────────────────────────
// Module state rather than React state: it is read from the audio poll timer,
// and written from useVoiceSettings (which lives for the whole signed-in
// session) — the same shape as the master speaker volume.
let enabled = true;
const listeners = new Set<() => void>();

export function isIncomingLevelerEnabled(): boolean {
    return enabled;
}

export function setIncomingLevelerEnabled(on: boolean): void {
    if (enabled === on) return;
    enabled = on;
    listeners.forEach(cb => { try { cb(); } catch { /* a bad subscriber must not break the setting */ } });
}

export function subscribeIncomingLeveler(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
