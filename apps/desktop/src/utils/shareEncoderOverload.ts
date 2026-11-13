/**
 * "Your computer's encoder cannot keep up with this share" - detected from the
 * live sender stats, on every platform, for every setting, and answered with
 * the best setting the encoder appears able to sustain. Nothing here lowers the
 * share by itself: the user's choice stands until they click the suggestion.
 *
 * ── Why a detector and not a cap (owner, 2026-11-02)
 *
 * Two reports from a base Apple M5 sharing a 3024x1964 display at Source / 90 fps
 * (H.265, VideoToolbox) showed an encoder that falls over rather than slowing
 * down: ~534 Mpx/s asked of it, the top layer's per-frame encode time 55-98 ms
 * (a 90 fps frame is 11 ms), 39-72 fps out, ~2.4 Mbps against 22 Mbps available.
 * libwebrtc then scaled the picture to 2268x1472 (qualityLimitationReason
 * `cpu`) and the same encoder ran 90 fps at ~10 ms per frame, only for the
 * scale to be undone 20 s later and the overload to return. Another encoder
 * (an RTX does 6-7 ms) would never notice. A fixed pixel budget would be a table
 * of chips; this reads what THIS encoder, with THIS codec, actually achieves.
 *
 * ── What counts as overload (top layer only)
 *
 * The TOP layer is the largest active outbound-rtp. Summing layers overstates
 * it: `enc_fps` in the share_fps event sums every active layer (60 fps full +
 * 30 fps lighter copy = 90 on a 60 fps share), `kbps` and `enc_ms` do too (the
 * cheap 720p copy dilutes the encode time, and its ~2.2 Mbps ceiling is the
 * flat "2.4 Mbps" of a static screen). A window is overloaded when, on the top
 * layer alone:
 *   - libwebrtc itself says `cpu` for at least half of it (the scaled-down
 *     stretches count: they are the encoder failing, merely hidden), or
 *   - the encode time per frame is more than SLOW_ENCODE_RATIO frame budgets
 *     AND fewer than KEEP_UP_RATIO of the frames the capture offered came out.
 * and the capture is delivering (otherwise it is the capture's problem:
 * shareCaptureBound / share_capture_stall) - EXCEPT when libwebrtc says `cpu` for
 * the window and no program is in front of the shared screen (see "CPU-starved
 * capture" below). A healthy encode time alone is not
 * overload, nor is a low frame rate with a healthy encode time (the bandwidth
 * ramp after a publish, a bandwidth limit, a still screen).
 *
 * It must hold for SUSTAIN_MS of consecutive valid windows, after SETTLE_MS
 * from the share (re)starting or its setting changing, and never across a
 * layer-set change (dynacast), a counter reset (republish) or while the caller
 * says the share is being republished.
 *
 * ── CPU-starved capture (2026-11-07, Linux lab: `--cpus=2`, 1080p / 90 fps VP8)
 *
 * When the whole machine is out of CPU, the CAPTURE starves together with the
 * encoder (capture 5-10 fps, encode 2-8 fps, `qualityLimitationReason=cpu` from the
 * second sample on). The old rule stood down on `capture < half the target`
 * (`no_capture`) BEFORE looking at libwebrtc's `cpu`, so a share that was
 * CPU-limited and delivering 5-10 fps of 90 never produced a window, let alone a
 * verdict - and since the software guard stopped judging (2026-11-05) and the
 * game-starve card needs a Windows foreground program, nothing at all spoke.
 * Now a window whose capture is under half the target still counts as overloaded
 * when the top layer is cpu-limited for half of it (the same CPU_LIMIT_FRACTION)
 * and the caller does not say a game is in front (that is shareGameStarve's, with
 * its own answers). Such a window is judged against the TARGET: the encoder is
 * "offered" the target rate, not the rate the starved capture happened to deliver
 * (comparing a stream with itself hid the shortfall). Same settle, same sustain,
 * same one-shot-per-setting, same click-to-apply: a transient dip never speaks,
 * and nothing changes the user's setting by itself (owner rule, 2026-11-05).
 * A suggestion for such a verdict is fitted to HALF the current work, not to the
 * collapsed rate (a starved rate is not a capacity) - see suggestionInputs.
 *
 * ── The suggestion
 *
 * From the same windows: the pixels per second the top layer achieved, plus the
 * lighter copy's measured load. If the encoder was caught keeping up at some
 * size (a cpu-scaled stretch) that rate is PROVEN; otherwise the achieved rate
 * is discounted by CAPACITY_MARGIN. The suggestion is the real option
 * (resolution x frame rate, resolved against this source's size through the same
 * capture box / codec clamp the share uses) with the highest pixel rate under
 * that budget, ties toward the user's frame rate. Its name is an estimate: "the
 * most this encoder appears able to sustain". If it still overloads, the next
 * fresh measurement yields the next step down - never automatically.
 */
