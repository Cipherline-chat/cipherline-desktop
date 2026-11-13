/**
 * Native share encoder injection: the PURE parts (SPIKE, off by default).
 * See docs/plans/native-share-encoder.md.
 *
 * Idea: the share is published as a tiny dummy video track so Chromium's RTP
 * sender, LiveKit's E2EE cryptor and the SFU all stay exactly as they are. In
 * the E2EE worker, in front of the cryptor, each dummy encoded frame's bytes are
 * REPLACED with the next access unit (AU) from an encoder running outside
 * Chromium. Everything here is deterministic and DOM-free so it is testable.
 *
 * The one rule that matters (key/delta alignment): the receiver's decoder is
 * only correct if it never sees a delta AU whose reference it did not get.
 * So the injector (1) emits nothing until the first IDR, (2) after ANY gap in
 * the AU sequence (queue overflow, stale drop, helper restart) discards every
 * delta AU until the next IDR and asks the encoder for one, and (3) asks for an
 * IDR when the dummy encoder produced a key frame or a PLI/FIR arrived.
 */

import { ReceiverViewNormalizer } from './h264ReceiverView';

export const NATIVE_SHARE_ENV = 'CIPHERLINE_NATIVE_SHARE_ENCODER';

export function nativeShareEncoderEnabled(env: { [k: string]: string | undefined }): boolean {
    return (env[NATIVE_SHARE_ENV] ?? '').trim() === '1';
}

// ── wire format from share-encoder-helper (little endian, 24-byte header) ───

export interface NativeAccessUnit {
    key: boolean;
    /** Header flag bit1: this AU belongs to the helper's lighter-copy (720p) session, i.e. the LOW simulcast layer. Absent/false = the full layer. */
    low?: boolean;
    /** Header flag bit2: NOT an access unit - the helper's thumbnail for the sharer's own tile (nativeSharePreview.ts). Never fed to an injector. */
    preview?: boolean;
    captureUs: number;
    doneUs: number;
    data: Uint8Array;
}

export const AU_HEADER_BYTES = 24;
/** Refuse absurd lengths (a corrupted stream must not allocate GBs). */
export const AU_MAX_BYTES = 16 * 1024 * 1024;

/** Incremental parser: feed arbitrary chunks, get whole AUs. Throws on a corrupt header. */
export class AccessUnitParser {
    private buf = new Uint8Array(0);
    push(chunk: Uint8Array): NativeAccessUnit[] {
        if (chunk.length) {
            const n = new Uint8Array(this.buf.length + chunk.length);
            n.set(this.buf); n.set(chunk, this.buf.length);
            this.buf = n;
        }
        const out: NativeAccessUnit[] = [];
        for (;;) {
            if (this.buf.length < AU_HEADER_BYTES) break;
            const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
            const len = dv.getUint32(0, true);
            if (len === 0 || len > AU_MAX_BYTES) throw new Error(`bad access unit length ${len}`);
            if (this.buf.length < AU_HEADER_BYTES + len) break;
            const flags = this.buf[4];
            const captureUs = Number(dv.getBigUint64(8, true));
            const doneUs = Number(dv.getBigUint64(16, true));
            out.push({ key: (flags & 1) === 1, low: (flags & 2) === 2, ...((flags & 4) === 4 ? { preview: true } : {}), captureUs, doneUs, data: this.buf.slice(AU_HEADER_BYTES, AU_HEADER_BYTES + len) });
            this.buf = this.buf.subarray(AU_HEADER_BYTES + len);
        }
        return out;
    }
}

/** True when the Annex-B bytes contain an IDR slice (NAL type 5). Used to cross-check the helper's flag. */
export function annexBHasIdr(d: Uint8Array): boolean {
    for (let i = 0; i + 3 < d.length; i++) {
        if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3] & 0x1f) === 5) return true;
    }
    return false;
}

// ── key/IDR alignment ───────────────────────────────────────────────────────

