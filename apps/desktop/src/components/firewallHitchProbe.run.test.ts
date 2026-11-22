// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rows: { activity: string; ms: number }[] = [];
vi.mock('../utils/freezeLog', () => ({ recordTimingRow: (activity: string, ms: number) => { rows.push({ activity, ms }); } }));

import { startHitchProbe } from './firewallHitchProbe';

/**
 * The probe must add no per-frame work to the window's main thread while the game runs
 * (worklog 2026-11-22-firewall-hitch): its old requestAnimationFrame loop made the main
 * thread render a frame every vsync (165 a second at 165 Hz) for the whole run. The
 * display rate it reports now comes from the worker's own frame interval.
 */
describe('startHitchProbe: no main-thread frame loop', () => {
    let raf: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        rows.length = 0;
        raf = vi.fn(() => 1);
        // Both spellings: the bare global (what module code calls) and window's.
        vi.stubGlobal('requestAnimationFrame', raf);
        window.requestAnimationFrame = raf as unknown as typeof window.requestAnimationFrame;
        // Timers only: faking requestAnimationFrame too would hide the spy above.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    for (const full of [true, false]) {
        it(`never asks for an animation frame (${full ? 'full' : 'light'} probe), over a whole run`, () => {
            const p = startHitchProbe(full);
            p.onWorker({ type: 'probe', kind: 'pillar', at: Date.now(), k: 1, slot: 0, score: 0 });
            p.onWorker({ type: 'probe', kind: 'gap', at: Date.now(), gap: 61, js: 0.4, score: 1, k: 1, iv: 1000 / 165 });
            vi.advanceTimersByTime(2000);
            p.onWorker({ type: 'probe', kind: 'rate', frames: 1650, ms: 10_000, fps: 165, busyAvgMs: 0.4, maxGapMs: 61, gl: 'NVIDIA', iv: 1000 / 165 });
            p.stop();
            expect(raf).not.toHaveBeenCalled();
            expect(rows.length).toBeGreaterThanOrEqual(2);
        });
    }

    it('reports the display rate the worker learned (iv), not a main-thread guess', () => {
        const p = startHitchProbe(false);
        p.onWorker({ type: 'probe', kind: 'gap', at: Date.now(), gap: 61, js: 0.4, score: 1, k: 1, iv: 1000 / 144 });
        vi.advanceTimersByTime(500);
        p.stop();
        expect(rows[0].activity).toContain('fw:hz:144');
        // and each hitch row carries the game's own frame time
        expect(rows[1].activity).toContain('fw:js:0');
    });

    it('a worker that sends no iv leaves the 60 Hz default (positive control for the test above)', () => {
        const p = startHitchProbe(false);
        p.onWorker({ type: 'probe', kind: 'gap', at: Date.now(), gap: 61, js: 0.4, score: 1, k: 1 });
        vi.advanceTimersByTime(500);
        p.stop();
        expect(rows[0].activity).toContain('fw:hz:60');
    });
});
