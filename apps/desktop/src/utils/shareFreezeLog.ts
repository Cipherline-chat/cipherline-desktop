/**
 * Writes the call-log events for a freeze of a watched SCREEN SHARE: the
 * `freeze_start` / `freeze_end` line with its counters (shareFreezeContext.ts)
 * and, next to it, a `share_rx_ring` summary of the last seconds
 * (shareSecondRing.ts). Cameras keep their short freeze lines (CallEventMonitor).
 *
 * Every key is written out literally at the call site on purpose:
 * callEventLog.test.ts scans these literals against the privacy allowlist, and
 * a spread would hide its keys from that scan.
 */
import { logCallEvent } from './callEventLog';
import { freezeFields, type FreezeDelta } from './shareFreezeContext';
import type { ShareRxRing, RingLimiter } from './shareSecondRing';

/** What the freeze logger needs of a watched share (ShareRxWatch implements it). */
export interface FreezeRingSource {
    readonly shareRef: string | undefined;
    readonly ring: ShareRxRing;
    readonly ringGate: RingLimiter;
}

export interface ShareFreezeArgs {
    /** The anonymous placeholder, remote-share-N. */
    track: string;
    delta: FreezeDelta | null;
    watch: FreezeRingSource | undefined;
    now: number;
}

function ringSummary(a: ShareFreezeArgs, phase: 'start' | 'end', ms?: number): void {
    const w = a.watch;
    if (!w) return;
    const s = w.ring.summary();
    if (!s || !w.ringGate.allow(a.now)) return;
    logCallEvent('share_rx_ring', {
        share_ref: w.shareRef ?? '', track: a.track, phase, ms: ms ?? NaN,
        rx_s: s.rx_s, dec_s: s.dec_s, disp_s: s.disp_s, pkt_s: s.pkt_s, window_s: s.window_s,
    });
}

export function logShareFreezeStart(a: ShareFreezeArgs & { bg: boolean }): void {
    const f = freezeFields(a.delta, a.watch?.shareRef, a.watch?.ring.recentJbMs());
    logCallEvent('freeze_start', {
        track: a.track, bg: a.bg, rx: f.rx, share_ref: f.share_ref, packets: f.packets, frames: f.frames,
        loss_pct: f.loss_pct, pli: f.pli, kf: f.kf, nack: f.nack, jb_ms: f.jb_ms,
    });
    ringSummary(a, 'start');
}

export function logShareFreezeEnd(a: ShareFreezeArgs & { ms: number }): void {
    const f = freezeFields(a.delta, a.watch?.shareRef, a.watch?.ring.recentJbMs());
    logCallEvent('freeze_end', {
        track: a.track, ms: a.ms, rx: f.rx, share_ref: f.share_ref, packets: f.packets, frames: f.frames,
        loss_pct: f.loss_pct, pli: f.pli, kf: f.kf, nack: f.nack, jb_ms: f.jb_ms,
    });
    ringSummary(a, 'end', a.ms);
}

/** The sharer's counterpart: the last seconds of capture / encode / send, when a share_fps sample dipped. */
export function logShareTxRing(i: {
    shareRef: string | undefined; why: string; target: number;
    summary: { src_s: string; enc_s: string; sent_s: string; act_s: string; window_s: number };
}): void {
    logCallEvent('share_tx_ring', {
        share_ref: i.shareRef ?? '', why: i.why, target: i.target,
        src_s: i.summary.src_s, enc_s: i.summary.enc_s, sent_s: i.summary.sent_s, act_s: i.summary.act_s,
        window_s: i.summary.window_s,
    });
}
