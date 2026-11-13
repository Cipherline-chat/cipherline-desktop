/**
 * A short, per-SECOND memory of a screen share's frame path, kept at both ends
 * so a freeze can be placed in time and blamed on the right side from the
 * reports alone.
 *
 * ── Why (survey of 30 screen_share reports, 2026-11)
 *
 * The periodic samples (share_rx_fps / share_fps) are ~10 s apart and the
 * 1 s snapshots (shareSnapshot.ts) exist only at the moment the user opens the
 * reporter. A freeze that happened a minute earlier therefore left "a freeze at
 * T" and a 10 s average on each side - not enough to say whether the sender
 * stopped sending, the network stopped delivering, or the viewer stopped
 * decoding. This keeps the last RING_SECONDS one-second rows in memory
 * (nothing is stored or sent) and writes a compact summary of them only when
 * something goes wrong:
 *
 *   viewer  share_rx_ring  around each freeze (start + end): per second, frames
 *                          RECEIVED / DECODED / PRESENTED and PACKETS received;
 *   sharer  share_tx_ring  when a share_fps sample dipped under half the target:
 *                          per second, frames CAPTURED (src) / ENCODED (enc) /
 *                          SENT and active LAYERS.
 *
 * A series is one short string, oldest first, "88/89/90/0/0/0" (whole numbers,
 * "-" = not measured that second), so a 10 s window is <= 64 chars - the log's
 * string limit - and one event carries several of them.
 *
 * Reading them:
 *   rx 0, pkt 0                 nothing reached the viewer: sender / SFU / network;
 *   rx > 0, dec 0               frames arrive and the viewer's decoder makes none;
 *   rx 0, pkt > 0               packets arrive but never assemble a frame (loss);
 *   dec > 0, disp 0 or "-"      decoded fine; the tile is not presenting;
 *   src ~0                      the capture stopped delivering (or a still screen);
 *   src > 0, enc 0, act > 0     the encoder stalled;  act 0 = nobody is watching
 *                               (dynacast paused every layer): not a fault.
 *
 * Bounded: RING_SECONDS rows per share, a minimum gap and a per-share cap on
 * how many summaries are written (RingLimiter), and the report's own size
 * budget on top (bundle.fitPayload). Counters, rates and anonymous placeholders
 * only - no names, ids, app names or window titles.
 */
import {
    readShareRxSnapshot, shareRxRates, dispFpsBetween, dispFpsPlausible,
    type ShareRxSnapshot, type VideoPlaybackSnapshot, type StatsLike,
} from './shareRxStats';

export const RING_SECONDS = 10;
/** A displayed value is clamped to this many digits-worth, so 10 of them always fit the log's 64-char string. */
const VALUE_CAP = 9999;
/** Anything faster than this between two reads is jitter, not a new second. */
const MIN_DT_S = 0.5;

type Stat = Record<string, unknown>;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** null = not measured that second. */
export type RingValue = number | null;

/** "88/89/-/0": whole numbers, "-" for unknown, oldest first; never longer than 64 chars (oldest values dropped). */
export function formatSeries(values: readonly RingValue[]): string {
    const one = (v: RingValue) => (v === null || !fin(v) || v < 0 ? '-' : String(Math.min(VALUE_CAP, Math.round(v))));
    let parts = values.map(one);
    while (parts.length > 1 && parts.join('/').length > 64) parts = parts.slice(1);
    return parts.join('/');
}

/** True when a series carries at least one measured value (an all-"-" series says nothing). */
export function hasData(values: readonly RingValue[]): boolean {
    return values.some(v => v !== null && fin(v));
}

const tail = <T>(rows: readonly T[], n: number): T[] => rows.slice(Math.max(0, rows.length - n));

// ── viewer ─────────────────────────────────────────────────────────────────

export interface RxSecond { rx: RingValue; dec: RingValue; disp: RingValue; pkt: RingValue; jb: RingValue }

const EMPTY_RX: RxSecond = { rx: null, dec: null, disp: null, pkt: null, jb: null };

/** inbound-rtp packetsReceived of the (single) video stream; null when absent. */
export function readPacketsReceived(report: StatsLike | null | undefined): number | null {
    let out: number | null = null;
    report?.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video') && fin(s.packetsReceived)) out = s.packetsReceived;
    });
    return out;
}

export interface RxSummary { rx_s: string; dec_s: string; disp_s: string; pkt_s: string; window_s: number }

/** One watched share, fed a stats report about once a second. */
export class ShareRxRing {
    private prev: { snap: ShareRxSnapshot; packets: number | null; play: VideoPlaybackSnapshot | null; key: object | null } | null = null;
    private rows: RxSecond[] = [];

