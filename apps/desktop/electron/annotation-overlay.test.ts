/**
 * electron/annotation-overlay.ts against a fake `electron`: what the show
 * call answers on each platform, and that the overlay page always learns its
 * geometry after it has loaded.
 *
 * The geometry case is the 2026-10-08 regression class: syncGeometry() now
 * skips a layout it has "already sent", and a resize/move while the page is
 * still loading sends the layout to the document being replaced. Without the
 * reset in did-finish-load the loaded page never received a layout and drew
 * nothing at all — on a desk where Windows nudges a new window (DPI fix-up,
 * work-area clamp) before its page loads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Listener = (...args: unknown[]) => void;
class Emitter {
    private ls = new Map<string, Listener[]>();
    on(ev: string, cb: Listener) { this.ls.set(ev, [...(this.ls.get(ev) ?? []), cb]); return this; }
    emit(ev: string, ...a: unknown[]) { for (const cb of this.ls.get(ev) ?? []) cb(...a); }
}

const created: FakeWindow[] = [];
class FakeWindow extends Emitter {
    bounds: { x: number; y: number; width: number; height: number };
    destroyed = false;
    visible = false;
    loaded = false;
    /** geometry messages the LOADED page received */
    pageGeometry: unknown[] = [];
    /** everything sent before the page loaded (goes to the old document) */
    lostBeforeLoad: string[] = [];
    contentProtection = false;
    webContents: Emitter & { send: (ch: string, payload: unknown) => void };
    constructor(public opts: Record<string, unknown>) {
        super();
        this.bounds = { x: opts.x as number, y: opts.y as number, width: opts.width as number, height: opts.height as number };
        const wc = new Emitter() as Emitter & { send: (ch: string, payload: unknown) => void };
        wc.send = (ch, payload) => {
            if (!this.loaded) { this.lostBeforeLoad.push(ch); return; }
            if (ch === 'annot-overlay:geometry') this.pageGeometry.push(payload);
        };
        this.webContents = wc;
        created.push(this);
    }
    setMenu() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection(v: boolean) { this.contentProtection = v; }
    getNativeWindowHandle() { return Buffer.from([1, 2, 0, 0, 0, 0, 0, 0]); }
    getContentBounds() { return { ...this.bounds }; }
    setContentBounds(b: typeof this.bounds) { this.bounds = { ...b }; }
    setBoundsCalls = 0;
    getBounds() { return { ...this.bounds }; }
    setBounds(b: typeof this.bounds) { this.setBoundsCalls++; this.bounds = { ...b }; this.emit('move'); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    showInactive() { this.visible = true; }
    isVisible() { return this.visible; }
    hide() { this.visible = false; }
    moveTop() {}
    loadFile() { return Promise.resolve(); }
    /** Test hook: the page finished loading. */
    finishLoad() { this.loaded = true; this.webContents.emit('did-finish-load'); }
}

let primaryScale = 1;
let displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number } }> = [];
vi.mock('electron', () => ({
    app: { commandLine: { getSwitchValue: () => '' } },
    BrowserWindow: FakeWindow,
    screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => ({ id: 1, scaleFactor: primaryScale }),
        on: () => {},
        dipToScreenRect: (_w: unknown, r: unknown) => r,
        screenToDipRect: (_w: unknown, r: unknown) => r,
    },
}));

// The Wayland overlay spawns a native helper; the tests give it a scripted fake.
type SpawnArgs = [string, string[], { stdio: unknown; env: Record<string, string | undefined> }];
let spawnImpl: (...a: SpawnArgs) => unknown = () => { throw new Error('unexpected spawn'); };
type ExecCb = (err: Error | null, stdout?: string) => void;
let execFileImpl: (...a: unknown[]) => void = (...a) => { (a[3] as ExecCb)(new Error('unexpected execFile')); };
vi.mock('child_process', () => ({ spawn: (...a: SpawnArgs) => spawnImpl(...a), execFile: (...a: unknown[]) => execFileImpl(...a) }));

