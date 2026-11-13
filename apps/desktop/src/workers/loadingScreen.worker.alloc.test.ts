// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import type { ToWorker } from './loadingScreenProtocol';
import { newGame, startRun, step, keysX, RULES, type StepResult } from '../utils/loadingGame';
import { tiltHomography, tiltToward } from '../utils/keysPose';

/**
 * The Firewall game's frame loop makes no garbage. It used to make ~4 KB a frame,
 * which filled the worker's young generation every ~3.3 s: a 3-5 ms stop-the-thread
 * scavenge about every other pillar, which is the rhythm players reported as a
 * stutter. See "THE FRAME LOOP ALLOCATES NOTHING" in loadingScreen.worker.ts.
 *
 * This runs the REAL worker, in-process, on a GL whose every call is an empty
 * function, and reads how much heap the frames take. The figure here is not the
 * browser's: a real WebGL call boxes its doubles, and that part is not in this
 * number (it did not move the browser's figure either way). What this does catch
 * is what caused the bug: closures, iterators and result objects in the loop.
 *
 * Measured: 270-311 B/frame here; the source before the fix fails at 3034 B/frame
 * (the positive control, run by hand).
 */

const noop = () => undefined;
const location = { name: 'u' };
const special: Record<string, unknown> = {
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => location,
    getAttribLocation: () => 0,
    getParameter: () => new Float32Array([1, 1024]),
    getExtension: () => null,
};
/** The enums and methods the worker touches, as plain data properties: nothing here allocates per call. */
function fakeGl(): Record<string, unknown> {
    const gl: Record<string, unknown> = { ...special };
    for (const m of [
        'shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'bindBuffer', 'bufferData',
        'enableVertexAttribArray', 'vertexAttribPointer', 'enable', 'disable', 'blendFunc', 'clearColor', 'viewport',
        'clear', 'drawArrays', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniformMatrix3fv',
    ]) gl[m] = noop;
    for (const e of [
        'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS', 'ARRAY_BUFFER', 'STATIC_DRAW', 'FLOAT',
        'BLEND', 'ONE', 'ONE_MINUS_SRC_ALPHA', 'DEPTH_TEST', 'ALIASED_POINT_SIZE_RANGE', 'COLOR_BUFFER_BIT', 'POINTS', 'TRIANGLES',
    ]) gl[e] = 1;
    return gl;
}

let pending: FrameRequestCallback | null = null;
let ts = 0;
const send = (m: ToWorker | Record<string, unknown>) =>
    (globalThis as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage({ data: m });

beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.self = globalThis;
    g.postMessage = noop;
    // One slot, so the stand-in for rAF makes no garbage of its own.
    g.requestAnimationFrame = (cb: FrameRequestCallback) => { pending = cb; return 1; };
    g.cancelAnimationFrame = () => { pending = null; };
    await import('./loadingScreen.worker');
});

describe('the frame loop allocates nothing', () => {
    it('a long run makes next to no garbage per frame', () => {
        const gl = fakeGl();
        const canvas = { width: 0, height: 0, getContext: () => gl, addEventListener: noop } as unknown as OffscreenCanvas;
        send({ type: 'init', canvas, w: 1920, h: 1080, dpr: 1, best: 0, reduced: false });
        const frames = (n: number) => {
            for (let i = 0; i < n; i++) {
                ts += 1000 / 60;
                const cb = pending;
                pending = null;
                cb?.(ts);
            }
        };
        // Whatever happens to the run (a crash, the pause after it), it restarts: frames keep drawing pillars.
        const play = (n: number) => { for (let i = 0; i < n; i += 30) { send({ type: 'act' }); frames(30); } };

        play(30_000); // long enough for V8 to have tiered all of it up
        // Sum only what each short batch adds: a scavenge inside a batch makes its delta negative, and it is skipped.
        const BATCH = 300, BATCHES = 40;
        const added: number[] = [];
        for (let b = 0; b < BATCHES; b++) {
            const before = process.memoryUsage().heapUsed;
            play(BATCH);
            const delta = process.memoryUsage().heapUsed - before;
            if (delta >= 0) added.push(delta / BATCH);
        }
        added.sort((x, y) => x - y);
        const median = added[added.length >> 1];
        expect(added.length).toBeGreaterThan(BATCHES / 2);
        expect(median).toBeLessThan(600);
    }, 120_000);
});