export interface InjectorOptions {
    /** AUs older than this (ms since capture) are dropped (and count as a gap). */
    maxAgeMs: number;
    /** Max queued AUs; overflow drops the OLDEST and counts as a gap. */
    maxQueue: number;
    /** Minimum spacing between IDR requests caused by a GAP (correctness: the stream is undecodable until an IDR). */
    idrMinIntervalMs: number;
    /**
     * Keyframe DEMAND from receivers (dummy key frame / PLI / FIR) is throttled harder, because it can come from a viewer
     * that can never be satisfied (wrong key, broken decoder) and would otherwise force an IDR burst for everyone.
     * Base spacing; after 3+ PLIs that each arrived within futileWindowMs of an IDR we just sent ("still asking after we
     * answered") the spacing widens to pliMaxIntervalMs; back to the base after quietResetMs without any PLI.
     */
    pliBaseIntervalMs: number;
    pliMaxIntervalMs: number;
    futileWindowMs: number;
    quietResetMs: number;
    /** No backoff is learned during this start-up grace (viewers legitimately re-ask while the first IDR is still in flight). */
    startupGraceMs: number;
}
export const DEFAULT_INJECTOR_OPTIONS: InjectorOptions = {
    maxAgeMs: 500, maxQueue: 8, idrMinIntervalMs: 200,
    pliBaseIntervalMs: 1500, pliMaxIntervalMs: 10000, futileWindowMs: 800, quietResetMs: 6000, startupGraceMs: 12000,
};

export type InjectDecision =
    | { kind: 'replace'; data: Uint8Array; key: boolean }
    | { kind: 'drop'; reason: 'no_au' | 'awaiting_idr' };

export interface InjectorStats { replaced: number; dropped: number; gaps: number; idrRequests: number; deltaDiscarded: number; keyMismatch: number; pliSeen: number; pliCoalesced: number; futilePli: number }

/**
 * The state machine. `onAu` is fed by the helper pipe, `next` is called once per
 * dummy encoded frame, `needKey` on a dummy key frame / PLI / FIR / new subscriber.
 * `requestIdr` is the callback to the encoder (rate limited here).
 */
export class NativeInjector {
    private q: (NativeAccessUnit & { arrived: number })[] = [];
    private synced = false; // true once an IDR has been emitted and no gap since
    private lastIdrReq = -Infinity;
    readonly stats: InjectorStats = { replaced: 0, dropped: 0, gaps: 0, idrRequests: 0, deltaDiscarded: 0, keyMismatch: 0, pliSeen: 0, pliCoalesced: 0, futilePli: 0 };
    private lastIdrEmitted = -Infinity;
    private lastPliAt = -Infinity;
    private futile = 0;
    private readonly createdAt: number;
    private pliPending = false;

    private readonly requestIdr: () => void;
    private readonly now: () => number;
    private readonly opts: InjectorOptions;

    private readonly requestRefresh: (() => void) | undefined;

    /** `requestRefresh`: when given, receiver keyframe DEMAND (PLI) starts a gradual intra-refresh wave instead of an IDR; gaps still get true IDRs. */
    constructor(requestIdr: () => void, now: () => number, opts: InjectorOptions = DEFAULT_INJECTOR_OPTIONS, requestRefresh?: () => void) {
        this.requestRefresh = requestRefresh;
        this.requestIdr = requestIdr; this.now = now; this.opts = opts; this.createdAt = now();
        this.askIdr();
    }

    private askIdr(): void {
        const t = this.now();
        if (t - this.lastIdrReq < this.opts.idrMinIntervalMs) return;
        this.lastIdrReq = t;
        this.stats.idrRequests++;
        this.requestIdr();
    }

    private gap(): void { this.synced = false; this.stats.gaps++; this.askIdr(); }

    /** Repairs what the receiver would otherwise change before LiveKit's cryptor authenticates it (h264ReceiverView.ts). */
    readonly viewNormalizer = new ReceiverViewNormalizer();

    onAu(au: NativeAccessUnit): void {
        au = { ...au, data: this.viewNormalizer.normalize(au.data) };
        // Trust the bitstream over the flag: a mislabelled AU is the desync we are guarding against.
        const real = annexBHasIdr(au.data);
        if (real !== au.key) { this.stats.keyMismatch++; au = { ...au, key: real }; }
        this.q.push({ ...au, arrived: this.now() });
        while (this.q.length > this.opts.maxQueue) { this.q.shift(); this.gap(); }
    }

    /** An AU that existed was discarded outside the injector (test hook / upstream loss): same effect as an overflow. */
    noteDroppedAu(): void { this.gap(); }

