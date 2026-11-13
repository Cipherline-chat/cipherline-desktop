/**
 * Publish ONE SCREEN of an ultra-wide display at native resolution.
 *
 * A Surround / Eyefinity display is one 7680x1440 "monitor" to the OS, far
 * past what any encoder takes (shareEncoderLimits.ts). Scaling it to fit gives
 * 3840x720 - fine as an overview, useless for watching a game. This module is
 * the other option: capture the whole display (the capturer can do that), then
 * crop each frame to one 2560x1440 screen BEFORE it reaches the encoder.
 *
 *     getDisplayMedia track -> MediaStreamTrackProcessor (decoded VideoFrames)
 *       -> crop (zero-copy `new VideoFrame(frame, { visibleRect })`)
 *       -> MediaStreamTrackGenerator -> the track LiveKit publishes
 *
 * (WebCodecs "breakout box". Chromium-only, which is all Electron is.)
 *
 * To LiveKit the generated track is just another video track: it is published
 * with publishTrack({ source: ScreenShare }), so the room's E2EE sender
 * transform, the sender-codec pin (e2eeSenderCodec.ts - it fires on EVERY local
 * video publication), the Annex-B canonicalisation and H.264 High preference
 * (installH264HighPreference - keyed on the publish source) all apply exactly
 * as for a normal share. Nothing about the frames is ever sent anywhere else.
 *
 * Which screen can be switched live (`setLayout`) - the crop rectangle is
 * re-read for every frame, no re-pick, no republish.
 *
 * The pipe runs in a worker when the streams can be transferred to one (the
 * main thread is the Dashboard's, and 90 fps leaves 11 ms a frame) and on the
 * main thread otherwise. All Chromium globals are injected so the lifecycle is
 * unit tested with fakes (shareCrop.test.ts).
 *
 * ── The worker must say it is alive BEFORE it gets the streams (2026-10-25)
 *
 * The owner's first real Surround share (stable 1.0.23, 7680x1440, DiRT
 * Rally) published a track that never carried a single frame - four starts,
 * every one `share_start_check: failed / stalled` - and the H.264 High
 * watcher blamed the encoder for it. The cause was the worker itself: it was
 * created as `new g.Worker(new URL(...))`, which Vite does not recognise as a
 * worker, so the production bundle shipped the RAW TypeScript source as a
 * `data:video/mp2t;base64,...` asset URL (the .ts extension read as MPEG-TS).
 * Chromium refuses to run it, asynchronously - but `postMessage` had already
 * TRANSFERRED the capture's readable and the generator's writable into the
 * dead worker, so nothing could read the capture or feed the published track,
 * and the main-thread fallback (only reached when postMessage throws) never
 * ran. Dev (Vite serving .ts on the fly) and the unit tests (fake workers)
 * both hid it.
 *
 * Now: the constructor is spelled `new Worker(new URL(...), ...)` so Vite
 * bundles the worker (workerBundling.test.ts pins it for every worker in the
 * app), and the streams stay HERE until the worker posts `{ type: 'ready' }`.
 * A worker that errors first, or is not ready within WORKER_READY_TIMEOUT_MS,
 * is terminated and the crop runs on the main thread with the very same,
 * never-transferred streams. `diag()` says which happened (share_crop event).
 */
import {
    runCropPipe, cropVideoFrame,
    type CropSize, type CropStats, type CropDeps,
} from './shareCropTransform';
import type { ShareLayout } from './shareLayout';

interface ProcessorLike { readable: ReadableStream<VideoFrame> }
interface GeneratorLike extends MediaStreamTrack { writable: WritableStream<VideoFrame> }
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => ProcessorLike;
type GeneratorCtor = new (init: { kind: 'video' }) => GeneratorLike;

/** The slice of Worker this uses - a test supplies a fake. */
export interface CropWorkerLike {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
}

export interface CropPipelineDeps {
    Processor?: ProcessorCtor;
    Generator?: GeneratorCtor;
    /** null/undefined or a throw = no worker: crop on the main thread. */
    createWorker?: (() => CropWorkerLike) | null;
    cropFrame?: CropDeps<VideoFrame>['cropFrame'];
    /** How long a new worker gets to say `ready` before the crop moves to the main thread. */
    readyTimeoutMs?: number;
}

/** A worker that has not said `ready` by then is presumed dead (it never loaded). */
export const WORKER_READY_TIMEOUT_MS = 3_000;

