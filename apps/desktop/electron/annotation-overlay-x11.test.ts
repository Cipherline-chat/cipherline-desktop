/**
 * The pure + life-cycle halves of the X11 annotation overlay's run-time checks:
 * annotation-overlay-x11-protocol.ts (parsing the helper's lines, DIP conversion) and
 * annotation-overlay-x11.ts (one-shot probe with a cache, long-lived watcher) against a fake
 * helper. The helper itself against a real X server: harness/wayland-annotation (run.sh x11).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    parseX11HelperLine, parseX11WindowId, x11WindowInfo, x11FrameToDip,
} from './annotation-overlay-x11-protocol';
import { createX11CompositorProbe, createX11Watcher, type X11WindowReport } from './annotation-overlay-x11';
import { windowOverlayPlacement, linuxOverlayVerdict, shouldProbeX11Compositor, x11WindowShareAllowed } from './annotation-overlay-target';
import type { HelperProc } from './annotation-overlay-wayland';

describe('parseX11HelperLine', () => {
    it('reads exactly the lines the helper prints', () => {
        expect(parseX11HelperLine('HELLO 1')).toEqual({ kind: 'hello' });
        expect(parseX11HelperLine('READY x11_watch=1')).toEqual({ kind: 'ready' });
        expect(parseX11HelperLine('CM 1')).toEqual({ kind: 'cm', compositor: true });
        expect(parseX11HelperLine('CM 0')).toEqual({ kind: 'cm', compositor: false });
        expect(parseX11HelperLine('ERR no_x_server')).toEqual({ kind: 'err', code: 'no_x_server' });
        expect(parseX11HelperLine('W ok -40 20 800 600')).toEqual({ kind: 'win', state: 'ok', frame: { x: -40, y: 20, width: 800, height: 600 } });
        for (const s of ['unmapped', 'minimized', 'workspace', 'gone']) {
            expect(parseX11HelperLine(`W ${s} 0 0 0 0`)).toEqual({ kind: 'win', state: s, frame: null });
        }
    });
    it('ignores anything else: junk, a wrong state, an empty or absurd rectangle, a CM value that is not 0/1', () => {
        for (const bad of ['', 'CM 2', 'CM', 'CM 1 extra', 'W ok 1 2 0 5', 'W ok 1 2 5 0', 'W ok 99999999 0 10 10', 'W sideways 0 0 1 1',
            'W ok a b c d', 'ERR Bad Code', 'x'.repeat(300), 'HELLO', 'READY']) {
            expect(parseX11HelperLine(bad)).toBeNull();
        }
    });
});

describe('parseX11WindowId', () => {
    it('window:<XID>:<n> → the decimal XID', () => {
        expect(parseX11WindowId('window:4242:0')).toBe('4242');
        expect(parseX11WindowId('window:4294967295:0')).toBe('4294967295');
        expect(parseX11WindowId('window:00012:0')).toBe('12');
    });
    it('refuses zero, wider than 32 bits, non-numeric and other kinds', () => {
        for (const bad of ['window:0:0', 'window:4294967296:0', 'window:abc:0', 'screen:1:0', 'window:1', 'window:1:0:x', 'window:-5:0', 'window:12345678901:0']) {
            expect(parseX11WindowId(bad)).toBeNull();
        }
    });
});

describe('x11WindowInfo → windowOverlayPlacement (same decisions as the Windows / macOS backends)', () => {
    const frame = { x: 5, y: 6, width: 70, height: 80 };
    it('ok → show on the frame', () => {
        expect(windowOverlayPlacement(x11WindowInfo('ok', frame))).toEqual({ action: 'show', rect: frame });
    });
    it('unmapped / minimized / other workspace → hide (keep tracking)', () => {
        for (const s of ['unmapped', 'minimized', 'workspace'] as const) {
            expect(windowOverlayPlacement(x11WindowInfo(s, null))).toEqual({ action: 'hide' });
        }
    });
    it('gone → close; no report yet → hide', () => {
        expect(windowOverlayPlacement(x11WindowInfo('gone', null))).toEqual({ action: 'close' });
        expect(windowOverlayPlacement(x11WindowInfo(null, null))).toEqual({ action: 'hide' });
    });
    it('"ok" without a frame cannot be shown', () => {
        expect(windowOverlayPlacement(x11WindowInfo('ok', null))).toEqual({ action: 'hide' });
    });
});

describe('x11FrameToDip', () => {
    it('scale 1 is the identity', () => {
        expect(x11FrameToDip({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    });
    it('divides by the device scale factor', () => {
        expect(x11FrameToDip({ x: 200, y: 400, width: 1600, height: 1200 }, 2)).toEqual({ x: 100, y: 200, width: 800, height: 600 });
    });
    it('rounds edges independently: a fractional scale never shrinks the frame by more than half a DIP', () => {
        const r = x11FrameToDip({ x: 101, y: 51, width: 301, height: 203 }, 1.5);
        expect(r.x).toBe(67); expect(r.y).toBe(34);
        expect(r.x + r.width).toBe(Math.round(402 / 1.5));
        expect(r.y + r.height).toBe(Math.round(254 / 1.5));
    });
    it('keeps negative origins (a monitor left of / above the primary)', () => {
        expect(x11FrameToDip({ x: -1920, y: -100, width: 800, height: 600 }, 1)).toEqual({ x: -1920, y: -100, width: 800, height: 600 });
    });
    it('a nonsense scale is treated as 1, and the size never collapses to zero', () => {
        expect(x11FrameToDip({ x: 10, y: 10, width: 4, height: 4 }, 0)).toEqual({ x: 10, y: 10, width: 4, height: 4 });
        expect(x11FrameToDip({ x: 0, y: 0, width: 1, height: 1 }, 4).width).toBeGreaterThanOrEqual(1);
        expect(x11FrameToDip({ x: 10, y: 10, width: 4, height: 4 }, Number.NaN)).toEqual({ x: 10, y: 10, width: 4, height: 4 });
    });
});

describe('linuxOverlayVerdict with the run-time compositor signal', () => {
    const v = (env: Record<string, string>, compositor?: boolean | null, ozonePlatform = '') => linuxOverlayVerdict({ env, ozonePlatform, compositor });
    it('a running compositor allows a desktop the name list does not know (MATE, LXQt, i3 + picom)', () => {
        for (const d of ['MATE', 'LXQt', 'i3', 'openbox', '']) expect(v({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: d }, true)).toBeNull();
    });
    it('no compositor refuses even a desktop that composites by default (XFCE with it off, KDE with it suspended)', () => {
        for (const d of ['XFCE', 'KDE', 'ubuntu:GNOME']) expect(v({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: d }, false)).toBe('no_compositor');
    });
    it('a probe that could not run (null / undefined) leaves the name list in charge, unchanged', () => {
        for (const c of [null, undefined]) {
            expect(v({ XDG_CURRENT_DESKTOP: 'KDE' }, c)).toBeNull();
            expect(v({ XDG_CURRENT_DESKTOP: 'i3' }, c)).toBe('no_compositor');
        }
    });
    it('the overrides win over the probe, both ways', () => {
        expect(v({ XDG_CURRENT_DESKTOP: 'i3', CIPHERLINE_ANNOT_OVERLAY: '1' }, false)).toBeNull();
        expect(v({ XDG_CURRENT_DESKTOP: 'KDE', CIPHERLINE_ANNOT_OVERLAY: '0' }, true)).toBe('platform');
    });
    it('a Wayland verdict never depends on it', () => {
        expect(v({ XDG_SESSION_TYPE: 'wayland' }, true)).toBe('wayland');
        expect(linuxOverlayVerdict({ env: { XDG_SESSION_TYPE: 'wayland' }, ozonePlatform: '', waylandHelper: true, compositor: false })).toBeNull();
    });
});

describe('where the probe and X11 window shares apply', () => {
    it('probe: plain X11 only — not under Wayland (even with XWayland) and not when overridden', () => {
        expect(shouldProbeX11Compositor({ XDG_SESSION_TYPE: 'x11' })).toBe(true);
        expect(shouldProbeX11Compositor({})).toBe(true);
        expect(shouldProbeX11Compositor({ XDG_SESSION_TYPE: 'wayland' })).toBe(false);
        expect(shouldProbeX11Compositor({ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11' })).toBe(false);
        expect(shouldProbeX11Compositor({ CIPHERLINE_ANNOT_OVERLAY: '1' })).toBe(false);
        expect(shouldProbeX11Compositor({ CIPHERLINE_ANNOT_OVERLAY: '0' })).toBe(false);
    });
    it('window shares: a real X11 session only', () => {
        expect(x11WindowShareAllowed({ XDG_SESSION_TYPE: 'x11' }, '')).toBe(true);
        expect(x11WindowShareAllowed({ XDG_SESSION_TYPE: 'x11' }, 'x11')).toBe(true);
        expect(x11WindowShareAllowed({ XDG_SESSION_TYPE: 'wayland' }, '')).toBe(false);
        expect(x11WindowShareAllowed({ WAYLAND_DISPLAY: 'wayland-0' }, 'x11')).toBe(false);
        expect(x11WindowShareAllowed({ XDG_SESSION_TYPE: 'x11' }, 'wayland')).toBe(false);
    });
});

describe('createX11CompositorProbe', () => {
    const mk = (outs: Array<string | null | Error>, opts: { ttlMs?: number; available?: boolean } = {}) => {
        let t = 0;
        let i = 0;
        const logs: string[] = [];
        const run = vi.fn(async () => {
            const o = outs[Math.min(i++, outs.length - 1)];
            if (o instanceof Error) throw o;
            return o;
        });
        const probe = createX11CompositorProbe({ available: () => opts.available ?? true, run, now: () => t, log: m => logs.push(m), ttlMs: opts.ttlMs });
        return { probe, run, logs, advance: (ms: number) => { t += ms; } };
    };
    it('reads CM 1 / CM 0', async () => {
        expect(await mk(['HELLO 1\nCM 1\n']).probe.get()).toBe(true);
        expect(await mk(['HELLO 1\nCM 0\n']).probe.get()).toBe(false);
    });
    it('null when the helper cannot run, errors, or says nothing; the reason is logged once', async () => {
        const a = mk([null]);
        expect(await a.probe.get()).toBeNull();
        a.advance(5000); expect(await a.probe.get()).toBeNull();
        expect(a.logs).toHaveLength(1);
        expect(a.logs[0]).toContain('guessing from the desktop name');
        const b = mk(['HELLO 1\nERR no_x_server\n']);
        expect(await b.probe.get()).toBeNull();
        expect(b.logs[0]).toContain('no_x_server');
        expect(await mk(['garbage\n']).probe.get()).toBeNull();
        expect(await mk([new Error('spawn failed')]).probe.get()).toBeNull();
    });
    it('no helper binary: null at once, synchronously, and nothing is spawned', async () => {
        const m = mk(['CM 1\n'], { available: false });
        expect(m.probe.peek()).toBeNull();
        expect(await m.probe.get()).toBeNull();
        expect(m.run).not.toHaveBeenCalled();
        expect(m.logs).toHaveLength(1);
    });
    it('peek() is a synchronous answer only while one is fresh', async () => {
        const m = mk(['CM 1\n', 'CM 0\n']);
        expect(m.probe.peek()).toBeUndefined();
        expect(await m.probe.get()).toBe(true);
        expect(m.probe.peek()).toBe(true);
        m.advance(1100);
        expect(m.probe.peek()).toBeUndefined();
    });
    it('reuses an answer for the TTL, then asks again (and sees a flip)', async () => {
        const m = mk(['CM 1\n', 'CM 0\n']);
        expect(await m.probe.get()).toBe(true);
        m.advance(500);
        expect(await m.probe.get()).toBe(true);
        expect(m.run).toHaveBeenCalledTimes(1);
        m.advance(600);
        expect(await m.probe.get()).toBe(false);
        expect(m.run).toHaveBeenCalledTimes(2);
    });
    it('concurrent askers share one spawn', async () => {
        const m = mk(['CM 1\n']);
        const [a, b, c] = await Promise.all([m.probe.get(), m.probe.get(), m.probe.get()]);
        expect([a, b, c]).toEqual([true, true, true]);
        expect(m.run).toHaveBeenCalledTimes(1);
    });
    it('a clock that went backwards does not serve a stale answer', async () => {
        let t = 5000;
        const run = vi.fn().mockResolvedValueOnce('CM 1\n').mockResolvedValueOnce('CM 0\n');
        const probe = createX11CompositorProbe({ available: () => true, run, now: () => t, log: () => {} });
        expect(await probe.get()).toBe(true);
        t = 100;
        expect(await probe.get()).toBe(false);
    });
});

describe('createX11Watcher', () => {
    afterEach(() => { vi.useRealTimers(); });

    function fakeProc() {
        let data: ((c: Buffer | string) => void) | null = null;
        let onExit: (() => void) | null = null;
        const written: string[] = [];
        const proc = {
            stdin: {
                write: (c: string) => { written.push(c); return true; },
                end: () => {}, writableLength: 0, destroyed: false,
            },
            stdout: { on: (_e: 'data', cb: (c: Buffer | string) => void) => { data = cb; } },
            on: (e: 'exit' | 'error', cb: () => void) => { if (e === 'exit') onExit = cb; return proc; },
            kill: () => true,
        } as unknown as HelperProc;
        return { proc, written, say: (s: string) => data?.(Buffer.from(s + '\n')), exit: () => onExit?.() };
    }
    function setup(spawn: () => HelperProc | null) {
        const events = { cm: [] as boolean[], win: [] as X11WindowReport[], lost: 0 };
        const w = createX11Watcher({ spawnHelper: spawn, log: () => {}, stepTimeoutMs: 50 }, {
            onCompositor: c => events.cm.push(c),
            onWindow: r => events.win.push(r),
            onLost: () => { events.lost++; },
        });
        return { w, events };
    }

    it('start() resolves to the first compositor state; later changes go to onCompositor only', async () => {
        const f = fakeProc();
        const { w, events } = setup(() => f.proc);
        const p = w.start();
        f.say('HELLO 1'); f.say('CM 1'); f.say('READY x11_watch=1');
        expect(await p).toBe(true);
        expect(w.isRunning()).toBe(true);
        expect(events.cm).toEqual([]);
        f.say('CM 0'); f.say('CM 1');
        expect(events.cm).toEqual([false, true]);
    });

    it('start() is null when there is no helper, when it reports an error, when it exits, or when it never answers', async () => {
        expect(await setup(() => null).w.start()).toBeNull();
        const e = fakeProc(); const a = setup(() => e.proc);
        const pe = a.w.start(); e.say('HELLO 1'); e.say('ERR no_libx11');
        expect(await pe).toBeNull();
        expect(a.w.isRunning()).toBe(false);
        const x = fakeProc(); const b = setup(() => x.proc);
        const px = b.w.start(); x.exit();
        expect(await px).toBeNull();
        vi.useFakeTimers();
        const s = fakeProc(); const c = setup(() => s.proc);
        const ps = c.w.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(await ps).toBeNull();
        expect(c.w.isRunning()).toBe(false);
    });

    it('track() sends WIN, resolves to the first report, and every later report reaches onWindow', async () => {
        const f = fakeProc();
        const { w, events } = setup(() => f.proc);
        const p = w.start(); f.say('CM 1'); await p;
        const t = w.track('4242');
        expect(f.written).toContain('WIN 4242\n');
        f.say('W ok 1 2 30 40');
        expect(await t).toEqual({ state: 'ok', frame: { x: 1, y: 2, width: 30, height: 40 } });
        f.say('W minimized 0 0 0 0');
        expect(events.win.map(r => r.state)).toEqual(['ok', 'minimized']);
    });

    it('track() refuses anything that is not a plain decimal id, and answers null before start / after stop', async () => {
        const f = fakeProc();
        const { w } = setup(() => f.proc);
        expect(await w.track('1')).toBeNull();
        const p = w.start(); f.say('CM 1'); await p;
        for (const bad of ['1; rm', '-1', '', '12345678901', '0x10']) expect(await w.track(bad)).toBeNull();
        expect(f.written.filter(l => l.startsWith('WIN'))).toEqual([]);
        w.stop();
        expect(await w.track('5')).toBeNull();
    });

    it('stop() sends QUIT and silences everything the helper still says', async () => {
        const f = fakeProc();
        const { w, events } = setup(() => f.proc);
        const p = w.start(); f.say('CM 1'); await p;
        w.stop();
        expect(f.written.at(-1)).toBe('QUIT\n');
        f.say('CM 0'); f.say('W ok 1 1 1 1');
        expect(events.cm).toEqual([]);
        expect(events.win).toEqual([]);
        expect(w.isRunning()).toBe(false);
    });

    it('a helper that dies while watching is reported once (onLost), not as a compositor change', async () => {
        const f = fakeProc();
        const { w, events } = setup(() => f.proc);
        const p = w.start(); f.say('CM 1'); await p;
        f.exit();
        expect(events.lost).toBe(1);
        expect(events.cm).toEqual([]);
    });

    it('lines that are not well-formed are ignored (a hostile or buggy helper cannot invent an event)', async () => {
        const f = fakeProc();
        const { w, events } = setup(() => f.proc);
        const p = w.start(); f.say('CM 1'); await p;
        f.say('CM 7'); f.say('W ok 1 2'); f.say('rm -rf /'); f.say('W ok 5 5 -3 4');
        expect(events.cm).toEqual([]);
        expect(events.win).toEqual([]);
    });
});