import { captureBoxFor, type ScreenShareCodec } from './screenShare';
import { planEncode } from './shareEncoderLimits';

type Stat = Record<string, unknown>;
export type StatsLike = { forEach(cb: (s: Stat) => void): void };
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (n: number) => Math.round(n * 10) / 10;

export type OverloadRes = 'source' | '1440p' | '1080p' | '720p' | '480p';
export interface OverloadSetting { resolution: OverloadRes; frameRate: number }

/** No verdict this soon after a (re)start or a setting change: the bandwidth ramp, the first keyframes, the capture warming up. */
export const OVERLOAD_SETTLE_MS = 25_000;
/** Consecutive overloaded windows this long before anything is said. */
export const OVERLOAD_SUSTAIN_MS = 30_000;
/** A window shorter than this says nothing. */
export const MIN_WINDOW_MS = 4_000;
/** Encode time per frame, in frame budgets (1000 / fps), beyond which frames queue. Healthy measured 0.9 (2268x1472 at 90 fps), overloaded 5-9. */
export const SLOW_ENCODE_RATIO = 2;
/** Fewer than this share of the frames the capture offered came out. */
export const KEEP_UP_RATIO = 0.9;
/** At or above this share of the offered frames the encoder is "keeping up" (its rate is proven). */
export const PROVEN_RATIO = 0.95;
/** Share of a window libwebrtc must report `cpu` for. */
export const CPU_LIMIT_FRACTION = 0.5;
/** Capture below this share of the target is the capture's problem, not the encoder's. */
export const CAPTURE_MIN_RATIO = 0.5;
/** Discount on an achieved rate that was NOT proven (the encoder was already falling behind). */
export const CAPACITY_MARGIN = 0.9;

// ── reading a sender report ────────────────────────────────────────────────

export interface LayerSnap { rid: string; frames: number; encodeTime: number; width: number; height: number; cpuS?: number }

export interface OverloadSnapshot {
    at: number;
    /** Active layers' rids, sorted (shareNetStats.layerSetOf's rule). */
    layerSet: string;
    /** Active layers, largest picture first: layers[0] is the TOP layer. */
    layers: LayerSnap[];
    /** media-source framesPerSecond: what the capturer delivered in the last second. */
    srcFps?: number;
    /** qualityLimitationReason of the top layer. */
    reason?: string;
    hardware?: boolean;
    encoder?: string;
}

const RID_RE = /^[A-Za-z0-9]{1,8}$/;

export function readOverloadSnapshot(report: StatsLike | null | undefined, at: number): OverloadSnapshot | null {
    if (!report) return null;
    const outs: Stat[] = [];
    let source: Stat | undefined;
    report.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) outs.push(s);
        else if (s.type === 'media-source' && s.kind === 'video' && !source) source = s;
    });
    const active = outs.filter(s => s.active !== false);
    if (active.length === 0) return null;
    const layers: LayerSnap[] = active.map(s => {
        const cpu = (s.qualityLimitationDurations as Stat | undefined)?.cpu;
        return {
            rid: typeof s.rid === 'string' && RID_RE.test(s.rid) ? s.rid : '-',
            frames: fin(s.framesEncoded) ? s.framesEncoded : 0,
            encodeTime: fin(s.totalEncodeTime) ? s.totalEncodeTime : 0,
            width: fin(s.frameWidth) ? s.frameWidth : 0,
            height: fin(s.frameHeight) ? s.frameHeight : 0,
            ...(fin(cpu) ? { cpuS: cpu } : {}),
        };
    }).sort((a, b) => b.width * b.height - a.width * a.height);
    const topStat = active.reduce((a, b) => ((fin(b.frameWidth) ? b.frameWidth : 0) * (fin(b.frameHeight) ? b.frameHeight : 0)
        > (fin(a.frameWidth) ? a.frameWidth : 0) * (fin(a.frameHeight) ? a.frameHeight : 0) ? b : a));
    const snap: OverloadSnapshot = {
        at,
        layerSet: active.map(s => (typeof s.rid === 'string' && RID_RE.test(s.rid) ? s.rid : '-')).sort().join('|'),
        layers,
    };
    if (source && fin((source as Stat).framesPerSecond)) snap.srcFps = (source as Stat).framesPerSecond as number;
    if (typeof topStat.qualityLimitationReason === 'string') snap.reason = topStat.qualityLimitationReason;
    if (typeof topStat.powerEfficientEncoder === 'boolean') snap.hardware = topStat.powerEfficientEncoder;
    if (typeof topStat.encoderImplementation === 'string' && topStat.encoderImplementation) snap.encoder = topStat.encoderImplementation.slice(0, 64);
    return snap;
}

