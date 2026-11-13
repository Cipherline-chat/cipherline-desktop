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

/** A pillar's dots (WALL_DOTS in the worker): how its draws are told apart from the body's 12 vertices. */
const WALL_DOTS = 360;
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

/**
 * Lock mode: the same dot-field scene as the loading screen, with Keys and the
 * loading bar structurally absent. The bar is hidden by `uBarA.x` (its alpha)
 * and Keys by `uKeys.w`; both must be exactly 0 on every frame in lock mode,
 * even when the worker is sent the messages that would turn them on. The boot
 * mode cases are the negative controls: the same probes DO see the bar and
 * Keys there, so a 0 means "hidden", not "probe broken".
 */
describe('loading screen worker — lock mode (dots only)', () => {
    type Call = [string, unknown[]];
    const last = (c: FakeCanvas, fn: string, name: string): number[] | undefined => {
        const hit = (c.gl.calls as Call[]).filter(([n, a]) => n === fn && (a[0] as { name?: string })?.name === name).pop();
        return hit ? (hit[1].slice(1) as number[]) : undefined;
    };
    const initMode = (c: FakeCanvas, mode?: 'lock' | 'boot', reduced = false) =>
        send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr: 1, best: 0, reduced, ...(mode ? { mode } : {}) });
    const barOn = () => { send({ type: 'bar', x: 0, y: -57, w: 180 }); send({ type: 'progress', floor: 0.2, ceil: 0.6, done: false }); };

    it('negative control (boot mode): the probes see Keys and the bar', () => {
        const c = canvas();
        initMode(c);
        barOn();
        runFrames(4);
        expect(last(c, 'uniform4f', 'uKeys')![3]).toBeGreaterThan(0.5);
        expect(last(c, 'uniform2f', 'uBarA')![0]).toBeGreaterThan(0.5);
        expect(last(c, 'uniform4f', 'uBar')![2]).toBe(180);
    });

    it('lock mode draws neither Keys nor the bar from the very first frame', () => {
        const c = canvas();
        initMode(c, 'lock');
        runFrames(1);
        expect(last(c, 'uniform4f', 'uKeys')![3]).toBe(0);
        expect(last(c, 'uniform2f', 'uBarA')![0]).toBe(0);
        expect(c.gl.calls.some(([n]) => n === 'drawArrays')).toBe(true); // ...but the field is drawn
    });

    it('lock mode ignores bar / progress / keys / act / quit / exit, however it is driven', () => {
        const c = canvas();
        initMode(c, 'lock');
        barOn();
        send({ type: 'keys', visible: true });
        send({ type: 'act' });
        send({ type: 'quit' });
        send({ type: 'exit' });
        runFrames(6);
        expect(last(c, 'uniform4f', 'uKeys')![3]).toBe(0);
        expect(last(c, 'uniform2f', 'uBarA')![0]).toBe(0);
        expect(last(c, 'uniform4f', 'uBar')![2]).toBe(0); // no width: the bar has no place to be
        expect(posted.map(m => m.type)).not.toContain('game'); // no run was started
        expect(frames.length).toBeGreaterThan(0); // and 'exit' did not stop the field
    });

    it('lock mode on a worker that previously showed the bar still starts clean', () => {
        const boot = canvas();
        initMode(boot);
        barOn();
        runFrames(3);
        const c = canvas();
        initMode(c, 'lock');
        runFrames(2);
        expect(last(c, 'uniform4f', 'uBar')![2]).toBe(0);
        expect(last(c, 'uniform2f', 'uBarA')![0]).toBe(0);
        expect(last(c, 'uniform4f', 'uKeys')![3]).toBe(0);
    });

    it('lock mode follows the pointer: the field is told where it is', () => {
        const c = canvas();
        initMode(c, 'lock');
        runFrames(2);
        send({ type: 'pointer', x: 0.5, y: 0.25, on: true });
        runFrames(40); // the camera eases toward it
        const cam = last(c, 'uniform4f', 'uCam')!;
        const mouse = last(c, 'uniform3f', 'uMouse')!;
        expect(cam.length).toBe(4);
        expect(mouse[0]).toBeGreaterThan(0.2);
        expect(mouse[1]).toBeGreaterThan(0.1);
    });

    it('negative control: with no pointer message the mouse stays at the centre', () => {
        const c = canvas();
        initMode(c, 'lock');
        send({ type: 'pointer', x: 0, y: 0, on: false }); // (the module keeps the last pointer between tests)
        runFrames(120);
        const mouse = last(c, 'uniform3f', 'uMouse')!;
        expect(Math.abs(mouse[0])).toBeLessThan(1e-6);
        expect(Math.abs(mouse[1])).toBeLessThan(1e-6);
    });

    it('lock mode honours reduced motion: one still frame, no loop, pointer ignored', () => {
        const c = canvas();
        initMode(c, 'lock', true);
        runFrames(1);
        const drawn = c.gl.calls.filter(([n]) => n === 'drawArrays').length;
        expect(drawn).toBe(1);
        expect(frames.length).toBe(0); // nothing scheduled after the still frame
        send({ type: 'pointer', x: 1, y: 1, on: true });
        runFrames(3);
        expect(c.gl.calls.filter(([n]) => n === 'drawArrays').length).toBe(1);
    });
});


