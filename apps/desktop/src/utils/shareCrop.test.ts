import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createCropTransformer, runCropPipe, cropVideoFrame, type CropFrame, type CropSize,
} from './shareCropTransform';
import { createCropPipeline, supportsCropPipeline, type CropWorkerLike } from './shareCrop';
import type { CropRect, ShareLayout } from './shareLayout';
import { codecPinMessage } from './e2eeSenderCodec';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A VideoFrame stand-in that counts how it is closed. */
class FakeFrame implements CropFrame {
    static live = new Set<FakeFrame>();
    closed = 0;
    codedWidth: number;
    codedHeight: number;
    visibleRect: { x: number; y: number; width: number; height: number } | null;
    parent: FakeFrame | null;
    rect: CropRect | null;
    constructor(
        codedWidth: number,
        codedHeight: number,
        visibleRect: { x: number; y: number; width: number; height: number } | null = null,
        parent: FakeFrame | null = null,
        rect: CropRect | null = null,
    ) {
        this.codedWidth = codedWidth;
        this.codedHeight = codedHeight;
        this.visibleRect = visibleRect;
        this.parent = parent;
        this.rect = rect;
        FakeFrame.live.add(this);
    }
    close() { this.closed++; FakeFrame.live.delete(this); }
}

const crop = (f: FakeFrame, rect: CropRect) => new FakeFrame(rect.width, rect.height, null, f, rect);
const SLICE = (index: number, count = 3): ShareLayout => ({ kind: 'slice', count, index });
const WHOLE: ShareLayout = { kind: 'whole' };

function collector<F>() {
    const out: F[] = [];
    const ctrl = { enqueue: (f: F) => { out.push(f); }, error: () => {}, terminate: () => {}, desiredSize: 1 } as unknown as TransformStreamDefaultController<F>;
    return { out, ctrl };
}

afterEach(() => { FakeFrame.live.clear(); vi.useRealTimers(); });

// ── The per-frame transform ─────────────────────────────────────────────────

