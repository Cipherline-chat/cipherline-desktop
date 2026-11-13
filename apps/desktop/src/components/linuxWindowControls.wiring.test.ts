/**
 * Source-wiring pin for the Linux caption buttons (minimise / maximise / close).
 * 2026-11-04: none of them worked on Linux. App.tsx draws a full-width, fixed drag strip at
 * z-index 9999 over the top of the window; Dashboard's <WindowControls> sat below it, so every
 * click landed on the strip (shown in Chromium with elementFromPoint: the strip, not the button).
 * The wrapper now rises above the strip, as the title-bar wordmark already did.
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
