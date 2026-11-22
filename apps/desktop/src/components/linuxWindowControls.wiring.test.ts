/**
 * Source-wiring pin for the Linux caption buttons (minimise / maximise / close).
 * 2026-11-04: none of them worked on Linux. App.tsx draws a full-width, fixed drag strip at
 * z-index 9999 over the top of the window; Dashboard's <WindowControls> sat below it, so every
 * click landed on the strip (shown in Chromium with elementFromPoint: the strip, not the button).
 * The wrapper now rises above the strip, as the title-bar wordmark already did.
 *
 * 2026-11-21: Linux now gets Electron's native caption overlay like Windows
 * (electron/window-chrome.ts); these HTML buttons are only the fallback for a
 * window without it, and must never draw next to the native ones.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

const stripZ = (): number => {
    const m = read('../App.tsx').match(/WebkitAppRegion: 'drag', position: 'fixed'[^}]*zIndex: (\d+)/);
    return m ? Number(m[1]) : NaN;
};

const controlsWrapperZ = (src: string): number => {
    const i = src.indexOf('<WindowControls />');
    const open = src.lastIndexOf('<div className="', i);
    const cls = src.slice(open, src.indexOf('>', open));
    const m = cls.match(/\bz-\[(\d+)\]/);
    return m && /\brelative\b/.test(cls) ? Number(m[1]) : -1;
};

describe('Linux window controls sit above the app drag strip', () => {
    it('the strip is still fixed with a z-index (the premise of this pin)', () => {
        expect(stripZ()).toBeGreaterThan(0);
    });

    it('the WindowControls wrapper is positioned above it', () => {
        expect(controlsWrapperZ(read('Dashboard.tsx'))).toBeGreaterThan(stripZ());
    });

    it('positive control: the pre-fix wrapper fails the check', () => {
        const before = read('Dashboard.tsx').replace('ml-auto no-drag relative z-[10000]', 'ml-auto no-drag');
        expect(controlsWrapperZ(before)).toBeLessThan(stripZ());
    });
});

describe('the HTML buttons are only a fallback for a window without the native overlay', () => {
    const dash = read('Dashboard.tsx');

    it('the Dashboard wrapper is gated on drawsOwnWindowControls (so no empty no-drag div beside the overlay)', () => {
        const i = dash.indexOf('<div className="ml-auto no-drag relative z-[10000]">');
        expect(i).toBeGreaterThan(-1);
        expect(dash.slice(Math.max(0, i - 120), i)).toContain('drawsOwnWindowControls(currentWindowControlsEnv()) && (');
    });

    it('WindowControls itself renders nothing unless it is the fallback', () => {
        const body = dash.slice(dash.indexOf('const WindowControls: React.FC'), dash.indexOf('const OptionRow'));
        expect(body).toContain('const own = drawsOwnWindowControls(currentWindowControlsEnv());');
        expect(body).toContain('if (!own) return null;');
    });

    it('the blocking screen uses the same decision', () => {
        expect(read('ClientBlockScreen.tsx')).toContain('const needsOwnWindowControls = (): boolean => drawsOwnWindowControls(currentWindowControlsEnv());');
    });
});

describe('the title bar leaves room for a native overlay placed on the LEFT', () => {
    // A Linux button layout such as GNOME's "close,minimize,maximize:" puts the
    // native overlay at the left edge, over the wordmark (seen on Fedora 44
    // GNOME Wayland, 2026-11-21). env(titlebar-area-x) is that overlay's width.
    const dash = read('Dashboard.tsx');

    it('pads the bar by env(titlebar-area-x), 12px (px-3) when it is 0', () => {
        expect(dash).toContain("const TITLE_BAR_PADDING_LEFT = 'calc(env(titlebar-area-x, 0px) + 12px)';");
        const bar = dash.indexOf('<div className="drag-region h-[34px]');
        const tag = dash.slice(bar, dash.indexOf('>', bar));
        expect(tag).toContain('style={{ paddingLeft: TITLE_BAR_PADDING_LEFT }}');
    });
});
