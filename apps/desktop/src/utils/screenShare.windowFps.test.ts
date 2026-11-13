import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampShareFps, maxShareFps } from './screenShare';

/** 90 fps is for an entire screen; a window tops out at 60 (owner 2026-10-31). */
describe('frame rate by source', () => {
    it('a window tops out at 60, a screen at 90', () => {
        expect(maxShareFps('window:123:0')).toBe(60);
        expect(maxShareFps('screen:0:0')).toBe(90);
        expect(maxShareFps(null)).toBe(90);
    });

    it('only 90 on a window changes', () => {
        expect(clampShareFps(90, 'window:1:0')).toBe(60);
        for (const f of [60, 30, 15] as const) expect(clampShareFps(f, 'window:1:0')).toBe(f);
        for (const f of [90, 60, 30, 15] as const) expect(clampShareFps(f, 'screen:0:0')).toBe(f);
    });
});

describe('wiring', () => {
    const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

    it('the picker hides 90 for a window, moves a selected 90 down, and clamps at confirm', () => {
        const s = read('components/ScreenSharePickerModal.tsx');
        expect(s).toContain("...(maxFps >= 90 ? [{ value: 90 as const, label: 'Up to 90 fps' }] : [])");
        expect(s).toContain('setFrameRate(f => clampFps(f, selectedSourceId))');
        expect(s).toContain('frameRate: clampFps(frameRate, id)');
        expect(s).toContain('capFrameRate(clampShareFps(f, id), chromiumCap)');
        expect((s.match(/maxFps=\{maxFps\}/g) ?? []).length).toBe(3); // X11 grid, X11 settings step, the portal step
    });

    it('the live quality chips hide 90 during a window share', () => {
        const s = read('components/call/ControlBar.tsx');
        expect(s).toContain('QUALITY_FPS.filter(fps => fps <= maxShareFps(currentShareSourceId) &&');
        expect(read('components/SidebarConference.tsx')).toContain('currentShareSourceId={currentShare?.sourceId ?? null}');
    });

    it('every start and restart is clamped at the one entry point', () => {
        expect(read('components/SidebarConference.tsx')).toContain('frameRate: capFrameRate(clampShareFps(requested.frameRate, requested.sourceId), chromiumFpsCap)');
    });
});

describe('maxShareFps on Linux', () => {
    it('offers 90 for any source, because the id cannot tell a screen from a window there', () => {
        expect(maxShareFps('window:123:0', 'linux')).toBe(90);
        expect(maxShareFps('screen:0:0', 'linux')).toBe(90);
    });
    it('Windows and macOS keep the window cap', () => {
        expect(maxShareFps('window:123:0', 'windows')).toBe(60);
        expect(maxShareFps('window:123:0', 'mac')).toBe(60);
        expect(maxShareFps('screen:0:0', 'windows')).toBe(90);
    });
});