    /** The encoder was restarted / failed over: whatever was queued belongs to a dead reference chain. */
    reset(): void { this.q = []; this.gap(); }

    /** A key frame is wanted downstream (dummy key frame, PLI, FIR). */
    /** TEST ONLY (harness control): drop all receiver keyframe demand, to separate PLI effects from load effects. */
    ignorePli = false;

    needKey(): void {
        if (this.ignorePli) return;
        const t = this.now();
        this.stats.pliSeen++;
        if (t - this.createdAt < this.opts.startupGraceMs) { /* start-up: never learn a backoff */ }
        else if (t - this.lastIdrEmitted < this.opts.futileWindowMs) { this.futile = Math.min(this.futile + 1, 6); this.stats.futilePli++; }
        else if (t - this.lastPliAt > this.opts.quietResetMs) this.futile = 0;
        this.lastPliAt = t;
        if (!this.tryPliIdr(t)) { this.pliPending = true; this.stats.pliCoalesced++; }
    }

    /** Current spacing for keyframe demand (visible for tests / HUD). */
    pliInterval(): number {
        // A genuine viewer also asks again shortly after an IDR when that IDR was lost, and the SFU merges every subscriber's PLI into
        // one stream, so a single "futile" PLI proves nothing. Only a SUSTAINED pattern (3+) widens the spacing, and only to the cap
        // (10 s): the worst case for a real viewer is a 10 s wait, never a long freeze (bounded by the cap).
        return this.futile >= 3 ? this.opts.pliMaxIntervalMs : this.opts.pliBaseIntervalMs;
    }

    private tryPliIdr(t: number): boolean {
        if (t - this.lastIdrReq < this.pliInterval()) return false;
        this.lastIdrReq = t; this.stats.idrRequests++; this.pliPending = false;
        if (this.requestRefresh) this.requestRefresh(); else this.requestIdr();
        return true;
    }

    next(): InjectDecision {
        const t = this.now();
        if (this.pliPending) this.tryPliIdr(t); // coalesced demand: one IDR once the spacing has elapsed
        for (;;) {
            const au = this.q[0];
            if (!au) { this.stats.dropped++; return { kind: 'drop', reason: this.synced ? 'no_au' : 'awaiting_idr' }; }
            if (t - au.arrived > this.opts.maxAgeMs) { this.q.shift(); this.gap(); continue; }
            if (!this.synced && !au.key) { this.q.shift(); this.stats.deltaDiscarded++; this.askIdr(); continue; }
            this.q.shift();
            if (au.key) { this.synced = true; this.lastIdrEmitted = t; }
            this.stats.replaced++;
            return { kind: 'replace', data: au.data, key: au.key };
        }
    }
}

// ── bitrate mapping ─────────────────────────────────────────────────────────

export interface BitrateMapOptions { minBps: number; maxBps: number; headroom: number; hysteresis: number; minIntervalMs: number }
export const DEFAULT_BITRATE_MAP: BitrateMapOptions = { minBps: 1_000_000, maxBps: 80_000_000, headroom: 0.85, hysteresis: 0.1, minIntervalMs: 1000 };

/** Map a sender bandwidth estimate (availableOutgoingBitrate / targetBitrate, bps) to the encoder target. */
export function mapBitrate(estimateBps: number, o: BitrateMapOptions = DEFAULT_BITRATE_MAP): number | null {
    if (!Number.isFinite(estimateBps) || estimateBps <= 0) return null;
    return Math.round(Math.min(o.maxBps, Math.max(o.minBps, estimateBps * o.headroom)));
}

/** What the sender's stats say about the path, beyond the bandwidth estimate. null = unknown (a signal that is missing never counts as congestion). */
export interface PathSignals { lossPct: number | null; rttMs: number | null }

/** Probe-up tuning (see BitrateController). */
export const PROBE = { stepFactor: 1.25, maxOverEstimate: 2.0, lossPct: 2, rttFactor: 1.5, rttSlackMs: 40, holdMs: 5000 } as const;

