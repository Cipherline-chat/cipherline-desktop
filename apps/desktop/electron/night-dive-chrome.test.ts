/**
 * Night dive -> the native caption overlay (electron/night-dive-chrome.ts).
 * The decision and the IPC validation are pure; main.ts / preload.ts import
 * `electron` and cannot load under vitest, so their WIRING is pinned from the
 * source. A test file may import from ../src (tsconfig.electron.json excludes
 * *.test.ts), which is how the colour is tied to the renderer and the CSS.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    NIGHT_DIVE_CHANNEL, NIGHT_DIVE_TITLE_BAR_COLOR, createNightDiveState, nightDiveAppliesToPalette,
    parseNightDivePayload, titleBarColoursFor,
} from './night-dive-chrome';
import { BOOT_PALETTES, BOOT_THEME_IDS, bootPalette, type BootPalette } from './theme-boot';
import { createWindowThemePreview, paletteForState, parseCustomBootPayload } from './theme-custom-boot';
import { titleBarOverlayFor } from './window-chrome';
import { ABYSS_NIGHT } from '../src/utils/nightDive';

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe('the night colour is the darkened title bar', () => {
    it('equals the renderer constant and night-dive.css --nd-bar at night', () => {
        expect(NIGHT_DIVE_TITLE_BAR_COLOR).toBe(ABYSS_NIGHT);
        const css = read('..', 'src', 'styles', 'night-dive.css');
        const night = css.match(/:root\[data-depth="night"\] \[data-layout="drift"\] > \.drag-region \{\s*--nd-bar:\s*(#[0-9A-Fa-f]{6})/)![1];
        expect(night.toUpperCase()).toBe(NIGHT_DIVE_TITLE_BAR_COLOR.toUpperCase());
    });
    it('the day --nd-bar is Dark\'s caption colour (the overlay already matched by day)', () => {
        const css = read('..', 'src', 'styles', 'night-dive.css');
        const day = css.match(/@property --nd-bar\s*\{[^}]*initial-value:\s*(#[0-9A-Fa-f]{6})/)![1];
        expect(day.toUpperCase()).toBe(BOOT_PALETTES.dark.titleBar.color.toUpperCase());
    });
    it('is a valid #rrggbb for setTitleBarOverlay', () => {
        expect(NIGHT_DIVE_TITLE_BAR_COLOR).toMatch(/^#[0-9A-F]{6}$/);
    });
    it('the glyphs stay legible: Dark\'s symbol colour on the night box clears 7:1 (and beats day)', () => {
        const sym = BOOT_PALETTES.dark.titleBar.symbolColor;
        expect(contrast(sym, NIGHT_DIVE_TITLE_BAR_COLOR)).toBeGreaterThan(7);
        expect(contrast(sym, NIGHT_DIVE_TITLE_BAR_COLOR)).toBeGreaterThanOrEqual(contrast(sym, BOOT_PALETTES.dark.titleBar.color));
    });
});

describe('IPC payload validation', () => {
    it('accepts exactly true / false', () => {
        expect(parseNightDivePayload(true)).toBe(true);
        expect(parseNightDivePayload(false)).toBe(false);
    });
    it('rejects everything else, never coerces', () => {
        for (const bad of [undefined, null, 0, 1, '', 'true', 'false', '#05070F', {}, { active: true }, [true], NaN]) {
            expect(parseNightDivePayload(bad), String(bad)).toBeNull();
        }
    });
    it('the channel name is the one main and preload use', () => {
        expect(NIGHT_DIVE_CHANNEL).toBe('window:night-dive');
    });
});

describe('main\'s in-memory flag', () => {
    it('set reports a change only when the value really changes', () => {
        const s = createNightDiveState();
        expect(s.active()).toBe(false);
        expect(s.set(false)).toBe(false);
        expect(s.set(true)).toBe(true);
        expect(s.active()).toBe(true);
        expect(s.set(true)).toBe(false);
        expect(s.set(false)).toBe(true);
        expect(s.active()).toBe(false);
    });
    it('an invalid payload changes nothing (and asks for no repaint)', () => {
        const s = createNightDiveState();
        s.set(true);
        for (const bad of ['false', 0, null, undefined, {}]) expect(s.set(bad)).toBe(false);
        expect(s.active()).toBe(true);
    });
    it('reset (page reload) drops night, reporting whether it did', () => {
        const s = createNightDiveState();
        expect(s.reset()).toBe(false);
        s.set(true);
        expect(s.reset()).toBe(true);
        expect(s.active()).toBe(false);
    });
});

// A custom theme on a Dark base whose colours are EXACTLY Dark's: still not
// the built-in palette (night-dive.css leaves custom themes alone).
const darkClone = parseCustomBootPayload({
    id: 'mine',
    theme: { v: 1, base: 'dark', colors: { bg: '#0b0f1e', panel: '#131a30', surface: '#1c2542', text: '#f4f7ff', muted: '#a7b3d4', accent: '#25e0c8', onAccent: '#0b0f1e', danger: '#ff5c7a', border: '#2a3558' }, glow: true },
    boot: { ...BOOT_PALETTES.dark, titleBar: { ...BOOT_PALETTES.dark.titleBar }, gradient: ['#0B0F1E', '#131A30', '#1C2542'] },
});

describe('which palette the night colour applies to', () => {
    it('only the built-in Dark palette: not Light, Midnight or the high-contrast themes', () => {
        for (const id of BOOT_THEME_IDS) expect(nightDiveAppliesToPalette(bootPalette(id)), id).toBe(id === 'dark');
    });
    it('not a custom theme, even one with Dark\'s exact colours', () => {
        expect(darkClone).not.toBeNull();
        expect(darkClone!.boot.titleBar.color).toBe(BOOT_PALETTES.dark.titleBar.color);
        expect(nightDiveAppliesToPalette(darkClone!.boot)).toBe(false);
        expect(titleBarColoursFor(darkClone!.boot, true)).toEqual(darkClone!.boot.titleBar);
    });
    it('a device state resolved to Dark (picked, or `system` on a dark OS) is the built-in palette', () => {
        expect(nightDiveAppliesToPalette(paletteForState({ id: 'dark', pref: 'dark' }, bootPalette))).toBe(true);
        expect(nightDiveAppliesToPalette(paletteForState({ id: 'dark', pref: 'system' }, bootPalette))).toBe(true);
        expect(nightDiveAppliesToPalette(paletteForState({ id: 'dark', pref: 'custom', custom: darkClone! }, bootPalette))).toBe(false);
    });
});

describe('titleBarColoursFor: the decision table', () => {
    const dark = BOOT_PALETTES.dark;
    it('Dark + night -> the night colour, Dark\'s symbol colour', () => {
        expect(titleBarColoursFor(dark, true)).toEqual({ color: NIGHT_DIVE_TITLE_BAR_COLOR, symbolColor: dark.titleBar.symbolColor });
    });
    it('Dark + day -> the theme\'s own caption colours (unchanged object)', () => {
        expect(titleBarColoursFor(dark, false)).toBe(dark.titleBar);
    });
    for (const id of BOOT_THEME_IDS.filter((t) => t !== 'dark')) {
        it(`${id} + night or day -> the theme's own caption colours`, () => {
            expect(titleBarColoursFor(bootPalette(id), true)).toBe(bootPalette(id).titleBar);
            expect(titleBarColoursFor(bootPalette(id), false)).toBe(bootPalette(id).titleBar);
        });
    }
    it('never mutates the shared boot palette', () => {
        const before = JSON.stringify(BOOT_PALETTES.dark);
        titleBarColoursFor(dark, true);
        expect(JSON.stringify(BOOT_PALETTES.dark)).toBe(before);
    });
    it('Windows and Linux overlays carry it; macOS has no overlay', () => {
        for (const p of ['win32', 'linux']) {
            expect(titleBarOverlayFor(p, titleBarColoursFor(dark, true))).toEqual({ color: NIGHT_DIVE_TITLE_BAR_COLOR, symbolColor: dark.titleBar.symbolColor, height: 34 });
        }
        expect(titleBarOverlayFor('darwin', titleBarColoursFor(dark, true))).toBeUndefined();
    });
});

/**
 * main.ts's paint path, modelled with the REAL pieces (state, preview, palette
 * pick, decision) and the same repaint rules as main.ts, so the sequences the
 * owner can hit are checked end to end. The wiring tests below pin that main.ts
 * really is shaped like this.
 */
