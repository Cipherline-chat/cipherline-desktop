import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaptureBoundWatch, isCaptureBound, captureBoundNotice, CAPTURE_BOUND_SAMPLES, type CaptureBoundSample } from './shareCaptureBound';

// share_fps samples straight from the reports: [src_fps, enc_fps, limit, focus, fg_cover]
type Row = [number, number, string, boolean, boolean];
const sample = (r: Row, target = 90): CaptureBoundSample =>
    ({ targetFps: target, srcFps: r[0], encFps: r[1], limit: r[2], focused: r[3], fgCover: r[4] });

describe('CaptureBoundWatch', () => {
    it('884b6045 (window share of BeamNG, WGC): 56-58 fps from the capturer, encoder at 84-88 - tells the user on the 3rd game-in-front sample', () => {
        const rows: Row[] = [
            [58, 88.4, 'none', false, true],   // -255.8 BeamNG in front
            [43, 85.2, 'none', true, false],   // -248.1 Cipherline focused: ignored (and resets)
            [56, 85, 'none', false, true],     // -245.8
            [30, 75.2, 'none', true, false],   // -241.3 Cipherline focused
            [56, 68.8, 'none', false, true],   // -50.1
            [56, 84.1, 'none', false, true],   // -47.6
            [58, 86.2, 'none', false, true],   // -37.6
        ];
        const w = new CaptureBoundWatch();
        const out = rows.map(r => w.observe(sample(r)));
        expect(out.slice(0, 6).every(o => o === null)).toBe(true);
        expect(out[6]).toEqual({ fps: 57 });
    });

    it('438f97a1 (screen share, DXGI, last share): 55-58 fps with the game in front, tells once', () => {
        const rows: Row[] = [
            [57, 50.4, 'none', false, true],  // -65: the encoder sat at 88% of the capture - not yet "keeping up"
            [56, 55.3, 'none', false, true],
            [55, 56.5, 'none', false, true],
            [53, 56, 'none', false, true],
            [58, 56.1, 'none', false, true],
            [56, 55.9, 'none', false, true],
        ];
        const w = new CaptureBoundWatch();
        const out = rows.map(r => w.observe(sample(r)));
        expect(out.filter(o => o !== null)).toHaveLength(1);
        expect(out[3]).toEqual({ fps: 55 });
    });

    it('never fires for a static desktop / Cipherline in front (1-13 fps by design)', () => {
        const w = new CaptureBoundWatch();
        for (const src of [7, 8, 12, 13, 10, 9]) expect(w.observe(sample([src, 9, 'none', true, false], 60))).toBeNull();
        for (const src of [30, 30, 30, 30]) expect(w.observe(sample([src, 29.8, 'none', true, false]))).toBeNull();
    });

    it('never fires for the fullscreen-game collapse (1-10 fps) - that is the "share the game window" hint\'s case', () => {
        const w = new CaptureBoundWatch();
        for (const src of [1, 2, 1, 10, 2]) expect(w.observe(sample([src, 20, 'none', false, true]))).toBeNull();
    });

    it('never blames the capture when the encoder or the network is the limit', () => {
        expect(isCaptureBound(sample([56, 55, 'cpu', false, true]))).toBe(false);
        expect(isCaptureBound(sample([56, 55, 'bandwidth', false, true]))).toBe(false);
        expect(isCaptureBound(sample([56, 30, 'none', false, true]))).toBe(false); // encoder at 54% of the capture
    });

    it('a share that is not asking for 60+ fps has nothing to explain', () => {
        expect(isCaptureBound(sample([28, 28, 'none', false, true], 30))).toBe(false);
        expect(isCaptureBound(sample([56, 55, 'none', false, true], 90))).toBe(true);
    });

    it('a capture at/above 80% of the target is simply "close enough"', () => {
        expect(isCaptureBound(sample([75, 75, 'none', false, true], 90))).toBe(false);
        expect(isCaptureBound(sample([71, 71, 'none', false, true], 90))).toBe(true);
    });

    it('an unsteady capture (spread > 12 fps) is not reported', () => {
        const w = new CaptureBoundWatch();
        const out = [30, 56, 40].map(src => w.observe(sample([src, src, 'none', false, true])));
        expect(out).toEqual([null, null, null]);
        expect(CAPTURE_BOUND_SAMPLES).toBe(3);
    });

    it('unknown fg_cover / missing numbers never count', () => {
        expect(isCaptureBound({ targetFps: 90, srcFps: 56, encFps: 55, focused: false, fgCover: '' })).toBe(false);
        expect(isCaptureBound({ targetFps: 90, encFps: 55, focused: false, fgCover: true })).toBe(false);
        expect(isCaptureBound({ targetFps: 90, srcFps: 56, focused: false, fgCover: true })).toBe(false);
    });

    it('the notice names the rate and the likely cause in plain words - and, for a window, the way out', () => {
        const screen = captureBoundNotice(57, 90, 'screen');
        expect(screen).toMatch(/screen is only producing about 57 new frames per second/);
        expect(screen).toMatch(/90/);
        expect(screen).toMatch(/frame cap, V-Sync or windowed mode/);
        const win = captureBoundNotice(57, 90, 'window');
        expect(win).toMatch(/window is only producing/);
        expect(win).toMatch(/share the screen/);
    });
});