/**
 * Stateful wrapper: returns a new target only when it moved by > hysteresis and the interval elapsed.
 *
 * Following the estimate alone is a chicken-and-egg on this path: libwebrtc's send-side estimate is driven by what is actually
 * acknowledged, and the bytes on the wire are the helper's (the dummy track carries almost nothing), so a target of 0.85 x estimate
 * keeps the acknowledged rate - and with it the estimate - where it already is (report bcde1655: avail flat ~3.2 Mbps for the
 * whole share at 3440x1440, loss 0, rtt steady). With `ceilingBps` set and path signals given, the target LEADS the estimate
 * while the path is clean: +25% per step, never above 2x the estimate (the pacer drains up to ~2.5x it) and never above the ceiling.
 * Loss >= 2% or an RTT well above the lowest seen drops it straight back to 0.85 x estimate and holds off probing for 5 s, so
 * the worst case is one short excursion, not a sustained overshoot. Without signals it is the plain follower.
 */
/**
 * Owner 2026-11-13 (report d9568862: 3440x1440 share "started out blocky", kbps 1.4 -> 14.7 Mbps over ~60 s): a share with a ceiling
 * and path signals STARTS at this fraction of its ceiling instead of creeping up from libwebrtc's low first estimate. The start floor
 * is dropped for good the first time the path shows congestion (loss / RTT rise -> straight back to 0.85 x estimate, as below), or
 * once the normal lead has caught up with it. So a fast link is sharp from the first second; a slow one pays one short excursion.
 */
export const START_FRACTION = 0.5;

export class BitrateController {
    private cur = 0; private last = -Infinity;
    private minRtt = Infinity; private holdUntil = -Infinity;
    private readonly now: () => number;
    private readonly o: BitrateMapOptions;
    private readonly ceiling: number | null;
    private startFloor: number | null;
    constructor(now: () => number, o: BitrateMapOptions = DEFAULT_BITRATE_MAP, ceilingBps: number | null = null) {
        this.now = now; this.o = o; this.ceiling = ceilingBps;
        this.startFloor = ceilingBps !== null && ceilingBps > 0 ? Math.max(o.minBps, Math.round(ceilingBps * START_FRACTION)) : null;
    }
    update(estimateBps: number, sig?: PathSignals): number | null {
        const base = mapBitrate(estimateBps, this.o);
        if (base === null) return null;
        const t = this.now();
        const capped = this.ceiling === null ? base : Math.max(this.o.minBps, Math.min(base, this.ceiling));
        let target = capped;
        if (sig && this.ceiling !== null) {
            const rtt = sig.rttMs !== null && Number.isFinite(sig.rttMs) && sig.rttMs > 0 ? sig.rttMs : null;
            if (rtt !== null) this.minRtt = Math.min(this.minRtt, rtt);
            const congested = (sig.lossPct !== null && sig.lossPct >= PROBE.lossPct)
                || (rtt !== null && this.minRtt < Infinity && rtt > this.minRtt * PROBE.rttFactor + PROBE.rttSlackMs);
            if (congested) { this.startFloor = null; this.holdUntil = t + PROBE.holdMs; if (this.cur > capped) this.last = -Infinity; }   // back off now, not a second later
            else if (t >= this.holdUntil) {
                const lead = Math.min(this.ceiling, estimateBps * PROBE.maxOverEstimate, Math.max(this.cur, capped) * PROBE.stepFactor);
                target = Math.round(Math.max(capped, lead));
                if (this.startFloor !== null) {
                    if (target >= this.startFloor) this.startFloor = null;          // the normal lead caught up: floor no longer needed
                    else target = Math.min(this.ceiling, this.startFloor);         // start in the middle, not from the low first estimate
                }
            }
        }
        if (this.cur && (t - this.last < this.o.minIntervalMs || Math.abs(target - this.cur) / this.cur <= this.o.hysteresis)) return null;
        this.cur = target; this.last = t;
        return target;
    }
}

// ── fallback watchdog ───────────────────────────────────────────────────────