    /** Feed one report. `play` / `key`: the presenting <video>'s counters and an identity for WHICH element (a new element resets them). */
    observe(report: StatsLike | null | undefined, at: number, play: VideoPlaybackSnapshot | null, key: object | null): void {
        const snap = readShareRxSnapshot(report, at);
        if (!snap) { this.push(EMPTY_RX); this.prev = null; return; }
        const packets = readPacketsReceived(report);
        const prev = this.prev;
        if (!prev) { this.prev = { snap, packets, play, key }; return; }
        const dt = (snap.at - prev.snap.at) / 1000;
        if (!(dt >= MIN_DT_S)) return; // two reads inside one second: keep the older baseline
        const rates = shareRxRates(prev.snap, snap);
        this.prev = { snap, packets, play, key };
        if (!rates) { this.push(EMPTY_RX); return; } // a restarted stream: counters went backwards
        const dec = rates.dec_fps;
        // A tile that presented 0 while the decoder made frames was not drawing: unknown, never "0 fps displayed".
        const shown = prev.key === key ? dispFpsBetween(prev.play, play) : undefined;
        const disp = dispFpsPlausible(shown, dec) ? shown : null;
        const pkt = packets !== null && prev.packets !== null && packets >= prev.packets ? Math.round((packets - prev.packets) / dt) : null;
        this.push({ rx: rates.rx_fps, dec, disp, pkt, jb: rates.jb_ms ?? null });
    }

    private push(r: RxSecond): void {
        this.rows.push(r);
        if (this.rows.length > RING_SECONDS) this.rows.shift();
    }

    get size(): number { return this.rows.length; }

    /** The last `n` rows' summary, or null when nothing was measured in them. */
    summary(n = RING_SECONDS): RxSummary | null {
        const rows = tail(this.rows, n);
        if (rows.length === 0 || !rows.some(r => hasData([r.rx, r.dec, r.pkt]))) return null;
        return {
            rx_s: formatSeries(rows.map(r => r.rx)), dec_s: formatSeries(rows.map(r => r.dec)),
            disp_s: formatSeries(rows.map(r => r.disp)), pkt_s: formatSeries(rows.map(r => r.pkt)),
            window_s: rows.length,
        };
    }

    /**
     * Mean jitter-buffer ms over the last `n` rows that HAVE one (undefined: none). A frozen
     * stream emits no frames, so its newest rows have none: this is the buffer just before it froze.
     */
    recentJbMs(n = 3): number | undefined {
        const v = this.rows.map(r => r.jb).filter((x): x is number => x !== null && fin(x)).slice(-n);
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined;
    }
}

// ── sharer ─────────────────────────────────────────────────────────────────

export interface TxSnapshot {
    at: number;
    /** Active layers (outbound-rtp with active !== false). */
    act: number;
    /** Which layers `topFrames` belongs to: a change of the top layer breaks the delta. */
    topKey: string;
    /** framesEncoded of the TOP (largest) active layer, cumulative. */
    topFrames: number;
    /** framesPerSecond of the top layer: frames sent in the last second. */
    sent?: number;
    /** media-source framesPerSecond: frames the capture delivered in the last second. */
    src?: number;
}

const RID_RE = /^[A-Za-z0-9]{1,8}$/;

/** Pull the numbers the sender ring needs from a sender report; null = no video outbound-rtp. */
export function readTxSnapshot(report: StatsLike | null | undefined, at: number): TxSnapshot | null {
    if (!report) return null;
    const outs: Stat[] = [];
    let source: Stat | undefined;
    report.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) outs.push(s);
        else if (s.type === 'media-source' && s.kind === 'video' && !source) source = s;
    });
    if (outs.length === 0) return null;
    const area = (s: Stat) => (fin(s.frameWidth) ? s.frameWidth : 0) * (fin(s.frameHeight) ? s.frameHeight : 0);
    const active = outs.filter(s => s.active !== false);
    const snap: TxSnapshot = { at, act: active.length, topKey: '-', topFrames: 0 };
    if (active.length > 0) {
        const top = active.reduce((a, b) => (area(b) > area(a) ? b : a));
        snap.topKey = typeof top.rid === 'string' && RID_RE.test(top.rid) ? top.rid : '-';
        snap.topFrames = fin(top.framesEncoded) ? top.framesEncoded : 0;
        if (fin(top.framesPerSecond)) snap.sent = top.framesPerSecond;
    }
    if (source && fin((source as Stat).framesPerSecond)) snap.src = (source as Stat).framesPerSecond as number;
    return snap;
}