describe('wiring (SidebarConference)', () => {
    const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('every share_fps sample feeds the watch; the notice is once per share_ref and only for the current source', () => {
        expect(src).toMatch(/new CaptureBoundWatch\(\)/);
        expect(src).toMatch(/captureBound\.observe\(\{/);
        expect(src).toMatch(/claimShareOnce\('capture_bound', shareRef\)/);
        expect(src).toMatch(/captureBoundNotice\(bound\.fps, share\.frameRate, shareKindOf\(share\.sourceId\), wide, window\.electronAPI\?\.platform\)/);
        expect(src).toMatch(/isUltrawide\(aspectOf\(trackSettings\?\.width, trackSettings\?\.height\)\)/);
    });
});

describe('ultra-wide (Surround) shares: capture-bound with no game in front (report 6b3ddab6)', () => {
    // 7680x1440 @ 180 Hz shared at 3840x720: a flat 30 fps whether the game or Cipherline was in front.
    const wideRows: Row[] = [[30, 30, 'none', true, false], [30, 30, 'none', false, true], [29, 29, 'none', true, false]];

    it('says so on the 3rd steady sample even though Cipherline was focused and nothing covered the screen', () => {
        const w = new CaptureBoundWatch();
        const out = wideRows.map(r => w.observe({ ...sample(r), wide: true }));
        expect(out).toEqual([null, null, { fps: 30 }]);
    });

    it('the same rows on a normal-shaped screen stay silent (the gates for a game in front still hold)', () => {
        const w = new CaptureBoundWatch();
        expect(wideRows.map(r => w.observe(sample(r)))).toEqual([null, null, null]);
    });

    it('a wide share whose encoder is NOT keeping up is not blamed on the capture', () => {
        expect(isCaptureBound({ ...sample([30, 10, 'none', true, false]), wide: true })).toBe(false);
    });

    it('the wide notice blames the pixel count, not the game', () => {
        const t = captureBoundNotice(30, 90, 'screen', true);
        expect(t).toMatch(/display this wide/);
        expect(t).not.toMatch(/game’s own frame rate/);
        expect(captureBoundNotice(30, 90, 'screen')).toMatch(/game’s own frame rate/);
    });
});

describe('captureBoundNotice: platform wording', () => {
    it('names Windows only for Windows', () => {
        expect(captureBoundNotice(57, 90, 'window', false, 'windows')).toContain('on Windows');
        expect(captureBoundNotice(57, 90, 'window')).toContain('on Windows');
        for (const p of ['linux', 'mac']) {
            const t = captureBoundNotice(57, 90, 'window', false, p);
            expect(t).not.toContain('Windows');
            expect(t).toContain('share the screen to go higher');
            expect(captureBoundNotice(30, 90, 'screen', true, p)).not.toContain('Windows');
        }
    });
});
