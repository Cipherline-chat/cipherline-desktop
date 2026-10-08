// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import type { FromWorker, ToWorker } from './loadingScreenProtocol';

/**
 * The worker itself, run in-process against a fake WebGL context. These
 * cover what only shows up on the real boot path (found by running the app's
 * own boot → loading → app flow): the App → HydrationGate handoff re-attaches
 * the worker to a NEW canvas and deliberately loses the old context — and
 * that old context's late `webglcontextlost` must not be mistaken for "no
 * WebGL" (it was: every signed-in boot fell back to the static screen right
 * after the handoff).
 */

type Listener = (e: { preventDefault(): void }) => void;
interface FakeCanvas { width: number; height: number; lost: Listener[]; gl: ReturnType<typeof fakeGl>; getContext(): unknown; addEventListener(t: string, f: Listener): void }

function fakeGl(canvas: { lost: Listener[] }) {
    const calls: Array<[string, unknown[]]> = [];
    const special: Record<string, (...a: unknown[]) => unknown> = {
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getParameter: () => new Float32Array([1, 1024]),
        getUniformLocation: (_p, name) => ({ name }),
        getAttribLocation: () => 0,
        // like the real WEBGL_lose_context: the event arrives LATER
        getExtension: () => ({ loseContext: () => { pending.push(() => canvas.lost.forEach(f => f({ preventDefault() {} }))); } }),
    };
    return new Proxy({ calls } as Record<string, unknown>, {
        get(target, prop: string) {
            if (prop in target) return target[prop];
            if (/^[A-Z_]+$/.test(prop)) return 1; // GL enums
            return (...args: unknown[]) => { calls.push([prop, args]); return special[prop]?.(...args) ?? {}; };
        },
    }) as unknown as { calls: Array<[string, unknown[]]> };
}
const pending: Array<() => void> = [];
function canvas(): FakeCanvas {
    const c = { width: 0, height: 0, lost: [] as Listener[] } as unknown as FakeCanvas;
    c.gl = fakeGl(c);
    c.getContext = () => c.gl;
    c.addEventListener = (t: string, f: Listener) => { if (t === 'webglcontextlost') c.lost.push(f); };
    return c;
}

const posted: FromWorker[] = [];
let frames: FrameRequestCallback[] = [];
let ts = 0;
const send = (m: ToWorker | Record<string, unknown>) => (window.onmessage as (e: MessageEvent) => void)({ data: m } as MessageEvent);
const runFrames = (n = 3) => { for (let i = 0; i < n; i++) { ts += 33; frames.splice(0).forEach(cb => cb(ts)); } };
const init = (c: FakeCanvas) => send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr: 1, best: 0, reduced: false });

beforeAll(async () => {
    (window as unknown as { postMessage: (m: FromWorker) => void }).postMessage = (m: FromWorker) => { posted.push(m); };
    window.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; };
    window.cancelAnimationFrame = () => { frames = []; };
    await import('./loadingScreen.worker');
});

describe('loading screen worker', () => {
    it('draws its first frame and says so', () => {
        const c1 = canvas();
        init(c1);
        runFrames();
        expect(posted.map(m => m.type)).toContain('ok');
        // one draw call per frame
        const draws = c1.gl.calls.filter(([n]) => n === 'drawArrays').length;
        const frameCount = c1.gl.calls.filter(([n]) => n === 'clear').length;
        expect(draws).toBe(frameCount);
    });

    it('survives the handoff: the old canvas losing its context later is not "no WebGL"', () => {
        posted.length = 0;
        send({ type: 'pause' });
        const c2 = canvas();
        init(c2); // the handoff: loses the old context on purpose
        pending.splice(0).forEach(f => f()); // ...whose event arrives now
        runFrames();
        expect(posted.map(m => m.type)).not.toContain('nogl');
        expect(posted.map(m => m.type)).toContain('ok');
        expect(c2.gl.calls.some(([n]) => n === 'drawArrays')).toBe(true);
    });

    it('a real loss of the current context does fall back', () => {
        posted.length = 0;
        const c3 = canvas();
        init(c3);
        pending.splice(0).forEach(f => f()); // the previous canvas: ignored
        expect(posted.map(m => m.type)).not.toContain('nogl');
        c3.lost.forEach(f => f({ preventDefault() {} })); // the GPU really dropped it
        expect(posted.map(m => m.type)).toContain('nogl');
    });

    it('draws Keys upright: the tilt is the identity with no pointer', () => {
        const c4 = canvas();
        init(c4);
        runFrames(2);
        const tilt = c4.gl.calls.filter(([n, a]) => n === 'uniformMatrix3fv' && (a[0] as { name: string }).name === 'uTilt').pop();
        expect(tilt).toBeTruthy();
        const m = Array.from(tilt![1][2] as Float32Array);
        // a homography is defined up to scale: normalise, then it is exactly I
        [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(m[i] / m[8]).toBeCloseTo(v, 6));
    });
});
