import { describe, it, expect } from 'vitest';
import {
    parseScreenSourceIndex, parseWindowSourceHandle, cleanRect, resolveCapturedDisplay,
    cleanWindowInfo, windowOverlayPlacement, nativeHandleToDecimal, linuxOverlayVerdict, type DisplayCandidate, type Rect,
} from './annotation-overlay-target';
import { overlayCanvasLayout, renderedScreenPoint } from './annotation-overlay-projection';

/**
 * The owner's desk (bug report 2026-10-08): a 2560x1440 primary at 125 %
 * between two 1080x1920 portraits at 100 %, the portraits hanging 480 px
 * above the primary's top edge — so negative X on the left, negative Y on
 * both portraits, and two monitors of the identical size.
 *
 * `displays` is in getAllDisplays() order (EnumDisplayMonitors: primary
 * first here). `adapter` is the EnumDisplayDevicesW index each monitor has —
 * the number in its `screen:<n>:0` source id under GDI/WGC — and it is a
 * DIFFERENT order, with a gap (index 2 is an inactive adapter output).
 */
const PRIMARY = 2779098405;
const LEFT = 1166435861;
const RIGHT = 3712358218;
const displays: DisplayCandidate[] = [
    { id: PRIMARY, bounds: { x: 0, y: 0, width: 2048, height: 1152 },      physical: { x: 0, y: 0, width: 2560, height: 1440 } },
    { id: LEFT,    bounds: { x: -1080, y: -384, width: 1080, height: 1920 }, physical: { x: -1080, y: -480, width: 1080, height: 1920 } },
    { id: RIGHT,   bounds: { x: 2048, y: -384, width: 1080, height: 1920 },  physical: { x: 2560, y: -480, width: 1080, height: 1920 } },
];
/** What window_geometry.cc reports per adapter index (webrtc GetScreenRect). */
const adapter: Record<number, Rect> = {
    0: { x: 2560, y: -480, width: 1080, height: 1920 },   // \\.\DISPLAY1 = right portrait (180 Hz)
    1: { x: 0, y: 0, width: 2560, height: 1440 },         // \\.\DISPLAY2 = primary
    3: { x: -1080, y: -480, width: 1080, height: 1920 },  // \\.\DISPLAY4 = left portrait (144 Hz)
};
const expected: Record<string, number> = { 'screen:0:0': RIGHT, 'screen:1:0': PRIMARY, 'screen:3:0': LEFT };

/** The rule annotation-overlay.ts used before this fix. */
function legacyIndexPick(sourceId: string, list: DisplayCandidate[]): number | null {
    const m = /^screen:(\d+):/.exec(sourceId);
    if (m && list[Number(m[1])]) return list[Number(m[1])].id;
    return list.length === 1 ? list[0].id : null;
}

const resolveFor = (sourceId: string, extra: Partial<Parameters<typeof resolveCapturedDisplay>[0]> = {}) => {
    const idx = parseScreenSourceIndex(sourceId);
    return resolveCapturedDisplay({
        displayId: '',
        displays,
        monitorRect: idx == null ? null : adapter[idx] ?? null,
        ...extra,
    });
};