export interface TxSecond { src: RingValue; enc: RingValue; sent: RingValue; act: RingValue }

export interface TxSummary { src_s: string; enc_s: string; sent_s: string; act_s: string; window_s: number }

/** The sender's own share, fed a sender report about once a second. */
export class ShareTxRing {
    private prev: TxSnapshot | null = null;
    private rows: TxSecond[] = [];

    observe(report: StatsLike | null | undefined, at: number): void {
        const cur = readTxSnapshot(report, at);
        if (!cur) { this.push({ src: null, enc: null, sent: null, act: null }); this.prev = null; return; }
        const prev = this.prev;
        if (!prev) { this.prev = cur; return; }
        const dt = (cur.at - prev.at) / 1000;
        if (!(dt >= MIN_DT_S)) return;
        this.prev = cur;
        // Encoded frames of the top layer: not across a change of which layer that is, nor a counter reset.
        const enc = prev.topKey === cur.topKey && cur.topFrames >= prev.topFrames && cur.act > 0 ? (cur.topFrames - prev.topFrames) / dt : null;
        this.push({ src: cur.src ?? null, enc: cur.act === 0 ? 0 : enc, sent: cur.act === 0 ? 0 : cur.sent ?? null, act: cur.act });
    }

    private push(r: TxSecond): void {
        this.rows.push(r);
        if (this.rows.length > RING_SECONDS) this.rows.shift();
    }

    get size(): number { return this.rows.length; }

    summary(n = RING_SECONDS): TxSummary | null {
        const rows = tail(this.rows, n);
        if (rows.length === 0 || !rows.some(r => hasData([r.src, r.enc, r.sent]))) return null;
        return {
            src_s: formatSeries(rows.map(r => r.src)), enc_s: formatSeries(rows.map(r => r.enc)),
            sent_s: formatSeries(rows.map(r => r.sent)), act_s: formatSeries(rows.map(r => r.act)),
            window_s: rows.length,
        };
    }
}

// ── when to write a summary ────────────────────────────────────────────────

export type FpsDip = 'src' | 'enc' | 'sent';

/**
 * Did a share_fps sample dip under half the target? Names the most UPSTREAM
 * stage that did (capture, then encoder, then what was sent) - when the capture
 * is low everything after it is too. With no active layer (dynacast paused
 * every layer: nobody is watching) encoded / sent are 0 by design and never a dip.
 */
export function shareFpsDip(i: { target: number; src?: number; enc?: number; sent?: number; act?: number }): FpsDip | null {
    if (!(i.target > 0)) return null;
    const half = i.target * 0.5;
    const low = (v: number | undefined) => fin(v) && v < half;
    if (low(i.src)) return 'src';
    if (i.act === 0) return null;
    if (low(i.enc)) return 'enc';
    if (low(i.sent)) return 'sent';
    return null;
}

/** At most `max` summaries per share, at least `minGapMs` apart. */
export class RingLimiter {
    private count = 0;
    private last = -Infinity;
    private readonly minGapMs: number;
    private readonly max: number;

    constructor(minGapMs: number, max: number) {
        this.minGapMs = minGapMs;
        this.max = max;
    }

    allow(now: number): boolean {
        if (this.count >= this.max || now - this.last < this.minGapMs) return false;
        this.count++;
        this.last = now;
        return true;
    }

    get used(): number { return this.count; }
}

/** Viewer: >= 8 s between summaries, at most 16 per share (8 freezes x start + end). */
export const RX_RING_GAP_MS = 8_000;
export const RX_RING_MAX = 16;
/** Sharer: a dip writes once when it begins; a dip that lasts writes again at most every 60 s; 8 per share. */
export const TX_RING_GAP_MS = 30_000;
export const TX_RING_CONTINUING_MS = 60_000;
export const TX_RING_MAX = 8;

/** Edge-triggered gate for the sender ring: on entering a dip, then rarely while it lasts. */
export class TxRingGate {
    private dipping = false;
    private readonly limiter = new RingLimiter(TX_RING_GAP_MS, TX_RING_MAX);
    private last = -Infinity;

    shouldLog(now: number, dip: FpsDip | null): boolean {
        if (!dip) { this.dipping = false; return false; }
        const entering = !this.dipping;
        this.dipping = true;
        if (!entering && now - this.last < TX_RING_CONTINUING_MS) return false;
        if (!this.limiter.allow(now)) return false;
        this.last = now;
        return true;
    }
}