/**
 * Where the crop runs and, when it fell back to the main thread, why:
 *   'starting' - waiting for the worker's `ready`;
 *   'worker' / 'main' - running there.
 * `fallback`: 'no_worker' (none could be created), 'transfer' (the streams
 * could not be handed over), 'worker_error' (it failed to load / threw before
 * ready), 'ready_timeout'. `workerError`: set when a RUNNING worker reported an
 * error (its streams are gone - the share's stall check takes it from there).
 */
export interface CropDiag {
    mode: 'starting' | 'worker' | 'main';
    fallback?: 'no_worker' | 'transfer' | 'worker_error' | 'ready_timeout';
    workerError?: boolean;
}

export interface CropPipeline {
    /** The track to publish. */
    readonly track: MediaStreamTrack;
    /** Where the crop runs right now ('starting' until the worker said it is alive). */
    readonly mode: CropDiag['mode'];
    /** Where the crop runs and, if it fell back to the main thread, why. */
    diag(): CropDiag;
    /** Switch screens (or to the uncropped whole display) from the next frame on. */
    setLayout(layout: ShareLayout): void;
    /** Whole-display and output size, first at the first frame and on every change. Returns the unsubscribe. */
    onSize(cb: (size: CropSize) => void): () => void;
    /** The display capture ended on its own (window closed, display unplugged, system "stop sharing"). */
    onSourceEnded(cb: () => void): () => void;
    /** Latest counters (worker: as of the last 5 s report). */
    stats(): CropStats;
    /** The display capture's own settings (its frame rate is the capturer's negotiated rate). */
    captureSettings(): MediaTrackSettings;
    /**
     * A clone of the display capture itself (the whole display, before the crop), or null
     * when it is gone. It outlives stop(): a share that goes back to the whole display
     * through the Wayland portal keeps the capture it already has instead of asking the
     * desktop for another with nobody there to answer.
     */
    cloneSource(): MediaStreamTrack | null;
    /** Stop cropping and release the display capture. Idempotent. */
    stop(): void;
}

const g = globalThis as unknown as {
    MediaStreamTrackProcessor?: ProcessorCtor;
    MediaStreamTrackGenerator?: GeneratorCtor;
    VideoFrame?: unknown;
    Worker?: new (url: URL, opts?: WorkerOptions) => CropWorkerLike;
};

/** Does this runtime have the breakout-box APIs? (Chromium 94+; always true in Electron.) */
export function supportsCropPipeline(): boolean {
    return typeof g.MediaStreamTrackProcessor === 'function'
        && typeof g.MediaStreamTrackGenerator === 'function'
        && typeof g.VideoFrame === 'function';
}

// Spelled EXACTLY `new Worker(new URL('...', import.meta.url), ...)`: that is
// the only form Vite turns into a bundled worker chunk. Any indirection (an
// aliased constructor, a variable URL) ships the raw .ts as an asset instead -
// which no browser will run (see the header).
const defaultWorker = (): CropWorkerLike => {
    if (typeof g.Worker !== 'function') throw new Error('no Worker');
    return new Worker(
        new URL('../workers/shareCropWorker.ts', import.meta.url),
        { type: 'module', name: 'share-crop' },
    ) as unknown as CropWorkerLike;
};