describe('which display a screen share captures (owner 3-monitor layout)', () => {
    it('POSITIVE CONTROL: the old index rule puts strokes on the wrong monitor here', () => {
        const wrong = Object.entries(expected).filter(([id, want]) => legacyIndexPick(id, displays) !== want);
        // Every one of the three shares lands wrong or nowhere with the old rule.
        expect(wrong.map(([id]) => id)).toEqual(['screen:0:0', 'screen:1:0', 'screen:3:0']);
        expect(legacyIndexPick('screen:0:0', displays)).toBe(PRIMARY);   // shares the RIGHT portrait
        expect(legacyIndexPick('screen:3:0', displays)).toBeNull();      // non-contiguous index: no overlay at all
    });

    it('matches each share to its own monitor by physical rectangle', () => {
        for (const [id, want] of Object.entries(expected)) {
            expect(resolveFor(id), id).toEqual({ id: want, how: 'monitor-rect' });
        }
    });

    it('tells the two identical 1080x1920 portraits apart (size alone could not)', () => {
        expect(resolveFor('screen:0:0')?.id).toBe(RIGHT);
        expect(resolveFor('screen:3:0')?.id).toBe(LEFT);
    });

    it('is independent of getAllDisplays() order', () => {
        const shuffled = [displays[2], displays[0], displays[1]];
        for (const [id, want] of Object.entries(expected)) {
            const idx = parseScreenSourceIndex(id)!;
            expect(resolveCapturedDisplay({ displayId: '', displays: shuffled, monitorRect: adapter[idx] })?.id).toBe(want);
        }
    });

    it('tolerates off-by-one rounding in dipToScreenRect at 125 %', () => {
        const fuzzy = displays.map(d => d.id === PRIMARY
            ? { ...d, physical: { x: 0, y: 0, width: 2559, height: 1441 } }
            : d);
        expect(resolveCapturedDisplay({ displayId: '', displays: fuzzy, monitorRect: adapter[1] })?.id).toBe(PRIMARY);
    });

    it('display_id (DXGI enumeration) wins when Electron provides it', () => {
        expect(resolveCapturedDisplay({ displayId: String(LEFT), displays, monitorRect: adapter[0] }))
            .toEqual({ id: LEFT, how: 'display-id' });
    });

    it('with no usable signal, shows nothing rather than guess (multi-monitor)', () => {
        // Addon missing / predates getScreenRectFromDeviceIndex.
        expect(resolveCapturedDisplay({ displayId: '', displays, monitorRect: null })).toBeNull();
        // A monitor rect that matches no display (topology changed mid-share).
        expect(resolveCapturedDisplay({ displayId: '', displays, monitorRect: { x: 9000, y: 0, width: 1920, height: 1080 } })).toBeNull();
        // An unknown display_id falls through to the rect, not to a guess.
        expect(resolveCapturedDisplay({ displayId: '42', displays, monitorRect: null })).toBeNull();
    });

    it('a single display needs no signal', () => {
        expect(resolveCapturedDisplay({ displayId: '', displays: [displays[0]], monitorRect: null }))
            .toEqual({ id: PRIMARY, how: 'only-display' });
    });

    it('requires a majority overlap, not any overlap', () => {
        // A rect straddling primary/right with only 40 % on the right display.
        const straddle = { x: 2560 - 648, y: 0, width: 1080, height: 1080 };
        const r = resolveCapturedDisplay({ displayId: '', displays, monitorRect: straddle });
        expect(r?.id).toBe(PRIMARY);
        const tiny = { x: 2500, y: 1400, width: 200, height: 200 }; // 6 % primary / 14 % right
        expect(resolveCapturedDisplay({ displayId: '', displays, monitorRect: tiny })).toBeNull();
    });
});

