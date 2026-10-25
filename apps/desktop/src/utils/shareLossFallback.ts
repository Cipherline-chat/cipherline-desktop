/**
 * Viewer-side fallback for a screen share whose FULL layer is not getting
 * through: while the top layer loses packets or freezes, ask for the share's
 * lower layer (the 720p "lighter copy", screenShare.ts / shareLowLayer.ts)
 * instead, then go back up once the link has been clean for a while.
 *
 * Why the client does this on top of LiveKit's own subscriber congestion
 * control (2026-10-23 diagnostic reports): the viewer had the share focused,
 * so it asked for the full layer, and the full layer arrived with 12–26 %
 * loss for minutes at a time, 3–10 % loss on every other incoming track
 * (voice included) at the same moments, RTT 76 → 151 ms, and freezes of
 * 2–20 s. The SFU's allocator moves a subscriber down only when ITS bandwidth
 * estimate says so — and loss from a burst-limited downlink (Wi-Fi, a
 * shaped ISP) keeps that estimate high while the picture is frozen. The
 * client sees the result directly: lost packets and frames that stop
 * decoding. A layer switch is one setVideoQuality call; the SFU grants it at
 * once with a keyframe (remoteVideoQuality.ts).
 *
 * Pure state machine — fed one tick per CallEventMonitor sample (2 s):
 *   top → fallback  after TRIP_TICKS consecutive bad ticks (loss ≥
 *                   LOSS_TRIP_PCT, or no frame decoded over the tick WITH
 *                   some loss or a keyframe request — a still screen is not
 *                   a freeze), or a single tick at ≥ LOSS_SEVERE_PCT;
 *   fallback → top  once the hold has elapsed AND the last CLEAN_TICKS ticks
 *                   were clean (loss < CLEAN_LOSS_PCT, no stuck decoder);
 *   hysteresis      the hold starts at HOLD_MS_INITIAL and doubles (up to
 *                   HOLD_MS_MAX) each time the top layer fails again within
 *                   PROBE_WINDOW_MS of being restored; a top layer that
 *                   survives the probe window resets it;
 *   no lower layer  while capped, NO_LOW_TICKS ticks in a row with NO packet
 *                   at all lift the cap at once ('no_low_layer'). The lower
 *                   layer is advertised whenever the share was published with
 *                   it, but the publisher only ENCODES it while its gate
 *                   allows (shareLowLayer.ts — hardware, viewers, no cost to
 *                   the sharer), and LiveKit v1.9.12 does NOT then forward the
 *                   full layer instead: measured against a real SFU
 *                   (harness/share-e2e), a viewer capped to an unencoded copy
 *                   received nothing — 0 kbit/s, a frozen picture for the
 *                   whole 20–40 s hold, where staying on the lossy full layer
 *                   at least moves. If the lower layer never delivered (no
 *                   frame smaller than the full layer's was decoded since the
 *                   cap), it is not tried again for
 *                   NO_LOW_RETRY_MS (doubling up to NO_LOW_RETRY_MS_MAX);
 *                   silence AFTER it delivered (a still screen, or the copy
 *                   stopping) just lifts the cap.
 * Only acts on a share that publishes ≥ 2 layers (there is nothing to fall
 * back to otherwise) and only while the viewer actually wants the top layer.
 *
 * Privacy: nothing here knows whose share it is; the caller logs by track
 * placeholder.
 */

export const LOSS_TRIP_PCT = 4;
export const LOSS_SEVERE_PCT = 10;
export const TRIP_TICKS = 2;
export const CLEAN_LOSS_PCT = 1;
export const CLEAN_TICKS = 3;
export const HOLD_MS_INITIAL = 20_000;
export const HOLD_MS_MAX = 160_000;
export const PROBE_WINDOW_MS = 30_000;
/** Capped and this many ticks with no packet at all → the lower layer is not arriving. */
export const NO_LOW_TICKS = 2;
/** Capped and this many ticks in a row with no frame decoded while asking for a
 *  keyframe → the lower layer is not decodable (e.g. not being encoded); lift.
 *  3 ticks (~6 s) leaves room for the SFU's layer switch, which waits for the
 *  lower layer's keyframe (~4 s measured). */
export const STUCK_LOW_TICKS = 3;
/** After an unanswered fallback, how long before the lower layer is tried again (doubles per miss). */
export const NO_LOW_RETRY_MS = 60_000;
export const NO_LOW_RETRY_MS_MAX = 480_000;

