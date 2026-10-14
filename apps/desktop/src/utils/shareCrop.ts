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
}

export interface CropPipeline {
    /** The track to publish. */
    readonly track: MediaStreamTrack;
    /** Where the crop runs. */
    readonly mode: 'worker' | 'main';
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

const defaultWorker = (): CropWorkerLike => {
    if (typeof g.Worker !== 'function') throw new Error('no Worker');
    return new g.Worker(new URL('../workers/shareCropWorker.ts', import.meta.url), { type: 'module', name: 'share-crop' });
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

    const makeWorker = deps.createWorker === undefined ? defaultWorker : deps.createWorker;
    if (makeWorker) {
        try {
            const w = makeWorker();
            try {
                w.postMessage(
                    { type: 'start', readable: processor.readable, writable: generator.writable, layout },
                    [processor.readable, generator.writable] as unknown as Transferable[],
                );
                worker = w;
            } catch (err) {
                // Streams not transferable here (or the worker is dead): nothing
                // was transferred (the clone is atomic), so the main-thread pipe
                // can still use them.
                console.warn('[ShareCrop] cannot hand the streams to a worker, cropping on the main thread:', err);
                try { w.terminate(); } catch { /* gone */ }
            }
        } catch (err) {
            console.warn('[ShareCrop] no worker, cropping on the main thread:', err);
        }
    }
    if (worker) {
        worker.onmessage = (e: MessageEvent) => {
            const m = e.data as Record<string, unknown> | null;
            if (!m || typeof m.type !== 'string') return;
            if (m.type === 'size') {
                const n = (k: string) => (typeof m[k] === 'number' ? m[k] as number : 0);
                emitSize({ sourceWidth: n('sourceWidth'), sourceHeight: n('sourceHeight'), outWidth: n('outWidth'), outHeight: n('outHeight') });
            } else if (m.type === 'stats') {
                const n = (k: string) => (typeof m[k] === 'number' ? m[k] as number : 0);
                latestStats = { framesIn: n('framesIn'), framesOut: n('framesOut'), errors: n('errors') };
            }
        };
        worker.onerror = (e) => console.warn('[ShareCrop] worker error:', e?.message);
    } else {
        mainPipe = runCropPipe<VideoFrame>(processor.readable, generator.writable, {
            getLayout: () => current,
            cropFrame: deps.cropFrame ?? cropVideoFrame,
            onSize: emitSize,
        });
    }

    const onEnded = () => {
        if (stopped) return;
        for (const l of [...endedListeners]) { try { l(); } catch { /* isolate */ } }
    };
    source.addEventListener('ended', onEnded);

    return {
        track: generator,
        mode: worker ? 'worker' : 'main',
        setLayout(next) {
            if (stopped) return;
            current = next;
            worker?.postMessage({ type: 'layout', layout: next });
        },
        onSize(cb) { sizeListeners.add(cb); return () => { sizeListeners.delete(cb); }; },
        onSourceEnded(cb) { endedListeners.add(cb); return () => { endedListeners.delete(cb); }; },
        stats() { return mainPipe ? { ...mainPipe.stats } : { ...latestStats }; },
        captureSettings() { try { return source.getSettings(); } catch { return {}; } },
        stop() {
            if (stopped) return;
            stopped = true;
            source.removeEventListener('ended', onEnded);
            sizeListeners.clear();
            endedListeners.clear();
            if (worker) {
                const w = worker;
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