// The helper's DEFAULT location (build/Release/cl-wayland-overlay) exists in a tree that ran
// `npm run rebuild-native`; hide it so every test here depends only on what it sets up itself
// (CIPHERLINE_WAYLAND_OVERLAY_HELPER), never on whether this checkout happens to be built.
vi.mock('fs', async (importOriginal) => {
    const real = await importOriginal<typeof import('fs')>();
    const hidden = (p: unknown) => String(p).replace(/\\/g, '/').endsWith('build/Release/cl-wayland-overlay');
    const statSync = ((p: Parameters<typeof real.statSync>[0], ...rest: unknown[]) => {
        if (hidden(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return (real.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.statSync;
    return { ...real, statSync, default: { ...real, statSync } };
});

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
// os.tmpdir() follows process.platform: under a faked win32 it reads TEMP.
const REAL_TMP = (await import('os')).tmpdir();
const ENV_KEYS = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'CIPHERLINE_ANNOT_OVERLAY', 'CIPHERLINE_WAYLAND_OVERLAY_HELPER', 'DISPLAY', 'SECRET_SHOULD_NOT_LEAK', 'TEMP'] as const;
let savedEnv: Record<string, string | undefined> = {};

async function load() {
    const mod = await import('./annotation-overlay');
    mod.hideAnnotationOverlay();
    return mod;
}

beforeEach(() => {
    created.length = 0;
    primaryScale = 1;
    displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.TEMP = REAL_TMP;
});
afterEach(async () => {
    (await import('./annotation-overlay')).hideAnnotationOverlay();
    setPlatform(realPlatform);
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('overlay page geometry', () => {
    it('a resize/move while the page is loading does not stop the loaded page from getting its layout', async () => {
        setPlatform('win32');
        const ov = await load();
        expect(ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toMatchObject({ ok: true });
        const win = created.at(-1)!;
        win.emit('move');                 // the OS nudged the window before load
        expect(win.lostBeforeLoad).toContain('annot-overlay:geometry');
        win.finishLoad();
        expect(win.pageGeometry.length).toBeGreaterThan(0);
        expect(win.visible).toBe(true);
    });

    it('positive control: with no pre-load event the page gets its layout too', async () => {
        setPlatform('win32');
        const ov = await load();
        ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        const win = created.at(-1)!;
        win.finishLoad();
        expect(win.pageGeometry).toHaveLength(1);
    });

    it('two windows in a row load two different page files', async () => {
        setPlatform('win32');
        const ov = await load();
        const files: string[] = [];
        const orig = FakeWindow.prototype.loadFile;
        FakeWindow.prototype.loadFile = function (p: string) { files.push(p); return Promise.resolve(); } as typeof orig;
        try {
            ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
            ov.hideAnnotationOverlay();
            ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        } finally { FakeWindow.prototype.loadFile = orig; }
        expect(files).toHaveLength(2);
        expect(files[0]).not.toBe(files[1]);
    });
});

describe('show result per platform', () => {
    it('Windows / macOS screen share: shown, excluded from capture', async () => {
        for (const p of ['win32', 'darwin']) {
            setPlatform(p);
            const ov = await load();
            expect(ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toEqual({ ok: true, how: 'only-display', captured: false });
            expect(created.at(-1)!.contentProtection).toBe(true);
        }
    });

    it('several displays and no way to tell which is shared: refused with the count, never a guess', async () => {
        setPlatform('win32');
        displays = [displays[0], { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }];
        const ov = await load();
        expect(ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toEqual({ ok: false, reason: 'no_display_match', displays: 2, addon: false });
        expect(created).toHaveLength(0);
    });

    it('window shares: Windows and macOS need the addon; Linux refused as platform', async () => {
        setPlatform('win32');
        let ov = await load();
        ov.setAnnotationOverlayNative(null);
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        setPlatform('darwin');
        ov = await load();
        expect(await ov.annotationOverlayPrecheck('window')).toBeNull();
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        // An addon from before window_geometry_mac.mm (audio only) is "missing" too.
        ov.setAnnotationOverlayNative({ startCapture() {}, getPidFromSourceId() { return 1; } });
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        // The Windows calls alone do not drive the mac path.
        ov.setAnnotationOverlayNative({ getWindowInfo: () => ({ exists: true }), placeOverlayAbove: () => true });
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        setPlatform('linux');
        // Wayland / portal: no protocol exposes a window position, so it stays refused as 'platform'.
        process.env.XDG_SESSION_TYPE = 'wayland';
        ov = await load();
        expect(await ov.annotationOverlayPrecheck('window')).toEqual({ ok: false, reason: 'platform' });
        // A real X11 session is no longer refused for being a window share: it gets the same compositor check as a screen share.
        process.env.XDG_SESSION_TYPE = 'x11';
        process.env.XDG_CURRENT_DESKTOP = 'i3';
        expect(await ov.annotationOverlayPrecheck('window')).toEqual({ ok: false, reason: 'no_compositor' });
        expect(created).toHaveLength(0);
    });

    it('Linux X11 on a compositing desktop: shown, and says it is captured into the share', async () => {
        setPlatform('linux');
        process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME';
        process.env.XDG_SESSION_TYPE = 'x11';
        const ov = await load();
        expect(ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toEqual({ ok: true, how: 'only-display', captured: true });
    });

    it('Linux Wayland / no compositor: refused before anything is created', async () => {
        setPlatform('linux');
        process.env.XDG_CURRENT_DESKTOP = 'GNOME';
        process.env.WAYLAND_DISPLAY = 'wayland-0';
        let ov = await load();
        expect(ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toEqual({ ok: false, reason: 'wayland' });
        delete process.env.WAYLAND_DISPLAY;
        process.env.XDG_CURRENT_DESKTOP = 'i3';
        ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'no_compositor' });
        expect(created).toHaveLength(0);
    });
});

describe('macOS window shares (window_geometry_mac.mm backend)', () => {
    type Info = { exists: boolean; visible?: boolean; minimized?: boolean; cloaked?: boolean; frame?: unknown };
    let info: Info;
    const ordered: Array<[string, string]> = [];
    const macNative = () => ({
        getWindowInfo: (id: string) => (id === '777' ? info : { exists: false }),
        orderOverlayAbove: (handle: string, id: string) => { ordered.push([handle, id]); return true; },
    });
    beforeEach(() => {
        vi.useFakeTimers();
        ordered.length = 0;
        info = { exists: true, visible: true, minimized: false, cloaked: false, frame: { x: -1700, y: -60, width: 1280, height: 900 } };
    });
    afterEach(() => { vi.useRealTimers(); });

    it('shown over the CG frame unchanged (no DIP conversion), never captured', async () => {
        setPlatform('darwin');
        const ov = await load();
        ov.setAnnotationOverlayNative(macNative());
        expect(ov.showAnnotationOverlay({ id: 'window:777:0', display_id: '' })).toEqual({ ok: true, how: 'window', captured: false });
        const win = created.at(-1)!;
        expect(win.bounds).toEqual({ x: -1700, y: -60, width: 1280, height: 900 });
        expect(win.contentProtection).toBe(true);
        expect(win.opts.alwaysOnTop).toBe(false);   // stacked by the addon, not floated over everything
    });

    it('tracks moves, stacks above the target every tick, hides when off screen, closes when gone', async () => {
        setPlatform('darwin');
        const ov = await load();
        ov.setAnnotationOverlayNative(macNative());
        ov.showAnnotationOverlay({ id: 'window:777:0', display_id: '' });
        const win = created.at(-1)!;
        win.finishLoad();
        expect(win.visible).toBe(true);
        expect(ordered.at(-1)).toEqual(['513', '777']);   // getNativeWindowHandle() [1,2,0..] little-endian = 513
        info = { ...info, frame: { x: 10.4, y: 20.6, width: 300, height: 200 } };
        vi.advanceTimersByTime(20);
        expect(win.bounds).toEqual({ x: 10, y: 21, width: 300, height: 200 });
        const calls = win.setBoundsCalls;
        vi.advanceTimersByTime(100);
        expect(win.setBoundsCalls).toBe(calls);          // unchanged frame: no redundant setBounds
        info = { ...info, visible: false };               // minimized / other Space / app hidden
        vi.advanceTimersByTime(20);
        expect(win.visible).toBe(false);
        expect(win.destroyed).toBe(false);
        const orderedWhileHidden = ordered.length;
        vi.advanceTimersByTime(100);
        expect(ordered.length).toBe(orderedWhileHidden);   // never re-ordered while hidden
        info = { ...info, visible: true };
        vi.advanceTimersByTime(20);
        expect(win.visible).toBe(true);
        info = { exists: false };
        vi.advanceTimersByTime(20);
        expect(win.destroyed).toBe(true);
        expect(ov.isAnnotationOverlayShown()).toBe(false);
    });

    it('a window that is already gone is refused, nothing created', async () => {
        setPlatform('darwin');
        const ov = await load();
        ov.setAnnotationOverlayNative(macNative());
        expect(ov.showAnnotationOverlay({ id: 'window:778:0', display_id: '' })).toEqual({ ok: false, reason: 'window_gone' });
        expect(created).toHaveLength(0);
    });
});

describe('Linux Wayland with the native overlay helper', () => {
    let helperFile = '';
    const written: string[] = [];
    let spawned: Array<SpawnArgs> = [];
    let ready = 'READY layer_shell=1 x11=0';

    /** A fake `cl-wayland-overlay` child: answers HELLO/OUT/READY, then SHOWN to SHOW/SHOWX. */
    function fakeChild() {
        let data: ((c: Buffer) => void) | null = null;
        const child = {
            stdin: {
                write: (c: string) => {
                    written.push(c);
                    const m = /^SHOWX? (\d+)/.exec(c);
                    if (m) queueMicrotask(() => data?.(Buffer.from(`SHOWN ${m[1]} 1920 1080 1\n`)));
                    return true;
                },
                end: () => {},
                writableLength: 0,
                destroyed: false,
            },
            stdout: { on: (_e: string, cb: (c: Buffer) => void) => { data = cb; queueMicrotask(() => data?.(Buffer.from(`HELLO 1\nOUT 0 DP-1 0 0 1920 1080 1 1920 1080\n${ready}\n`))); } },
            on: () => child,
            kill: () => true,
        };
        return child;
    }

    beforeEach(async () => {
        vi.resetModules();     // a fresh module: the "no layer-shell" verdict is remembered per process
        const fs = await import('fs');
        const os = await import('os');
        helperFile = (await import('path')).join(fs.mkdtempSync((await import('path')).join(os.tmpdir(), 'cl-wlo-test-')), 'cl-wayland-overlay');
        fs.writeFileSync(helperFile, '#!/bin/sh\n', { mode: 0o755 });
        written.length = 0;
        spawned = [];
        ready = 'READY layer_shell=1 x11=0';
        spawnImpl = (...a) => { spawned.push(a); return fakeChild(); };
        displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }] as typeof displays;
        setPlatform('linux');
        process.env.XDG_SESSION_TYPE = 'wayland';
        process.env.WAYLAND_DISPLAY = 'wayland-1';
        process.env.XDG_CURRENT_DESKTOP = 'KDE';
        process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER = helperFile;
        process.env.SECRET_SHOULD_NOT_LEAK = 'hunter2';
    });
    afterEach(async () => {
        spawnImpl = () => { throw new Error('unexpected spawn'); };
        (await import('fs')).rmSync((await import('path')).dirname(helperFile), { recursive: true, force: true });
    });

    it('a Wayland screen share is shown through the helper, captured into the share, and no Electron window is created', async () => {
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toBeNull();
        const r = await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' }, { width: 1920, height: 1080 });
        expect(r).toEqual({ ok: true, how: 'wl-layer-only-display', captured: true });
        expect(created).toHaveLength(0);
        expect(written).toEqual(['SHOW 0\n']);
        expect(ov.isAnnotationOverlayShown()).toBe(true);
    });

    it('the helper is started with the path from the install and ONLY the compositor-related environment', async () => {
        const ov = await load();
        process.env.WAYLAND_DISPLAY = 'wayland-7';
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' }, { width: 1920, height: 1080 });
        expect(spawned).toHaveLength(1);
        const [bin, args, opts] = spawned[0];
        expect(bin).toBe(helperFile);
        expect(args).toEqual([]);
        expect(opts.stdio).toEqual(['pipe', 'pipe', 'ignore']);
        expect(opts.env.WAYLAND_DISPLAY).toBe('wayland-7');
        expect(opts.env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
        expect(Object.keys(opts.env).every(k => ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'HOME'].includes(k))).toBe(true);
    });

    it('strokes pushed to main reach the helper as validated lines, and hide() stops it', async () => {
        const ov = await load();
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' }, { width: 1920, height: 1080 });
        ov.pushAnnotationOverlayDelta({ reset: true, upsert: [{ id: 'abc', color: '#ff3b6b', width: 4, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], updatedAt: Date.now(), closedAt: 0 }] });
        expect(written[1]).toBe('Z\n');
        expect(written[2]).toMatch(/^U 1 ff3b6b 40 \d+ 0 2 0,0 65535,65535\n$/);
        ov.hideAnnotationOverlay();
        expect(written.at(-1)).toBe('QUIT\n');
        expect(ov.isAnnotationOverlayShown()).toBe(false);
    });

    it('GNOME (layer-shell absent, XWayland present) uses SHOWX', async () => {
        ready = 'READY layer_shell=0 x11=1';
        process.env.XDG_CURRENT_DESKTOP = 'GNOME';
        const ov = await load();
        expect(await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' }, { width: 1920, height: 1080 })).toMatchObject({ ok: true, how: 'wl-x11-only-display', captured: true });
        expect(written).toEqual(['SHOWX 0\n']);
    });

    it('a compositor that can host neither: a clear refusal, in-app preview only', async () => {
        ready = 'READY layer_shell=0 x11=0';
        const ov = await load();
        expect(await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' }, { width: 1920, height: 1080 })).toEqual({ ok: false, reason: 'no_layer_shell' });
        expect(created).toHaveLength(0);
    });

    it('window shares are still refused on Linux, even with the helper', async () => {
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('window')).toEqual({ ok: false, reason: 'platform' });
        expect(spawned).toHaveLength(0);
    });

    it('a junk frame hint is ignored (a lone display is still unambiguous), never trusted', async () => {
        const ov = await load();
        expect(await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' }, { width: 'huge', height: -1 })).toMatchObject({ ok: true });
    });

    it('CIPHERLINE_ANNOT_OVERLAY=0 switches it off', async () => {
        process.env.CIPHERLINE_ANNOT_OVERLAY = '0';
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'platform' });
        expect(spawned).toHaveLength(0);
    });

    it('without the helper binary a Wayland session is refused exactly as before', async () => {
        delete process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER;
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'wayland' });
        expect(spawned).toHaveLength(0);
    });

    it('X11 sessions never run the helper\'s WAYLAND protocol (only its plain-X11 modes, which the X11 suite below covers)', async () => {
        process.env.XDG_SESSION_TYPE = 'x11';
        delete process.env.WAYLAND_DISPLAY;
        process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME';
        execFileImpl = (...a) => (a[3] as ExecCb)(null, 'HELLO 1\nCM 1\n');
        const ov = await load();
        expect(await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toEqual({ ok: true, how: 'only-display', captured: true });
        expect(spawned.every(s => s[1].length === 1 && s[1][0] === '--x11-watch')).toBe(true);
        expect(written).toEqual([]);
    });
});

describe('Linux X11: the compositor is asked at run time, and watched while the overlay is up', () => {
    let helperFile = '';
    let spawned: Array<SpawnArgs> = [];
    let syncCalls: unknown[][] = [];
    const written: string[] = [];
    /** What the fake `--x11-watch` child says at start, and a handle to make it say more later. */
    let cmAtStart = 1;
    let winAtTrack = 'ok 100 200 800 600';
    let say: (line: string) => void = () => {};
    let helperExited: () => void = () => {};

    function fakeWatchChild() {
        let data: ((c: Buffer) => void) | null = null;
        const child = {
            stdin: {
                write: (c: string) => {
                    written.push(c);
                    const m = /^WIN (\d+)/.exec(c);
                    if (m) queueMicrotask(() => data?.(Buffer.from(`W ${winAtTrack}\n`)));
                    return true;
                },
                end: () => {},
                writableLength: 0,
                destroyed: false,
            },
            stdout: {
                on: (_e: string, cb: (c: Buffer) => void) => {
                    data = cb;
                    say = (line) => cb(Buffer.from(line + '\n'));
                    queueMicrotask(() => cb(Buffer.from(`HELLO 1\nCM ${cmAtStart}\nREADY x11_watch=1\n`)));
                },
            },
            on: (e: string, cb: () => void) => { if (e === 'exit') helperExited = cb; return child; },
            kill: () => true,
        };
        return child;
    }
    /** What the (asynchronous) `--x11-probe` prints: CM 1 / CM 0, or a failure to run. */
    const setProbe = (v: 0 | 1 | 'fail') => {
        execFileImpl = (...a) => {
            syncCalls.push(a);
            const cb = a[3] as ExecCb;
            if (v === 'fail') cb(new Error('ENOENT')); else cb(null, `HELLO 1\nCM ${v}\n`);
        };
    };
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        helperFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-x11-test-')), 'cl-wayland-overlay');
        fs.writeFileSync(helperFile, '#!/bin/sh\n', { mode: 0o755 });
        written.length = 0;
        spawned = [];
        syncCalls = [];
        cmAtStart = 1;
        winAtTrack = 'ok 100 200 800 600';
        spawnImpl = (...a) => { spawned.push(a); return fakeWatchChild(); };
        setProbe(1);
        setPlatform('linux');
        process.env.XDG_SESSION_TYPE = 'x11';
        process.env.DISPLAY = ':0';
        process.env.XDG_CURRENT_DESKTOP = 'i3';           // NOT in the name list: only the probe can allow it
        process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER = helperFile;
    });
    afterEach(async () => {
        vi.useRealTimers();
        spawnImpl = () => { throw new Error('unexpected spawn'); };
        execFileImpl = (...a) => (a[3] as ExecCb)(new Error('unexpected execFile'));
        (await import('fs')).rmSync((await import('path')).dirname(helperFile), { recursive: true, force: true });
    });

    it('the probe, not the desktop name, decides: i3 + a running compositor is allowed (positive control)', async () => {
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toBeNull();
        expect(syncCalls).toHaveLength(1);
        expect(syncCalls[0][0]).toBe(helperFile);
        expect(syncCalls[0][1]).toEqual(['--x11-probe']);
    });

    it('...and GNOME with compositing suspended is refused (negative control: the name list alone would have shown it)', async () => {
        process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME';
        setProbe(0);
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'no_compositor' });
        expect(created).toHaveLength(0);
    });

    it('the probe runs with the minimal environment, no shell, and its answer is reused for a moment (precheck + show = one spawn)', async () => {
        const ov = await load();
        ov.annotationOverlayPrecheck('screen');
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        expect(syncCalls).toHaveLength(1);
        const opts = syncCalls[0][2] as { env: Record<string, string>; timeout: number; shell?: boolean };
        expect(opts.shell).toBeUndefined();
        expect(opts.timeout).toBeGreaterThan(0);
        expect(Object.keys(opts.env).every(k => ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'HOME'].includes(k))).toBe(true);
        vi.setSystemTime(1_000_000 + 1500);
        ov.annotationOverlayPrecheck('screen');
        expect(syncCalls).toHaveLength(2);                  // stale: asked again
    });

    it('a probe that cannot run falls back to the desktop name, exactly as before', async () => {
        setProbe('fail');
        process.env.XDG_CURRENT_DESKTOP = 'i3';
        let ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'no_compositor' });
        process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME';
        vi.setSystemTime(1_000_000 + 5000);
        ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toBeNull();
    });

    it('a build without the helper binary also falls back (no spawn at all)', async () => {
        delete process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER;
        process.env.XDG_CURRENT_DESKTOP = 'KDE';
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toBeNull();
        expect(syncCalls).toHaveLength(0);
    });

    it('CIPHERLINE_ANNOT_OVERLAY=1 / =0 still override, and neither asks X anything', async () => {
        process.env.CIPHERLINE_ANNOT_OVERLAY = '1';
        let ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toBeNull();
        process.env.CIPHERLINE_ANNOT_OVERLAY = '0';
        ov = await load();
        expect(await ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'platform' });
        expect(syncCalls).toHaveLength(0);
        expect(spawned).toHaveLength(0);
    });

    it('a Wayland session never runs the X probe (the Wayland compositor need not own the X selection)', async () => {
        process.env.XDG_SESSION_TYPE = 'wayland';
        process.env.WAYLAND_DISPLAY = 'wayland-0';
        process.env.XDG_CURRENT_DESKTOP = 'GNOME';
        const ov = await load();
        // ozone-platform is '' in this mock, so this is a native-Wayland verdict with the helper present: allowed, no X probe.
        expect(await ov.annotationOverlayPrecheck('screen')).toBeNull();
        expect(syncCalls).toHaveLength(0);
    });

    it('screen share: watched while up; when the compositor goes away the overlay is taken down at once and the renderer is told', async () => {
        const ov = await load();
        const ended: string[] = [];
        ov.setAnnotationOverlayEndedListener(r => ended.push(r));
        expect(await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toEqual({ ok: true, how: 'only-display', captured: true });
        await flush();
        expect(spawned).toHaveLength(1);
        expect(spawned[0][1]).toEqual(['--x11-watch']);
        const win = created.at(-1)!;
        win.finishLoad();
        expect(win.visible).toBe(true);
        say('CM 1');                                          // unchanged: nothing happens
        expect(win.destroyed).toBe(false);
        say('CM 0');
        expect(win.destroyed).toBe(true);
        expect(ov.isAnnotationOverlayShown()).toBe(false);
        expect(ended).toEqual(['no_compositor']);
        expect(written.at(-1)).toBe('QUIT\n');
        // ...and when it is back, the next show works again
        setProbe(1);
        vi.setSystemTime(1_000_000 + 3000);
        expect(await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' })).toMatchObject({ ok: true });
        expect(created).toHaveLength(2);
    });

    it('...but CM events do nothing to a share the user forced on with =1 (no watcher for a screen share, none needed)', async () => {
        process.env.CIPHERLINE_ANNOT_OVERLAY = '1';
        const ov = await load();
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        await flush();
        expect(spawned).toHaveLength(0);
        expect(created.at(-1)!.destroyed).toBe(false);
    });

    it('the compositor already gone by the time the watcher answers takes the fresh overlay straight back down', async () => {
        const ov = await load();
        const ended: string[] = [];
        ov.setAnnotationOverlayEndedListener(r => ended.push(r));
        cmAtStart = 0;                                        // lost between the precheck's probe and the watcher's first look
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        await flush();
        expect(created.at(-1)!.destroyed).toBe(true);
        expect(ended).toEqual(['no_compositor']);
    });

    it('hiding the overlay stops the watcher; a watcher that dies by itself leaves the overlay alone', async () => {
        const ov = await load();
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        await flush();
        helperExited();
        expect(created.at(-1)!.destroyed).toBe(false);        // monitoring lost, overlay kept (the launch-time answer stands)
        written.length = 0;
        await ov.showAnnotationOverlay({ id: 'screen:0:0', display_id: '' });
        ov.hideAnnotationOverlay();
        expect(created.at(-1)!.destroyed).toBe(true);
    });

    // ── window shares ──
    const WIN = { id: 'window:4242:0', display_id: '' };

    it('window share: placed on the window\'s frame, above everything, not captured; WIN is sent to the helper', async () => {
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('window')).toBeNull();
        expect(await ov.showAnnotationOverlay(WIN)).toEqual({ ok: true, how: 'x11-window', captured: false });
        expect(written).toContain('WIN 4242\n');
        const win = created.at(-1)!;
        expect(win.bounds).toEqual({ x: 100, y: 200, width: 800, height: 600 });
        expect(win.opts.alwaysOnTop).toBe(true);
        win.finishLoad();
        expect(win.visible).toBe(true);
    });

    it('window share: physical px become DIP by the (single) X11 device scale factor', async () => {
        primaryScale = 2;
        winAtTrack = 'ok 200 400 1600 1200';
        const ov = await load();
        await ov.showAnnotationOverlay(WIN);
        expect(created.at(-1)!.bounds).toEqual({ x: 100, y: 200, width: 800, height: 600 });
    });

    it('window share follows moves and resizes, hides while minimized / on another workspace, shows again, closes when the window is gone', async () => {
        const ov = await load();
        await ov.showAnnotationOverlay(WIN);
        const win = created.at(-1)!;
        win.finishLoad();
        say('W ok 150 260 900 500');
        expect(win.bounds).toEqual({ x: 150, y: 260, width: 900, height: 500 });
        const calls = win.setBoundsCalls;
        say('W ok 150 260 900 500');
        expect(win.setBoundsCalls).toBe(calls);               // same frame: no redundant setBounds
        for (const state of ['minimized', 'workspace', 'unmapped']) {
            say(`W ${state} 0 0 0 0`);
            expect(win.visible).toBe(false);
            expect(win.destroyed).toBe(false);
            say('W ok 150 260 900 500');
            expect(win.visible).toBe(true);
        }
        say('W gone 0 0 0 0');
        expect(win.destroyed).toBe(true);
        expect(ov.isAnnotationOverlayShown()).toBe(false);
        expect(written.at(-1)).toBe('QUIT\n');
    });

    it('window share is NOT shown while the window starts hidden, and appears when it does', async () => {
        winAtTrack = 'minimized 0 0 0 0';
        const ov = await load();
        expect(await ov.showAnnotationOverlay(WIN)).toMatchObject({ ok: true });
        const win = created.at(-1)!;
        win.finishLoad();
        expect(win.visible).toBe(false);
        say('W ok 10 20 300 200');
        expect(win.visible).toBe(true);
        expect(win.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    });

    it('window share: refused with the usual reasons — no compositor, window already gone, no helper, bad id', async () => {
        let ov = await load();
        winAtTrack = 'gone 0 0 0 0';
        expect(await ov.showAnnotationOverlay(WIN)).toEqual({ ok: false, reason: 'window_gone' });
        expect(created).toHaveLength(0);
        expect(await ov.showAnnotationOverlay({ id: 'window:0:0', display_id: '' })).toEqual({ ok: false, reason: 'bad_source' });
        expect(await ov.showAnnotationOverlay({ id: 'window:99999999999:0', display_id: '' })).toEqual({ ok: false, reason: 'bad_source' });
        setProbe(0);
        vi.setSystemTime(1_000_000 + 5000);
        ov = await load();
        expect(await ov.annotationOverlayPrecheck('window')).toEqual({ ok: false, reason: 'no_compositor' });
        // The name-list fallback allows KDE; with no helper binary there is nothing to ask the window's position of.
        delete process.env.CIPHERLINE_WAYLAND_OVERLAY_HELPER;
        process.env.XDG_CURRENT_DESKTOP = 'KDE';
        vi.setSystemTime(1_000_000 + 10_000);
        ov = await load();
        expect(await ov.showAnnotationOverlay(WIN)).toEqual({ ok: false, reason: 'helper_failed' });
    });

    it('window share: the compositor going away mid-share takes it down and reports it, same as a screen share', async () => {
        const ov = await load();
        const ended: string[] = [];
        ov.setAnnotationOverlayEndedListener(r => ended.push(r));
        await ov.showAnnotationOverlay(WIN);
        const win = created.at(-1)!;
        win.finishLoad();
        say('CM 0');
        expect(win.destroyed).toBe(true);
        expect(ended).toEqual(['no_compositor']);
    });

    it('Wayland / portal window shares stay refused, and no helper is run for them (path unchanged)', async () => {
        process.env.XDG_SESSION_TYPE = 'wayland';
        process.env.WAYLAND_DISPLAY = 'wayland-0';
        const ov = await load();
        expect(await ov.annotationOverlayPrecheck('window')).toEqual({ ok: false, reason: 'platform' });
        expect(await ov.showAnnotationOverlay({ id: 'window:0:0', display_id: '' })).toMatchObject({ ok: false });
        expect(spawned).toHaveLength(0);
        expect(syncCalls).toHaveLength(0);
    });
});