function mainModel(initialPref: { id: string; pref: string } = { id: 'dark', pref: 'dark' }) {
    let device: { id: string; pref: string } = initialPref;
    const painted: string[] = [];
    const night = createNightDiveState();
    const paint = (colors: BootPalette) => { painted.push(titleBarColoursFor(colors, night.active()).color); };
    const preview = createWindowThemePreview(paint, () => paletteForState(device as never, bootPalette));
    const repaint = () => { if (!preview.active()) paint(paletteForState(device as never, bootPalette)); };
    return {
        painted,
        last: () => painted.at(-1),
        setNight: (v: unknown) => { if (night.set(v)) repaint(); },
        setTheme: (id: string) => { device = { id, pref: id }; repaint(); },
        reload: () => { const dropped = night.reset(); if (!preview.end() && dropped) repaint(); },
        previewStart: (payload: unknown) => preview.start(payload),
        previewEnd: () => preview.end(),
    };
}

const lightPreview = {
    id: 'preview',
    theme: { v: 1, base: 'light', colors: { bg: '#fff5f7', panel: '#ffe4ea', surface: '#ffffff', text: '#3a1020', muted: '#7a4a5a', accent: '#c2185b', onAccent: '#ffffff', danger: '#b00020', border: '#f0c0cc' }, glow: false },
    boot: {
        abyss: '#FFF5F7', deep: '#FFE4EA', surface: '#FFFFFF', border: '#F0C0CC', sink: '#FFF0F3', lume: '#C2185B', lumeHi: '#D81B60',
        lumeDeep: '#880E4F', glow: '#FFC94D', ok: '#2E7D32', text: '#3A1020', muted: '#7A4A5A', faint: '#8A5A6A', windowBackground: '#FFF5F7',
        titleBar: { color: '#FFF5F7', symbolColor: '#3A1020' }, card: '#FFFFFF', gradient: ['#FFF5F7', '#FFE4EA', '#FFFFFF'],
    },
};