describe('reusing the result objects changes nothing', () => {
    const seeded = () => {
        const g = newGame(0, 12345);
        startRun(g, 16 / 9, 0);
        return g;
    };
    /** A stable autopilot: swims whenever he is below the next gap's centre. */
    const fly = (g: ReturnType<typeof newGame>, steps: number, res?: StepResult) => {
        const halfW = 16 / 9, kx = keysX(halfW);
        for (let i = 0; i < steps && g.mode === 'playing'; i++) {
            let nx = null;
            for (const w of g.walls) if (w.live && !w.passed && w.x + RULES.wallW / 2 > kx - RULES.radius && (!nx || w.x < nx.x)) nx = w;
            if (nx && g.y < nx.gap - 0.08 && g.thrust <= 0 && g.vy <= 0.15) g.thrust = RULES.thrust;
            const r = step(g, 1 / 120, halfW, res);
            if (res) expect(r).toBe(res);
        }
    };

    it('step: the same run with and without a kept result object, and it really does pass pillars', () => {
        const a = seeded(), b = seeded();
        fly(a, 6000);
        fly(b, 6000, { scored: true, died: true, respawned: [99] }); // stale results must not leak in
        expect(a.score).toBeGreaterThan(5);
        expect(b).toEqual(a);
    });

    it('step resets a kept result, and reports exactly what happened', () => {
        const g = seeded();
        const res: StepResult = { scored: true, died: true, respawned: [99] };
        step(g, 1 / 120, 16 / 9, res);
        expect(res).toEqual({ scored: false, died: false, respawned: [] });
        g.y = -2; // through the floor
        step(g, 1 / 120, 16 / 9, res);
        expect(res.died).toBe(true);
    });

    it('golden: a seeded run lands exactly where the rules before this change landed it', () => {
        // Captured from the source before the frame loop stopped allocating.
        const g = seeded();
        fly(g, 6000);
        expect({ score: g.score, mode: g.mode, seed: g.seed }).toEqual(GOLDEN.state);
        expect(g.y).toBeCloseTo(GOLDEN.y, 9);
        g.walls.forEach((w, i) => {
            expect(w.x).toBeCloseTo(GOLDEN.xs[i], 9);
            expect(w.gap).toBeCloseTo(GOLDEN.gaps[i], 9);
        });
    });

    it('tiltHomography into a kept array: the same array back, the same numbers as a fresh one', () => {
        const out = new Float32Array(9);
        for (const [ax, ay] of [[0, 0], [0.07, -0.1], [-0.05, 0.03]]) {
            expect(tiltHomography(ax, ay, out)).toBe(out);
            expect(Array.from(out)).toEqual(Array.from(tiltHomography(ax, ay)));
        }
    });

    it('tiltToward into a kept object: the same object back, the same numbers as a fresh one', () => {
        const out = { ax: 9, ay: 9 };
        expect(tiltToward(0.4, -0.2, 1, out)).toBe(out);
        expect(out).toEqual(tiltToward(0.4, -0.2, 1));
    });
});

const GOLDEN = {
    state: { score: 29, mode: 'over', seed: 312142030 },
    y: 0.05678809194717095,
    xs: [0.2183277777777023, 1.168327777777702, 2.118327777777683, -1.6818722222222744, -0.7319722222222791, 0, 0, 0],
    gaps: [-0.2787284806091338, -0.4711111302440985, 0.03626937810797247, 0.14701147340703757, -0.4390024394448846, 0, 0, 0],
};