/**
 * macOS regression ("Jump the firewall" showed no pillars, 1.0.23): the dots
 * wrote premultiplied rgb > 0 with alpha 0, which is not a valid premultiplied
 * colour under premultipliedAlpha:true; Windows' compositor adds it anyway,
 * macOS' drops it, so every dot vanished and only the solid Keys showed.
 * These pin the contract the GPU cannot be asked for here.
 */
describe('loading screen worker: pillars on every compositor', () => {
    type Call = [string, unknown[]];
    const sources = (c: FakeCanvas) => (c.gl.calls as Call[]).filter(([n]) => n === 'shaderSource').map(([, a]) => a[1] as string);
    const start = () => {
        const c = canvas();
        send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr: 2, best: 0, reduced: false });
        send({ type: 'act' });
        runFrames(4);
        return c;
    };

    it('the dot fragment output is a valid premultiplied colour (alpha >= rgb), never alpha 0', () => {
        const fs = sources(start()).find(s => s.includes('gl_FragColor'))!;
        const dot = fs.slice(0, fs.indexOf('Keys, in the logo'));
        const writes = dot.match(/gl_FragColor\s*=\s*[^;]+;/g) ?? [];
        // two outputs before Keys: a pillar's body, and a dot
        expect(writes.length).toBe(2);
        const dotWrite = writes.find(w => /rgb/.test(w))!;
        expect(dotWrite).toMatch(/max\(rgb\.r/); // alpha is the brightest channel
        expect(dotWrite).not.toMatch(/,\s*0\.0\)\s*;/); // negative control: the old form
    });

    it('the vertex shader indexes no uniform array by a per-vertex value', () => {
        const vs = sources(start()).find(s => s.includes('gl_PointSize'))!;
        expect(vs).not.toMatch(/uniform\s+\w+\s+\w+\s*\[/);
        expect(vs).not.toMatch(/\bint\s*\(/);
    });

    it('in a run, every live pillar is drawn on its own with a visible alpha', () => {
        const c = start();
        const calls = c.gl.calls as Call[];
        const lastFrame = calls.slice(calls.map(([n]) => n).lastIndexOf('clear'));
        const draws = lastFrame.filter(([n]) => n === 'drawArrays');
        const walls = lastFrame.filter(([n, a]) => n === 'uniform3f' && (a[0] as { name: string }).name === 'uWallS');
        expect(walls.length).toBeGreaterThanOrEqual(2);
        // field, then per pillar: its body (triangles) and, while it forms, its dots (points), then burst/keys/bar
        const forming = walls.filter(([, a]) => (a[3] as number) < 1).length;
        expect(draws.length).toBe(walls.length + forming + 2);
        walls.forEach(([, a]) => expect(a[2]).toBeGreaterThan(0.5)); // alpha: not culled
    });

    it('idle: one draw, pillars culled by alpha 0', () => {
        const c = canvas();
        send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr: 2, best: 0, reduced: false });
        send({ type: 'quit' });
        runFrames(2);
        const calls = c.gl.calls as Call[];
        const lastFrame = calls.slice(calls.map(([n]) => n).lastIndexOf('clear'));
        expect(lastFrame.filter(([n]) => n === 'drawArrays').length).toBe(1);
        const w = lastFrame.filter(([n, a]) => n === 'uniform3f' && (a[0] as { name: string }).name === 'uWallS').pop()!;
        expect(w[1][2]).toBe(0);
    });
});

