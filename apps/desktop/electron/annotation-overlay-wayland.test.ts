/**
 * The Wayland overlay controller against a fake helper process: spawn -> outputs -> READY -> match
 * -> SHOW/SHOWX -> SHOWN -> strokes, and every way that can go wrong (no layer-shell, no XWayland,
 * ambiguous monitor, helper crash/silence, compositor closing the surface, a pipe that stops
 * draining). The real helper against real compositors is harness/wayland-annotation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWaylandOverlay, type HelperProc, type WaylandOverlayDeps } from './annotation-overlay-wayland';
import type { DisplayLite } from './annotation-overlay-wayland-protocol';

class FakeHelper implements HelperProc {
    written: string[] = [];
    killed: string[] = [];
    ended = false;
    /** what the pipe reports as unsent; a closure target so the getter needs no `this` alias */
    state = { backlog: 0 };
    private dataCb: ((c: Buffer | string) => void) | null = null;
    private exitCbs: Array<() => void> = [];
    stdin = {
        write: (chunk: string): boolean => { this.written.push(chunk); this.onWrite?.(chunk); return true; },
        end: (): void => { this.ended = true; },
        writableLength: 0,
        destroyed: false,
    };
    stdout = { on: (_ev: 'data', cb: (c: Buffer | string) => void): unknown => { this.dataCb = cb; return this; } };
    /** reacts to what main writes (a scripted helper) */
    onWrite: ((chunk: string) => void) | null = null;
    constructor() {
        const state = this.state;
        Object.defineProperty(this.stdin, 'writableLength', { get: () => state.backlog });
    }
    on(ev: 'exit' | 'error', cb: () => void): unknown { if (ev === 'exit' || ev === 'error') this.exitCbs.push(cb); return this; }
    kill(sig?: string): boolean { this.killed.push(sig ?? 'SIGTERM'); return true; }
    say(...lines: string[]): void { this.dataCb?.(Buffer.from(lines.join('\n') + '\n')); }
    die(): void { for (const cb of this.exitCbs) cb(); }
    lines(): string[] { return this.written.join('').split('\n').filter(Boolean); }
}
const HELLO = 'HELLO 1';
const OUT0 = 'OUT 0 DP-1 0 0 1920 1080 1 1920 1080';
const OUT1 = 'OUT 1 DP-2 1920 0 1080 1920 1 1080 1920';