describe('source id parsing', () => {
    it('screen ids', () => {
        expect(parseScreenSourceIndex('screen:0:0')).toBe(0);
        expect(parseScreenSourceIndex('screen:12:0')).toBe(12);
        expect(parseScreenSourceIndex('screen:-1:0')).toBeNull();
        expect(parseScreenSourceIndex('screen:1')).toBeNull();
        expect(parseScreenSourceIndex('window:1:0')).toBeNull();
        expect(parseScreenSourceIndex('screen:1:0 ')).toBeNull();
    });
    it('window ids', () => {
        expect(parseWindowSourceHandle('window:132456:0')).toBe('132456');
        expect(parseWindowSourceHandle('window:00042:0')).toBe('42');
        expect(parseWindowSourceHandle('window:18446744073709551615:0')).toBe('18446744073709551615');
        expect(parseWindowSourceHandle('window:18446744073709551616:0')).toBeNull();
        expect(parseWindowSourceHandle('window:0:0')).toBeNull();
        expect(parseWindowSourceHandle('window:0x10:0')).toBeNull();
        expect(parseWindowSourceHandle('window:-5:0')).toBeNull();
        expect(parseWindowSourceHandle('screen:5:0')).toBeNull();
    });
    it('native HWND buffers (little-endian)', () => {
        expect(nativeHandleToDecimal(Uint8Array.from([0x1c, 0x0b, 0x0a, 0, 0, 0, 0, 0]))).toBe(String(0x0a0b1c));
        expect(nativeHandleToDecimal(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBe('18446744073709551615');
        expect(nativeHandleToDecimal(Uint8Array.from([1, 0, 0, 0]))).toBe('1');
        expect(nativeHandleToDecimal(new Uint8Array(8))).toBeNull();
        expect(nativeHandleToDecimal(new Uint8Array(3))).toBeNull();
    });
    it('rects from native are validated', () => {
        expect(cleanRect({ x: -1080, y: -480, width: 1080, height: 1920 })).toEqual({ x: -1080, y: -480, width: 1080, height: 1920 });
        expect(cleanRect({ x: 0, y: 0, width: 0, height: 10 })).toBeNull();
        expect(cleanRect({ x: NaN, y: 0, width: 10, height: 10 })).toBeNull();
        expect(cleanRect(null)).toBeNull();
    });
});

describe('window shares: where the overlay goes', () => {
    const frame = { x: -1000, y: -300, width: 900, height: 700 }; // on the left portrait
    const info = (o: Record<string, unknown>) => cleanWindowInfo({ exists: true, visible: true, minimized: false, cloaked: false, frame, ...o });

    it('covers the window frame while it is visible', () => {
        expect(windowOverlayPlacement(info({}))).toEqual({ action: 'show', rect: frame });
    });
    it('hides while minimized, hidden, cloaked (other virtual desktop) or unreadable', () => {
        expect(windowOverlayPlacement(info({ minimized: true })).action).toBe('hide');
        expect(windowOverlayPlacement(info({ visible: false })).action).toBe('hide');
        expect(windowOverlayPlacement(info({ cloaked: true })).action).toBe('hide');
        expect(windowOverlayPlacement(info({ frame: null })).action).toBe('hide');
        expect(windowOverlayPlacement(cleanWindowInfo('garbage')).action).toBe('hide');
    });
    it('closes once the window is gone', () => {
        expect(windowOverlayPlacement(cleanWindowInfo({ exists: false })).action).toBe('close');
    });
    it('a normalized stroke point lands on the same spot of the window, at any scale', () => {
        // The overlay window IS the frame rect (placed natively, physical px),
        // so the layout is the identity and the canvas fills the client area.
        for (const scale of [1, 1.25, 1.5]) {
            const content = { x: 0, y: 0, width: frame.width / scale, height: frame.height / scale }; // CSS px
            const layout = overlayCanvasLayout(content, content);
            expect(layout).toEqual({ cssLeft: 0, cssTop: 0, cssWidth: content.width, cssHeight: content.height });
            for (const [nx, ny] of [[0, 0], [1, 1], [0.25, 0.75]]) {
                const css = renderedScreenPoint(nx, ny, layout, content, scale);
                const physX = frame.x + css.x * scale;
                const physY = frame.y + css.y * scale;
                expect(physX).toBeCloseTo(frame.x + nx * frame.width, 6);
                expect(physY).toBeCloseTo(frame.y + ny * frame.height, 6);
            }
        }
    });
});

describe('resolveCapturedDisplay — DIP fallback (monitorDip)', () => {
    it("matches the owner desk through Chromium's own physical->DIP mapping when physical rects are unavailable", () => {
        const noPhysical = displays.map(d => ({ ...d, physical: null }));
        for (const [sid, want] of Object.entries(expected)) {
            const idx = parseScreenSourceIndex(sid)!;
            const dip = displays.find(d => d.id === want)!.bounds;   // what screenToDipRect returns for that monitor
            expect(resolveCapturedDisplay({ displayId: '', displays: noPhysical, monitorRect: adapter[idx], monitorDip: dip })).toEqual({ id: want, how: 'monitor-rect' });
        }
    });
    it('negative control: neither signal on three displays is still "unknown", never a guess', () => {
        const noPhysical = displays.map(d => ({ ...d, physical: null }));
        expect(resolveCapturedDisplay({ displayId: '', displays: noPhysical, monitorRect: null, monitorDip: null })).toBeNull();
    });
});

describe('linuxOverlayVerdict', () => {
    const v = (env: Record<string, string>, ozonePlatform = '') => linuxOverlayVerdict({ env, ozonePlatform });
    it('X11 on a compositing desktop: shown', () => {
        expect(v({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBeNull();
        expect(v({ XDG_CURRENT_DESKTOP: 'KDE' })).toBeNull();
        expect(v({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' })).toBeNull();
        expect(v({ XDG_CURRENT_DESKTOP: 'XFCE' })).toBeNull();
    });
    it('Wayland session (native Wayland client): refused', () => {
        expect(v({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('wayland');
        expect(v({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' })).toBe('wayland');
        expect(v({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' }, 'wayland')).toBe('wayland');
    });
    it('explicit --ozone-platform=x11 under a Wayland session (XWayland) counts as X11', () => {
        expect(v({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, 'x11')).toBeNull();
    });
    it('X11 without a known compositing desktop: refused (a transparent window would paint black)', () => {
        expect(v({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'i3' })).toBe('no_compositor');
        expect(v({})).toBe('no_compositor');
    });
    it('CIPHERLINE_ANNOT_OVERLAY overrides both ways', () => {
        expect(v({ XDG_CURRENT_DESKTOP: 'i3', CIPHERLINE_ANNOT_OVERLAY: '1' })).toBeNull();
        expect(v({ WAYLAND_DISPLAY: 'w', CIPHERLINE_ANNOT_OVERLAY: '1' })).toBeNull();
        expect(v({ XDG_CURRENT_DESKTOP: 'GNOME', CIPHERLINE_ANNOT_OVERLAY: '0' })).toBe('platform');
    });
});