/** Decides when the native path is dead and the share must go back to the normal Chromium encoder. */
export class FallbackWatchdog {
    private lastAu: number;
    private fired = false;
    private readonly now: () => number;
    private readonly stallMs: number;
    private readonly helperExited: () => boolean;
    private armed: boolean;
    /**
     * `armed=false`: the stall clock does not run until the first AU (or an explicit arm()). A native share starts BEFORE the portal chooser
     * is answered, and a person takes seconds there; only a helper exit can end an unarmed watchdog.
     */
    constructor(now: () => number, stallMs = 1500, helperExited: () => boolean = () => false, armed = true) {
        this.now = now; this.stallMs = stallMs; this.helperExited = helperExited; this.lastAu = now(); this.armed = armed;
    }
    sawAu(): void { this.lastAu = this.now(); this.armed = true; }
    /** Start the stall clock now (the stream is up: frames are owed from here on). */
    arm(): void { this.lastAu = this.now(); this.armed = true; }
    /** True exactly once, when the helper died or (once armed) no AU arrived for stallMs. */
    shouldFallBack(): boolean {
        if (this.fired) return false;
        if (this.helperExited() || (this.armed && this.now() - this.lastAu > this.stallMs)) { this.fired = true; return true; }
        return false;
    }
}

// ── the worker stage ────────────────────────────────────────────────────────

export interface InjectableFrame { data: ArrayBuffer; type?: string; getMetadata?(): LayerMeta }

/** The parts of RTCEncodedVideoFrameMetadata that say which simulcast layer a (dummy) frame belongs to. */
export interface LayerMeta { rid?: string; synchronizationSource?: number; width?: number; height?: number }

/**
 * Which simulcast layer is this dummy frame? LiveKit names a two-layer share's encodings q (low, the lighter copy) and h (full), and the
 * encoded-frame metadata carries the rid. Without a rid the smaller of two SSRCs is the low one. A frame that cannot be placed is treated as
 * the FULL layer (it then competes for a full-layer AU and the stage still replaces or drops it: dummy bytes never go out), and is counted.
 */
export class LayerClassifier {
    private area = new Map<number, number>();
    unclassified = 0;
    isLow(md: LayerMeta | undefined): boolean {
        if (!md) { this.unclassified++; return false; }
        if (typeof md.rid === 'string' && md.rid) return md.rid === 'q';
        const ssrc = md.synchronizationSource, a = (md.width ?? 0) * (md.height ?? 0);
        if (typeof ssrc !== 'number' || !(a > 0)) { this.unclassified++; return false; }
        this.area.set(ssrc, a);
        if (this.area.size < 2) return false;
        let max = 0; for (const v of this.area.values()) if (v > max) max = v;
        return a < max;
    }
}

/**
 * TransformStream stage for ONE sender stream (the dummy track). For every dummy
 * frame: a dummy key frame asks the encoder for an IDR; the frame's bytes are
 * replaced by the next AU or the frame is dropped (never forwarded as dummy bytes).
 */
export function createInjectStage<F extends InjectableFrame>(inj: NativeInjector): TransformStream<F, F> {
    return new TransformStream<F, F>({
        transform(frame, controller) {
            if (frame.type === 'key') inj.needKey();
            const d = inj.next();
            if (d.kind === 'drop') return;
            const ab = d.data.buffer.slice(d.data.byteOffset, d.data.byteOffset + d.data.byteLength) as ArrayBuffer;
            frame.data = ab;
            controller.enqueue(frame);
        },
    });
}

/**
 * The two-layer variant (the native share's lighter copy). The dummy track is published as a 2-layer simulcast, so Chromium hands this
 * stage dummy frames for BOTH layers; each is replaced by the next AU of ITS layer's injector, or dropped. The same rules as the single-layer
 * stage hold per layer (own key/IDR alignment, own gap handling, own SPS/VUI normaliser), and nothing else comes out: a dummy frame is never
 * forwarded, and a full-layer AU is never placed in a low-layer frame or the reverse. Everything emitted continues into the call's cryptor.
 */
export function createLayeredInjectStage<F extends InjectableFrame>(full: NativeInjector, low: NativeInjector, classifier: LayerClassifier = new LayerClassifier()): TransformStream<F, F> {
    return new TransformStream<F, F>({
        transform(frame, controller) {
            let md: LayerMeta | undefined;
            try { md = frame.getMetadata?.(); } catch { md = undefined; }
            const inj = classifier.isLow(md) ? low : full;
            if (frame.type === 'key') inj.needKey();
            const d = inj.next();
            if (d.kind === 'drop') return;
            frame.data = d.data.buffer.slice(d.data.byteOffset, d.data.byteOffset + d.data.byteLength) as ArrayBuffer;
            controller.enqueue(frame);
        },
    });
}