function setup(opts: { displays?: DisplayLite[]; spawn?: () => HelperProc | null } = {}) {
    const helpers: FakeHelper[] = [];
    const logs: string[] = [];
    const ended = vi.fn();
    const deps: WaylandOverlayDeps = {
        spawnHelper: opts.spawn ?? (() => { const h = new FakeHelper(); helpers.push(h); return h; }),
        getDisplays: () => opts.displays ?? [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
        now: () => Date.now(),
        log: m => logs.push(m),
        onEnded: ended,
        stepTimeoutMs: 400,
    };
    return { ov: createWaylandOverlay(deps), helpers, logs, ended };
}

/** A helper that answers like cl_wayland_overlay does. */
function scripted(h: FakeHelper, ready: string, outs: string[] = [OUT0]): void {
    h.onWrite = chunk => {
        const m = /^(SHOWX?) (\d+)/.exec(chunk);
        if (m) queueMicrotask(() => h.say(`SHOWN ${m[2]} 1920 1080 1`));
    };
    queueMicrotask(() => h.say(HELLO, ...outs, ready));
}
const spawnScripted = (ready: string, outs?: string[]) => (): HelperProc => {
    const h = new FakeHelper();
    helpers_.push(h);
    scripted(h, ready, outs);
    return h;
};
let helpers_: FakeHelper[] = [];
beforeEach(() => { helpers_ = []; });

const SRC = { id: 'screen:0:0', display_id: '' };
const FRAME = { width: 1920, height: 1080 };

describe('layer-shell compositors (KWin, Sway, Hyprland...)', () => {
    it('spawns the helper, matches the output, sends SHOW <idx> and reports a captured overlay', async () => {
        const { ov, logs } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        const r = await ov.show(SRC, FRAME);
        expect(r).toEqual({ ok: true, how: 'wl-layer-only-display', captured: true });
        expect(helpers_[0].lines()).toEqual(['SHOW 0']);
        expect(ov.isShown()).toBe(true);
        expect(logs.join('\n')).toMatch(/layer-shell, only-display, 1 outputs/);
        expect(logs.join('\n')).not.toMatch(/screen:0|DP-1/);          // counts and states only
    });

    it('prefers layer-shell even when XWayland is reachable too', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=1') });
        await ov.show(SRC, FRAME);
        expect(helpers_[0].lines()).toEqual(['SHOW 0']);
    });

    it('picks the right output of two by frame size', async () => {
        const displays: DisplayLite[] = [
            { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
            { id: 2, bounds: { x: 1920, y: 0, width: 1080, height: 1920 }, scaleFactor: 1 },
        ];
        const { ov } = setup({ displays, spawn: spawnScripted('READY layer_shell=1 x11=0', [OUT0, OUT1]) });
        const r = await ov.show(SRC, { width: 1080, height: 1920 });
        expect(r).toMatchObject({ ok: true, how: 'wl-layer-stream-size' });
        expect(helpers_[0].lines()).toEqual(['SHOW 1']);
    });

    it('two identical monitors and no way to tell: refused, nothing is shown, helper stopped', async () => {
        const displays: DisplayLite[] = [
            { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
            { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        ];
        const { ov, logs } = setup({ displays, spawn: spawnScripted('READY layer_shell=1 x11=0', [OUT0, 'OUT 1 DP-2 1920 0 1920 1080 1 1920 1080']) });
        const r = await ov.show(SRC, FRAME);
        expect(r).toMatchObject({ ok: false, reason: 'needs_choice', displays: 2, choice: { candidates: [1, 2] } });
        expect(helpers_[0].lines()).toEqual(['QUIT']);                    // never told to show anything
        expect(ov.isShown()).toBe(false);
        expect(logs.join('\n')).toMatch(/identical displays/);
    });

    it('a window picked in the portal is refused as not-a-whole-screen', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        expect(await ov.show(SRC, { width: 1000, height: 700 })).toMatchObject({ ok: false, reason: 'not_whole_screen' });
    });
});

describe('GNOME / Mutter (no layer-shell): the XWayland fallback', () => {
    it('uses SHOWX when only XWayland is available', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=0 x11=1') });
        const r = await ov.show(SRC, FRAME);
        expect(r).toEqual({ ok: true, how: 'wl-x11-only-display', captured: true });
        expect(helpers_[0].lines()).toEqual(['SHOWX 0']);
    });

    it('neither layer-shell nor XWayland: refused with a stable reason, and not retried for every stroke', async () => {
        const { ov, logs } = setup({ spawn: spawnScripted('READY layer_shell=0 x11=0') });
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'no_layer_shell' });
        expect(logs.join('\n')).toMatch(/no layer-shell/);
        expect(helpers_).toHaveLength(1);
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'no_layer_shell' });
        expect(helpers_).toHaveLength(1);                                // the second ask did not spawn again
    });

    it('XWayland cannot place it on that monitor: refused, not shown elsewhere', async () => {
        const { ov } = setup({
            spawn: () => {
                const h = new FakeHelper();
                helpers_.push(h);
                h.onWrite = chunk => { if (/^SHOWX/.test(chunk)) queueMicrotask(() => h.say('ERR no_x_monitor')); };
                queueMicrotask(() => h.say(HELLO, OUT0, 'READY layer_shell=0 x11=1'));
                return h;
            },
        });
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'no_display_match' });
    });
});

