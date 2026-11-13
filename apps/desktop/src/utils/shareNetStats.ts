/**
 * Sharer side of a screen share, as network numbers: how fast the share is
 * actually leaving the machine versus what the encoder is allowed and what the
 * path says it can carry, how long a frame takes to encode, and what the far
 * end reports losing. Pure readers / delta maths over the SAME sender report
 * ShareStatsSampler already fetches for share_fps (no extra getStats call).
 *
 *   kbps        payload bytes sent per second over every ACTIVE layer
 *   cap_kbps    the sender's configured ceiling (sum of the active encodings'
 *               maxBitrate), read from sender.getParameters() by the caller
 *   avail_kbps  the transport's estimate (candidate-pair availableOutgoingBitrate)
 *   rtt_ms      remote-inbound-rtp roundTripTime, else the pair's currentRoundTripTime
 *   loss_pct    remote-inbound-rtp fractionLost (the receiver's last report), %
 *   enc_ms      totalEncodeTime / framesEncoded deltas - per-frame encode time
 *   top_kbps / top_enc_ms / pace_ms / tgt_kbps   the same for the TOP layer alone, the
 *               pacer's mean wait per packet, and the rate the encoder was told to hit
 *
 * Privacy: ONLY these numbers leave the stats report. The candidate-pair is
 * read for its two bandwidth/RTT counters; its candidate ids, addresses, ports,
 * foundations, usernames and the remote-inbound ssrc are never copied (the
 * snapshot type has no field for them - tests assert it).
 *
 * Counter resets (a republish restarts bytesSent / framesEncoded / totalEncodeTime
 * from 0): any backwards counter makes the window null and the caller
 * re-baselines. A reset is never reported as a rate.
 */

type Stat = Record<string, unknown>;
export type StatsLike = { forEach(cb: (s: Stat) => void): void };
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Which simulcast layers the sums below cover: the ACTIVE layers' rids, sorted
 * ('h|q'; '-' for a layer without one). The sums are only comparable between
 * two snapshots that cover the SAME layers: dynacast pauses and resumes the
 * full layer, and a layer that appears in (or drops out of) the sum carries its
 * whole cumulative bytes / frames since the share began (reports 4667c6fa /
 * 14a5184a: kbps=73667..111528, enc_fps=646..766 in the window after a resume).
 * rid letters only - never an ssrc.
 */
export function layerSetOf(active: ReadonlyArray<Record<string, unknown>>): string {
    return active
        .map(s => (typeof s.rid === 'string' && /^[A-Za-z0-9]{1,8}$/.test(s.rid) ? s.rid : '-'))
        .sort()
        .join('|');
}

export interface ShareNetSnapshot {
    /** Report timestamp (ms) of the top outbound-rtp, else the caller's clock. */
    at: number;
    /** The active layers the sums cover (layerSetOf). Absent on hand-built snapshots. */
    layerSet?: string;
    /** Sums over ACTIVE outbound video layers. */
    bytesSent: number;
    framesEncoded: number;
    totalEncodeTime: number;
    /** bit/s, from the selected candidate pair. */
    availBps?: number;
    /** ms. */
    rttMs?: number;
    /** 0..100. */
    lossPct?: number;
    /**
     * The TOP layer (largest active picture) on its own. The sums above also
     * carry the lighter copy, whose ~2.2 Mbps ceiling alone can read as "the
     * share is stuck at 2.4 Mbps" and whose cheap frames dilute enc_ms.
     */
    top?: { bytes: number; frames: number; encodeTime: number; packets: number; sendDelay: number; targetBps?: number };
}

export function readShareNetSnapshot(report: StatsLike | null | undefined, fallbackAt: number): ShareNetSnapshot | null {
    if (!report) return null;
    const outs: Stat[] = [];
    const remotes: Stat[] = [];
    const pairs: Stat[] = [];
    let selectedPairId: string | undefined;
    report.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) outs.push(s);
        else if (s.type === 'remote-inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) remotes.push(s);
        else if (s.type === 'candidate-pair') pairs.push(s);
        else if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') selectedPairId = s.selectedCandidatePairId;
    });
    if (outs.length === 0) return null;
    const active = outs.filter(s => s.active !== false);
    const pool = active.length > 0 ? active : outs;
    const area = (s: Stat) => (fin(s.frameWidth) ? s.frameWidth : 0) * (fin(s.frameHeight) ? s.frameHeight : 0);
    const top = pool.reduce((a, b) => (area(b) > area(a) ? b : a));
    const sum = (k: string) => pool.reduce((n, s) => n + (fin(s[k]) ? s[k] as number : 0), 0);
    const snap: ShareNetSnapshot = {
        at: fin(top.timestamp) ? top.timestamp : fallbackAt,
        layerSet: layerSetOf(pool),
        bytesSent: sum('bytesSent'),
        framesEncoded: sum('framesEncoded'),
        totalEncodeTime: sum('totalEncodeTime'),
    };

    const tn = (k: string) => (fin(top[k]) ? top[k] as number : 0);
    snap.top = {
        bytes: tn('bytesSent'), frames: tn('framesEncoded'), encodeTime: tn('totalEncodeTime'),
        packets: tn('packetsSent'), sendDelay: tn('totalPacketSendDelay'),
        ...(fin(top.targetBitrate) && top.targetBitrate > 0 ? { targetBps: top.targetBitrate } : {}),
    };

    // The pair carrying the media: the transport's selection, else the nominated succeeded one.
    const pair = pairs.find(p => selectedPairId !== undefined && p.id === selectedPairId)
        ?? pairs.find(p => p.nominated === true && p.state === 'succeeded')
        ?? pairs.find(p => p.selected === true);
    if (pair && fin(pair.availableOutgoingBitrate) && pair.availableOutgoingBitrate > 0) snap.availBps = pair.availableOutgoingBitrate;

    // The receiver report for the top layer (matched by ssrc, which is only compared, never stored).
    const remote = (fin(top.ssrc) ? remotes.find(r => r.ssrc === top.ssrc) : undefined) ?? remotes[0];
    if (remote && fin(remote.fractionLost)) snap.lossPct = Math.min(100, Math.max(0, r1(remote.fractionLost * 100)));
    if (remote && fin(remote.roundTripTime) && remote.roundTripTime > 0) snap.rttMs = r1(remote.roundTripTime * 1000);
    else if (pair && fin(pair.currentRoundTripTime) && pair.currentRoundTripTime > 0) snap.rttMs = r1(pair.currentRoundTripTime * 1000);
    return snap;
}