describe('createCropTransformer', () => {
    it('crops 7680x1440 to the chosen screen: rect per slice, input closed, output left open for its new owner', () => {
        const rects: CropRect[] = [];
        let layout: ShareLayout = SLICE(0);
        const t = createCropTransformer<FakeFrame>({ getLayout: () => layout, cropFrame: (f, r) => { rects.push(r); return crop(f, r); } });
        const { out, ctrl } = collector<FakeFrame>();
        const inputs: FakeFrame[] = [];
        for (let i = 0; i < 3; i++) {
            layout = SLICE(i);
            const f = new FakeFrame(7680, 1440);
            inputs.push(f);
            t.transform!(f, ctrl);
        }
        expect(rects).toEqual([
            { x: 0, y: 0, width: 2560, height: 1440 },
            { x: 2560, y: 0, width: 2560, height: 1440 },
            { x: 5120, y: 0, width: 2560, height: 1440 },
        ]);
        expect(out.map(o => [o.codedWidth, o.codedHeight])).toEqual([[2560, 1440], [2560, 1440], [2560, 1440]]);
        expect(inputs.every(f => f.closed === 1)).toBe(true);   // closed exactly once
        expect(out.every(o => o.closed === 0)).toBe(true);       // the downstream owner closes these
        expect(t.stats).toEqual({ framesIn: 3, framesOut: 3, errors: 0 });
    });

    it('switches screens live: the very next frame uses the new rect', () => {
        const rects: CropRect[] = [];
        let layout: ShareLayout = SLICE(1);
        const t = createCropTransformer<FakeFrame>({ getLayout: () => layout, cropFrame: (f, r) => { rects.push(r); return crop(f, r); } });
        const { ctrl } = collector<FakeFrame>();
        t.transform!(new FakeFrame(7680, 1440), ctrl);
        layout = SLICE(2);
        t.transform!(new FakeFrame(7680, 1440), ctrl);
        layout = SLICE(0);
        t.transform!(new FakeFrame(7680, 1440), ctrl);
        expect(rects.map(r => r.x)).toEqual([2560, 5120, 0]);
    });

    it('the whole-display layout passes the frame through UNclosed (its next owner closes it) and uncropped', () => {
        const cropFrame = vi.fn(crop);
        const t = createCropTransformer<FakeFrame>({ getLayout: () => WHOLE, cropFrame });
        const { out, ctrl } = collector<FakeFrame>();
        const f = new FakeFrame(7680, 1440);
        t.transform!(f, ctrl);
        expect(out).toEqual([f]);
        expect(f.closed).toBe(0);
        expect(cropFrame).not.toHaveBeenCalled();
    });

    it('honours a frame whose visible area is offset inside the coded area', () => {
        const rects: CropRect[] = [];
        const t = createCropTransformer<FakeFrame>({ getLayout: () => SLICE(1), cropFrame: (f, r) => { rects.push(r); return crop(f, r); } });
        const { ctrl } = collector<FakeFrame>();
        t.transform!(new FakeFrame(8000, 1600, { x: 100, y: 20, width: 7680, height: 1440 }), ctrl);
        expect(rects).toEqual([{ x: 100 + 2560, y: 20, width: 2560, height: 1440 }]);
    });

    it('a crop that throws drops THAT frame, closes it, and keeps going', () => {
        let n = 0;
        const t = createCropTransformer<FakeFrame>({
            getLayout: () => SLICE(0),
            cropFrame: (f, r) => { if (++n === 2) throw new Error('boom'); return crop(f, r); },
        });
        const { out, ctrl } = collector<FakeFrame>();
        const frames = [1, 2, 3].map(() => new FakeFrame(7680, 1440));
        for (const f of frames) t.transform!(f, ctrl);
        expect(out).toHaveLength(2);
        expect(frames.every(f => f.closed === 1)).toBe(true);
        expect(t.stats).toEqual({ framesIn: 3, framesOut: 2, errors: 1 });
    });

    it('an enqueue that throws (cancelled stream) closes BOTH the cropped frame and the input - no leak', () => {
        const t = createCropTransformer<FakeFrame>({ getLayout: () => SLICE(0), cropFrame: crop });
        const made: FakeFrame[] = [];
        const ctrl = { enqueue: (f: FakeFrame) => { made.push(f); throw new Error('stream cancelled'); } } as unknown as TransformStreamDefaultController<FakeFrame>;
        const input = new FakeFrame(7680, 1440);
        t.transform!(input, ctrl);
        expect(input.closed).toBe(1);
        expect(made).toHaveLength(1);
        expect(made[0].closed).toBe(1);
        expect(FakeFrame.live.size).toBe(0);
    });

    it('a layout read that throws is a dropped, closed frame, not a crash', () => {
        const t = createCropTransformer<FakeFrame>({ getLayout: () => { throw new Error('x'); }, cropFrame: crop });
        const { out, ctrl } = collector<FakeFrame>();
        const f = new FakeFrame(7680, 1440);
        expect(() => t.transform!(f, ctrl)).not.toThrow();
        expect(out).toHaveLength(0);
        expect(f.closed).toBe(1);
    });

    it('reports sizes on the first frame and only when they change', () => {
        const sizes: CropSize[] = [];
        let layout: ShareLayout = SLICE(0);
        const t = createCropTransformer<FakeFrame>({ getLayout: () => layout, cropFrame: crop, onSize: s => sizes.push(s) });
        const { ctrl } = collector<FakeFrame>();
        for (let i = 0; i < 5; i++) t.transform!(new FakeFrame(7680, 1440), ctrl);
        expect(sizes).toEqual([{ sourceWidth: 7680, sourceHeight: 1440, outWidth: 2560, outHeight: 1440 }]);
        layout = WHOLE;
        t.transform!(new FakeFrame(7680, 1440), ctrl);
        expect(sizes[1]).toEqual({ sourceWidth: 7680, sourceHeight: 1440, outWidth: 7680, outHeight: 1440 });
        t.transform!(new FakeFrame(5120, 1440), ctrl); // display mode changed
        expect(sizes).toHaveLength(3);
    });

    it('a throwing size listener never costs a frame', () => {
        const t = createCropTransformer<FakeFrame>({ getLayout: () => SLICE(0), cropFrame: crop, onSize: () => { throw new Error('listener'); } });
        const { out, ctrl } = collector<FakeFrame>();
        t.transform!(new FakeFrame(7680, 1440), ctrl);
        expect(out).toHaveLength(1);
    });
});

