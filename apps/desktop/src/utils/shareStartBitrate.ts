/**
 * Start a screen share at a real bitrate instead of WebRTC's 300 kbps.
 *
 * ── Why a share "takes a while to load"
 *
 * WebRTC's bandwidth estimate (GCC) for a peer connection starts at 300 kbps
 * and only grows as it measures the link. In a call the publisher connection
 * usually carries nothing but the mic (~64 kbps), which never gives it a
 * reason to grow — so when a share is added the estimate is still ~300 kbps.
 * The encoder is told to fit the share into that, and with
 * 'maintain-framerate' it does it by shrinking the PICTURE: a 1440p share
 * goes out as 640×360 or 480×270. GCC then climbs at ~7 %/s. Measured in
 * the harness (this Electron 43 + livekit-client 2.18.8 + E2EE, LiveKit
 * v1.9.12, real X11 capture of a 2560×1440 display, H.264, mic already
 * published): first frame 640×360, still 1280×720 at ~3.5 Mbps after 38 s.
 * That is the "loading" the sharer and the viewers see.
 *
 * LiveKit already fixes this for VP9 only: it adds
 * `x-google-start-bitrate` (0.7 × the encoding's maxBitrate) to the SDP. Our
 * shares are H.264 / H.265 / VP8, where it adds nothing. The same attribute
 * placed in the publisher's ANSWER for the share's m-section works for all of
 * them (measured: munging the offer alone does nothing for VP8/H.264 — the
 * send codec's parameters come from the answer); with it the first frame
 * leaves at full resolution and the estimate starts where we put it.
 *
 * ── What this does, and what it deliberately does not
 *
 * - Only the answer to the negotiation that adds a SCREEN SHARE sender, once
 *   (armed by LiveKit's synchronous `localSenderCreated`, disarmed when that
 *   answer is applied). Later renegotiations carry no start bitrate, and
 *   WebRTC only resets its estimate when one is present.
 * - Never LOWERS the estimate: when the connection already measures at least
 *   the target (a camera is on, a second share), nothing is changed.
 * - Leaves an existing x-google-start-bitrate alone (LiveKit's own VP9 munge).
 * - Start = half the share's maxBitrate, capped at 8 Mbps. It is only a
 *   starting point: GCC still backs off within a round trip or two if the
 *   uplink cannot carry it. (LiveKit's VP9 rule is 0.7 × maxBitrate with no
 *   cap — up to ~25 Mbps for a 1440p60 share.)
 * - Nothing about E2EE: the SDP carries no keys, and the frames are encrypted
 *   exactly as before.
 */

/** Never start above this (kbps). */
export const SHARE_START_CAP_KBPS = 8_000;
/** Fraction of the share's maxBitrate to start at. */
export const SHARE_START_FRACTION = 0.5;

const START_ATTR = 'x-google-start-bitrate';
const VIDEO_CODECS = /^(VP8|VP9|H264|H265|AV1)$/i;

/**
 * The start bitrate (kbps) for a share whose encoding ceiling is
 * `maxBitrateBps`, given what the connection already estimates
 * (`currentBps`, null = unknown). Null = leave the SDP alone.
 */
export function shareStartKbps(maxBitrateBps: number, currentBps: number | null | undefined): number | null {
    if (!Number.isFinite(maxBitrateBps) || maxBitrateBps <= 0) return null;
    const target = Math.min(SHARE_START_CAP_KBPS, Math.round((maxBitrateBps * SHARE_START_FRACTION) / 1000));
    if (target <= 0) return null;
    if (typeof currentBps === 'number' && Number.isFinite(currentBps) && currentBps / 1000 >= target) return null;
    return target;
}

export type StartBitrateMungeResult = 'applied' | 'present' | 'vp9' | 'no-section';