export function netCountersReset(prev: ShareNetSnapshot, cur: ShareNetSnapshot): boolean {
    // A different layer set is not comparable (see layerSetOf): treat it like a reset.
    if (prev.layerSet !== cur.layerSet) return true;
    return cur.bytesSent < prev.bytesSent || cur.framesEncoded < prev.framesEncoded || cur.totalEncodeTime < prev.totalEncodeTime;
}

/** Sum of the ACTIVE encodings' maxBitrate in kbit/s; undefined when none declares one. */
export function capKbpsFromEncodings(encodings: ReadonlyArray<{ active?: boolean; maxBitrate?: number }> | undefined): number | undefined {
    if (!encodings) return undefined;
    let bps = 0;
    for (const e of encodings) if (e && e.active !== false && fin(e.maxBitrate) && e.maxBitrate > 0) bps += e.maxBitrate;
    return bps > 0 ? Math.round(bps / 1000) : undefined;
}

export type ShareDetail = Record<string, string | number | boolean>;

export interface ShareNetContext {
    shareRef?: string;
    capKbps?: number;
    /** Add the top-layer keys (share_net, 11 keys). The report-time snapshot is already full and leaves them out. */
    topLayer?: boolean;
}

/**
 * The `share_net` detail: share_ref, kbps, cap_kbps, avail_kbps, rtt_ms,
 * loss_pct, enc_ms. null = no usable window (first sample, short window, reset).
 * `kbps` and `enc_ms` need a window; the other fields are instantaneous.
 */
export function buildShareNetDetail(prev: ShareNetSnapshot | null, cur: ShareNetSnapshot, ctx: ShareNetContext): ShareDetail | null {
    if (!prev) return null;
    const dt = (cur.at - prev.at) / 1000;
    if (!(dt >= 0.5) || netCountersReset(prev, cur)) return null;
    const d: ShareDetail = {};
    if (ctx.shareRef) d.share_ref = ctx.shareRef;
    d.kbps = Math.round(((cur.bytesSent - prev.bytesSent) * 8) / dt / 1000);
    if (fin(ctx.capKbps) && ctx.capKbps > 0) d.cap_kbps = Math.round(ctx.capKbps);
    if (fin(cur.availBps)) d.avail_kbps = Math.round(cur.availBps / 1000);
    if (fin(cur.rttMs)) d.rtt_ms = Math.round(cur.rttMs);
    if (fin(cur.lossPct)) d.loss_pct = cur.lossPct;
    const frames = cur.framesEncoded - prev.framesEncoded;
    if (frames > 0) d.enc_ms = r1(((cur.totalEncodeTime - prev.totalEncodeTime) / frames) * 1000);
    // The top layer alone (same layer set, so the same top): its own send rate,
    // encode time, the pacer's mean wait per packet (a queue behind big frames
    // shows here, not in the RTT of a Wi-Fi hop), and the rate the encoder was told to hit.
    const pt = ctx.topLayer ? prev.top : undefined;
    const ct = ctx.topLayer ? cur.top : undefined;
    if (pt && ct && ct.bytes >= pt.bytes && ct.frames >= pt.frames && ct.packets >= pt.packets) {
        d.top_kbps = Math.round(((ct.bytes - pt.bytes) * 8) / dt / 1000);
        if (ct.frames > pt.frames) d.top_enc_ms = r1(((ct.encodeTime - pt.encodeTime) / (ct.frames - pt.frames)) * 1000);
        if (ct.packets > pt.packets && ct.sendDelay >= pt.sendDelay) d.pace_ms = r1(((ct.sendDelay - pt.sendDelay) / (ct.packets - pt.packets)) * 1000);
    }
    if (ct && fin(ct.targetBps)) d.tgt_kbps = Math.round(ct.targetBps / 1000);
    return d;
}