describe('main paint path: the sequences', () => {
    const DAY = BOOT_PALETTES.dark.titleBar.color;
    const NIGHT = NIGHT_DIVE_TITLE_BAR_COLOR;
    it('enter at 00:00 -> night; exit at 05:00 -> day; repeats do not repaint', () => {
        const m = mainModel();
        m.setNight(true); m.setNight(true);
        expect(m.painted).toEqual([NIGHT]);
        m.setNight(false); m.setNight(false);
        expect(m.painted).toEqual([NIGHT, DAY]);
    });
    it('a theme change during the night: Light is never painted with the night box, whatever order the messages come in', () => {
        // theme:set lands BEFORE the renderer's exit (renderer applies, then invokes).
        const a = mainModel(); a.setNight(true); a.setTheme('light');
        expect(a.last()).toBe(BOOT_PALETTES.light.titleBar.color);
        a.setNight(false);
        expect(a.painted).not.toContain(undefined);
        expect(a.painted.slice(1).every((c) => c === BOOT_PALETTES.light.titleBar.color)).toBe(true);
        // ...and back to Dark: the renderer's enter may come before or after theme:set.
        const b = mainModel({ id: 'light', pref: 'light' }); b.setNight(true); b.setTheme('dark');
        expect(b.last()).toBe(NIGHT);
        const c = mainModel({ id: 'light', pref: 'light' }); c.setTheme('dark'); c.setNight(true);
        expect(c.painted).toEqual([DAY, NIGHT]);
        for (const id of ['midnight', 'hc-dark', 'hc-light']) {
            const m = mainModel(); m.setNight(true); m.setTheme(id);
            expect(m.last(), id).toBe(BOOT_PALETTES[id as keyof typeof BOOT_PALETTES].titleBar.color);
        }
    });
    it('a preview owns the window: night does not paint over it, and its end comes back to night', () => {
        const m = mainModel();
        m.setNight(true);
        expect(m.previewStart(lightPreview)).toBe(true);
        expect(m.last()).toBe('#FFF5F7');
        const n = m.painted.length;
        m.setNight(false); m.setNight(true);
        expect(m.painted.length).toBe(n);
        m.previewEnd();
        expect(m.last()).toBe(NIGHT);
    });
    it('the night ending during a preview: the end paints day', () => {
        const m = mainModel();
        m.setNight(true); m.previewStart(lightPreview); m.setNight(false); m.previewEnd();
        expect(m.last()).toBe(DAY);
    });
    it('a reload drops night (boot backdrop is day) and paints once, preview or not', () => {
        const m = mainModel();
        m.setNight(true);
        m.reload();
        expect(m.painted).toEqual([NIGHT, DAY]);
        m.reload();
        expect(m.painted).toEqual([NIGHT, DAY]);
        const p = mainModel();
        p.setNight(true); p.previewStart(lightPreview);
        const n = p.painted.length;
        p.reload();
        expect(p.painted.length).toBe(n + 1);
        expect(p.last()).toBe(DAY);
        // ...then the reloaded page announces night again.
        p.setNight(true);
        expect(p.last()).toBe(NIGHT);
    });
});