// ── one window ─────────────────────────────────────────────────────────────

export interface OverloadWindow {
    dtS: number;
    overloaded: boolean;
    cpuLimited: boolean;
    slow: boolean;
    /** Top layer, frames encoded per second. */
    encFps: number;
    /** Top layer, encode time per frame, ms (undefined: no frame). */
    encMs?: number;
    /** What the encoder was offered per second (target, held to the capture's rate). */
    offeredFps: number;
    srcFps?: number;
    /** Top layer's picture, pixels. */
    topPixels: number;
    /** Top layer: pixels per second actually encoded. */
    topRate: number;
    /** Lighter copy(ies): pixels per second actually encoded. */
    lowRate: number;
    cpuFrac: number;
    /** The encoder kept up with what it was offered. */
    provenUp: boolean;
    /** The capture is under half the target and the top layer is cpu-limited: judged against the target (see the header). */
    starved: boolean;
}

export interface EvaluateOptions {
    /** A program other than Cipherline is in front of the shared screen: a collapsed capture is shareGameStarve's, not this watch's. */
    gameInFront?: boolean;
}

export type WindowResult = { valid: false; why: 'short' | 'layers' | 'reset' | 'no_capture' } | ({ valid: true } & OverloadWindow);

export function evaluateWindow(prev: OverloadSnapshot, cur: OverloadSnapshot, targetFps: number, opts: EvaluateOptions = {}): WindowResult {
    const dtS = (cur.at - prev.at) / 1000;
    if (!(dtS * 1000 >= MIN_WINDOW_MS)) return { valid: false, why: 'short' };
    if (prev.layerSet !== cur.layerSet || prev.layers.length !== cur.layers.length) return { valid: false, why: 'layers' };
    const top = cur.layers[0];
    const pTop = prev.layers.find(l => l.rid === top.rid);
    if (!pTop || top.frames < pTop.frames || top.encodeTime < pTop.encodeTime) return { valid: false, why: 'reset' };
    let cpuFrac = 0;
    if (fin(top.cpuS) && fin(pTop.cpuS)) cpuFrac = Math.max(0, Math.min(1, (top.cpuS - pTop.cpuS) / dtS));
    else if (cur.reason === 'cpu') cpuFrac = 1;
    const cpuLimited = cpuFrac >= CPU_LIMIT_FRACTION;
    // The capture is not delivering: that is shareCaptureBound / share_capture_stall's to say - unless the encoder is
    // cpu-limited for the window too and nothing is in front of the screen: then the machine is out of CPU and both starve.
    let starved = false;
    if (fin(cur.srcFps) && cur.srcFps < CAPTURE_MIN_RATIO * targetFps) {
        if (opts.gameInFront || !cpuLimited) return { valid: false, why: 'no_capture' };
        starved = true;
    }

    const dFrames = top.frames - pTop.frames;
    const encFps = dFrames / dtS;
    const encMs = dFrames > 0 ? ((top.encodeTime - pTop.encodeTime) / dFrames) * 1000 : undefined;
    // A starved capture's own rate is not what the encoder was asked for: the shortfall is against the target.
    const offeredFps = !starved && fin(cur.srcFps) && cur.srcFps > 0 ? Math.min(targetFps, cur.srcFps) : targetFps;
    const budgetMs = 1000 / offeredFps;
    const slow = encMs !== undefined && encMs > SLOW_ENCODE_RATIO * budgetMs && encFps < KEEP_UP_RATIO * offeredFps;

    let lowRate = 0;
    for (const l of cur.layers.slice(1)) {
        const p = prev.layers.find(x => x.rid === l.rid);
        if (p && l.frames >= p.frames) lowRate += ((l.frames - p.frames) / dtS) * l.width * l.height;
    }
    const topPixels = top.width * top.height;
    return {
        valid: true, dtS, overloaded: cpuLimited || slow, cpuLimited, slow, encFps, encMs, offeredFps,
        ...(fin(cur.srcFps) ? { srcFps: cur.srcFps } : {}),
        topPixels, topRate: encFps * topPixels, lowRate, cpuFrac, starved,
        provenUp: encFps >= PROVEN_RATIO * offeredFps && (encMs === undefined || encMs <= SLOW_ENCODE_RATIO * budgetMs),
    };
}

