/**
 * The renderer half of an HDR screen share (Windows).
 *
 * A screen in HDR mode cannot be shared through getDisplayMedia without
 * being blown out: Chromium's capturers receive it as 8-bit clipped at 80
 * nits (see src/utils/hdrTonemap.ts). For such a screen main runs our own
 * capture (src-native/hdr_capture.cc: FP16 Desktop Duplication + a tone-map
 * shader, electron/hdr-share.ts) and hands every finished frame over as a
 * GPU VideoFrame. This module turns those frames into a MediaStreamTrack:
 *
 *     main: shared D3D11 texture -> preload: VideoFrame (same blink object)
 *       -> MediaStreamTrackGenerator -> the track LiveKit publishes
 *
 * exactly the shape of the ultra-wide crop pipeline (shareCrop.ts), so the
 * room's E2EE sender transform, the sender-codec pin and every other sender
 * hook apply as to any share. Nothing about the frames goes anywhere else,
 * and nothing changes for anyone receiving the share.
 *
 * It only ever REPLACES the Chromium capture once real frames flow: start()
 * resolves `ok: false` (and the caller shares the normal way) if main says
 * no, if no frame arrives in time, or if the first frames are blank - so a
 * broken native path costs a share start a moment, never the share.
 *
 * All Chromium globals are injected so the lifecycle is unit tested with
 * fakes (hdrSharePipeline.test.ts).
 */

export interface HdrProbe {
    use: boolean;
    reason: string;
    hdr: boolean | null;
    display: { width: number; height: number; sdrWhiteNits: number; maxLuminance: number; bitsPerColor: number } | null;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v.slice(0, 64) : d);

export function parseHdrProbe(raw: unknown): HdrProbe {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const d = (o.display && typeof o.display === 'object' ? o.display : null) as Record<string, unknown> | null;
    return {
        use: o.use === true,
        reason: str(o.reason, 'unknown'),
        hdr: typeof o.hdr === 'boolean' ? o.hdr : null,
        display: d ? {
            width: num(d.width), height: num(d.height), sdrWhiteNits: num(d.sdrWhiteNits),
            maxLuminance: num(d.maxLuminance), bitsPerColor: num(d.bitsPerColor),
        } : null,
    };
}

export interface HdrStartInfo {
    width: number; height: number; srcWidth: number; srcHeight: number;
    hdr: boolean; inputFormat: string; sdrWhiteNits: number; peakNits: number; knee: number;
}

export function parseHdrStart(raw: unknown): { ok: true; session: number; info: HdrStartInfo } | { ok: false; error: string } {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (o.ok !== true) return { ok: false, error: str(o.error, 'start_failed') || 'start_failed' };
    const i = (o.info && typeof o.info === 'object' ? o.info : {}) as Record<string, unknown>;
    const info: HdrStartInfo = {
        width: num(i.width), height: num(i.height), srcWidth: num(i.srcWidth), srcHeight: num(i.srcHeight),
        hdr: i.hdr === true, inputFormat: str(i.inputFormat), sdrWhiteNits: num(i.sdrWhiteNits),
        peakNits: num(i.peakNits), knee: num(i.knee),
    };
    const session = num(o.session, -1);
    if (session < 0 || info.width < 2 || info.height < 2) return { ok: false, error: 'bad_start' };
    return { ok: true, session, info };
}

/**
 * The output size for a display of `src` held inside `box`: aspect kept,
 * never upscaled, even dimensions (4:2:0 encoders). The scaling is free - it
 * happens in the tone-map pass itself.
 */
export function fitOutputSize(src: { width: number; height: number }, box: { width: number; height: number }): { width: number; height: number } {
    const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
    if (!(src.width > 0 && src.height > 0)) return { width: even(box.width), height: even(box.height) };
    const scale = Math.min(1, box.width > 0 ? box.width / src.width : 1, box.height > 0 ? box.height / src.height : 1);
    return { width: even(src.width * scale), height: even(src.height * scale) };
}

/** The preload bridge (window.electronAPI.hdrShare). */
export interface HdrShareApi {
    probe(sourceId: string): Promise<unknown>;
    start(sourceId: string, grantToken: string | undefined, opts: { width: number; height: number; maxFps: number }): Promise<unknown>;
    stop(session?: number): Promise<void>;
    stats(): Promise<unknown>;
    setFrameReceiver(cb: ((frame: VideoFrame, session: number) => void) | null): void;
    onEnded(cb: ((session: number, reason: string) => void) | null): void;
}

interface GeneratorLike extends MediaStreamTrack { writable: WritableStream<VideoFrame> }
type GeneratorCtor = new (init: { kind: 'video' }) => GeneratorLike;

export interface HdrPipelineDeps {
    api: HdrShareApi;
    Generator?: GeneratorCtor;
    /** true when a frame is blank (all black). Default: a 16x16 sample on an OffscreenCanvas. */
    isBlank?: (frame: VideoFrame) => boolean;
    /** How long to wait for the first non-blank frame. */
    firstFrameTimeoutMs?: number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (h: unknown) => void;
    now?: () => number;
}

