/**
 * What the mic's RTCRtpSender is really doing, read from its own getStats()
 * report: the ground truth the "connected but silent" watchdog
 * (audioSilenceWatchdog.ts) judges against.
 *
 * Two cumulative counters, both on the SENDER (nothing the SFU says):
 *   - `outbound-rtp` (audio).bytesSent  — RTP actually leaving this machine;
 *   - `media-source` (audio).totalAudioEnergy / totalSamplesDuration — the
 *     energy of the samples the track handed to the encoder.
 *
 * Measured in Chromium 150 (loopback RTCPeerConnection, a WebAudio
 * MediaStreamDestination track): while the context runs, bytesSent climbs
 * (~4 kB/s for a tone) and sqrt(dEnergy/dDuration) reproduces the source's RMS
 * (0.0999 for a 0.1-amplitude tone); with the context SUSPENDED the sender sends
 * NOTHING — bytesSent, packetsSent and totalSamplesDuration all stay 0. So a
 * dead processed track shows up as flat bytes, not as quiet audio.
 *
 * No identities, SSRCs or ids are read; only these four numbers leave this file.
 */

export interface WireReading {
    /** Cumulative RTP payload+header bytes sent on the mic's sender. */
    bytesSent: number;
    /** Cumulative sum of squared (0..1) samples x duration fed to the encoder; null when the browser reports none. */
    energy: number | null;
    /** Cumulative seconds of samples fed to the encoder; null when the browser reports none. */
    duration: number | null;
}

interface StatsLike { forEach(cb: (stat: Record<string, unknown>) => void): void }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The audio sender's counters out of a `sender.getStats()` report, or null when
 * the report has no audio outbound-rtp (no sender yet, a video track, an empty
 * report). Never throws.
 */
export function readOutboundAudio(report: StatsLike | null | undefined): WireReading | null {
    if (!report || typeof report.forEach !== 'function') return null;
    let bytes: number | null = null;
    let energy: number | null = null;
    let duration: number | null = null;
    try {
        report.forEach((s) => {
            const kind = s.kind ?? s.mediaType;
            if (kind !== 'audio') return;
            if (s.type === 'outbound-rtp') {
                const b = num(s.bytesSent);
                if (b !== null) bytes = (bytes ?? 0) + b;
            } else if (s.type === 'media-source') {
                energy = num(s.totalAudioEnergy);
                duration = num(s.totalSamplesDuration);
            }
        });
    } catch { return null; }
    if (bytes === null) return null;
    return { bytesSent: bytes, energy, duration };
}

/**
 * RMS (0..1, linear, full scale = 1) of the samples the encoder was fed between
 * two readings, or null when it cannot be told (no counters, or no new samples).
 */
export function sourceRmsBetween(prev: WireReading, cur: WireReading): number | null {
    if (prev.energy === null || prev.duration === null || cur.energy === null || cur.duration === null) return null;
    const dDur = cur.duration - prev.duration;
    const dEnergy = cur.energy - prev.energy;
    if (!(dDur > 0) || dEnergy < 0) return null;
    return Math.sqrt(dEnergy / dDur);
}