// ── evidence and suggestion ────────────────────────────────────────────────

export interface OverloadEvidence {
    /** Seconds of overloaded windows the verdict rests on. */
    seconds: number;
    /** Time-weighted means over those windows. */
    encMs: number;
    encFps: number;
    srcFps?: number;
    cpuPct: number;
    topRate: number;
    lowRate: number;
    /** Highest total (top + lighter copy) rate seen while the encoder kept up; 0 = never. */
    provenTotal: number;
    /** The pixels per second the TOP layer can be given: the capacity less the lighter copy. */
    budgetTop: number;
    /** Most of the evidence is CPU-starved windows (capture under half the target, encoder cpu-limited). */
    starved: boolean;
}

export function summarizeEvidence(windows: readonly OverloadWindow[]): OverloadEvidence {
    const secs = windows.reduce((n, w) => n + w.dtS, 0) || 1;
    const mean = (f: (w: OverloadWindow) => number) => windows.reduce((n, w) => n + f(w) * w.dtS, 0) / secs;
    const withMs = windows.filter(w => w.encMs !== undefined);
    const msSecs = withMs.reduce((n, w) => n + w.dtS, 0);
    const topRate = mean(w => w.topRate);
    const lowRate = mean(w => w.lowRate);
    let provenTotal = 0;
    for (const w of windows) if (w.provenUp) provenTotal = Math.max(provenTotal, w.topRate + w.lowRate);
    const capacity = Math.max(provenTotal, CAPACITY_MARGIN * (topRate + lowRate));
    const srcWindows = windows.filter(w => w.srcFps !== undefined);
    return {
        seconds: Math.round(secs),
        encMs: msSecs > 0 ? r1(withMs.reduce((n, w) => n + (w.encMs as number) * w.dtS, 0) / msSecs) : 0,
        encFps: r1(mean(w => w.encFps)),
        ...(srcWindows.length ? { srcFps: r1(srcWindows.reduce((n, w) => n + (w.srcFps as number) * w.dtS, 0) / (srcWindows.reduce((n, w) => n + w.dtS, 0) || 1)) } : {}),
        cpuPct: Math.round(mean(w => w.cpuFrac) * 100),
        topRate, lowRate, provenTotal,
        budgetTop: Math.max(0, capacity - lowRate),
        starved: windows.reduce((n, w) => n + (w.starved ? w.dtS : 0), 0) >= secs / 2,
    };
}

/**
 * What suggestSetting / resolveOption are given for a verdict. A normal verdict is fitted to what the top layer
 * achieved and to the capture's measured rate. A starved one is not: its achieved rate is the collapse itself, not a
 * capacity, and its capture rate is a symptom (capping every option at it would make "90 fps" and "30 fps" the same
 * option). Budget 0 makes suggestSetting take the biggest option at HALF the current work, the user's frame rate
 * winning ties.
 */
export function suggestionInputs(e: OverloadEvidence): { budgetTop: number; srcFpsCap: number | undefined } {
    return e.starved ? { budgetTop: 0, srcFpsCap: undefined } : { budgetTop: e.budgetTop, srcFpsCap: e.srcFps };
}

export const OVERLOAD_RESOLUTIONS: readonly OverloadRes[] = ['source', '1440p', '1080p', '720p', '480p'];
export const OVERLOAD_FRAME_RATES: readonly number[] = [90, 60, 30, 15];

const nearestEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface ResolvedOption extends OverloadSetting {
    width: number;
    height: number;
    /** Frames per second this option can actually deliver from this source (held to the capture's rate). */
    fps: number;
    /** Pixels per second the TOP layer would have to encode. */
    rate: number;
}

/**
 * The size an option encodes at for THIS source: the picker's box (held to the
 * codec's limits, captureBoxFor) fitted around the source without upscaling,
 * then the same encoder clamp the share applies (planEncode).
 */
export function resolveOption(
    setting: OverloadSetting, codec: ScreenShareCodec, source: { width: number; height: number }, srcFpsCap?: number,
): ResolvedOption {
    const box = captureBoxFor(setting.resolution, codec);
    const k = Math.min(1, box.width / source.width, box.height / source.height);
    const plan = planEncode(codec, nearestEven(source.width * k), nearestEven(source.height * k));
    const width = plan.width || nearestEven(source.width * k);
    const height = plan.height || nearestEven(source.height * k);
    const fps = fin(srcFpsCap) && srcFpsCap > 0 ? Math.min(setting.frameRate, srcFpsCap) : setting.frameRate;
    return { ...setting, width, height, fps, rate: width * height * fps };
}

export interface OverloadSuggestion extends ResolvedOption {
    /** Nothing fit the estimate; this is the lowest option that is below the current one. */
    floor: boolean;
}

/** Rates this close count as equal, so the user's frame rate can win the tie. */
const TIE = 0.03;

/**
 * The highest-rate option (below the current one) the top layer's budget can
 * carry; ties go to the frame rate the user chose. null = nothing lower exists.
 */
export function suggestSetting(i: {
    current: OverloadSetting;
    codec: ScreenShareCodec;
    source: { width: number; height: number };
    /** Highest frame rate this source may ask for (a window: 60). */
    maxFps: number;
    budgetTop: number;
    /** The capture's own rate, when measured (a 60 Hz display offers no 90). */
    srcFpsCap?: number;
}): OverloadSuggestion | null {
    const cur = resolveOption(i.current, i.codec, i.source, i.srcFpsCap);
    const all: ResolvedOption[] = [];
    for (const resolution of OVERLOAD_RESOLUTIONS) {
        for (const frameRate of OVERLOAD_FRAME_RATES) {
            if (frameRate > i.maxFps) continue;
            if (resolution === i.current.resolution && frameRate === i.current.frameRate) continue;
            all.push(resolveOption({ resolution, frameRate }, i.codec, i.source, i.srcFpsCap));
        }
    }
    // Strictly less work than now, and not the same picture at the same rate under another name.
    const lower = all.filter(o => o.rate < cur.rate * 0.98);
    if (lower.length === 0) return null;
    const fits = lower.filter(o => o.rate <= i.budgetTop);
    const pool = fits.length > 0 ? fits : lower.filter(o => o.rate <= cur.rate * 0.5);
    const floor = fits.length === 0;
    const from = pool.length > 0 ? pool : [lower.reduce((a, b) => (b.rate < a.rate ? b : a))];
    const top = Math.max(...from.map(o => o.rate));
    const near = from.filter(o => o.rate >= top * (1 - TIE));
    near.sort((a, b) =>
        Math.abs(a.frameRate - i.current.frameRate) - Math.abs(b.frameRate - i.current.frameRate)
        || b.rate - a.rate);
    // With nothing fitting, the biggest of the "half the work" options is a step down, not the floor.
    return { ...near[0], floor };
}

// ── the watch ──────────────────────────────────────────────────────────────

export const settingKey = (s: OverloadSetting) => `${s.resolution}@${s.frameRate}`;

export interface OverloadObserveContext {
    setting: OverloadSetting;
    /** The frame rate the user asked for. */
    targetFps: number;
    /** The caller says the share is being (re)published or held: no judgement now. */
    blocked: boolean;
    /** Something else is already telling the user about this share (a stall, a codec drift, a capture-bound note): wait. */
    suppressed: boolean;
    /** A program other than Cipherline is in front of the shared screen (Windows foreground info; unknown = false). */
    gameInFront?: boolean;
}

export interface OverloadVerdict {
    key: string;
    evidence: OverloadEvidence;
    hardware?: boolean;
    encoder?: string;
}