describe('cropVideoFrame (the zero-copy default)', () => {
    it('builds new VideoFrame(frame, { visibleRect, displayWidth, displayHeight }) - no pixel copy', () => {
        const calls: Array<{ src: unknown; init: Record<string, unknown> }> = [];
        class FakeVideoFrame { constructor(src: unknown, init: Record<string, unknown>) { calls.push({ src, init }); } }
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        try {
            const src = {} as VideoFrame;
            cropVideoFrame(src, { x: 2560, y: 0, width: 2560, height: 1440 });
            expect(calls).toEqual([{ src, init: {
                visibleRect: { x: 2560, y: 0, width: 2560, height: 1440 }, displayWidth: 2560, displayHeight: 1440,
            } }]);
        } finally { vi.unstubAllGlobals(); }
    });
});

// ── A real stream pipe at 90 fps ────────────────────────────────────────────

describe('runCropPipe over real streams', () => {
    it('600 frames (a 90 fps burst): every input closed exactly once, every output delivered, nothing left open but the outputs', async () => {
        const inputs: FakeFrame[] = [];
        const readable = new ReadableStream<FakeFrame>({
            start(c) {
                for (let i = 0; i < 600; i++) { const f = new FakeFrame(7680, 1440); inputs.push(f); c.enqueue(f); }
                c.close();
            },
        });
        const sink: FakeFrame[] = [];
        const writable = new WritableStream<FakeFrame>({ write(f) { sink.push(f); } });
        const layout: ShareLayout = SLICE(1);
        const pipe = runCropPipe(readable, writable, { getLayout: () => layout, cropFrame: crop });
        await pipe.done;
        expect(sink).toHaveLength(600);
        expect(inputs.every(f => f.closed === 1)).toBe(true);
        expect(sink.every(f => f.rect!.x === 2560 && f.rect!.width === 2560 && f.parent !== null)).toBe(true);
        expect(pipe.stats.framesIn).toBe(600);
        expect(pipe.stats.framesOut).toBe(600);
        // the only frames still open are the 600 outputs (their owner closes them)
        expect(FakeFrame.live.size).toBe(600);
        sink.forEach(f => f.close());
        expect(FakeFrame.live.size).toBe(0);
    });

    it('a layout switch in the middle of a stream takes effect on the next frame', async () => {
        let layout: ShareLayout = SLICE(0);
        let n = 0;
        const readable = new ReadableStream<FakeFrame>({
            pull(c) {
                if (n >= 20) { c.close(); return; }
                if (n === 10) layout = SLICE(2);
                n++;
                c.enqueue(new FakeFrame(7680, 1440));
            },
        });
        const sink: FakeFrame[] = [];
        const pipe = runCropPipe(readable, new WritableStream<FakeFrame>({ write(f) { sink.push(f); } }), { getLayout: () => layout, cropFrame: crop });
        await pipe.done;
        const xs = sink.map(f => f.rect!.x);
        expect(xs).toHaveLength(20);
        expect(new Set(xs)).toEqual(new Set([0, 5120]));
        expect(xs[0]).toBe(0);
        expect(xs[19]).toBe(5120);
        expect(xs.findIndex(x => x === 5120)).toBeGreaterThan(0);
        // monotone: it switched once and stayed
        expect(xs.slice(xs.indexOf(5120)).every(x => x === 5120)).toBe(true);
    });

    it('stop() ends the pipe and its promise resolves', async () => {
        let pushed = 0;
        const readable = new ReadableStream<FakeFrame>({
            async pull(c) { await new Promise(r => setTimeout(r, 2)); pushed++; c.enqueue(new FakeFrame(7680, 1440)); },
        });
        const pipe = runCropPipe(readable, new WritableStream<FakeFrame>({ write() {} }), { getLayout: () => SLICE(0), cropFrame: crop });
        await new Promise(r => setTimeout(r, 30));
        pipe.stop();
        await pipe.done;
        const after = pushed;
        await new Promise(r => setTimeout(r, 30));
        expect(pushed).toBeLessThanOrEqual(after + 1); // the source stops being pulled
    });
});

