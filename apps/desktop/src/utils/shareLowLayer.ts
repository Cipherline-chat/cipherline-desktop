/**
 * The screen share's 720p "lighter copy for viewers" — when it may run.
 *
 * Owner rule: "I don't want someone to screenshare and it lags their game
 * whereas Discord didn't before." Discord's Go Live is one stream, so the
 * sharer must never pay for a second layer they do not need. Hence:
 *
 *   - Advanced setting "Lighter copy for viewers (saves bandwidth)", DEFAULT
 *     ON since 2026-10-23 (streamDiagnosticsPrefs.ts; was off). A stored "off"
 *     is still honoured. Turned on by default because without a second layer
 *     the SFU has nothing to give a viewer whose downlink cannot carry the full
 *     layer: the 2026-10-23 reports show a single 57 Mbps 1440p90 layer
 *     freezing a viewer for 2-20 s at a time, and 1080p60 still freezing
 *     "here and there". The cost side is unchanged and still guarded by the
 *     back-off below — the copy is a 720p30 hardware-encoder session.
 *   - Published (as a second simulcast encoding) only when the share's codec
 *     decision is a HARDWARE H.264 or H.265 encoder (screenShare.shareHasLowerLayer +
 *     the caller's HW check). VP8 / VP9 / software → one layer, always.
 *   - Even then the copy's encoding is kept `active: false` (the encoder for
 *     it is not run) unless this gate says yes, every second:
 *       · every active layer reports a hardware encoder (encoderImplementation /
 *         powerEfficientEncoder) — software is never allowed;
 *       · people are watching the share (screenShareViewers count — a
 *         performance hint only, never an access control): ≥ 1 on a HEAVY
 *         share (≥ 60 fps or a ≥ 1440p full layer — shareIsHeavy), where the
 *         copy is every viewer's congestion fallback; ≥ 2 otherwise (it was 3);
 *       · nothing has tripped the back-off below.
 *   - Back-off, LATCHED for the rest of the share (no flapping, no retries):
 *       · any layer reports qualityLimitationReason 'cpu';
 *       · while the copy runs, the full layer's encode time rises ≥ 30 % over
 *         its own level measured while the copy was off (3 ticks);
 *       · while the copy runs, the full layer delivers < 95 % of what it
 *         delivered with the copy OFF (capped at its target fps; a game
 *         rendering below the target is not the copy's fault) for 3 ticks with a game running, or for 5 ticks without — not
 *         counting, in the copy's first SHARE_LOW_RAMP_TICKS ticks, ticks
 *         where the full layer is BANDWIDTH-limited (ShareLowTick.topLimit):
 *         a share's first seconds, while the sender's bandwidth estimate
 *         ramps up, run below target on any encoder — measured against a
 *         real SFU (harness/share-e2e), 5 such ticks with 4 ms encodes,
 *         which alone latched the copy off for the whole share.
 *     The full layer always wins: at 90 fps it must hit what it hits with
 *     the feature off.
 *
 * Why our own control is needed at all (verified in source): LiveKit's
 * dynacast is "max quality" based — the server (dynacastmanagervideo.go)
 * sends `enabled: q <= maxSubscribedQuality`, and livekit-client 2.18.8's
 * setPublishingLayersForSender copies that straight into `encoding.active`.
 * So with anyone watching the full layer the copy would be encoded whether
 * or not anyone watches it. installShareLowLayerControl wraps the share
 * track's setPublishingLayers so LOW is only ever enabled when the gate
 * allows it. While the copy is off, a viewer asking for it may get NOTHING.
 * Measured on LiveKit v1.9.12 (harness/share-e2e, 2026-10-24): a copy that
 * was never encoded → the SFU keeps forwarding the full layer (the overshoot
 * forwarder.go AllocateOptimal describes); a copy that had been encoded and
 * was then switched off (the gate's back-off latching) → after ~4 s the SFU
 * forwarded nothing at all, 0 kbit/s and a frozen picture for as long as
 * the viewer held the request. Hence ShareLossFallback lifts a cap whose
 * lower layer delivers no packets.
 */
import { isHardwareCodec } from './streamStatsHud';

