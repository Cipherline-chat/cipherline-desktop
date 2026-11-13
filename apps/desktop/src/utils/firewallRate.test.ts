import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunRateCounter, rateLine, resolvePower } from './firewallRate';

const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('RunRateCounter', () => {
    it('measures the real draw rate, which a late-frame test cannot', () => {
        // A steady 16.67 ms cadence: no frame is "late", yet this is 60 fps, not 159.
        const c = new RunRateCounter();
        for (let i = 0; i < 301; i++) c.frame(i * (1000 / 60), 0.5);
        const r = c.result()!;
        expect(r.fps).toBeCloseTo(60, 5);
        expect(r.maxGapMs).toBeCloseTo(1000 / 60, 5);
        expect(r.busyAvgMs).toBeCloseTo(0.5, 5);
        expect(r.frames).toBe(301);
    });
    it('reports the worst gap and needs two frames', () => {
        const c = new RunRateCounter();
        c.frame(0, 1);
        expect(c.result()).toBeNull();
        c.frame(6, 1); c.frame(12, 1); c.frame(80, 1);
        expect(c.result()!.maxGapMs).toBe(68);
        c.reset();
        expect(c.count).toBe(0);
        expect(c.result()).toBeNull();
    });
});

describe('rateLine', () => {
    const r = { frames: 301, ms: 5000, fps: 60, busyAvgMs: 0.4, maxGapMs: 18 };
    it('flags a game drawn well under the display rate', () => {
        expect(rateLine(r, 159, 'AMD (powerPreference low-power)')).toMatch(/60 fps .* vs display ~159 Hz -> the game draws at 38% of the display's rate/);
    });
    it('says it matches when it does, and handles no run', () => {
        expect(rateLine({ ...r, fps: 158 }, 159, 'NVIDIA')).toContain('matches the display');
        expect(rateLine(null, 159, '')).toContain('no run measured');
    });
});

describe('power preference', () => {
    it('defaults to low-power and only honours known values', () => {
        expect(resolvePower(undefined)).toBe('low-power');
        expect(resolvePower('turbo')).toBe('low-power');
        expect(resolvePower('high-performance')).toBe('high-performance');
    });
    it('the game asks for the fast GPU and the worker passes it to WebGL', () => {
        expect(src('../components/FirewallOverlay.tsx')).toMatch(/type: 'init'[^\n]*power: 'high-performance'/);
        const w = src('../workers/loadingScreen.worker.ts');
        expect(w).toMatch(/powerPreference: power/);
        expect(w).not.toMatch(/powerPreference: 'low-power'/);
        // The loading screen and the lock backdrop keep the idle-friendly default.
        expect(src('../components/AppLoadingScreen.tsx')).not.toMatch(/high-performance/);
    });
});