// ── The pipeline object (processor + generator + worker) ───────────────────

function fakeTrack() {
    const listeners = new Map<string, Set<() => void>>();
    const t = {
        id: 'src-1', kind: 'video', readyState: 'live', contentHint: '',
        stop: vi.fn(() => { t.readyState = 'ended'; }),
        getSettings: () => ({ width: 7680, height: 1440, frameRate: 90 }),
        addEventListener: (n: string, cb: () => void) => { (listeners.get(n) ?? listeners.set(n, new Set()).get(n)!).add(cb); },
        removeEventListener: (n: string, cb: () => void) => { listeners.get(n)?.delete(cb); },
        fire: (n: string) => { for (const cb of [...(listeners.get(n) ?? [])]) cb(); },
        listenerCount: (n: string) => listeners.get(n)?.size ?? 0,
    };
    return t;
}

function fakeBreakoutBox(frames: FakeFrame[]) {
    const processorReadable = new ReadableStream<FakeFrame>({
        start(c) { for (const f of frames) c.enqueue(f); /* stays open: a live capture */ },
    });
    const sink: FakeFrame[] = [];
    const generatorWritable = new WritableStream<FakeFrame>({ write(f) { sink.push(f); } });
    class Processor { readable = processorReadable; }
    class Generator {
        writable = generatorWritable; contentHint = ''; kind = 'video'; id = 'gen-1';
        stop = vi.fn(); clone = vi.fn(); addEventListener = vi.fn(); removeEventListener = vi.fn(); getSettings = () => ({});
    }
    return { Processor, Generator, sink, processorReadable, generatorWritable };
}