/** Viewers needed for the copy on an ordinary share (≤ 1080p and < 60 fps). */
export const SHARE_LOW_MIN_VIEWERS = 2;
/** Viewers needed on a HEAVY share (shareIsHeavy): one. */
export const SHARE_LOW_MIN_VIEWERS_HEAVY = 1;
/** A share is heavy at this frame rate or above ... */
export const SHARE_LOW_HEAVY_FPS = 60;
/** ... or when the full layer's short side is at least this. */
export const SHARE_LOW_HEAVY_SHORT_SIDE = 1440;

/**
 * Heavy = a full layer big enough that a viewer on an ordinary connection can
 * fall behind it (1080p60 H.265 is ~10 Mbps, 1440p90 ~22 Mbps). For those the
 * copy is the congestion fallback for EVERY viewer, so it runs from the first
 * one: LiveKit's SFU can only move a subscriber whose downlink cannot carry the
 * full layer to a lower layer that exists, and with one layer it has nothing
 * to move them to (2026-10-23: 12-26 % loss and 2-20 s freezes on a single
 * 57 Mbps layer; still "freezing here and there" at 1080p60).
 */
export function shareIsHeavy(targetFps: number, topShortSide: number | undefined): boolean {
    return targetFps >= SHARE_LOW_HEAVY_FPS || (topShortSide ?? 0) >= SHARE_LOW_HEAVY_SHORT_SIDE;
}
export const SHARE_LOW_ENCODE_RISE = 1.3;
export const SHARE_LOW_FPS_RATIO = 0.95;
export const SHARE_LOW_TRIP_TICKS_GAME = 3;
export const SHARE_LOW_TRIP_TICKS = 5;
export const SHARE_LOW_ENCODE_TRIP_TICKS = 3;
/** The copy's first ticks, in which a bandwidth-limited full layer is the bandwidth estimate ramping up. */
export const SHARE_LOW_RAMP_TICKS = 15;

export interface ShareLowTick {
    settingOn: boolean;
    /** Every active layer reports a hardware encoder. null = unknown yet. */
    hardware: boolean | null;
    viewers: number;
    /** Any layer reports qualityLimitationReason 'cpu'. */
    cpuLimited: boolean;
    /** Full layer: encoded fps and average encode ms over the last second. */
    topFps?: number;
    topEncodeMs?: number;
    targetFps: number;
    /** Full layer's encoded short side (px), when known — see shareIsHeavy. */
    topShort?: number;
    gameRunning: boolean;
    /** Whether the copy was encoding during this tick. */
    lowActive: boolean;
    /**
     * The full layer's qualityLimitationReason. 'bandwidth' in the copy's
     * first SHARE_LOW_RAMP_TICKS ticks = the bandwidth estimate still ramping
     * up (short of BITS, not encoder time), so a frame-rate shortfall then
     * says nothing about what the copy costs the sharer's machine: such
     * ticks neither count as slow nor reset the count. Later, a
     * bandwidth-limited full layer counts as before.
     */
    topLimit?: string;
}

export interface ShareLowDecision { allow: boolean; reason: string; latched: boolean }

export class ShareLowLayerGate {
    private latched: string | null = null;
    private baselineMs: number | null = null;
    /** Full layer's delivered fps with the copy OFF (EMA): the bar the copy is held to. */
    private baselineFps: number | null = null;
    private slowTicks = 0;
    private encodeTicks = 0;
    private lowTicks = 0;

