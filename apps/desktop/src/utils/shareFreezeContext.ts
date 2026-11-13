/**
 * What was arriving while a watched screen share froze - the context that
 * lets `freeze_start` / `freeze_end` say WHICH SIDE stopped.
 *
 * A freeze is "framesDecoded stopped rising" (CallEventMonitor, 2 s ticks).
 * That alone is the same line whether the sender stopped, the network stopped
 * delivering, or the viewer's decoder stopped (7 of the 9 freezes in the
 * 2026-11 survey said `rx: packets` and nothing else). The inbound stream's own
 * counters, taken as the difference between two samples, separate them:
 *
 *   rx = 'no_packets'   nothing reached us: the sender, the SFU or the network;
 *   rx = 'packets'      packets arrived but no complete frame was assembled
 *                       (loss; the keyframe never came);
 *   rx = 'frames'       whole frames arrived and none was decoded: OUR decoder /
 *                       E2EE / a missing keyframe (see also share_rx_stall).
 *
 * plus the counts behind it: packets and frames received, loss %, keyframe
 * requests sent (pli), keyframes decoded (kf), NACKs, and the jitter-buffer ms
 * just before. On `freeze_start` the counts are the sample that DETECTED it
 * (about 2 s); on `freeze_end` they cover the whole freeze (from the last sample
 * that was still decoding, so `ms` is about one tick shorter than the counts).
 *
 * Pure: counters in, details out. A counter that went BACKWARDS (a new stream:
 * SFU layer switch to a new SSRC, a republish) makes the whole delta unusable -
 * `null`, and the fields are left out rather than guessed.
 *
 * Counts, rates and the anonymous `share_ref` only.
 */
import type { InboundVideoCounters } from './shareLossFallback';
import type { ShareRxSnapshot } from './shareRxStats';

export interface FreezeCounters {
    packets: number;
    lost: number;
    /** inbound-rtp framesReceived: whole frames assembled off the wire. */
    frames: number;
    /** PLI + FIR sent: keyframe requests. */
    pli: number;
    kf: number;
    nack: number;
}

/** Counters at one sample. `snap` supplies framesReceived (null: absent - the delta then has no frames figure). */
export function freezeCounters(cur: InboundVideoCounters, snap: ShareRxSnapshot | null): FreezeCounters {
    return {
        packets: cur.packetsReceived, lost: cur.packetsLost, frames: snap ? snap.framesReceived : NaN,
        pli: cur.pliCount + cur.firCount, kf: cur.keyFramesDecoded, nack: cur.nackCount,
    };
}

export interface FreezeDelta {
    packets: number;
    /** NaN: framesReceived was not reported. */
    frames: number;
    /** NaN: nothing was expected (no packets received or lost). */
    lossPct: number;
    pli: number;
    kf: number;
    nack: number;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What changed between two samples; null when there is no baseline or a counter went backwards. */
export function freezeDelta(base: FreezeCounters | null | undefined, cur: FreezeCounters | null | undefined): FreezeDelta | null {
    if (!base || !cur) return null;
    if (cur.packets < base.packets || cur.kf < base.kf || cur.pli < base.pli || cur.nack < base.nack) return null;
    if (fin(base.frames) && fin(cur.frames) && cur.frames < base.frames) return null;
    const packets = cur.packets - base.packets;
    const lost = Math.max(0, cur.lost - base.lost); // packetsLost can go DOWN (late arrivals): clamped
    const expected = packets + lost;
    return {
        packets,
        frames: fin(base.frames) && fin(cur.frames) ? cur.frames - base.frames : NaN,
        lossPct: expected > 0 ? Math.round((lost / expected) * 1000) / 10 : NaN,
        pli: cur.pli - base.pli, kf: cur.kf - base.kf, nack: cur.nack - base.nack,
    };
}

export type FreezeRx = 'no_packets' | 'packets' | 'frames';

/** Which side of the freeze the counters point at; '' = unknown (no usable delta). */
export function freezeRx(d: FreezeDelta | null): FreezeRx | '' {
    if (!d) return '';
    if (d.packets <= 0) return 'no_packets';
    return fin(d.frames) && d.frames > 0 ? 'frames' : 'packets';
}

/**
 * Event fields for `freeze_start` / `freeze_end` of a share. NaN / '' = not
 * measured: the call log drops them. 9 keys; with `track` and `bg` / `ms` that
 * is the log's 11, the 12th slot being kept for `repeat`.
 */
export interface FreezeFields {
    rx: FreezeRx | '';
    share_ref: string;
    packets: number;
    frames: number;
    loss_pct: number;
    pli: number;
    kf: number;
    nack: number;
    jb_ms: number;
}

export function freezeFields(d: FreezeDelta | null, shareRef: string | undefined, jbMs: number | undefined): FreezeFields {
    return {
        rx: freezeRx(d),
        share_ref: shareRef ?? '',
        packets: d ? d.packets : NaN,
        frames: d ? d.frames : NaN,
        loss_pct: d ? d.lossPct : NaN,
        pli: d ? d.pli : NaN,
        kf: d ? d.kf : NaN,
        nack: d ? d.nack : NaN,
        jb_ms: fin(jbMs) ? jbMs : NaN,
    };
}

// ── rx_video_health: a quiet window must not look like no window ───────────

/**
 * `rx_video_health` is written for a 10 s window that lost packets or asked for
 * keyframes, and used to be silent otherwise - so a share with no lines could
 * be perfectly healthy or not sampled at all. A share now also gets one line
 * per this long when it is healthy ("loss 0, pli 0, N packets"): silence means
 * no sampling.
 */
export const QUIET_HEALTH_MS = 60_000;

export function quietHealthDue(now: number, lastLoggedAt: number): boolean {
    return now - lastLoggedAt >= QUIET_HEALTH_MS;
}