describe('createCropPipeline - main-thread mode', () => {
    it('wires the source through the crop into the generator track and reports its mode', async () => {
        const frames = [new FakeFrame(7680, 1440), new FakeFrame(7680, 1440)];
        const bb = fakeBreakoutBox(frames);
        const src = fakeTrack();
        const pipe = createCropPipeline(src as unknown as MediaStreamTrack, SLICE(1), {
            Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: null,
            cropFrame: crop as never,
        });
        expect(pipe.mode).toBe('main');
        expect((pipe.track as unknown as { contentHint: string }).contentHint).toBe('motion');
        expect(pipe.track).toBeInstanceOf(bb.Generator);
        await new Promise(r => setTimeout(r, 20));
        expect(bb.sink.map(f => f.rect!.x)).toEqual([2560, 2560]);
        expect(frames.every(f => f.closed === 1)).toBe(true);
        pipe.stop();
    });

    it('setLayout re-points the crop for the next frames', async () => {
        let push: (f: FakeFrame) => void = () => {};
        const readable = new ReadableStream<FakeFrame>({ start(c) { push = f => c.enqueue(f); } });
        const sink: FakeFrame[] = [];
        class Processor { readable = readable; }
        class Generator { writable = new WritableStream<FakeFrame>({ write(f) { sink.push(f); } }); contentHint = ''; }
        const pipe = createCropPipeline(fakeTrack() as never, SLICE(0), { Processor: Processor as never, Generator: Generator as never, createWorker: null, cropFrame: crop as never });
        push(new FakeFrame(7680, 1440));
        await new Promise(r => setTimeout(r, 10));
        pipe.setLayout(SLICE(2));
        push(new FakeFrame(7680, 1440));
        await new Promise(r => setTimeout(r, 10));
        pipe.setLayout({ kind: 'whole' });
        push(new FakeFrame(7680, 1440));
        await new Promise(r => setTimeout(r, 10));
        expect(sink.map(f => f.codedWidth)).toEqual([2560, 2560, 7680]);
        expect(sink.slice(0, 2).map(f => f.rect!.x)).toEqual([0, 5120]);
        pipe.stop();
    });

    it('reports sizes, notices the display going away, and stop() releases the capture exactly once', async () => {
        const bb = fakeBreakoutBox([new FakeFrame(7680, 1440)]);
        const src = fakeTrack();
        const pipe = createCropPipeline(src as never, SLICE(1), { Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: null, cropFrame: crop as never });
        const sizes: CropSize[] = [];
        const ended = vi.fn();
        pipe.onSize(s => sizes.push(s));
        pipe.onSourceEnded(ended);
        await new Promise(r => setTimeout(r, 20));
        expect(sizes).toEqual([{ sourceWidth: 7680, sourceHeight: 1440, outWidth: 2560, outHeight: 1440 }]);
        src.fire('ended');
        expect(ended).toHaveBeenCalledTimes(1);
        pipe.stop();
        pipe.stop();
        expect(src.stop).toHaveBeenCalledTimes(1);
        expect(src.listenerCount('ended')).toBe(0);
        // after stop a late 'ended' is ignored
        src.fire('ended');
        expect(ended).toHaveBeenCalledTimes(1);
        expect(pipe.captureSettings()).toEqual({ width: 7680, height: 1440, frameRate: 90 });
    });

    it('throws a clear error when the breakout-box APIs are missing', () => {
        expect(() => createCropPipeline(fakeTrack() as never, SLICE(0), { createWorker: null })).toThrow(/MediaStreamTrackProcessor/);
    });

    it('supportsCropPipeline reflects the globals', () => {
        expect(supportsCropPipeline()).toBe(false); // node: none of them exist
        vi.stubGlobal('MediaStreamTrackProcessor', class {});
        vi.stubGlobal('MediaStreamTrackGenerator', class {});
        vi.stubGlobal('VideoFrame', class {});
        try { expect(supportsCropPipeline()).toBe(true); } finally { vi.unstubAllGlobals(); }
    });
});

