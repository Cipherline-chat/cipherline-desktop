/**
 * The screen share's 720p "lighter copy for viewers" — when it may run.
 *
 * Owner rule: "I don't want someone to screenshare and it lags their game
 * whereas Discord didn't before." Discord's Go Live is one stream, so the
 * sharer must never pay for a second layer they do not need. Hence:
 *
 *   - Advanced setting "Lighter copy for viewers (saves bandwidth)", DEFAULT
 *     OFF (streamDiagnosticsPrefs.ts). Off = exactly today's single-layer
 *     share. It stays off by default because the only place it can be
 *     measured cheaply is the owner's GPU: this dev box has no working
 *     hardware encoder, and with a software encoder the copy is never used.
 *   - Published (as a second simulcast encoding) only when the share's codec
 *     decision is a HARDWARE H.264 encoder (screenShare.shareHasLowerLayer +
 *     the caller's HW check). VP8 / VP9 / software → one layer, always.
 *   - Even then the copy's encoding is kept `active: false` (the encoder for
 *     it is not run) unless this gate says yes, every second:
 *       · every active layer reports a hardware encoder (encoderImplementation /
 *         powerEfficientEncoder) — software is never allowed;
 *       · ≥ 3 people are watching the share (screenShareViewers count — a
 *         performance hint only, never an access control);
 *       · nothing has tripped the back-off below.
 *   - Back-off, LATCHED for the rest of the share (no flapping, no retries):
 *       · any layer reports qualityLimitationReason 'cpu';
 *       · while the copy runs, the full layer's encode time rises ≥ 30 % over
 *         its own level measured while the copy was off (3 ticks);
 *       · while the copy runs, the full layer delivers < 95 % of its target
 *         fps for 3 ticks with a game running, or for 5 ticks without.
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
 * allows it. While the copy is off, a viewer asking for it simply gets the
 * full layer (the SFU's forwarder overshoots to the highest available layer
 * — forwarder.go AllocateOptimal) — i.e. exactly today's behaviour.
 */
import { isHardwareCodec } from './streamStatsHud';

export const SHARE_LOW_MIN_VIEWERS = 3;
export const SHARE_LOW_ENCODE_RISE = 1.3;
export const SHARE_LOW_FPS_RATIO = 0.95;
export const SHARE_LOW_TRIP_TICKS_GAME = 3;
export const SHARE_LOW_TRIP_TICKS = 5;
export const SHARE_LOW_ENCODE_TRIP_TICKS = 3;

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
    gameRunning: boolean;
    /** Whether the copy was encoding during this tick. */
    lowActive: boolean;
}

export interface ShareLowDecision { allow: boolean; reason: string; latched: boolean }

export class ShareLowLayerGate {
    private latched: string | null = null;
    private baselineMs: number | null = null;
    private slowTicks = 0;
    private encodeTicks = 0;

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
            this.slowTicks = 0;
            this.encodeTicks = 0;
        } else {
            const slow = typeof t.topFps === 'number' && t.topFps < SHARE_LOW_FPS_RATIO * t.targetFps;
            this.slowTicks = slow ? this.slowTicks + 1 : 0;
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
        if (t.viewers < SHARE_LOW_MIN_VIEWERS) return no(`${t.viewers} viewer(s) — needs ${SHARE_LOW_MIN_VIEWERS}`);
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
export function readShareEncoderTick(report: StatsLike): { hardware: boolean | null; cpuLimited: boolean; topFps?: number; topEncodeMs?: number; lowActive: boolean; topKey?: string; topFrames?: number; topEncodeS?: number } {
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
                topFps: r.topFps, topEncodeMs, targetFps: deps.targetFps, gameRunning: deps.gameRunning(), lowActive: r.lowActive,
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