describe('helper failures', () => {
    it('no helper binary: helper_failed', async () => {
        const { ov } = setup({ spawn: () => null });
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'helper_failed' });
    });

    it('helper that reports an error before READY (no libwayland, no socket)', async () => {
        const { ov } = setup({
            spawn: () => { const h = new FakeHelper(); helpers_.push(h); queueMicrotask(() => h.say(HELLO, 'ERR no_libwayland')); return h; },
        });
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'helper_failed' });
        expect(helpers_[0].lines()).toEqual(['QUIT']);
    });

    it('helper that dies on startup', async () => {
        const { ov } = setup({ spawn: () => { const h = new FakeHelper(); helpers_.push(h); queueMicrotask(() => h.die()); return h; } });
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'helper_failed' });
    });

    it('a silent helper times out instead of hanging the show call', async () => {
        const { ov } = setup({ spawn: () => { const h = new FakeHelper(); helpers_.push(h); return h; } });
        const t0 = Date.now();
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'helper_failed' });
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('SHOW that is never answered: create_failed', async () => {
        const { ov } = setup({
            spawn: () => { const h = new FakeHelper(); helpers_.push(h); queueMicrotask(() => h.say(HELLO, OUT0, 'READY layer_shell=1 x11=0')); return h; },
        });
        expect(await ov.show(SRC, FRAME)).toEqual({ ok: false, reason: 'create_failed' });
    });

    it('malformed or hostile helper output is ignored, not trusted', async () => {
        const { ov } = setup({
            spawn: () => {
                const h = new FakeHelper();
                helpers_.push(h);
                h.onWrite = chunk => { const m = /^SHOW (\d+)/.exec(chunk); if (m) queueMicrotask(() => h.say('SHOWN 99 1 1 1', 'SHOWN x', `SHOWN ${m[1]} 1920 1080 1`)); };
                queueMicrotask(() => h.say('garbage', 'OUT 0 ../../etc 0 0 1 1 1 1 1', HELLO, OUT0, 'READY layer_shell=1 x11=0 extra', 'READY layer_shell=1 x11=0'));
                return h;
            },
        });
        expect((await ov.show(SRC, FRAME)).ok).toBe(true);
    });

    it('the compositor closing the surface ends the overlay and says so', async () => {
        const { ov, ended } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        helpers_[0].say('CLOSED');
        expect(ov.isShown()).toBe(false);
        expect(ended).toHaveBeenCalledTimes(1);
        expect(helpers_[0].lines().at(-1)).toBe('QUIT');
    });

    it('the helper crashing after it was shown ends the overlay', async () => {
        const { ov, ended } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        helpers_[0].die();
        expect(ov.isShown()).toBe(false);
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it('a helper that stops draining its pipe is stopped, not buffered without bound', async () => {
        const { ov, ended, logs } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        helpers_[0].state.backlog = 5 << 20;
        ov.push({ upsert: [{ id: 'a', color: '#ffffff', width: 4, points: [{ x: 0, y: 0 }], updatedAt: Date.now(), closedAt: 0 }] });
        expect(ov.isShown()).toBe(false);
        expect(ended).toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/not draining/);
    });
});

describe('strokes and lifetime', () => {
    const stroke = (id = 'a') => ({ id, color: '#35e0ff', width: 6, points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }], updatedAt: Date.now(), closedAt: 0 });

    it('forwards only validated geometry as helper lines', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        ov.push({ reset: true, upsert: [stroke(), { ...stroke('bad'), color: 'url(javascript:1)' }], evil: 'ignored' });
        const lines = helpers_[0].lines();
        expect(lines[0]).toBe('SHOW 0');
        expect(lines[1]).toBe('Z');
        expect(lines[2]).toMatch(/^U 1 35e0ff 60 \d+ 0 2 16384,32768 49151,32768$/);
        expect(lines).toHaveLength(3);                                  // the bad colour never left main
    });

    it('deltas that arrive while the surface is still being created are held, then flushed in order', async () => {
        const { ov } = setup({
            spawn: () => {
                const h = new FakeHelper();
                helpers_.push(h);
                h.onWrite = chunk => { const m = /^SHOW (\d+)/.exec(chunk); if (m) setTimeout(() => h.say(`SHOWN ${m[1]} 1920 1080 1`), 30); };
                queueMicrotask(() => h.say(HELLO, OUT0, 'READY layer_shell=1 x11=0'));
                return h;
            },
        });
        const p = ov.show(SRC, FRAME);
        await new Promise(r => setTimeout(r, 10));
        expect(ov.isActive()).toBe(true);
        expect(ov.isShown()).toBe(false);
        ov.push({ upsert: [stroke()] });
        expect(helpers_[0].lines()).toEqual(['SHOW 0']);                // held back
        await p;
        expect(helpers_[0].lines().map(l => l.split(' ')[0])).toEqual(['SHOW', 'U']);
    });

    it('hide() quits the helper; pushes after it are ignored', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        ov.hide();
        expect(helpers_[0].lines().at(-1)).toBe('QUIT');
        expect(helpers_[0].ended).toBe(true);
        expect(ov.isShown()).toBe(false);
        const n = helpers_[0].lines().length;
        ov.push({ upsert: [stroke()] });
        expect(helpers_[0].lines()).toHaveLength(n);
    });

    it('showing the same share again is a no-op; a different one restarts the helper', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        await ov.show(SRC, FRAME);
        expect(helpers_).toHaveLength(1);
        await ov.show({ id: 'screen:7:0', display_id: '' }, FRAME);
        expect(helpers_).toHaveLength(2);
        expect(helpers_[0].lines().at(-1)).toBe('QUIT');
    });

    it('ids are renumbered: the helper never sees the renderer\'s strings', async () => {
        const { ov } = setup({ spawn: spawnScripted('READY layer_shell=1 x11=0') });
        await ov.show(SRC, FRAME);
        ov.push({ upsert: [stroke('1f3a9c7e-0000-4000-8000-aaaaaaaaaaaa')] });
        expect(helpers_[0].lines().join('\n')).not.toContain('1f3a9c7e');
    });
});