describe('createCropPipeline - worker mode', () => {
    function fakeWorker(opts: { throwOnStart?: boolean } = {}) {
        const posted: Array<{ msg: Record<string, unknown>; transfer?: unknown[] }> = [];
        const w: CropWorkerLike & { terminated: number } = {
            terminated: 0,
            postMessage(msg, transfer) {
                if (opts.throwOnStart && (msg as { type: string }).type === 'start') throw new Error('DataCloneError');
                posted.push({ msg: msg as Record<string, unknown>, transfer: transfer as unknown[] });
            },
            terminate() { w.terminated++; },
            onmessage: null, onerror: null,
        };
        return { w, posted };
    }

    it('transfers the processor\'s readable and the generator\'s writable to the worker and starts it on the chosen screen', () => {
        const bb = fakeBreakoutBox([]);
        const { w, posted } = fakeWorker();
        const pipe = createCropPipeline(fakeTrack() as never, SLICE(1), { Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: () => w });
        expect(pipe.mode).toBe('worker');
        expect(posted).toHaveLength(1);
        expect(posted[0].msg.type).toBe('start');
        expect(posted[0].msg.readable).toBe(bb.processorReadable);
        expect(posted[0].msg.writable).toBe(bb.generatorWritable);
        expect(posted[0].msg.layout).toEqual(SLICE(1));
        expect(posted[0].transfer).toEqual([bb.processorReadable, bb.generatorWritable]);
    });

    it('setLayout posts the new layout (no republish, no new worker)', () => {
        const bb = fakeBreakoutBox([]);
        const { w, posted } = fakeWorker();
        const pipe = createCropPipeline(fakeTrack() as never, SLICE(0), { Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: () => w });
        pipe.setLayout(SLICE(2));
        pipe.setLayout({ kind: 'whole' });
        expect(posted.slice(1).map(p => p.msg)).toEqual([
            { type: 'layout', layout: SLICE(2) },
            { type: 'layout', layout: { kind: 'whole' } },
        ]);
    });

    it('relays size and stats reports from the worker', () => {
        const bb = fakeBreakoutBox([]);
        const { w } = fakeWorker();
        const pipe = createCropPipeline(fakeTrack() as never, SLICE(0), { Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: () => w });
        const sizes: CropSize[] = [];
        pipe.onSize(s => sizes.push(s));
        w.onmessage!({ data: { type: 'size', sourceWidth: 7680, sourceHeight: 1440, outWidth: 2560, outHeight: 1440 } } as MessageEvent);
        w.onmessage!({ data: { type: 'stats', framesIn: 900, framesOut: 899, errors: 1 } } as MessageEvent);
        w.onmessage!({ data: 'garbage' } as MessageEvent);
        w.onmessage!({ data: { type: 'size', sourceWidth: 'x' } } as MessageEvent);
        expect(sizes[0]).toEqual({ sourceWidth: 7680, sourceHeight: 1440, outWidth: 2560, outHeight: 1440 });
        expect(pipe.stats()).toEqual({ framesIn: 900, framesOut: 899, errors: 1 });
    });

    it('stop() tells the worker, then terminates it, and stops the capture', () => {
        vi.useFakeTimers();
        const bb = fakeBreakoutBox([]);
        const { w, posted } = fakeWorker();
        const src = fakeTrack();
        const pipe = createCropPipeline(src as never, SLICE(0), { Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: () => w });
        pipe.stop();
        expect(posted[posted.length - 1].msg).toEqual({ type: 'stop' });
        expect(src.stop).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(600);
        expect(w.terminated).toBe(1);
        pipe.stop();
        expect(w.terminated).toBe(1);
        pipe.setLayout(SLICE(1)); // ignored after stop
        expect(posted.filter(p => p.msg.type === 'layout')).toHaveLength(0);
    });

    it('falls back to the main thread when the streams cannot be transferred, using the SAME streams', async () => {
        const frames = [new FakeFrame(7680, 1440)];
        const bb = fakeBreakoutBox(frames);
        const { w } = fakeWorker({ throwOnStart: true });
        const pipe = createCropPipeline(fakeTrack() as never, SLICE(2), {
            Processor: bb.Processor as never, Generator: bb.Generator as never, createWorker: () => w, cropFrame: crop as never,
        });
        expect(pipe.mode).toBe('main');
        expect(w.terminated).toBe(1);
        await new Promise(r => setTimeout(r, 20));
        expect(bb.sink.map(f => f.rect!.x)).toEqual([5120]);
        pipe.stop();
    });

    it('falls back to the main thread when no worker can be created', () => {
        const bb = fakeBreakoutBox([]);
        const pipe = createCropPipeline(fakeTrack() as never, SLICE(0), {
            Processor: bb.Processor as never, Generator: bb.Generator as never,
            createWorker: () => { throw new Error('worker-src blocked'); },
        });
        expect(pipe.mode).toBe('main');
        pipe.stop();
    });
});

describe('the cropped track is just another video track to the E2EE sender-codec pin', () => {
    it('a generated track publishes a codec pin keyed on its own id, like any capture', () => {
        const msg = codecPinMessage({ kind: 'video', track: { kind: 'video', mediaStreamID: 'generated-track-id', codec: 'h264' } }, 'me');
        expect(msg).toEqual({ kind: 'updateCodec', data: { trackId: 'generated-track-id', codec: 'h264', participantIdentity: 'me' } });
    });
});