/**
 * Why the watch did NOT (or could no longer) judge, as logged in a
 * `share_encoder_overload` event with phase = state. The watch used to say only
 * "shown / accepted / dismissed / none", so a share whose overload never
 * surfaced left no trace of why (a restart, a republish in flight, the capture
 * itself below half the target, ...):
 *   restart      the sampler was (re)installed: a start, a retune, a republish;
 *   blocked      a start / swap / republish or a codec-drift republish is in flight;
 *   no_stats     the sender report had no active video layer;
 *   layers       the active layer set changed (dynacast) between two reports;
 *   reset        a counter went backwards (a republished sender): a new stream;
 *   no_capture   the capture delivers under half the target fps: the capture's
 *                problem, not the encoder's (shareCaptureBound / share_capture_stall);
 *   cpu_starved  a window counted as overload although the capture is under half the target:
 *                the encoder is cpu-limited and the capture is starved with it (see the header);
 *   suppressed   the verdict was reached and another notice is up: held back;
 *   dismissed    the verdict was reached for a setting the user dismissed;
 *   recovered    an overloaded stretch ended with a healthy window (secs = how long it had run).
 * Only a CHANGE of reason is reported (never every tick), and at most
 * OVERLOAD_NOTE_MAX per share.
 */
export type OverloadWhy = 'restart' | 'blocked' | 'no_stats' | 'layers' | 'reset' | 'no_capture' | 'cpu_starved' | 'suppressed' | 'dismissed' | 'recovered';
/** Internal states that are not worth a line: settling, a too-short window, a healthy one, an overload still building, a verdict already said. */
type Mode = OverloadWhy | 'settling' | 'short' | 'healthy' | 'building' | 'said';
const LOGGED_WHY: ReadonlySet<string> = new Set<OverloadWhy>(['restart', 'blocked', 'no_stats', 'layers', 'reset', 'no_capture', 'cpu_starved', 'suppressed', 'dismissed', 'recovered']);
/** Per share (the watch outlives retunes): a flapping state cannot flood the log. */
export const OVERLOAD_NOTE_MAX = 12;

export interface OverloadNote {
    why: OverloadWhy;
    /** Seconds of overloaded windows the watch had collected when this happened. */
    secs: number;
    /** The capture's last measured rate, when known. */
    srcFps?: number;
}

/**
 * One per share (kept across the sampler's restarts for a retune, so a
 * dismissed setting stays dismissed). Feed it every sender stats report.
 */
export class EncoderOverloadWatch {
    private prev: OverloadSnapshot | null = null;
    private settleFrom: number | null = null;
    private streak: OverloadWindow[] = [];
    private streakMs = 0;
    private readonly dismissed = new Set<string>();
    private readonly said = new Set<string>();
    // Starts as 'restart': the FIRST start of a share is not news; a later restart (retune, republish) is.
    private mode: Mode = 'restart';
    private notes: OverloadNote[] = [];
    private noted = 0;
    private lastSrcFps: number | undefined;

    /** The share (re)started, its setting changed, or it was republished: start the settle period again. */
    restart(now: number): void {
        this.prev = null;
        this.settleFrom = now;
        this.setMode('restart', Math.round(this.streakMs / 1000));
        this.streak = [];
        this.streakMs = 0;
    }

    /** The reasons that changed since the last call (oldest first); the caller logs them. */
    takeNotes(): OverloadNote[] {
        const out = this.notes;
        this.notes = [];
        return out;
    }

    private setMode(m: Mode, secs = 0): void {
        if (m === this.mode) return;
        this.mode = m;
        if (!LOGGED_WHY.has(m) || this.noted >= OVERLOAD_NOTE_MAX) return;
        this.noted++;
        this.notes.push({ why: m as OverloadWhy, secs, ...(this.lastSrcFps !== undefined ? { srcFps: r1(this.lastSrcFps) } : {}) });
    }

    /** Throw the streak away, naming why (and how much evidence it had). */
    private drop(m: Mode): void {
        const secs = Math.round(this.streakMs / 1000);
        this.streak = [];
        this.streakMs = 0;
        this.setMode(m, secs);
    }

    dismiss(key: string): void { this.dismissed.add(key); }
    isDismissed(key: string): boolean { return this.dismissed.has(key); }