    observe(t: ShareLowTick): ShareLowDecision {
        const no = (reason: string): ShareLowDecision => ({ allow: false, reason, latched: this.latched !== null });
        if (!t.settingOn) return no('off in Settings');
        if (this.latched) return no(this.latched);
        // Back-off signals — evaluated before the "may it run" checks so a
        // trip is latched even if the copy is momentarily not needed.
        if (t.cpuLimited) { this.latched = 'encoder CPU-limited'; return no(this.latched); }
        if (!t.lowActive) {
            // Learn the full layer's own encode time with the copy off.
            if (typeof t.topEncodeMs === 'number' && t.topEncodeMs > 0) {
                this.baselineMs = this.baselineMs === null ? t.topEncodeMs : this.baselineMs * 0.8 + t.topEncodeMs * 0.2;
            }
            // Bandwidth-ramp ticks say nothing about the machine; don't learn from them.
            if (typeof t.topFps === 'number' && t.topFps > 0 && t.topLimit !== 'bandwidth') {
                this.baselineFps = this.baselineFps === null ? t.topFps : this.baselineFps * 0.8 + t.topFps * 0.2;
            }
            this.slowTicks = 0;
            this.encodeTicks = 0;
            this.lowTicks = 0;
        } else {
            this.lowTicks++;
            // "Slow" = below what the full layer delivered WITHOUT the copy (capped
            // at the target), not below the target itself: a game that renders at
            // 70 fps makes a 90 fps share deliver ~70 with or without the copy, and
            // measuring against 90 latched the copy off — the viewers' only
            // congestion fallback — for something the copy didn't cause.
            const bar = Math.min(t.targetFps, this.baselineFps ?? t.targetFps);
            const slow = typeof t.topFps === 'number' && t.topFps < SHARE_LOW_FPS_RATIO * bar;
            const rampingUp = slow && t.topLimit === 'bandwidth' && this.lowTicks <= SHARE_LOW_RAMP_TICKS;
            if (!rampingUp) this.slowTicks = slow ? this.slowTicks + 1 : 0;
            if (this.slowTicks >= (t.gameRunning ? SHARE_LOW_TRIP_TICKS_GAME : SHARE_LOW_TRIP_TICKS)) {
                this.latched = t.gameRunning ? 'full layer below target fps while gaming' : 'full layer below target fps';
                return no(this.latched);
            }
            const rose = this.baselineMs !== null && typeof t.topEncodeMs === 'number' && t.topEncodeMs >= SHARE_LOW_ENCODE_RISE * this.baselineMs;
            this.encodeTicks = rose ? this.encodeTicks + 1 : 0;
            if (this.encodeTicks >= SHARE_LOW_ENCODE_TRIP_TICKS) {
                this.latched = 'full layer encode time rose';
                return no(this.latched);
            }
        }
        if (t.hardware !== true) return no(t.hardware === false ? 'software encoder' : 'encoder not verified yet');
        const need = shareIsHeavy(t.targetFps, t.topShort) ? SHARE_LOW_MIN_VIEWERS_HEAVY : SHARE_LOW_MIN_VIEWERS;
        if (t.viewers < need) return no(`${t.viewers} viewer(s) — needs ${need}`);
        return { allow: true, reason: 'on', latched: false };
    }
}

// ── Runtime control over the share track ───────────────────────────────────

/** The LiveKit SubscribedQuality shape (protobuf: quality 0/1/2, enabled). */
export interface QualityLike { quality: number; enabled: boolean }

/** LOW (quality 0) is forced off unless the gate allows it; others untouched. */
export function gateQualities<T extends QualityLike>(qualities: readonly T[], allowLow: boolean): T[] {
    return qualities.map(q => (q.quality === 0 && !allowLow && q.enabled ? { ...q, enabled: false } : q));
}

export interface ShareTrackLike {
    sender?: RTCRtpSender;
    setPublishingLayers(isSvc: boolean, qualities: QualityLike[]): Promise<void>;
}

type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void };