/**
 * The pillars used to be dots ALONE: on a compositor or display that draws fine
 * dots poorly they vanished while still being deadly (macOS report). Each pillar
 * now has a solid body (two quads), which is what makes it a wall whatever the dots
 * do. Same contract as the dots: a valid premultiplied colour, per-pillar plain
 * uniforms, one draw each. (What the GPU really writes is checked by hand in real
 * Chromium: every pixel rgb <= alpha, drawn edges on the rules' rectangle.)
 */
describe('loading screen worker: pillar bodies', () => {
    type Call = [string, unknown[]];
    const start = (dpr = 2) => {
        const c = canvas();
        send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr, best: 0, reduced: false });
        send({ type: 'act' });
        runFrames(4);
        return c;
    };
    const lastFrame = (c: FakeCanvas) => {
        const calls = c.gl.calls as Call[];
        return calls.slice(calls.map(([n]) => n).lastIndexOf('clear'));
    };

    it.each([1, 2])('at DPR %i every live pillar draws a 12-vertex body of triangles, under its dots', (dpr) => {
        const c = start(dpr);
        const f = lastFrame(c);
        // the fake context returns 1 for every enum, so tell the draws apart by vertex count
        const draws = f.filter(([n]) => n === 'drawArrays');
        const bodies = draws.filter(([, a]) => a[2] === 12);
        expect(bodies.length).toBeGreaterThanOrEqual(2);
        expect(bodies.length).toBe(f.filter(([n, a]) => n === 'uniform3f' && (a[0] as { name: string }).name === 'uWallS').length);
        // a pillar's dots always come straight after its body
        const order = draws.map(([, a]) => a[2]);
        for (let i = 0; i < order.length; i++) if (order[i] === WALL_DOTS) expect(order[i - 1]).toBe(12);
    });

    it('a pillar draws its dots only while it is forming: once solid they cost nothing', () => {
        const c = canvas();
        send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr: 1, best: 0, reduced: false });
        send({ type: 'quit' });
        send({ type: 'act' });
        const seen = { formed: 0, forming: 0 };
        for (let i = 0; i < 140 && !seen.formed; i++) {
            if (i % 11 === 0) send({ type: 'act' }); // keep him up long enough for the first pillar to arrive
            runFrames(1);
            const f = lastFrame(c);
            const zs = f.filter(([n, a]) => n === 'uniform3f' && (a[0] as { name: string }).name === 'uWallS').map(([, a]) => a[3] as number);
            const dots = f.filter(([n, a]) => n === 'drawArrays' && a[2] === WALL_DOTS).length;
            expect(dots).toBe(zs.filter(z => z < 1).length);
            seen.formed += zs.filter(z => z >= 1).length;
            seen.forming += zs.filter(z => z < 1).length;
        }
        expect(seen.forming).toBeGreaterThan(0);
        expect(seen.formed).toBeGreaterThan(0); // negative control: the "solid" case really was reached
    });

    it('the body is a valid premultiplied colour, and nothing until the pillar starts forming', () => {
        const gl = (start().gl.calls as Call[]).filter(([n]) => n === 'shaderSource').map(([, a]) => a[1] as string);
        const vs = gl.find(s => s.includes('gl_PointSize'))!;
        const fs = gl.find(s => s.includes('gl_FragColor'))!;
        expect(vs).toMatch(/a = uWallS\.y\*step\(0\.001, uWallS\.z\);/); // culled by alpha 0 while still loose dots
        expect(vs).toMatch(/vKind = 2\.0/);
        expect(fs).toMatch(/if \(vKind > 1\.5\) \{ gl_FragColor = pillar\(\); return; \}/);
        // rgb = col*ca + teal*halo, alpha = ca + 0.878*halo, with col at most 1 and teal's largest channel 0.878: rgb <= alpha
        expect(fs).toMatch(/return vec4\(min\(col, vec3\(1\.0\)\)\*ca \+ vec3\(0\.145, 0\.878, 0\.784\)\*halo, ca \+ 0\.878\*halo\)\*uWallS\.y;/);
    });

    it('the body is solid once formed: it, not the dots, is what guarantees the wall is visible', () => {
        const fs = ((start().gl.calls as Call[]).filter(([n]) => n === 'shaderSource').map(([, a]) => a[1] as string)).find(s => s.includes('gl_FragColor'))!;
        // Never below this anywhere on the body; its edges and cap go up to fully solid.
        const alpha = Number(/float op = max\(([0-9.]+), max\(rail, tip\)\);/.exec(fs)![1]);
        expect(alpha).toBeGreaterThanOrEqual(0.8);
        expect(alpha).toBeLessThanOrEqual(1);
    });

    it('the body\'s edge is the rules\' rectangle: dx and along are measured from it, the glow only sits outside it', () => {
        const gl = (start().gl.calls as Call[]).filter(([n]) => n === 'shaderSource').map(([, a]) => a[1] as string);
        const fs = gl.find(s => s.includes('gl_FragColor'))!;
        expect(fs).toMatch(/float dx = hw - abs\(p\.x\);/);
        expect(fs).toMatch(/float along = abs\(p\.y - \(uWallG\.x \+ uWallG\.y\)\*0\.5\) - \(uWallG\.y - uWallG\.x\)\*0\.5;/);
        expect(fs).toMatch(/float cover = clamp\(min\(dx, along\)\*uDpr \+ 0\.5, 0\.0, 1\.0\);/);
    });

    /*
     * Owner report: "shortly after they animate in, the pillars have a harsh shift in
     * colour/brightness". Measured in real Chromium (ANGLE on the dev box's GPU): on
     * the frame a pillar finished forming (z reached 1) it stepped ~13% darker and
     * ~6% more see-through, in one frame, after a flat plateau. While forming, the
     * glow was laid over the whole body and showed through its 20% translucency; the
     * formed body works out no glow inside its rectangle at all. The glow inside now
     * only shows between the forming dots, so it is already 0 where and when they
     * cover the body: same formed look, no step.
     */
    it('no step when a pillar finishes forming: inside the body the glow is only what the forming dots leave uncovered', () => {
        const fs = ((start().gl.calls as Call[]).filter(([n]) => n === 'shaderSource').map(([, a]) => a[1] as string)).find(s => s.includes('gl_FragColor'))!;
        const body = fs.slice(fs.indexOf('vec4 pillar()'), fs.indexOf('void main()'));
        // the formed body (z = 1): glow only under the antialiased edge, none inside (unchanged)
        expect(body).toMatch(/if \(cover < 1\.0 \|\| z < 1\.0\) \{/);
        // the forming dots' coverage is kept apart from the rectangle's, and is 1 once formed
        expect(body).toMatch(/float grid = 1\.0;/);
        expect(body).toMatch(/grid = clamp\(/);
        expect(body).toMatch(/float ca = cover\*grid\*op;/);
        expect(body).toMatch(/halo \*= cover < 1\.0 \? 1\.0 - ca : 1\.0 - grid;/);
        expect(body).not.toMatch(/halo \*= 1\.0 - ca;/); // negative control: the old form, which left (1 - op) of the glow on the body
    });

    it('the forming dots touch by the time the pillar is formed, at every size the game is drawn at', () => {
        // The other half of "no step at z = 1": the grid's coverage must already be
        // 1 everywhere when the shader stops working it out, or the body's holes would
        // snap shut on that frame. Worked out from the shader's own constants.
        const fs = ((start().gl.calls as Call[]).filter(([n]) => n === 'shaderSource').map(([, a]) => a[1] as string)).find(s => s.includes('gl_FragColor'))!;
        const pitchK = Number(/float pitch = hw\*([0-9.]+);/.exec(fs)![1]);
        const radius = Number(/\*([0-9.]+) - length\(p\/pitch - cell - 0\.5\)\)\*pitch\*uDpr \+ 0\.5/.exec(fs)![1]);
        const halfWidth = (h: number) => (0.075 * h) / 2; // RULES.wallW / 2 in px (1 U = half the height)
        // at z = 1 a dot's radius is `radius` cells; the furthest a fragment sits from its cell's centre is the corner
        const grid = (h: number, dpr: number, dist: number) => Math.min(1, Math.max(0, (radius - dist) * halfWidth(h) * pitchK * dpr + 0.5));
        // the Home pane at the window's minimum size (720 tall) is ~670 px; the loading screen fills the window
        for (const h of [670, 720, 900, 1440]) for (const dpr of [1, 1.25, 1.5, 2]) expect(grid(h, dpr, Math.SQRT1_2)).toBe(1);
        expect(grid(300, 1, Math.SQRT1_2)).toBeLessThan(1); // positive control: a much smaller canvas would leave holes
    });

    it('a new pillar uploads nothing: its shape reaches the GPU as plain per-draw uniforms', () => {
        // The drop the owner saw "when a new pillar is created": each respawn used to re-send both
        // whole vertex buffers (~285 KB each) over ones in-flight draws were using.
        const c = canvas();
        send({ type: 'init', canvas: c as unknown as OffscreenCanvas, w: 1440, h: 900, dpr: 1, best: 0, reduced: false });
        send({ type: 'quit' });
        send({ type: 'act' });
        const uploadsAtStart = (c.gl.calls as Call[]).filter(([n]) => n === 'bufferData').length;
        expect(uploadsAtStart).toBe(3); // aA, aC, aS, once, at setup
        const U = 450, halfWidth = 0.075 * U;
        const uniformsOf = (f: Call[], name: string) => f.filter(([n, a]) => n === 'uniform3f' && (a[0] as { name: string }).name === name).map(([, a]) => a.slice(1) as number[]);
        // Fly him: the next gap ahead of Keys is known from the very uniforms under test.
        let respawns = 0;
        let prev: number[] = [];
        for (let i = 0; i < 700 && respawns < 2; i++) {
            runFrames(1);
            const f = lastFrame(c);
            const xs = uniformsOf(f, 'uWallS').map(w => w[0]), gaps = uniformsOf(f, 'uWallG');
            xs.forEach((x, k) => { if (prev[k] !== undefined && x > prev[k] + U) respawns++; });
            prev = xs;
            gaps.forEach(g => { expect(g[1] - g[0]).toBeCloseTo(0.66 * U, 3); expect(g[2]).toBeCloseTo(halfWidth, 6); });
            const keys = (f.filter(([n, a]) => n === 'uniform4f' && (a[0] as { name: string }).name === 'uKeys').pop()!)[1] as unknown as [unknown, number, number];
            let next = -1;
            xs.forEach((x, k) => { if (x > keys[1] - 2 * halfWidth && (next < 0 || x < xs[next])) next = k; });
            if (next >= 0 && keys[2] < (gaps[next][0] + gaps[next][1]) / 2 - 0.08 * U) send({ type: 'act' });
        }
        expect(respawns).toBeGreaterThanOrEqual(1); // negative control: a pillar really did come round again
        expect((c.gl.calls as Call[]).filter(([n]) => n === 'bufferSubData')).toEqual([]);
        expect((c.gl.calls as Call[]).filter(([n]) => n === 'bufferData').length).toBe(3);
    });

    it('the buffers have room for every pillar\'s body (a vertex past the end would draw nothing)', () => {
        const c = start();
        const bufs = (c.gl.calls as Call[]).filter(([n]) => n === 'bufferData').map(([, a]) => (a[1] as Float32Array).length / 4);
        const dotDraws = lastFrame(c).filter(([n, a]) => n === 'drawArrays' && a[2] === WALL_DOTS).map(([, a]) => a[1] as number);
        const bodyDraws = lastFrame(c).filter(([n, a]) => n === 'drawArrays' && a[2] === 12).map(([, a]) => (a[1] as number) + 12);
        expect(Math.max(...bodyDraws)).toBeLessThanOrEqual(bufs[0]);
        expect(Math.max(...dotDraws.map(x => x + WALL_DOTS))).toBeLessThanOrEqual(bufs[0]);
    });
});