    observe(now: number, report: StatsLike | null | undefined, ctx: OverloadObserveContext): OverloadVerdict | null {
        const cur = readOverloadSnapshot(report, now);
        if (!cur) { this.drop('no_stats'); return null; }
        if (fin(cur.srcFps)) this.lastSrcFps = cur.srcFps;
        if (this.settleFrom === null) this.settleFrom = now;
        const prev = this.prev;
        this.prev = cur;
        if (ctx.blocked) { this.drop('blocked'); this.settleFrom = now; return null; }
        if (!prev || now - this.settleFrom < OVERLOAD_SETTLE_MS) { this.setMode('settling'); return null; }
        const w = evaluateWindow(prev, cur, ctx.targetFps, { gameInFront: !!ctx.gameInFront });
        if (!w.valid) { this.drop(w.why); return null; }
        if (!w.overloaded) {
            if (this.streakMs > 0) this.drop('recovered'); else this.setMode('healthy');
            return null;
        }
        this.streak.push(w);
        this.streakMs += w.dtS * 1000;
        if (this.streakMs < OVERLOAD_SUSTAIN_MS) { this.setMode(w.starved ? 'cpu_starved' : 'building'); return null; }
        const key = settingKey(ctx.setting);
        if (this.dismissed.has(key)) { this.setMode('dismissed', Math.round(this.streakMs / 1000)); return null; }
        if (this.said.has(key)) { this.setMode('said'); return null; }
        if (ctx.suppressed) { this.setMode('suppressed', Math.round(this.streakMs / 1000)); return null; }
        this.said.add(key);
        this.setMode('said');
        return {
            key, evidence: summarizeEvidence(this.streak),
            ...(cur.hardware !== undefined ? { hardware: cur.hardware } : {}),
            ...(cur.encoder ? { encoder: cur.encoder } : {}),
        };
    }

}

// ── words ──────────────────────────────────────────────────────────────────

const RES_NAME: Record<OverloadRes, string> = { source: 'Source', '1440p': '1440p', '1080p': '1080p', '720p': '720p', '480p': '480p' };

/** "Source (3024×1964) at 90 fps" - plain words, the real size, the app's own resolution names. */
export function describeOption(o: { resolution: OverloadRes; width: number; height: number; frameRate: number }, presetName?: string | null): string {
    const base = `${RES_NAME[o.resolution]} (${o.width}×${o.height}) at ${o.frameRate} fps`;
    return presetName ? `${presetName} (${base})` : base;
}

/** A setting as the offer card says it: short, with no pixel counts. "Source at 90 fps", "1440p at 90 fps". */
export function shortOption(o: { resolution: OverloadRes; frameRate: number }): string {
    return `${RES_NAME[o.resolution]} at ${o.frameRate} fps`;
}

/**
 * "3024×1964 → 2216×1438", or null when the size is not changing. The names alone can
 * mislead: a Mac's 3024×1964 screen calls itself 1512×982, so "1440p" reads like a step UP.
 */
export function sizeChange(from: { width: number; height: number }, to: { width: number; height: number }): string | null {
    if (from.width === to.width && from.height === to.height) return null;
    return `${from.width}×${from.height} → ${to.width}×${to.height}`;
}

/** The `share_encoder_overload` detail for a reason change (phase = state): enums and counts only. */
export function overloadNoteDetail(n: OverloadNote, settingKey: string, targetFps: number): Record<string, string | number | boolean> {
    const d: Record<string, string | number | boolean> = { phase: 'state', why: n.why, setting: settingKey, secs: n.secs, target: targetFps };
    if (n.srcFps !== undefined) d.src_fps = n.srcFps;
    return d;
}

/** Content-free numbers for the `share_encoder_overload` event (<= 11 keys). */
export function overloadEventDetail(
    phase: 'shown' | 'accepted' | 'dismissed' | 'none',
    key: string, e: OverloadEvidence, sug: OverloadSetting | null,
): Record<string, string | number | boolean> {
    const d: Record<string, string | number | boolean> = {
        phase, setting: key, sug: sug ? settingKey(sug) : 'none',
        enc_ms: e.encMs, top_fps: e.encFps, cpu_pct: e.cpuPct,
        top_mpx: Math.round(e.topRate / 1e5) / 10, low_mpx: Math.round(e.lowRate / 1e5) / 10, budget_mpx: Math.round(e.budgetTop / 1e5) / 10,
        secs: e.seconds,
    };
    if (e.srcFps !== undefined) d.src_fps = e.srcFps;
    return d;
}