/** One tick's encoder facts from the share sender's stats. */
export function readShareEncoderTick(report: StatsLike): { hardware: boolean | null; cpuLimited: boolean; topFps?: number; topEncodeMs?: number; lowActive: boolean; topKey?: string; topFrames?: number; topEncodeS?: number; topShort?: number; topLimit?: string } {
    const layers: Record<string, unknown>[] = [];
    report.forEach(s => { if (s.type === 'outbound-rtp' && s.kind === 'video') layers.push(s); });
    if (layers.length === 0) return { hardware: null, cpuLimited: false, lowActive: false };
    const area = (s: Record<string, unknown>) => (Number(s.frameWidth) || 0) * (Number(s.frameHeight) || 0);
    const sorted = [...layers].sort((a, b) => area(a) - area(b));
    const top = sorted[sorted.length - 1];
    const active = layers.filter(s => s.active !== false);
    const hw = active.map(s => isHardwareCodec(typeof s.encoderImplementation === 'string' ? s.encoderImplementation : undefined, s.powerEfficientEncoder));
    const hardware = hw.length === 0 || hw.some(h => h === null) ? null : hw.every(Boolean);
    return {
        hardware,
        cpuLimited: layers.some(s => s.qualityLimitationReason === 'cpu'),
        topFps: typeof top.framesPerSecond === 'number' ? top.framesPerSecond : undefined,
        lowActive: sorted.length > 1 && sorted[0].active !== false,
        topKey: typeof top.rid === 'string' ? top.rid : undefined,
        topFrames: typeof top.framesEncoded === 'number' ? top.framesEncoded : undefined,
        topEncodeS: typeof top.totalEncodeTime === 'number' ? top.totalEncodeTime : undefined,
        topShort: Number(top.frameWidth) > 0 && Number(top.frameHeight) > 0 ? Math.min(Number(top.frameWidth), Number(top.frameHeight)) : undefined,
        topLimit: typeof top.qualityLimitationReason === 'string' ? top.qualityLimitationReason : undefined,
    };
}

export interface ShareLowControlDeps {
    settingOn: () => boolean;
    viewers: () => number;
    gameRunning: () => boolean;
    targetFps: number;
    log?: (m: string) => void;
    /** Called whenever the decision or its reason changes (call event log). */
    onChange?: (allow: boolean, reason: string) => void;
    intervalMs?: number;
}

/**
 * Take over the share track's LOW layer. Returns the dispose function, which
 * restores LiveKit's own method. Does nothing for a single-layer share.
 */
export function installShareLowLayerControl(track: ShareTrackLike, deps: ShareLowControlDeps): () => void {
    const sender = track.sender;
    if (!sender || (sender.getParameters().encodings?.length ?? 0) < 2) return () => {};
    const log = deps.log ?? (m => console.info(m));
    const gate = new ShareLowLayerGate();
    const original = track.setPublishingLayers;
    const orig = original.bind(track);
    let allowLow = false;
    let last: QualityLike[] = [{ quality: 0, enabled: true }, { quality: 1, enabled: true }, { quality: 2, enabled: true }];
    track.setPublishingLayers = (isSvc: boolean, qualities: QualityLike[]) => {
        last = qualities;
        return orig(isSvc, gateQualities(qualities, allowLow));
    };
    const reapply = () => orig(false, gateQualities(last, allowLow)).catch(() => {});
    void reapply(); // the copy starts OFF

    let prev: { frames?: number; encodeS?: number } = {};
    let lastReason = '';
    const iv = setInterval(async () => {
        try {
            const r = readShareEncoderTick(await sender.getStats() as unknown as StatsLike);
            const dFrames = r.topFrames !== undefined && prev.frames !== undefined ? r.topFrames - prev.frames : 0;
            const topEncodeMs = dFrames > 0 && r.topEncodeS !== undefined && prev.encodeS !== undefined
                ? ((r.topEncodeS - prev.encodeS) / dFrames) * 1000 : undefined;
            prev = { frames: r.topFrames, encodeS: r.topEncodeS };
            const d = gate.observe({
                settingOn: deps.settingOn(), hardware: r.hardware, viewers: deps.viewers(), cpuLimited: r.cpuLimited,
                topFps: r.topFps, topEncodeMs, targetFps: deps.targetFps, topShort: r.topShort, gameRunning: deps.gameRunning(), lowActive: r.lowActive,
                topLimit: r.topLimit,
            });
            if (d.reason !== lastReason) {
                log(`[ScreenShare] lighter copy for viewers: ${d.allow ? 'on' : `off (${d.reason})`}`);
                lastReason = d.reason;
                deps.onChange?.(d.allow, d.reason);
            }
            if (d.allow !== allowLow) { allowLow = d.allow; await reapply(); }
        } catch { /* share ended between ticks */ }
    }, deps.intervalMs ?? 1000);
    return () => {
        clearInterval(iv);
        track.setPublishingLayers = original;
    };
}