describe('main.ts / preload.ts wiring (source)', () => {
    const main = read('main.ts');
    const preload = read('preload.ts');
    const block = (start: string) => {
        const i = main.indexOf(start);
        expect(i, start).toBeGreaterThan(0);
        return main.slice(i, main.indexOf('\n  });', i) + 6);
    };
    it('paintWindowColors picks the caption colours through titleBarColoursFor with the in-memory flag', () => {
        const fn = main.slice(main.indexOf('function paintWindowColors('), main.indexOf('\n}\n', main.indexOf('function paintWindowColors(')));
        expect(fn).toContain('titleBarOverlayFor(process.platform, titleBarColoursFor(colors, nightDive.active()))');
        expect(main).toContain('const nightDive = createNightDiveState();');
    });
    it('repaintWindowColors respects a live preview', () => {
        expect(main).toContain('if (!windowThemePreview.active()) paintWindowColors(paletteForState(deviceThemeState(), bootPalette));');
    });
    it('the IPC handler: main window only, validated by the state, repaint only on a change, stores nothing', () => {
        const h = block('ipcMain.on(NIGHT_DIVE_CHANNEL,');
        expect(h).toContain('e.sender !== mainWindow.webContents');
        expect(h).toContain('if (nightDive.set(active)) repaintWindowColors();');
        expect(h).not.toMatch(/secureStore|secureLocalStore|sessionTheme|theme:changed/);
    });
    it('a page (re)load resets the flag before ending a preview, and paints once', () => {
        const h = block("ipcMain.on('theme:get-sync',");
        expect(h).toContain('const nightDropped = nightDive.reset();');
        expect(h).toContain('if (!windowThemePreview.end() && nightDropped) repaintWindowColors();');
        expect(h.indexOf('nightDive.reset()')).toBeLessThan(h.indexOf('windowThemePreview.end()'));
    });
    it('preload sends a boolean only, on the same channel', () => {
        expect(preload).toMatch(/setNightDive: \(active: boolean\): void => \{\s*if \(typeof active === 'boolean'\) ipcRenderer\.send\('window:night-dive', active\);\s*\},/);
        expect(read('..', 'src', 'env.d.ts')).toContain('setNightDive?: (active: boolean) => void;');
    });
    it('night-dive-chrome.ts imports nothing from ../src or electron (rootDir trap / unit-testable)', () => {
        const src = read('night-dive-chrome.ts');
        expect(src).not.toMatch(/from ['"]\.\.\//);
        expect(src).not.toMatch(/from ['"]electron['"]/);
    });
});