export function createCropPipeline(
    source: MediaStreamTrack,
    layout: ShareLayout,
    deps: CropPipelineDeps = {},
): CropPipeline {
    const Processor = deps.Processor ?? g.MediaStreamTrackProcessor;
    const Generator = deps.Generator ?? g.MediaStreamTrackGenerator;
    if (!Processor || !Generator) throw new Error('MediaStreamTrackProcessor/Generator are not available');

    const processor = new Processor({ track: source });
    const generator = new Generator({ kind: 'video' });
    // Set before it is published: WebRTC reads the hint when it configures the
    // encoder (a game share wants frame rate over sharpness).
    try { generator.contentHint = 'motion'; } catch { /* hint is advisory */ }

    let current = layout;
    let stopped = false;
    let latestStats: CropStats = { framesIn: 0, framesOut: 0, errors: 0 };
    const sizeListeners = new Set<(s: CropSize) => void>();
    const endedListeners = new Set<() => void>();
    const emitSize = (s: CropSize) => { for (const l of [...sizeListeners]) { try { l(s); } catch { /* isolate */ } } };

    let worker: CropWorkerLike | null = null;
    let mainPipe: { stop(): void; stats: CropStats } | null = null;
    let diag: CropDiag = { mode: 'starting' };
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    const runOnMain = (fallback: NonNullable<CropDiag['fallback']>) => {
        if (stopped || mainPipe) return;
        diag = { mode: 'main', fallback };
        mainPipe = runCropPipe<VideoFrame>(processor.readable, generator.writable, {
            getLayout: () => current,
            cropFrame: deps.cropFrame ?? cropVideoFrame,
            onSize: emitSize,
        });
    };
    const abandonWorker = (w: CropWorkerLike, fallback: NonNullable<CropDiag['fallback']>, err?: unknown) => {
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        w.onmessage = null;
        w.onerror = null;
        try { w.terminate(); } catch { /* gone */ }
        if (worker === w) worker = null;
        if (candidate === w) candidate = null;
        console.warn(`[ShareCrop] worker unusable (${fallback}), cropping on the main thread`, err ?? '');
        runOnMain(fallback);
    };

    const makeWorker = deps.createWorker === undefined ? defaultWorker : deps.createWorker;
    let candidate: CropWorkerLike | null = null;
    if (makeWorker) {
        try { candidate = makeWorker(); } catch (err) {
            console.warn('[ShareCrop] no worker, cropping on the main thread:', err);
        }
    }
    if (!candidate) {
        runOnMain('no_worker');
    } else {
        const w = candidate;
        let ready = false;
        w.onmessage = (e: MessageEvent) => {
            const m = e.data as Record<string, unknown> | null;
            if (!m || typeof m.type !== 'string') return;
            if (m.type === 'ready') {
                if (ready || stopped) return;
                ready = true;
                if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
                try {
                    w.postMessage(
                        { type: 'start', readable: processor.readable, writable: generator.writable, layout: current },
                        [processor.readable, generator.writable] as unknown as Transferable[],
                    );
                    worker = w;
                    diag = { mode: 'worker' };
                } catch (err) {
                    // Streams not transferable here (or the worker is dead):
                    // nothing was transferred (the clone is atomic), so the
                    // main-thread pipe can still use them.
                    abandonWorker(w, 'transfer', err);
                }
            } else if (m.type === 'size') {
                const n = (k: string) => (typeof m[k] === 'number' ? m[k] as number : 0);
                emitSize({ sourceWidth: n('sourceWidth'), sourceHeight: n('sourceHeight'), outWidth: n('outWidth'), outHeight: n('outHeight') });
            } else if (m.type === 'stats') {
                const n = (k: string) => (typeof m[k] === 'number' ? m[k] as number : 0);
                latestStats = { framesIn: n('framesIn'), framesOut: n('framesOut'), errors: n('errors') };
            }
        };
        w.onerror = (e) => {
            if (!ready) { abandonWorker(w, 'worker_error', e?.message); return; }
            // Running with our streams: they cannot be taken back. Say so; the
            // share's frame check sees the track go quiet and acts on it.
            diag = { ...diag, workerError: true };
            console.warn('[ShareCrop] worker error:', e?.message);
        };
        candidate = w;
        readyTimer = setTimeout(() => {
            readyTimer = null;
            if (!ready && !stopped) abandonWorker(w, 'ready_timeout');
        }, deps.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS);
    }

    const onEnded = () => {
        if (stopped) return;
        for (const l of [...endedListeners]) { try { l(); } catch { /* isolate */ } }
    };
    source.addEventListener('ended', onEnded);

    return {
        track: generator,
        get mode() { return diag.mode; },
        diag() { return { ...diag }; },
        setLayout(next) {
            if (stopped) return;
            current = next;
            worker?.postMessage({ type: 'layout', layout: next });
        },
        onSize(cb) { sizeListeners.add(cb); return () => { sizeListeners.delete(cb); }; },
        onSourceEnded(cb) { endedListeners.add(cb); return () => { endedListeners.delete(cb); }; },
        stats() { return mainPipe ? { ...mainPipe.stats } : { ...latestStats }; },
        captureSettings() { try { return source.getSettings(); } catch { return {}; } },
        cloneSource() {
            if (stopped || source.readyState !== 'live') return null;
            try { return source.clone(); } catch { return null; }
        },
        stop() {
            if (stopped) return;
            stopped = true;
            if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
            source.removeEventListener('ended', onEnded);
            sizeListeners.clear();
            endedListeners.clear();
            // A worker that never became ready still has to go.
            const w0 = worker ?? candidate;
            if (w0) {
                const w = w0;
                try { w.postMessage({ type: 'stop' }); } catch { /* already dead */ }
                // The worker closes itself on 'stop'; terminate after it had the
                // chance, in case it is wedged.
                setTimeout(() => { try { w.terminate(); } catch { /* gone */ } }, 500);
            }
            mainPipe?.stop();
            // Release the display capture (OS "sharing" indicator, capture CPU).
            try { source.stop(); } catch { /* ended */ }
        },
    };
}