/**
 * Add `x-google-start-bitrate=<kbps>` to every primary video codec (not
 * rtx/red/ulpfec) of the m-section whose a=mid is `mid`. A codec with no
 * a=fmtp line (VP8) gets one, placed right after its a=rtpmap. Every other
 * line is passed through byte for byte; the line ending is preserved.
 *
 * 'present' (sdp unchanged): the section already carries a start bitrate.
 * 'vp9' (sdp unchanged): the section sends VP9, which LiveKit's own offer
 *   munge already starts at 0.7 × maxBitrate — left exactly as it was.
 * 'no-section' (sdp unchanged): no video m-section with that mid.
 */
export function withVideoStartBitrate(sdp: string, mid: string, kbps: number): { sdp: string; result: StartBitrateMungeResult } {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(eol);
    // Section boundaries: [start, end) for each m= line.
    const starts: number[] = [];
    lines.forEach((l, i) => { if (l.startsWith('m=')) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
        const a = starts[s];
        const b = s + 1 < starts.length ? starts[s + 1] : lines.length;
        if (!lines[a].startsWith('m=video')) continue;
        const sec = lines.slice(a, b);
        if (!sec.some(l => l === `a=mid:${mid}`)) continue;

        const pts: string[] = [];
        const codecOf = new Map<string, string>();
        for (const l of sec) {
            const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
            if (m && VIDEO_CODECS.test(m[2])) { pts.push(m[1]); codecOf.set(m[1], m[2].toUpperCase()); }
        }
        if (pts.length === 0) return { sdp, result: 'no-section' };
        // The send codec is the first video codec in the m= line's format list.
        const sendPt = sec[0].split(' ').slice(3).find(pt => codecOf.has(pt));
        if (sendPt && codecOf.get(sendPt) === 'VP9') return { sdp, result: 'vp9' };
        if (sec.some(l => /^a=fmtp:\d+ /.test(l) && pts.includes(l.slice(7, l.indexOf(' '))) && l.includes(START_ATTR))) {
            return { sdp, result: 'present' };
        }
        const hasFmtp = new Set(sec.filter(l => /^a=fmtp:\d+ /.test(l)).map(l => l.slice(7, l.indexOf(' '))));
        const out: string[] = [];
        for (const l of sec) {
            const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
            if (f && pts.includes(f[1])) {
                out.push(`${l}${f[2].length > 0 ? ';' : ''}${START_ATTR}=${kbps}`);
                continue;
            }
            out.push(l);
            const r = /^a=rtpmap:(\d+) /.exec(l);
            if (r && pts.includes(r[1]) && !hasFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${START_ATTR}=${kbps}`);
        }
        return { sdp: [...lines.slice(0, a), ...out, ...lines.slice(b)].join(eol), result: 'applied' };
    }
    return { sdp, result: 'no-section' };
}

/** The connection's current send estimate (bps) from a getStats() report, or null. */
export function availableOutgoingBps(report: Iterable<unknown> | { forEach(cb: (v: unknown) => void): void }): number | null {
    const all: Array<Record<string, unknown>> = [];
    if (typeof (report as { forEach?: unknown }).forEach === 'function') {
        (report as { forEach(cb: (v: unknown) => void): void }).forEach(v => all.push(v as Record<string, unknown>));
    } else {
        for (const v of report as Iterable<unknown>) all.push(v as Record<string, unknown>);
    }
    const selected = new Set(all.filter(s => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string')
        .map(s => s.selectedCandidatePairId as string));
    const pairs = all.filter(s => s.type === 'candidate-pair' && typeof s.availableOutgoingBitrate === 'number');
    const pick = pairs.find(p => selected.has(p.id as string)) ?? pairs.find(p => p.nominated === true);
    return pick ? (pick.availableOutgoingBitrate as number) : null;
}

/** The slice of LiveKit's publisher PCTransport this needs. */
export interface PublisherTransportLike {
    setRemoteDescription(sd: RTCSessionDescriptionInit, offerId: number): Promise<boolean>;
    getTransceivers(): RTCRtpTransceiver[];
    getStats?(): Promise<RTCStatsReport>;
}

/** The slice of LiveKit's LocalParticipant this needs. */
export interface StartBitrateParticipant {
    engine?: { pcManager?: { publisher?: PublisherTransportLike } };
    on(event: 'localSenderCreated', cb: (sender: RTCRtpSender, track: { source?: string }) => void): unknown;
    off(event: 'localSenderCreated', cb: (sender: RTCRtpSender, track: { source?: string }) => void): unknown;
}

interface Armed { sender: RTCRtpSender; maxBitrateBps: number; estimate: Promise<number | null>; until: number }
const armedByTransport = new WeakMap<PublisherTransportLike, Armed>();
const wrapped = new WeakSet<PublisherTransportLike>();
/** An armed share whose answer never comes (publish failed) stops mattering after this. */
const ARM_TTL_MS = 15_000;
/** Longest an answer waits for the current-estimate read. */
const ESTIMATE_WAIT_MS = 100;

function wrapTransport(t: PublisherTransportLike, log: (m: string) => void, now: () => number): void {
    if (wrapped.has(t)) return;
    wrapped.add(t);
    const original = t.setRemoteDescription.bind(t);
    t.setRemoteDescription = async (sd: RTCSessionDescriptionInit, offerId: number) => {
        const arm = armedByTransport.get(t);
        if (arm && now() > arm.until) armedByTransport.delete(t);
        else if (arm && sd?.type === 'answer' && typeof sd.sdp === 'string') {
            try {
                const mid = t.getTransceivers().find(tr => tr.sender === arm.sender)?.mid;
                if (mid != null) {
                    // Started when the sender was created, so normally long
                    // settled; never hold a negotiation for it (unknown → null).
                    const current = await Promise.race([
                        arm.estimate,
                        new Promise<null>(res => setTimeout(() => res(null), ESTIMATE_WAIT_MS)),
                    ]);
                    const kbps = shareStartKbps(arm.maxBitrateBps, current);
                    if (kbps === null) {
                        armedByTransport.delete(t);
                        log(`[ScreenShare] start bitrate: connection already at ${Math.round((current ?? 0) / 1000)} kbps — unchanged`);
                    } else {
                        const r = withVideoStartBitrate(sd.sdp, mid, kbps);
                        if (r.result !== 'no-section') armedByTransport.delete(t);
                        if (r.result === 'applied') {
                            sd = { type: sd.type, sdp: r.sdp };
                            log(`[ScreenShare] start bitrate ${kbps} kbps (estimate was ${current === null ? '?' : Math.round(current / 1000)} kbps)`);
                        }
                    }
                }
            } catch (err) {
                // Never let a bitrate hint break the negotiation.
                armedByTransport.delete(t);
                console.warn('[ScreenShare] start bitrate munge skipped:', err);
            }
        }
        return original(sd, offerId);
    };
}

/**
 * Arm the start bitrate for every screen-share sender LiveKit creates (first
 * publish, our republishes, LiveKit's reconnect republish) while
 * `maxBitrateBps()` returns a number. Returns the unsubscribe.
 */
export function installShareStartBitrate(
    participant: StartBitrateParticipant,
    maxBitrateBps: () => number | null,
    log: (msg: string) => void = m => console.info(m),
    now: () => number = () => Date.now(),
): () => void {
    const onSender = (sender: RTCRtpSender, track: { source?: string }) => {
        if (track?.source !== 'screen_share') return;
        const max = maxBitrateBps();
        const t = participant.engine?.pcManager?.publisher;
        if (max === null || !t || typeof t.setRemoteDescription !== 'function') return;
        wrapTransport(t, log, now);
        const estimate = (t.getStats ? t.getStats().then(availableOutgoingBps) : Promise.resolve(null)).catch(() => null);
        armedByTransport.set(t, { sender, maxBitrateBps: max, estimate, until: now() + ARM_TTL_MS });
    };
    participant.on('localSenderCreated', onSender);
    return () => { participant.off('localSenderCreated', onSender); };
}