describe('multi-monitor: the sharer is asked, and the answer lands on that output', () => {
    const O0 = 'OUT 0 DP-1 0 0 3440 1440 1 3440 1440';
    const O1 = 'OUT 1 DP-2 3440 0 3440 1440 1 3440 1440';
    const O2 = 'OUT 2 DP-3 6880 0 1080 1920 1 1080 1920';
    const displays: DisplayLite[] = [
        { id: 1, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, scaleFactor: 1, primary: true },
        { id: 2, bounds: { x: 3440, y: 0, width: 3440, height: 1440 }, scaleFactor: 1 },
        { id: 3, bounds: { x: 6880, y: 0, width: 1080, height: 1920 }, scaleFactor: 1 },
    ];
    const spawn = () => spawnScripted('READY layer_shell=1 x11=0', [O0, O1, O2]);

    it('identical landscapes: needs_choice with the real layout, helper stopped, nothing shown', async () => {
        const { ov } = setup({ displays, spawn: spawn() });
        const r = await ov.show(SRC, { width: 3440, height: 1440 });
        expect(r).toEqual({
            ok: false, reason: 'needs_choice', displays: 3,
            choice: {
                displays: [
                    { id: 1, x: 0, y: 0, width: 3440, height: 1440, primary: true },
                    { id: 2, x: 3440, y: 0, width: 3440, height: 1440, primary: false },
                    { id: 3, x: 6880, y: 0, width: 1080, height: 1920, primary: false },
                ],
                candidates: [1, 2],
            },
        });
        expect(helpers_[0].lines()).toEqual(['QUIT']);
        expect(ov.isShown()).toBe(false);
    });

    it('the answer is honoured: SHOW goes to the chosen output only', async () => {
        const a = setup({ displays, spawn: spawn() });
        const ra = await a.ov.show(SRC, { width: 3440, height: 1440 }, 2);
        expect(ra).toMatchObject({ ok: true, how: 'wl-layer-chosen' });
        expect(helpers_[0].lines()).toEqual(['SHOW 1']);
        helpers_ = [];
        const b = setup({ displays, spawn: spawn() });
        await b.ov.show(SRC, { width: 3440, height: 1440 }, 1);
        expect(helpers_[0].lines()).toEqual(['SHOW 0']);
    });

    it('single match needs no question: the portrait screen is shown straight away', async () => {
        const { ov } = setup({ displays, spawn: spawn() });
        const r = await ov.show(SRC, { width: 1080, height: 1920 });
        expect(r).toMatchObject({ ok: true, how: 'wl-layer-stream-size' });
        expect(helpers_[0].lines()).toEqual(['SHOW 2']);
    });

    it('negative control: an answer naming a display that does not fit the share asks again instead of obeying', async () => {
        const { ov } = setup({ displays, spawn: spawn() });
        const r = await ov.show(SRC, { width: 3440, height: 1440 }, 3);
        expect(r).toMatchObject({ ok: false, reason: 'needs_choice' });
        expect(helpers_[0].lines()).toEqual(['QUIT']);
    });

    it('a changed answer re-targets: the session key includes it', async () => {
        const { ov } = setup({ displays, spawn: spawn() });
        await ov.show(SRC, { width: 3440, height: 1440 }, 1);
        await ov.show(SRC, { width: 3440, height: 1440 }, 2);
        expect(helpers_).toHaveLength(2);
        expect(helpers_[1].lines()).toEqual(['SHOW 1']);
    });
});