export interface ShareRxTick {
    now: number;
    /** Packet loss over the tick, % of packets expected; null = no packets / unknown. */
    lossPct: number | null;
    /** Subscribed, enabled and no frame decoded over the tick. */
    frozen: boolean;
    /** This receiver sent a PLI / FIR over the tick (its decoder is waiting for a keyframe). */
    keyframeAsked: boolean;
    /** The viewer's tiles ask for the top layer (before any fallback cap). */
    wantsTop: boolean;
    /** Layers the publisher advertises. */
    layers: number;
    /** Packets received over the tick; undefined = unknown (never read as "nothing arrived"). */
    packets?: number;
    /** Short side (px) of the last decoded frame; undefined = unknown. */
    frameShort?: number;
}

export type ShareRxReason = 'loss' | 'freeze' | 'recovered' | 'not_needed' | 'no_low_layer';

export interface ShareRxDecision {
    /** Hold the publication at its lowest layer. */
    cap: boolean;
    /** The cap changed on this tick. */
    changed: boolean;
    reason?: ShareRxReason;
    /** The hold applied when the cap went on (ms). */
    holdMs?: number;
}

export class ShareLossFallback {
    private state: 'top' | 'fallback' = 'top';
    private bad = 0;
    private clean = 0;
    private since = 0;
    private holdMs = HOLD_MS_INITIAL;
    private restoredAt: number | null = null;
    /** Capped: consecutive ticks with no packet, and whether the lower layer delivered anything yet. */
    private silent = 0;
    private stuckLow = 0;
    private lowDelivered = false;
    /** Decoded short side on the top layer (last seen), and when the cap went on. */
    private topShort = 0;
    private capShort = 0;
    /** No fallback before this time (the lower layer did not arrive last time). */
    private lowBlockedUntil = 0;
    private lowRetryMs = NO_LOW_RETRY_MS;

    get capped(): boolean { return this.state === 'fallback'; }

    observe(t: ShareRxTick): ShareRxDecision {
        if (t.layers < 2 || !t.wantsTop) {
            // Nothing to fall back to, or the viewer is on the low layer anyway.
            this.bad = 0;
            if (this.state === 'fallback') {
                this.state = 'top';
                this.clean = 0;
                return { cap: false, changed: true, reason: 'not_needed' };
            }
            return { cap: false, changed: false };
        }
        const loss = t.lossPct ?? 0;
        if (this.state === 'top') {
            if (t.frameShort && t.frameShort > 0) this.topShort = t.frameShort;
            // A top layer that held through the probe window earns the short hold back.
            if (this.restoredAt !== null && t.now - this.restoredAt >= PROBE_WINDOW_MS) {
                this.holdMs = HOLD_MS_INITIAL;
                this.restoredAt = null;
            }
            // A freeze alone is not proof: a share of a still screen stops
            // producing frames too. It counts when the receiver also lost
            // packets or had to ask for a keyframe.
            const stuck = t.frozen && (loss >= CLEAN_LOSS_PCT || t.keyframeAsked);
            const isBad = stuck || loss >= LOSS_TRIP_PCT;
            this.bad = isBad && t.now >= this.lowBlockedUntil ? this.bad + 1 : 0;
            if (t.now >= this.lowBlockedUntil && (this.bad >= TRIP_TICKS || loss >= LOSS_SEVERE_PCT)) {
                if (this.restoredAt !== null && t.now - this.restoredAt < PROBE_WINDOW_MS) {
                    this.holdMs = Math.min(HOLD_MS_MAX, this.holdMs * 2);
                }
                this.restoredAt = null;
                this.state = 'fallback';
                this.since = t.now;
                this.bad = 0;
                this.clean = 0;
                this.silent = 0;
                this.stuckLow = 0;
                this.lowDelivered = false;
                this.capShort = this.topShort;
                return { cap: true, changed: true, reason: stuck && loss < LOSS_TRIP_PCT ? 'freeze' : 'loss', holdMs: this.holdMs };
            }
            return { cap: false, changed: false };
        }
        // Is the lower layer arriving at all? Packets right after the cap can
        // still be the full layer (the SFU switches on the lower layer's
        // keyframe; measured: ~4 s of full-layer packets, then silence), so
        // with a known size the lower layer counts as delivered only once a
        // SMALLER frame has been decoded.
        if (t.packets === 0) this.silent++;
        else if (t.packets !== undefined) {
            this.silent = 0;
            const sized = this.capShort > 0 && t.frameShort !== undefined && t.frameShort > 0;
            // A tick that decoded nothing proves nothing about the lower layer.
            if (!t.frozen && (!sized || t.frameShort! < this.capShort)) this.lowDelivered = true;
        }
        // Packets arrive but NOTHING decodes and the decoder keeps asking for a
        // keyframe: the viewer's 2026-10-24 report (staging.174) — capped
        // with reason 'freeze' at 0 % loss, then 46-55 PLIs per 10 s, zero
        // keyframes, frozen for 30+ s. The sharer's lower layer was gated OFF
        // (software encoder), so the keyframe requests went to an encoder that
        // was not running, while padding / probe packets kept `packets` above
        // zero and the silence rule above never fired. Same verdict as silence.
        this.stuckLow = t.frozen && t.keyframeAsked ? this.stuckLow + 1 : 0;
        if (this.silent >= NO_LOW_TICKS || this.stuckLow >= STUCK_LOW_TICKS) {
            this.stuckLow = 0;
            if (!this.lowDelivered) {
                this.lowBlockedUntil = t.now + this.lowRetryMs;
                this.lowRetryMs = Math.min(NO_LOW_RETRY_MS_MAX, this.lowRetryMs * 2);
            }
            this.state = 'top';
            this.silent = 0;
            this.clean = 0;
            this.bad = 0;
            return { cap: false, changed: true, reason: 'no_low_layer' };
        }
        // Clean = no loss and no decoder waiting on a keyframe (a still
        // screen that simply sends no frames is clean).
        const isClean = loss < CLEAN_LOSS_PCT && !(t.frozen && t.keyframeAsked);
        this.clean = isClean ? this.clean + 1 : 0;
        if (t.now - this.since >= this.holdMs && this.clean >= CLEAN_TICKS) {
            this.state = 'top';
            this.restoredAt = t.now;
            this.clean = 0;
            return { cap: false, changed: true, reason: 'recovered' };
        }
        return { cap: true, changed: false };
    }
}

