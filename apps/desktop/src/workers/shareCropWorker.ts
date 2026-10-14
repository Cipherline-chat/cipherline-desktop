/**
 * Crop worker for ultra-wide screen shares (utils/shareCrop.ts).
 *
 * The page hands over the two ends of a pipe through transferable streams -
 * a MediaStreamTrackProcessor's `readable` (decoded VideoFrames of the whole
 * display) and a MediaStreamTrackGenerator's `writable` (the track that gets
 * published) - and this worker sits between them, cropping each frame to the
 * chosen screen (utils/shareCropTransform.ts). Keeping it off the main thread
 * is the point: the Dashboard can block the renderer for tens of ms at a time,
 * which at 90 fps (11 ms a frame) would otherwise be dropped frames.
 *
 * Protocol (every message is plain data except the two streams):
 *   page -> worker  { type: 'start', readable, writable, layout }  (streams transferred)
 *                   { type: 'layout', layout }                      (switch screens live)
 *                   { type: 'stop' }
 *   worker -> page  { type: 'size', sourceWidth, sourceHeight, outWidth, outHeight }
 *                   { type: 'stats', framesIn, framesOut, errors }  (every 5 s and at stop)
 *                   { type: 'ended' }                               (the pipe finished)
 * An untrusted `layout` is re-validated here (parseLayout) - a bad one is ignored.
 */
import { runCropPipe, cropVideoFrame, type CropStats } from '../utils/shareCropTransform';
import { parseLayout, WHOLE_LAYOUT, type ShareLayout } from '../utils/shareLayout';

interface WorkerScope {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
}
const scope = self as unknown as WorkerScope;

let layout: ShareLayout = WHOLE_LAYOUT;
let pipe: { stop(): void; stats: CropStats } | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

const postStats = () => {
    if (pipe) scope.postMessage({ type: 'stats', ...pipe.stats });
};

scope.onmessage = (e: MessageEvent) => {
    const m = e.data as { type?: unknown; readable?: unknown; writable?: unknown; layout?: unknown } | null;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'layout') {
        const next = parseLayout(m.layout);
        if (next) layout = next;
        return;
    }
    if (m.type === 'stop') {
        postStats();
        pipe?.stop();
        pipe = null;
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        scope.close();
        return;
    }
    if (m.type === 'start' && !pipe) {
        const next = parseLayout(m.layout);
        if (next) layout = next;
        const p = runCropPipe<VideoFrame>(
            m.readable as ReadableStream<VideoFrame>,
            m.writable as WritableStream<VideoFrame>,
            {
                getLayout: () => layout,
                cropFrame: cropVideoFrame,
                onSize: size => scope.postMessage({ type: 'size', ...size }),
            },
        );
        pipe = p;
        statsTimer = setInterval(postStats, 5000);
        void p.done.then(() => {
            postStats();
            scope.postMessage({ type: 'ended' });
        });
    }
};