export interface HdrSharePipeline {
    readonly track: MediaStreamTrack;
    readonly session: number;
    readonly info: HdrStartInfo;
    /** The capture ended on its own (display gone, HDR switched off, main gave up). */
    onSourceEnded(cb: (reason: string) => void): () => void;
    /** Output size and the frame rate delivered over the last second (a generated track reports no settings). */
    captureSettings(): MediaTrackSettings;
    stats(): { written: number; dropped: number };
    /** Stop the capture and the track. Idempotent. */
    stop(): void;
}

export type HdrStartOutcome = { ok: true; pipeline: HdrSharePipeline } | { ok: false; reason: string };

/** Default blank test: any of 256 sampled pixels brighter than code 2. */
export function frameLooksBlank(frame: VideoFrame): boolean {
    try {
        const c = new OffscreenCanvas(16, 16);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        ctx.drawImage(frame, 0, 0, 16, 16);
        const px = ctx.getImageData(0, 0, 16, 16).data;
        for (let i = 0; i < px.length; i += 4) if (px[i] > 2 || px[i + 1] > 2 || px[i + 2] > 2) return false;
        return true;
    } catch {
        return false; // cannot tell: do not block the share on the check itself
    }
}

/** Frames examined for content before the share is declared blank. */
export const BLANK_CHECK_FRAMES = 30;

export async function startHdrSharePipeline(
    sourceId: string,
    grantToken: string | undefined,
    opts: { width: number; height: number; maxFps: number },
    deps: HdrPipelineDeps,
): Promise<HdrStartOutcome> {
    const g = globalThis as unknown as { MediaStreamTrackGenerator?: GeneratorCtor };
    const Generator = deps.Generator ?? g.MediaStreamTrackGenerator;
    if (!Generator) return { ok: false, reason: 'no_generator' };
    const api = deps.api;
    const isBlank = deps.isBlank ?? frameLooksBlank;
    const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

    let generator: GeneratorLike;
    try { generator = new Generator({ kind: 'video' }); } catch { return { ok: false, reason: 'no_generator' }; }
    const writer = generator.writable.getWriter();

    let session: number | null = null;
    let stopped = false;
    let written = 0;
    let dropped = 0;
    let checked = 0;
    let sawContent = false;
    let firstFrame: ((ok: boolean, why: string) => void) | null = null;
    // Arrival times of the last second's frames: the delivered capture rate
    // (a still desktop delivers ~1 fps, not the requested rate).
    const recent: number[] = [];
    const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const prune = (t: number) => { while (recent.length && t - recent[0] > 1000) recent.shift(); };
    const ended = new Set<(reason: string) => void>();

    const teardown = () => {
        if (stopped) return;
        stopped = true;
        api.setFrameReceiver(null);
        api.onEnded(null);
        void api.stop(session ?? undefined).catch(() => { /* main already stopped it */ });
        void writer.close().catch(() => { /* already errored */ });
        try { generator.stop(); } catch { /* already stopped */ }
    };

    api.setFrameReceiver((frame, s) => {
        // A frame from an earlier session, or after stop: just release it.
        if (stopped || (session !== null && s !== session)) { try { frame.close(); } catch { /* closed */ } return; }
        if (!sawContent && checked < BLANK_CHECK_FRAMES) {
            checked++;
            if (!isBlank(frame)) {
                sawContent = true;
                firstFrame?.(true, 'ok');
            } else if (checked >= BLANK_CHECK_FRAMES) {
                firstFrame?.(false, 'blank_frames');
            }
        }
        // The encoder is behind: drop rather than queue (latency over completeness).
        if (writer.desiredSize !== null && writer.desiredSize <= 0) {
            dropped++;
            try { frame.close(); } catch { /* closed */ }
            return;
        }
        written++;
        const t = now();
        recent.push(t);
        prune(t);
        writer.write(frame).catch(() => { /* the track was stopped */ });
    });
    api.onEnded((s, reason) => {
        if (session !== null && s !== session) return;
        firstFrame?.(false, reason || 'ended');
        if (!stopped) {
            teardown();
            for (const cb of [...ended]) { try { cb(reason); } catch { /* isolate */ } }
        }
    });

    let started: ReturnType<typeof parseHdrStart>;
    try {
        started = parseHdrStart(await api.start(sourceId, grantToken, opts));
    } catch (e) {
        started = { ok: false, error: `ipc: ${(e as Error)?.message ?? e}`.slice(0, 64) };
    }
    if (!started.ok) { teardown(); return { ok: false, reason: started.error }; }
    session = started.session;
    const info = started.info;

    const verdict = await new Promise<{ ok: boolean; why: string }>((resolve) => {
        if (sawContent) { resolve({ ok: true, why: 'ok' }); return; }
        if (stopped) { resolve({ ok: false, why: 'ended' }); return; }
        const timer = setT(() => { firstFrame = null; resolve({ ok: false, why: checked > 0 ? 'blank_frames' : 'no_frames' }); }, deps.firstFrameTimeoutMs ?? 3000);
        firstFrame = (ok, why) => { firstFrame = null; clearT(timer); resolve({ ok, why }); };
    });
    if (!verdict.ok) { teardown(); return { ok: false, reason: verdict.why }; }

    return {
        ok: true,
        pipeline: {
            track: generator,
            session,
            info,
            onSourceEnded: (cb) => { ended.add(cb); return () => { ended.delete(cb); }; },
            captureSettings: () => { prune(now()); return { width: info.width, height: info.height, frameRate: recent.length }; },
            stats: () => ({ written, dropped }),
            stop: teardown,
        },
    };
}