/**
 * The share_rx_fallback call-event detail. Carries `from` / `to` like every
 * other *fallback kind (callEventLog's contract — the reporter and the admin
 * dashboard read them), plus the legacy `action`.
 */
export function shareRxFallbackDetail(track: string, d: ShareRxDecision, lossPct: number | null): Record<string, string | number> {
    return {
        track, action: d.cap ? 'down' : 'up', from: d.cap ? 'top' : 'low', to: d.cap ? 'low' : 'top',
        reason: d.reason ?? 'none', loss_pct: lossPct ?? 0, hold_s: Math.round((d.holdMs ?? 0) / 1000),
    };
}

// ── Receive-side counters (inbound-rtp) ────────────────────────────────────

export interface InboundVideoCounters {
    packetsReceived: number;
    packetsLost: number;
    framesDecoded: number;
    pliCount: number;
    firCount: number;
    nackCount: number;
    keyFramesDecoded: number;
    frameWidth: number;
    frameHeight: number;
}

type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void };

/** The inbound video stream's cumulative counters (one remote track's report). */
export function readInboundVideo(report: StatsLike | undefined | null): InboundVideoCounters | null {
    let out: InboundVideoCounters | null = null;
    report?.forEach(s => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        const n = (k: string) => (typeof s[k] === 'number' && Number.isFinite(s[k] as number) ? s[k] as number : 0);
        out = {
            packetsReceived: n('packetsReceived'), packetsLost: n('packetsLost'), framesDecoded: n('framesDecoded'),
            pliCount: n('pliCount'), firCount: n('firCount'), nackCount: n('nackCount'),
            keyFramesDecoded: n('keyFramesDecoded'), frameWidth: n('frameWidth'), frameHeight: n('frameHeight'),
        };
    });
    return out;
}

/** Loss % between two readings (null when nothing was expected). packetsLost can go DOWN (late arrivals) — clamped. */
export function lossPctBetween(prev: InboundVideoCounters, cur: InboundVideoCounters): number | null {
    const rx = Math.max(0, cur.packetsReceived - prev.packetsReceived);
    const lost = Math.max(0, cur.packetsLost - prev.packetsLost);
    const expected = rx + lost;
    return expected > 0 ? Math.round((lost / expected) * 1000) / 10 : null;
}
