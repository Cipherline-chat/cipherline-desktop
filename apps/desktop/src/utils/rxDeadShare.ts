/**
 * Receive side: a remote SCREEN SHARE that never shows a frame.
 *
 * The freeze detector (CallEventMonitor freeze_start / freeze_end) only fires
 * for a video that HAD decoded frames and stopped. A share that never decodes
 * one - the viewer side of report 83da3af8: the friend's republished share
 * (`remote-video-11`) had no codec and no frames for its whole life, because
 * its sender had silently switched codec and the SFU forwarded nothing - left
 * no event at all; the only trace was a stats sample with no fields.
 *
 * This says, once per publication, "subscribed for RX_DEAD_MS and nothing
 * decoded", and whether packets are arriving at all:
 *   rx = 'no_packets'  nothing reaches us: the sender / SFU side (a codec the
 *                      SFU will not forward, a dead encoder, a paused layer);
 *   rx = 'packets'     packets arrive and none decodes: our side (decoder,
 *                      E2EE, a missing keyframe).
 * and, if it later starts decoding, how long it was dead (phase 'end').
 * Counts and enums only.
 */

export const RX_DEAD_MS = 6_000;

export interface RxDeadReport {
    phase: 'start' | 'end';
    rx: 'packets' | 'no_packets';
    /** Packets received so far. */
    packets: number;
    /** For 'end': how long nothing was decoded, from the first sample. */
    ms?: number;
}

/** One per subscribed remote share video. Feed it every stats sample. */
export class RxDeadShareWatch {
    private firstAt: number | null = null;
    private deadSince: number | null = null;
    private done = false;

    observe(now: number, framesDecoded: number, packetsReceived: number): RxDeadReport | null {
        if (this.done) return null;
        if (this.firstAt === null) this.firstAt = now;
        if (framesDecoded > 0) {
            this.done = true; // decoding: the freeze detector owns it from here
            if (this.deadSince === null) return null;
            return { phase: 'end', rx: packetsReceived > 0 ? 'packets' : 'no_packets', packets: packetsReceived, ms: Math.round(now - this.firstAt) };
        }
        if (this.deadSince === null && now - this.firstAt >= RX_DEAD_MS) {
            this.deadSince = now;
            return { phase: 'start', rx: packetsReceived > 0 ? 'packets' : 'no_packets', packets: packetsReceived };
        }
        return null;
    }
}

/** For freeze_start: did any packet arrive between two samples? */
export function rxSince(prevPackets: number | undefined, curPackets: number): 'packets' | 'no_packets' {
    return prevPackets !== undefined && curPackets > prevPackets ? 'packets' : 'no_packets';
}
