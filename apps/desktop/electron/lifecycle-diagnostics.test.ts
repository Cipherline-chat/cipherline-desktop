import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { FreezeMonitor } from './freeze-monitor';
import {
    wireWindowDiagnostics, summarizeAppMetrics, describeChildProcessGone, summarizeGpuFeatureStatus,
    RESTORE_COALESCE_MS, type RestoredPayload,
} from './lifecycle-diagnostics';

afterEach(() => { vi.useRealTimers(); });

function fakeWindow() {
    const win = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const wc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const sent: Array<[string, unknown]> = [];
    wc.send = (ch: string, arg: unknown) => { sent.push([ch, arg]); };
    wc.isDestroyed = () => false;
    win.webContents = wc;
    win.isMinimized = () => false;
    win.isVisible = () => true;
    win.isDestroyed = () => false;
    return { win: win as never, emitWin: (e: string, ...a: unknown[]) => win.emit(e, ...a), emitWc: (e: string, ...a: unknown[]) => wc.emit(e, ...a), sent };
}

function setup() {
    vi.useFakeTimers();
    const m = new FreezeMonitor(() => Date.now());
    const samples: string[] = [];
    const restored: RestoredPayload[] = [];
    const w = fakeWindow();
    const d = wireWindowDiagnostics(w.win, { monitor: m, sampleMetrics: (why) => samples.push(why), onRestored: p => restored.push(p), frameTimeoutMs: 10_000 });
    const events = () => m.snapshot().filter(e => e.source === 'event').map(e => e.activity);
    return { m, samples, restored, ...w, d, events };
}

describe('wireWindowDiagnostics', () => {
    it('minimize → restore: logs how long it was hidden, samples metrics, notifies once, and times the next frame', () => {
        const { emitWin, restored, samples, sent, d, events, m } = setup();
        emitWin('minimize');
        vi.advanceTimersByTime(5 * 60_000);
        emitWin('restore');
        emitWin('show');            // Windows can send show + focus right after restore
        emitWin('focus');
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({ from: 'minimized', hiddenMs: 5 * 60_000 });
        expect(samples).toEqual(['restore']);
        const ping = sent.find(([ch]) => ch === 'perf:frame-ping');
        expect(ping).toBeTruthy();
        vi.advanceTimersByTime(840);
        d.onFramePong(ping![1] as number);
        expect(events()).toEqual(expect.arrayContaining(['window:minimize', 'window:restore from=minimized', 'window:first-frame restore to next painted frame', 'window:focus']));
        const frame = m.snapshot().find(e => e.activity.startsWith('window:first-frame'))!;
        expect(frame.ms).toBe(840);
    });

    it('a restore that never paints is logged as a timeout (the "won\'t open" case)', () => {
        const { emitWin, events, samples } = setup();
        emitWin('minimize');
        emitWin('restore');
        vi.advanceTimersByTime(10_000);
        expect(events().some(a => a.startsWith('window:first-frame-timeout'))).toBe(true);
        expect(samples).toContain('frame-timeout');
    });

    it('tray hide → show is a restore from "hidden"; a first show is not a restore', () => {
        const { emitWin, restored, events } = setup();
        emitWin('show');
        expect(restored).toHaveLength(0);
        expect(events()).toContain('window:show');
        vi.advanceTimersByTime(RESTORE_COALESCE_MS + 1);
        emitWin('hide');
        vi.advanceTimersByTime(2000);
        emitWin('show');
        expect(restored).toEqual([expect.objectContaining({ from: 'hidden', hiddenMs: 2000 })]);
    });

    it('a stale or unknown pong is ignored', () => {
        const { emitWin, d, events } = setup();
        emitWin('minimize'); emitWin('restore');
        d.onFramePong(9999);
        expect(events().some(a => a.startsWith('window:first-frame '))).toBe(false);
    });

    it('unresponsive → responsive records the hang duration; a crash records the reason code only', () => {
        const { emitWc, events, m } = setup();
        emitWc('unresponsive');
        vi.advanceTimersByTime(7000);
        emitWc('responsive');
        const row = m.snapshot().find(e => e.activity.startsWith('renderer:responsive'))!;
        expect(row.ms).toBe(7000);
        emitWc('render-process-gone', {}, { reason: 'oom', exitCode: -536870904 });
        expect(events()).toContain('renderer:gone reason=oom exit=-536870904');
    });

    it('a window move is one row per drag, not one per pixel', () => {
        const { emitWin, events } = setup();
        for (let i = 0; i < 30; i++) { emitWin('moved'); vi.advanceTimersByTime(50); }
        vi.advanceTimersByTime(1000);
        expect(events().filter(a => a === 'window:moved')).toHaveLength(1);
    });
});

describe('summaries carry types, reasons and numbers only', () => {
    it('summarizeAppMetrics sums per process TYPE and drops unknown type strings', () => {
        const s = summarizeAppMetrics([
            { type: 'Browser', cpu: { percentCPUUsage: 1.25 }, memory: { workingSetSize: 150 * 1024 } },
            { type: 'Tab', cpu: { percentCPUUsage: 8 }, memory: { workingSetSize: 400 * 1024 } },
            { type: 'Tab', cpu: { percentCPUUsage: 0.5 }, memory: { workingSetSize: 30 * 1024 } },
            { type: 'GPU', cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 200 * 1024 } },
            { type: 'C:\\Users\\alice\\evil', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1024 } },
        ]);
        expect(s).toBe('browser 1.3% 150MB | tab(2) 8.5% 430MB | gpu 3.0% 200MB | other 1.0% 1MB | total 781MB');
        // And it passes the monitor's own pattern, so it is actually stored.
        const m = new FreezeMonitor(() => 0);
        m.metrics(`restore: ${s}`);
        expect(m.snapshot()).toHaveLength(1);
    });

    it('child-process-gone keeps the type and Electron reason, nothing free-form', () => {
        expect(describeChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 34, name: 'something user-ish' })).toBe('type=GPU reason=crashed exit=34');
        expect(describeChildProcessGone({ type: '<script>', reason: 'Some Sentence!' })).toBe('type=unknown reason=unknown exit=0');
    });

    it('GPU feature status keeps the known features with enum-like values', () => {
        expect(summarizeGpuFeatureStatus({ gpu_compositing: 'enabled', rasterization: 'disabled_software', webgl: 'enabled', foo: 'bar' }))
            .toBe('gpu_compositing=enabled, rasterization=disabled_software, webgl=enabled');
        expect(summarizeGpuFeatureStatus(null)).toBe('unavailable');
    });
});
