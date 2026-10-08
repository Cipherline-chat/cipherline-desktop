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

let displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number } }> = [];
vi.mock('electron', () => ({
    app: { commandLine: { getSwitchValue: () => '' } },
    BrowserWindow: FakeWindow,
    screen: {
        getAllDisplays: () => displays,
        on: () => {},
        dipToScreenRect: (_w: unknown, r: unknown) => r,
        screenToDipRect: (_w: unknown, r: unknown) => r,
    },
}));

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
// os.tmpdir() follows process.platform: under a faked win32 it reads TEMP.
const REAL_TMP = (await import('os')).tmpdir();
const ENV_KEYS = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'CIPHERLINE_ANNOT_OVERLAY', 'TEMP'] as const;
let savedEnv: Record<string, string | undefined> = {};

async function load() {
    const mod = await import('./annotation-overlay');
    mod.hideAnnotationOverlay();
    return mod;
}

beforeEach(() => {
    created.length = 0;
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
        expect(ov.annotationOverlayPrecheck('window')).toBeNull();
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        // An addon from before window_geometry_mac.mm (audio only) is "missing" too.
        ov.setAnnotationOverlayNative({ startCapture() {}, getPidFromSourceId() { return 1; } });
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        // The Windows calls alone do not drive the mac path.
        ov.setAnnotationOverlayNative({ getWindowInfo: () => ({ exists: true }), placeOverlayAbove: () => true });
        expect(ov.showAnnotationOverlay({ id: 'window:1234:0', display_id: '' })).toMatchObject({ ok: false, reason: 'addon_missing' });
        setPlatform('linux');
        ov = await load();
        expect(ov.annotationOverlayPrecheck('window')).toEqual({ ok: false, reason: 'platform' });
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
        expect(ov.annotationOverlayPrecheck('screen')).toEqual({ ok: false, reason: 'no_compositor' });
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
